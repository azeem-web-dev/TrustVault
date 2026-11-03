/**
 * PDF sanitization (THREATS.md C9-C11). Every accepted PDF is rebuilt: the
 * stored file is always one this module generated, never the bytes the
 * uploader sent.
 *
 * The rebuild is a fresh pdf-lib document into which every page of the
 * upload is copied. Only what a page needs to be drawn comes across -
 * content streams, fonts, images, page size, rotation, crop boxes - plus
 * annotations that cannot run anything. The new catalog has no
 * OpenAction, Names (JavaScript, EmbeddedFiles), AcroForm/XFA, AA or
 * outlines, because nothing is ever copied into it. On the copied pages:
 *
 *   - /AA (automatic actions) is deleted from the page and every annotation;
 *   - FileAttachment, RichMedia, 3D, Movie, Sound and Screen annotations are dropped;
 *   - Link annotations are kept only if their action is a GoTo inside the
 *     document or a URI to http(s)/mailto; others are dropped;
 *   - widget (form field) annotations keep their appearance but lose /A,
 *     /AA and /Parent: the form is gone (AcroForm is never copied), the
 *     filled-in look stays, nothing is interactive (no flattening into
 *     the content stream);
 *   - every other annotation loses /A and /AA; /P back-pointers are removed
 *     so the copier cannot drag the whole original page tree along.
 *
 * Then a scrub walks every object of the new document and deletes the same
 * keys wherever they survived, and action chains (/Next).
 *
 * The result is NOT trusted because of the above. content-check.ts runs
 * the complete strict check on it - the raw-byte regexes, the %%EOF and
 * polyglot checks, the structural walk with hidden-object detection - plus
 * assertRebuilt() below and an equal page count. Any failure refuses the
 * upload (fail closed); the original is never stored.
 *
 * Runs only in the content-check worker (heap cap, same deadline as the
 * check itself), as the unprivileged API user; no external tools.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObject, PDFRef, PDFStream, PDFString,
} from 'pdf-lib';
import { REMOVED } from './pdf-inspect.js';

export class SanitizeFailed extends Error {}

const DROP_SUBTYPES = new Set(['FileAttachment', 'RichMedia', '3D', 'Movie', 'Sound', 'Screen']);
/** Deleted wherever they appear in the rebuilt document. */
const SCRUB_KEYS = ['AA', 'OpenAction', 'JS', 'JavaScript', 'XFA', 'AcroForm', 'EmbeddedFiles', 'EmbeddedFile', 'EF', 'RichMediaContent', 'RichMediaSettings', 'RichMediaExecute', '3DD', 'Next'];
/** Must not appear anywhere in the output at all (checked after the scrub). */
const NEVER_IN_OUTPUT = new Set([...SCRUB_KEYS, 'Names', 'Outlines']);
const SAFE_URI = /^(https?:\/\/|mailto:)/i;

const N = (s: string) => PDFName.of(s);
const decodeName = (n: PDFName): string => n.decodeText().replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const nameOf = (o: PDFObject | undefined): string | undefined => (o instanceof PDFName ? decodeName(o) : undefined);
const textOf = (o: PDFObject | undefined): string | undefined => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined);

/** A simple metadata string worth keeping: short, printable, single line. */
const simple = (s: string | undefined): string | undefined => (s && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s) ? s : undefined);

export interface Sanitized {
  data: Buffer;
  /** REMOVED labels for what the rebuild left out (in addition to what the inspector found). */
  removed: Set<string>;
  pages: number;
}

/** A Link is kept only for an internal GoTo or a web/mail URI, and never with an action chain. */
function safeLinkAction(doc: PDFDocument, annot: PDFDict): boolean {
  const a = doc.context.lookup(annot.get(N('A')));
  if (a === undefined) return true; // /Dest only: an internal destination
  if (!(a instanceof PDFDict)) return false;
  const s = nameOf(a.get(N('S')));
  if (s === 'GoTo') return true;
  if (s === 'URI') {
    const uri = textOf(doc.context.lookup(a.get(N('URI'))));
    return uri !== undefined && SAFE_URI.test(uri.trim());
  }
  return false;
}

/** Cleans the SOURCE page in place before it is copied, so nothing unsafe is reachable from it. */
function cleanPage(src: PDFDocument, page: PDFDict, removed: Set<string>): void {
  if (page.has(N('AA'))) { page.delete(N('AA')); removed.add(REMOVED.aa); }
  const annotsObj = src.context.lookup(page.get(N('Annots')));
  if (annotsObj === undefined) return;
  if (!(annotsObj instanceof PDFArray)) { page.delete(N('Annots')); return; }
  const kept: PDFObject[] = [];
  for (const entry of annotsObj.asArray()) {
    const annot = src.context.lookup(entry);
    if (!(annot instanceof PDFDict)) continue;
    const subtype = nameOf(annot.get(N('Subtype')));
    if (subtype && DROP_SUBTYPES.has(subtype)) {
      removed.add(subtype === 'FileAttachment' ? REMOVED.fileAttachment : REMOVED.multimedia);
      continue;
    }
    if (subtype === 'Link' && !safeLinkAction(src, annot)) continue; // the inspector already named what it was
    if (annot.has(N('AA'))) { annot.delete(N('AA')); removed.add(REMOVED.aa); }
    if (subtype !== 'Link') annot.delete(N('A'));
    if (subtype === 'Widget') annot.delete(N('Parent'));
    annot.delete(N('P'));
    kept.push(entry);
  }
  if (kept.length) page.set(N('Annots'), src.context.obj(kept));
  else page.delete(N('Annots'));
}

/** Deletes SCRUB_KEYS from every dictionary of the new document (iterative, cycle-safe). */
function scrub(out: PDFDocument): void {
  const seen = new Set<PDFObject>();
  const stack: PDFObject[] = out.context.enumerateIndirectObjects().map(([, o]) => o);
  while (stack.length) {
    const o = stack.pop()!;
    if (seen.has(o)) continue;
    seen.add(o);
    const dict = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (dict) {
      for (const [k] of dict.entries()) if (SCRUB_KEYS.includes(decodeName(k))) dict.delete(k);
      for (const [, v] of dict.entries()) if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFStream) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFStream) stack.push(v);
    }
  }
}

/**
 * The output must look like something this module wrote: none of the
 * NEVER_IN_OUTPUT keys anywhere, no indirect reference to an object that
 * does not exist. Run on a fresh parse of the saved bytes.
 */
export async function assertRebuilt(data: Buffer): Promise<number> {
  const doc = await PDFDocument.load(data, { updateMetadata: false, throwOnInvalidObject: true });
  const seen = new Set<PDFObject>();
  const stack: PDFObject[] = doc.context.enumerateIndirectObjects().map(([, o]) => o);
  stack.push(doc.context.trailerInfo.Root!);
  while (stack.length) {
    const o = stack.pop()!;
    if (seen.has(o)) continue;
    seen.add(o);
    if (o instanceof PDFRef) {
      if (doc.context.lookup(o) === undefined) throw new SanitizeFailed('dangling reference in the rebuilt PDF');
      continue;
    }
    const dict = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    const children = dict ? dict.entries().map(([k, v]) => {
      if (NEVER_IN_OUTPUT.has(decodeName(k))) throw new SanitizeFailed(`/${decodeName(k)} survived the rebuild`);
      return v;
    }) : o instanceof PDFArray ? o.asArray() : [];
    for (const v of children) if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFStream || v instanceof PDFRef) stack.push(v);
  }
  return doc.getPageCount();
}

/**
 * Rebuilds `input` (which has already passed inspectPdf in collect mode:
 * parseable, unencrypted, no hidden objects, within limits). Throws
 * SanitizeFailed or any pdf-lib error; the caller refuses the upload.
 */
export async function rebuildPdf(input: Buffer): Promise<Sanitized> {
  const removed = new Set<string>();
  const src = await PDFDocument.load(input, { updateMetadata: false, throwOnInvalidObject: true });
  const count = src.getPageCount();
  for (const page of src.getPages()) cleanPage(src, page.node, removed);

  const out = await PDFDocument.create({ updateMetadata: true });
  const copied = await out.copyPages(src, src.getPageIndices());
  for (const p of copied) out.addPage(p);

  // Simple document information only; the original Info dictionary and
  // XMP metadata stream are not copied.
  const meta = (get: () => string | undefined) => { try { return simple(get()); } catch { return undefined; } };
  const title = meta(() => src.getTitle());
  const author = meta(() => src.getAuthor());
  if (title) out.setTitle(title);
  if (author) out.setAuthor(author);
  out.setProducer('TrustVault PDF sanitizer (pdf-lib)');
  out.setCreator('TrustVault');

  scrub(out);
  const data = Buffer.from(await out.save({ useObjectStreams: true, addDefaultPage: false }));
  if (out.getPageCount() !== count) throw new SanitizeFailed('page count changed');
  return { data, removed, pages: count };
}
