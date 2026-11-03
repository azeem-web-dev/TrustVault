/**
 * Structural PDF inspection (THREATS.md C1-C4).
 *
 * The cheap regex in content-check.ts reads the raw bytes, so it cannot see
 * names inside compressed object streams. This parses the file with
 * pdf-lib (MIT; the same pinned version the view-only renderer uses),
 * which decompresses object streams and decodes #xx escapes in names
 * (/J#61vaScript is /JavaScript), then walks EVERY object it parsed -
 * including objects replaced by later incremental updates and objects no
 * page refers to - looking for active content:
 *
 *   JavaScript (OpenAction, AA on pages/annotations/fields, the Names
 *   JavaScript tree, /JS anywhere), Launch, GoToR/GoToE/ImportData/
 *   SubmitForm, embedded files and FileAttachment annotations, RichMedia,
 *   3D, multimedia, XFA forms, and URI actions to anything but http(s)/mailto.
 *
 * Anything it cannot parse is refused (fail closed). It runs only inside
 * the content-check worker (content-worker.ts), which has its own heap
 * limit and a deadline, so a hostile file cannot stall or exhaust the API.
 */
import { createRequire } from 'node:module';
import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFObject, PDFParser, PDFRef, PDFStream, PDFString,
} from 'pdf-lib';

export class PdfRejected extends Error {}

export const PDF_LIMITS = {
  /** Indirect objects (top level and inside object streams). */
  maxObjects: 200_000,
  /** Output of one decoded stream (object streams only are decoded). */
  maxStreamBytes: 32 * 1024 * 1024,
  /** Output of all decoded streams together. */
  maxDecodedTotal: 128 * 1024 * 1024,
  /** Nesting of arrays/dictionaries walked. */
  maxDepth: 200,
};

// --- resource limits inside pdf-lib --------------------------------------
// pdf-lib's stream decoders (a port of pdf.js's) grow their output buffer
// through DecodeStream.ensureBuffer. Capping it there stops a "zip bomb"
// object stream before the memory is allocated.
const require = createRequire(import.meta.url);
const { default: DecodeStream } = require('pdf-lib/cjs/core/streams/DecodeStream.js') as {
  default: { prototype: { ensureBuffer(requested: number): Uint8Array; buffer: Uint8Array } };
};
const { default: PDFContextClass } = require('pdf-lib/cjs/core/PDFContext.js') as {
  default: { prototype: { assign(ref: PDFRef, object: PDFObject): void } };
};

let decodedTotal = 0;
/** pdf-lib swallows errors thrown while parsing an object; remember ours. */
let limitHit: PdfRejected | null = null;
const overLimit = (why: string): never => { limitHit = new PdfRejected(why); throw limitHit; };
let collected: PDFObject[] | null = null;

const originalEnsure = DecodeStream.prototype.ensureBuffer;
DecodeStream.prototype.ensureBuffer = function ensureBuffer(this: { buffer: Uint8Array }, requested: number) {
  // Only while inspectPdf() runs: other pdf-lib users in this process
  // (e.g. download stamping) are left alone.
  if (!collected) return originalEnsure.call(this, requested);
  const before = this.buffer?.byteLength ?? 0;
  if (requested > PDF_LIMITS.maxStreamBytes) overLimit('The PDF has a compressed stream that expands beyond the limit');
  const out = originalEnsure.call(this, requested);
  decodedTotal += Math.max(0, out.byteLength - before);
  if (decodedTotal > PDF_LIMITS.maxDecodedTotal) overLimit('The PDF has compressed streams that expand beyond the limit');
  return out;
};

const originalAssign = PDFContextClass.prototype.assign;
PDFContextClass.prototype.assign = function assign(this: unknown, ref: PDFRef, object: PDFObject) {
  if (collected) {
    collected.push(object);
    if (collected.length > PDF_LIMITS.maxObjects) overLimit('The PDF has too many objects to check');
  }
  return originalAssign.call(this, ref, object);
};

// --- what is refused --------------------------------------------------------
const BAD_KEYS = new Set(['JS', 'JavaScript', 'XFA', 'EmbeddedFiles', 'EmbeddedFile', 'EF', 'RichMediaContent', 'RichMediaSettings', 'RichMediaExecute', '3DD']);
const BAD_ACTIONS = new Set([
  'JavaScript', 'Launch', 'GoToR', 'GoToE', 'ImportData', 'SubmitForm', 'RichMediaExecute', 'Rendition', 'Movie', 'Sound', 'GoTo3DView',
]);
const BAD_SUBTYPES = new Set(['FileAttachment', 'RichMedia', '3D', 'Movie', 'Sound', 'Screen']);
const BAD_TYPES = new Set(['EmbeddedFile', 'RichMediaContent', 'RichMediaSettings', '3D', 'Rendition', 'Filespec_EF']);
const SAFE_URI = /^(https?:\/\/|mailto:)/i;

/**
 * A name's text with every #xx escape decoded. pdf-lib decodes only
 * upper-case hex (#4A) when parsing; viewers accept #4a too, so decode
 * again, case-insensitively.
 */
const decodeName = (n: PDFName): string => n.decodeText().replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const nameOf = (o: PDFObject | undefined): string | undefined => (o instanceof PDFName ? decodeName(o) : undefined);

function describe(key: string): string {
  switch (key) {
    case 'JS': case 'JavaScript': return 'JavaScript';
    case 'XFA': return 'XFA forms';
    case 'Launch': return 'launch actions';
    case 'EmbeddedFiles': case 'EmbeddedFile': case 'EF': case 'FileAttachment': return 'embedded files';
    default: return `active content (${key})`;
  }
}

/**
 * What the sanitizer reports as removed for each finding (shown to the
 * uploader and written to the audit row). Stable strings: tests and the
 * web client match them.
 */
export const REMOVED = {
  javascript: 'JavaScript',
  openAction: 'OpenAction',
  aa: 'Automatic actions (AA)',
  launch: 'Launch action',
  remoteGoTo: 'Links to other files (GoToR/GoToE)',
  importData: 'ImportData action',
  submitForm: 'SubmitForm action',
  embeddedFiles: 'EmbeddedFiles',
  fileAttachment: 'FileAttachment annotation',
  multimedia: 'RichMedia/3D/multimedia',
  xfa: 'XFA form',
  acroForm: 'Form fields (AcroForm)',
  badUri: 'Non-web link (URI)',
} as const;

/** The REMOVED label for a key, action, type or subtype the strict walk refuses. */
export function removedLabel(what: string): string {
  switch (what) {
    case 'JS': case 'JavaScript': return REMOVED.javascript;
    case 'XFA': return REMOVED.xfa;
    case 'Launch': return REMOVED.launch;
    case 'GoToR': case 'GoToE': return REMOVED.remoteGoTo;
    case 'ImportData': return REMOVED.importData;
    case 'SubmitForm': return REMOVED.submitForm;
    case 'FileAttachment': return REMOVED.fileAttachment;
    case 'EmbeddedFiles': case 'EmbeddedFile': case 'EF': case 'Filespec_EF': return REMOVED.embeddedFiles;
    case 'URI': return REMOVED.badUri;
    default: return REMOVED.multimedia;
  }
}

/**
 * Where findings go. Strict (the default, and always for the sanitizer's
 * OUTPUT): the first one throws. Collect (the sanitizer's INPUT): each is
 * noted and the walk goes on; structural problems still throw.
 */
type Sink = ((what: string) => void) | null;

function refuse(what: string, sink: Sink): void {
  if (sink) { sink(what); return; }
  throw new PdfRejected(`PDFs containing ${describe(what)} are not accepted`);
}

function textOf(o: PDFObject | undefined): string | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  return undefined;
}

/** Checks one dictionary's own entries (not its children). */
function checkDict(d: PDFDict, sink: Sink): void {
  const own = new Map<string, PDFObject>();
  for (const [k, v] of d.entries()) own.set(decodeName(k), v);
  for (const [key, v] of own) {
    if (BAD_KEYS.has(key)) refuse(key, sink);
    // An embedded file stream can also be reached through /Type.
    if (key === 'Type' && BAD_TYPES.has(nameOf(v) ?? '')) refuse(nameOf(v)!, sink);
    if (key === 'Subtype' && BAD_SUBTYPES.has(nameOf(v) ?? '')) refuse(nameOf(v)!, sink);
    if (key === 'S' && BAD_ACTIONS.has(nameOf(v) ?? '')) refuse(nameOf(v)!, sink);
    // Collect mode only: things the rebuild always drops, worth telling the uploader about.
    if (sink && key === 'OpenAction') sink('OpenAction');
    if (sink && key === 'AA') sink('AA');
    if (sink && key === 'AcroForm') sink('AcroForm');
  }
  if (nameOf(own.get('S')) === 'URI') {
    const uri = textOf(own.get('URI'));
    if (uri !== undefined && !SAFE_URI.test(uri.trim())) {
      if (sink) sink('URI');
      else throw new PdfRejected('PDFs with links to local files or other non-web addresses are not accepted');
    }
  }
}

function walk(roots: PDFObject[], sink: Sink): void {
  // Iterative, with a visited set: no recursion for a deep or cyclic file
  // to exhaust. References are not followed: every indirect object is a
  // root already, so following them would only revisit.
  const seen = new Set<PDFObject>();
  const stack: [PDFObject, number][] = roots.map((r) => [r, 0]);
  while (stack.length) {
    const [o, depth] = stack.pop()!;
    if (seen.has(o)) continue;
    seen.add(o);
    if (depth > PDF_LIMITS.maxDepth) throw new PdfRejected('The PDF is nested too deeply to check');
    if (o instanceof PDFStream) {
      stack.push([o.dict, depth + 1]);
    } else if (o instanceof PDFDict) {
      checkDict(o, sink);
      for (const [, v] of o.entries()) if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFStream) stack.push([v, depth + 1]);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFStream) stack.push([v, depth + 1]);
    }
  }
}

/** Indirect object headers ("12 0 obj") anywhere in the raw bytes. */
function rawObjectHeaders(latin1: string): number {
  let n = 0;
  for (const _ of latin1.matchAll(/(?<![0-9])[0-9]{1,10}[\0\t\n\f\r ]+[0-9]{1,5}[\0\t\n\f\r ]+obj(?![A-Za-z0-9])/g)) n++;
  return n;
}

/**
 * Throws PdfRejected if the PDF cannot be parsed, is encrypted, hides
 * objects or goes over a limit. Active content also throws, unless
 * `activeContent` is given: then each kind found is added to it as a
 * REMOVED label and the file is otherwise accepted (the sanitizer's input,
 * pdf-sanitize.ts). `latin1` is the raw file as latin1 text (already
 * computed by the caller for the regex first pass).
 */
export async function inspectPdf(buf: Buffer, latin1: string, activeContent?: Set<string>): Promise<void> {
  const sink: Sink = activeContent ? (what) => {
    activeContent.add(what === 'OpenAction' ? REMOVED.openAction : what === 'AA' ? REMOVED.aa : what === 'AcroForm' ? REMOVED.acroForm : removedLabel(what));
  } : null;
  decodedTotal = 0;
  limitHit = null;
  collected = [];
  let topLevel = 0;
  const parser = PDFParser.forBytesWithOptions(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), Infinity, true, false);
  // Count objects parsed at the top level of the file (not inside object streams).
  const p = parser as unknown as { parseIndirectObject(): Promise<PDFRef> };
  const parseIndirect = p.parseIndirectObject.bind(parser);
  p.parseIndirectObject = async () => { topLevel++; return parseIndirect(); };

  let context: Awaited<ReturnType<PDFParser['parseDocument']>>;
  try {
    context = await parser.parseDocument();
  } catch (err) {
    collected = null;
    if (limitHit) throw limitHit;
    if (err instanceof PdfRejected) throw err;
    throw new PdfRejected('The PDF is damaged or malformed and cannot be checked');
  }
  const objects = collected;
  collected = null;
  if (limitHit) throw limitHit;

  // A viewer that finds an object by its xref offset, or rebuilds a broken
  // xref by scanning for "N G obj", can reach an object hidden inside
  // another object's stream data. pdf-lib reads the file in order and
  // skips stream data, so such an object would never be inspected. Every
  // header in the raw bytes must therefore be one pdf-lib parsed.
  if (rawObjectHeaders(latin1) !== topLevel) {
    throw new PdfRejected('The PDF has objects hidden inside other objects and cannot be checked');
  }

  if (context.trailerInfo.Encrypt) throw new PdfRejected('Encrypted PDFs cannot be checked; remove the password and upload again');
  const root = context.trailerInfo.Root ? context.lookup(context.trailerInfo.Root) : undefined;
  if (!(root instanceof PDFDict)) throw new PdfRejected('The PDF is damaged or malformed and cannot be checked');
  if (!(root.get(PDFName.of('Pages')) instanceof PDFRef) && !(root.get(PDFName.of('Pages')) instanceof PDFDict)) {
    throw new PdfRejected('The PDF is damaged or malformed and cannot be checked');
  }

  walk(objects, sink);
}
