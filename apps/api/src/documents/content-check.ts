/**
 * Upload validation. The file type is decided from the bytes, never from
 * the extension or the Content-Type header the client sent. Anything not
 * on the allowlist is refused, including HTML, SVG, scripts, executables,
 * archives, macro-enabled Office files and PDFs with JavaScript.
 */

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

export function detectType(buf: Buffer, originalName: string): DetectedType {
  if (buf.length === 0) throw new RejectedFile('The file is empty');

  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    // %PDF-  — refuse active content. A false positive costs a re-export;
    // a false negative could run script in a viewer.
    const text = buf.toString('latin1');
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\b/.test(text)) {
      throw new RejectedFile('PDFs containing JavaScript, launch actions or embedded files are not accepted');
    }
    return TYPES.pdf;
  }
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return TYPES.png;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return TYPES.jpeg;
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return detectOoxml(buf);

  return detectText(buf, originalName);
}

/** Office Open XML files are ZIPs; look at the entry names, never unpack. */
function detectOoxml(buf: Buffer): DetectedType {
  const names = zipEntryNames(buf);
  if (names.some((n) => n.includes('..') || n.startsWith('/') || n.includes('\\'))) {
    throw new RejectedFile('The archive contains unsafe paths');
  }
  if (names.some((n) => n.toLowerCase().endsWith('vbaproject.bin'))) {
    throw new RejectedFile('Macro-enabled Office files are not accepted');
  }
  if (!names.includes('[Content_Types].xml')) throw new RejectedFile(`Only ${ALLOWED_DESCRIPTION} files are accepted`);
  if (names.some((n) => n.startsWith('word/'))) return TYPES.docx;
  if (names.some((n) => n.startsWith('xl/'))) return TYPES.xlsx;
  if (names.some((n) => n.startsWith('ppt/'))) return TYPES.pptx;
  throw new RejectedFile(`Only ${ALLOWED_DESCRIPTION} files are accepted`);
}

/** Reads file names from the ZIP central directory. Throws on malformed input. */
export function zipEntryNames(buf: Buffer): string[] {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  const searchFrom = Math.max(0, buf.length - (0xffff + 22));
  let eocd = -1;
  for (let i = buf.length - 22; i >= searchFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new RejectedFile('The file is not a valid Office document');
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries > 10_000 || cdOffset >= buf.length) throw new RejectedFile('The file is not a valid Office document');

  const names: string[] = [];
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new RejectedFile('The file is not a valid Office document');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLen > buf.length) throw new RejectedFile('The file is not a valid Office document');
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function detectText(buf: Buffer, originalName: string): DetectedType {
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
