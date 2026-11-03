/**
 * Upload validation. The file type is decided from the bytes, never from
 * the extension or the Content-Type header the client sent. Anything not
 * on the allowlist is refused, including HTML, SVG, scripts, executables,
 * archives, macro-enabled Office files and PDFs with JavaScript.
 *
 * This module does the whole check, synchronously apart from the PDF
 * parser. It is run in a worker thread with heap and time limits
 * (content-inspector.ts), never on the request thread.
 */
import { crc32 } from 'node:zlib';
import { inspectPdf, PdfRejected } from './pdf-inspect.js';
import { inspectOoxml, looksLikeZip, ZipRejected } from './zip-inspect.js';

export interface DetectedType {
  mime: string;
  ext: string;
  label: string;
}

export class RejectedFile extends Error {}

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

export async function detectType(buf: Buffer, originalName: string): Promise<DetectedType> {
  if (buf.length === 0) throw new RejectedFile('The file is empty');

  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    // %PDF-  — refuse active content. A false positive costs a re-export;
    // a false negative could run script in a viewer.
    // First pass: the raw bytes, cheap. Second pass: the same with #xx
    // name escapes decoded, which also catches escaped names hidden where
    // the parser would not look. Third pass: the parsed structure, which
    // sees inside compressed object streams (pdf-inspect.ts).
    const text = buf.toString('latin1');
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\b/.test(text)) {
      throw new RejectedFile('PDFs containing JavaScript, launch actions or embedded files are not accepted');
    }
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/.test(unescapePdfNames(text))) {
      throw new RejectedFile('PDFs containing JavaScript, launch actions or embedded files are not accepted (names written with #xx escapes)');
    }
    // Nothing but whitespace may follow the last %%EOF (no appended HTML,
    // ZIP or second document), and it must be near the end (not truncated).
    const eof = text.lastIndexOf('%%EOF');
    if (eof < 0 || buf.length - eof > 1024 || !/^[\0\t\n\f\r ]*$/.test(text.slice(eof + 5))) {
      throw new RejectedFile('The PDF is truncated or has data appended after its end');
    }
    refusePolyglot(buf, 'pdf');
    try {
      await inspectPdf(buf, text);
    } catch (err) {
      if (err instanceof PdfRejected) throw new RejectedFile(err.message);
      throw new RejectedFile('The PDF is damaged or malformed and cannot be checked');
    }
    return TYPES.pdf;
  }
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
  if (buf.includes(0)) throw new RejectedFile(`Only ${ALLOWED_DESCRIPTION} files are accepted`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new RejectedFile('Text files must be valid UTF-8');
  }
  // Control characters other than tab, newline, carriage return and form
  // feed mean this is not a text document (e.g. a renamed binary).
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) {
    throw new RejectedFile(`Only ${ALLOWED_DESCRIPTION} files are accepted`);
  }
  // Markup is refused even as "text": a browser that ever rendered it
  // inline would run it. We never render inline, but defence in depth.
  const head = text.slice(0, 4096).trimStart().toLowerCase();
  if (head.startsWith('<') || /<\s*(script|svg|html|iframe|object|embed)\b/.test(text.slice(0, 65536).toLowerCase())) {
    throw new RejectedFile('HTML, SVG and XML files are not accepted');
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
