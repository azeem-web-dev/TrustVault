/**
 * Upload validation. The file type is decided from the bytes, never from
 * the extension or the Content-Type header the client sent. Anything not
 * on the allowlist is refused, including HTML, SVG, scripts, executables,
 * archives and macro-enabled Office files. PDFs are never stored as sent:
 * every one is rebuilt without active content (pdf-sanitize.ts) and the
 * rebuilt file must pass the full strict check before it is accepted.
 *
 * This module does the whole check, synchronously apart from the PDF
 * parser. It is run in a worker thread with heap and time limits
 * (content-inspector.ts), never on the request thread.
 */
import { crc32 } from 'node:zlib';
import { inspectPdf, PdfRejected, removedLabel } from './pdf-inspect.js';
import { assertRebuilt, rebuildPdf } from './pdf-sanitize.js';
import { inspectOoxml, looksLikeZip, ZipRejected } from './zip-inspect.js';

export interface DetectedType {
  mime: string;
  ext: string;
  label: string;
}

/**
 * Stable reason codes for a refused upload (the audit row's `reason`).
 * type_not_allowed: not a kind of file we take at all. content_rejected:
 * an allowed kind, but damaged, a polyglot, macros, an unsafe structure.
 * sanitize_failed: a PDF that could not be rebuilt into one that passes the
 * strict check. check_failed: the worker ran out of time or memory or died.
 */
export type RefusalCode = 'type_not_allowed' | 'content_rejected' | 'sanitize_failed' | 'check_failed';

export class RejectedFile extends Error {
  constructor(message: string, readonly code: RefusalCode = 'content_rejected') {
    super(message);
  }
}

/** What the check hands back: the type, and for PDFs the rebuilt bytes to store instead of the upload. */
export interface CheckResult {
  type: DetectedType;
  sanitized?: { data: Buffer; removed: string[] };
}

const TYPES = {
  pdf: { mime: 'application/pdf', ext: 'pdf', label: 'PDF' },
  png: { mime: 'image/png', ext: 'png', label: 'PNG image' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG image' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', label: 'Word document' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', label: 'Excel workbook' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx', label: 'PowerPoint presentation' },
  txt: { mime: 'text/plain; charset=utf-8', ext: 'txt', label: 'Text' },
  csv: { mime: 'text/csv; charset=utf-8', ext: 'csv', label: 'CSV' },
  md: { mime: 'text/markdown; charset=utf-8', ext: 'md', label: 'Markdown' },
} as const satisfies Record<string, DetectedType>;

export const ALLOWED_DESCRIPTION = 'PDF, PNG, JPEG, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), plain text, CSV or Markdown';

const startsWith = (buf: Buffer, sig: number[]): boolean => sig.every((b, i) => buf[i] === b);

/** "%PDF-" anywhere a PDF reader would still accept it (the first 1 KB). */
const PDF_MAGIC_NEAR_START = (buf: Buffer): boolean => buf.subarray(0, 1024).includes('%PDF-', 0, 'latin1');
/**
 * Markup a browser would render if the bytes were ever sniffed as HTML.
 * Only tags of three or more letters plus a delimiter: compressed image
 * data contains random short sequences such as "<a " (a 5 MB photo has a
 * few), while a five-byte match such as "<svg " is vanishingly unlikely.
 */
const MARKUP = /<(script|html|body|svg|iframe|object|embed|\?php|!doctype)[\s>/]/i;

/** Decodes #xx escapes in PDF names so /J#61vaScript reads as /JavaScript. */
const unescapePdfNames = (s: string): string => s.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** Polyglots: a file that is also a PDF or also a ZIP is refused, whatever it claims to be. */
function refusePolyglot(buf: Buffer, kind: string): void {
  if (kind !== 'pdf' && PDF_MAGIC_NEAR_START(buf)) throw new RejectedFile('Files that are also PDFs (polyglots) are not accepted');
  if (kind !== 'zip' && looksLikeZip(buf)) throw new RejectedFile('Files that are also ZIP archives (polyglots) are not accepted');
}

const ACTIVE_RAW = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\b/;
const ACTIVE_RAW_ESCAPED = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/;

/**
 * The strict PDF check: refuses active content and every structural
 * problem. Before sanitization this was the whole PDF check; now it is the
 * gate the REBUILT file must pass (the re-inspection guard, THREATS.md C10).
 * Exported for tests.
 */
export async function strictPdfCheck(buf: Buffer): Promise<void> {
  const text = buf.toString('latin1');
  // First pass: the raw bytes, cheap. Second pass: the same with #xx name
  // escapes decoded, which also catches escaped names hidden where the
  // parser would not look. Third pass: the parsed structure, which sees
  // inside compressed object streams (pdf-inspect.ts).
  if (ACTIVE_RAW.test(text)) {
    throw new RejectedFile('PDFs containing JavaScript, launch actions or embedded files are not accepted');
  }
  if (ACTIVE_RAW_ESCAPED.test(unescapePdfNames(text))) {
    throw new RejectedFile('PDFs containing JavaScript, launch actions or embedded files are not accepted (names written with #xx escapes)');
  }
  checkPdfEnvelope(buf, text);
  try {
    await inspectPdf(buf, text);
  } catch (err) {
    if (err instanceof PdfRejected) throw new RejectedFile(err.message);
    throw new RejectedFile('The PDF is damaged or malformed and cannot be checked');
  }
}

/**
 * Not active content, so never "sanitized": nothing but whitespace may
 * follow the last %%EOF (no appended HTML, ZIP or second document), it must
 * be near the end (not truncated), and the file must not also be a ZIP.
 */
function checkPdfEnvelope(buf: Buffer, text: string): void {
  const eof = text.lastIndexOf('%%EOF');
  if (eof < 0 || buf.length - eof > 1024 || !/^[\0\t\n\f\r ]*$/.test(text.slice(eof + 5))) {
    throw new RejectedFile('The PDF is truncated or has data appended after its end');
  }
  refusePolyglot(buf, 'pdf');
}

/**
 * PDFs: refuse what is broken, rebuild what is merely active (THREATS.md
 * C9-C11). The input must be a well-formed, unencrypted PDF with no hidden
 * objects and within the parser limits; active content (JavaScript,
 * actions, attachments, multimedia, XFA, non-web links) is noted, not
 * refused. Every PDF is then rebuilt, and the rebuilt bytes must pass
 * strictPdfCheck() and assertRebuilt() with the same page count, or the
 * upload is refused as sanitize_failed.
 */
async function checkPdf(buf: Buffer): Promise<CheckResult> {
  const text = buf.toString('latin1');
  const removed = new Set<string>();
  // The raw-byte passes on the INPUT name what is there; they no longer refuse.
  for (const m of text.matchAll(/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\b/g)) removed.add(removedLabel(m[1]!));
  for (const m of unescapePdfNames(text).matchAll(/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/g)) removed.add(removedLabel(m[1]!));
  checkPdfEnvelope(buf, text);
  try {
    await inspectPdf(buf, text, removed);
  } catch (err) {
    if (err instanceof PdfRejected) throw new RejectedFile(err.message);
    throw new RejectedFile('The PDF is damaged or malformed and cannot be checked');
  }

  let out: Buffer;
  try {
    const rebuilt = await rebuildPdf(buf);
    for (const r of rebuilt.removed) removed.add(r);
    out = rebuilt.data;
    // The re-inspection guard: the output gets the full strict check.
    await strictPdfCheck(out);
    if ((await assertRebuilt(out)) !== rebuilt.pages) throw new Error('page count changed');
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new RejectedFile(`The PDF could not be made safe and was not accepted (${why.slice(0, 160)})`, 'sanitize_failed');
  }
  return { type: TYPES.pdf, sanitized: { data: out, removed: [...removed].sort() } };
}

/** The whole upload check. PDFs come back with the rebuilt bytes to store. */
export async function checkUpload(buf: Buffer, originalName: string): Promise<CheckResult> {
  if (buf.length === 0) throw new RejectedFile('The file is empty');
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return checkPdf(buf); // %PDF-
  return { type: await detectOther(buf, originalName) };
}

/** The detected type only (tests, and callers that do not store). */
export async function detectType(buf: Buffer, originalName: string): Promise<DetectedType> {
  return (await checkUpload(buf, originalName)).type;
}

async function detectOther(buf: Buffer, originalName: string): Promise<DetectedType> {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    checkPng(buf);
    refuseMarkupInImage(buf);
    refusePolyglot(buf, 'png');
    return TYPES.png;
  }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    checkJpeg(buf);
    refuseMarkupInImage(buf);
    refusePolyglot(buf, 'jpeg');
    return TYPES.jpeg;
  }
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    refusePolyglot(buf, 'zip');
    return detectOoxml(buf);
  }

  return detectText(buf, originalName);
}

/** Office Open XML files are ZIPs: strict structure, then active-content checks (zip-inspect.ts). */
function detectOoxml(buf: Buffer): DetectedType {
  let kind: 'docx' | 'xlsx' | 'pptx';
  try {
    kind = inspectOoxml(buf);
  } catch (err) {
    if (err instanceof ZipRejected) {
      // Structural problems get one generic message; specific refusals
      // (macros, ActiveX, external content...) keep theirs.
      throw new RejectedFile(/^[A-Z]/.test(err.message) ? err.message : `The file is not a valid Office document (${err.message})`);
    }
    throw new RejectedFile('The file is not a valid Office document');
  }
  return TYPES[kind];
}

/** PNG: every chunk well-formed with a correct CRC, IHDR first, nothing after IEND. */
function checkPng(buf: Buffer): void {
  const bad = (): never => { throw new RejectedFile('The PNG image is damaged or has data appended after its end'); };
  let p = 8;
  let first = true;
  let chunks = 0;
  for (;;) {
    if (p + 12 > buf.length) bad();
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (len > 0x7fffffff || p + 12 + len > buf.length || !/^[A-Za-z]{4}$/.test(type)) bad();
    if (first && type !== 'IHDR') bad();
    first = false;
    if ((crc32(buf.subarray(p + 4, p + 8 + len)) >>> 0) !== buf.readUInt32BE(p + 8 + len)) bad();
    p += 12 + len;
    if (++chunks > 100_000) bad();
    if (type === 'IEND') break;
  }
  if (p !== buf.length) bad();
}

/** JPEG: markers walk from SOI to EOI. Data after EOI is allowed only if it holds no markup or archive (phones append motion-photo video there). */
function checkJpeg(buf: Buffer): void {
  const bad = (): never => { throw new RejectedFile('The JPEG image is damaged'); };
  let p = 2;
  let segments = 0;
  for (;;) {
    if (++segments > 100_000) bad();
    if (p + 2 > buf.length) bad();
    if (buf[p] !== 0xff) bad();
    let marker = buf[p + 1]!;
    while (marker === 0xff && p + 2 < buf.length) { p++; marker = buf[p + 1]!; } // fill bytes
    p += 2;
    if (marker === 0xd9) return; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (p + 2 > buf.length) bad();
    const len = buf.readUInt16BE(p);
    if (len < 2 || p + len > buf.length) bad();
    p += len;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not a stuffed
      // zero or a restart marker.
      while (p + 1 < buf.length && !(buf[p] === 0xff && buf[p + 1] !== 0x00 && !(buf[p + 1]! >= 0xd0 && buf[p + 1]! <= 0xd7))) p++;
      if (p + 1 >= buf.length) bad();
    }
  }
}

function refuseMarkupInImage(buf: Buffer): void {
  if (MARKUP.test(buf.toString('latin1'))) throw new RejectedFile('Images containing HTML or script are not accepted');
}

/** Reads file names from the ZIP central directory (strict; see zip-inspect.ts). Throws on malformed input. */
export { readZip as zipEntries } from './zip-inspect.js';

function detectText(buf: Buffer, originalName: string): DetectedType {
  refusePolyglot(buf, 'text');
  if (buf.includes(0)) throw new RejectedFile(`Only ${ALLOWED_DESCRIPTION} files are accepted`, 'type_not_allowed');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new RejectedFile('Text files must be valid UTF-8', 'type_not_allowed');
  }
  // Control characters other than tab, newline, carriage return and form
  // feed mean this is not a text document (e.g. a renamed binary).
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) {
    throw new RejectedFile(`Only ${ALLOWED_DESCRIPTION} files are accepted`, 'type_not_allowed');
  }
  // Markup is refused even as "text": a browser that ever rendered it
  // inline would run it. We never render inline, but defence in depth.
  const head = text.slice(0, 4096).trimStart().toLowerCase();
  if (head.startsWith('<') || /<\s*(script|svg|html|iframe|object|embed)\b/.test(text.slice(0, 65536).toLowerCase())) {
    throw new RejectedFile('HTML, SVG and XML files are not accepted', 'type_not_allowed');
  }
  const ext = originalName.toLowerCase().split('.').pop();
  if (ext === 'csv') return TYPES.csv;
  if (ext === 'md' || ext === 'markdown') return TYPES.md;
  return TYPES.txt;
}

/**
 * Display name for a stored file: no directories, no control characters,
 * no quotes, bounded length, and an extension that matches what the file
 * actually is.
 */
export function safeFileName(original: string, type: DetectedType): string {
  let name = original.normalize('NFC').split(/[\\/]/).pop() ?? '';
  name = name.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim();
  const dot = name.lastIndexOf('.');
  let stem = dot > 0 ? name.slice(0, dot) : name;
  stem = stem.slice(0, 150).trim() || 'document';
  return `${stem}.${type.ext}`;
}
