import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createCanvas, GlobalFonts, loadImage, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

/**
 * Page images for view-only access, and stamps on downloaded copies
 * (THREATS.md V2-V5, V8).
 *
 * Files are drawn here, on the server, into plain PNG images; the original
 * bytes never leave. PDFs are drawn by pdf.js (Apache-2.0) onto Skia
 * (@napi-rs/canvas, MIT): prebuilt binaries, no system packages, and the
 * font comes from pdf.js's own Liberation Sans, so a bare Ubuntu server
 * draws the same watermark as a laptop. Word, Excel and PowerPoint files
 * are not drawn: that would need LibreOffice on the server.
 */

const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'));
const FONTS_DIR = join(PDFJS_DIR, 'standard_fonts') + '/';
const MARK_FONT = 'TrustVaultMark';
GlobalFonts.registerFromPath(join(FONTS_DIR, 'LiberationSans-Regular.ttf'), MARK_FONT);

/** Width of a drawn page in pixels (about 150 dpi for A4). */
const PAGE_WIDTH = 1240;
/** Hard cap on one page's pixels, whatever shape the page claims to be. */
const MAX_PIXELS = 1240 * 4000;
/** Pages beyond this are not shown. */
export const MAX_PAGES = 500;
const TEXT_LINES_PER_PAGE = 60;
const TEXT_COLS = 100;

export type PageKind = 'pdf' | 'image' | 'text';

export function pageKind(mime: string): PageKind | null {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png' || mime === 'image/jpeg') return 'image';
  if (mime.startsWith('text/')) return 'text';
  return null; // Word, Excel, PowerPoint: no preview (see THREATS.md V2)
}

/** A short code printed on every page and stored in its audit row. Crockford base32, 40 bits. */
export function traceCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let n = BigInt('0x' + randomBytes(5).toString('hex'));
  let out = '';
  for (let i = 0; i < 8; i++) { out = alphabet[Number(n & 31n)]! + out; n >>= 5n; }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

// ------------------------------------------------------------------ limits

// Drawing is CPU work on the API process. At most two at a time; the rest wait.
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// ------------------------------------------------------------------ cache

/**
 * Drawn pages WITHOUT watermark, in this process's memory only, for five
 * minutes, so paging through a document does not re-draw it each time.
 * Keyed by version id (a version never changes). Every request still goes
 * through the access check and the audit row before the cache is read, so
 * a revoked person gets nothing from it (THREATS.md V2).
 */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, { png: Buffer; at: number }>();
let cacheBytes = 0;

function cacheGet(key: string): Buffer | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); cacheBytes -= hit.png.length; return null; }
  return hit.png;
}

function cachePut(key: string, png: Buffer) {
  if (png.length > CACHE_MAX_BYTES / 4) return;
  const old = cache.get(key);
  if (old) { cache.delete(key); cacheBytes -= old.png.length; }
  cache.set(key, { png, at: Date.now() });
  cacheBytes += png.length;
  for (const [k, v] of cache) {           // oldest first
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(k); cacheBytes -= v.png.length;
  }
}

// ------------------------------------------------------------------ drawing

async function openPdf(bytes: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // getDocument() never runs a PDF's scripts; no XFA forms, no system
  // fonts, everything read from pdf.js's own folder (THREATS.md V8).
  const task = getDocument({
    data: new Uint8Array(bytes), enableXfa: false, disableFontFace: true, useSystemFonts: false,
    standardFontDataUrl: FONTS_DIR, cMapUrl: join(PDFJS_DIR, 'cmaps') + '/', cMapPacked: true,
    wasmUrl: join(PDFJS_DIR, 'wasm') + '/', stopAtErrors: false, verbosity: 0,
  });
  return { task, doc: await task.promise };
}

function textPages(bytes: Buffer): string[][] {
  const lines: string[] = [];
  for (const raw of bytes.toString('utf8').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, '    ');
    if (line.length === 0) lines.push('');
    for (let i = 0; i < line.length; i += TEXT_COLS) lines.push(line.slice(i, i + TEXT_COLS));
  }
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += TEXT_LINES_PER_PAGE) pages.push(lines.slice(i, i + TEXT_LINES_PER_PAGE));
  return pages.length ? pages : [['']];
}

/** Number of pages that can be shown. */
export async function countPages(versionId: string, kind: PageKind, bytes: Buffer): Promise<number> {
  const key = `${versionId}:count`;
  const hit = cacheGet(key);
  if (hit) return hit.readUInt32BE(0);
  let n = 1;
  if (kind === 'text') n = textPages(bytes).length;
  if (kind === 'pdf') {
    n = await slot(async () => {
      const { task, doc } = await openPdf(bytes);
      try { return doc.numPages; } finally { await task.destroy(); }
    });
  }
  n = Math.min(n, MAX_PAGES);
  const b = Buffer.alloc(4); b.writeUInt32BE(n);
  cachePut(key, b);
  return n;
}

/** Page `n` (1-based) as a PNG, without watermark. */
export async function drawPage(versionId: string, kind: PageKind, bytes: Buffer, n: number): Promise<Buffer> {
  const key = `${versionId}:${n}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const png = await slot(async () => {
    if (kind === 'pdf') return drawPdfPage(bytes, n);
    if (kind === 'image') return drawImage(bytes);
    return drawText(textPages(bytes)[n - 1] ?? []);
  });
  cachePut(key, png);
  return png;
}

function fit(w: number, h: number): number {
  let scale = PAGE_WIDTH / w;
  if (w * scale * h * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (w * h));
  return scale;
}

async function drawPdfPage(bytes: Buffer, n: number): Promise<Buffer> {
  const { task, doc } = await openPdf(bytes);
  try {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: fit(base.width, base.height) });
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise;
    return canvas.encode('png');
  } finally {
    await task.destroy();
  }
}

async function drawImage(bytes: Buffer): Promise<Buffer> {
  const img = await loadImage(bytes);
  const scale = Math.min(1, fit(img.width, img.height));
  const canvas = createCanvas(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.encode('png');
}

async function drawText(lines: string[]): Promise<Buffer> {
  const canvas = createCanvas(PAGE_WIDTH, Math.round(PAGE_WIDTH * 1.414));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  ctx.font = `20px ${MARK_FONT}`;
  lines.forEach((line, i) => ctx.fillText(line, 60, 80 + i * 28));
  return canvas.encode('png');
}

// ------------------------------------------------------------------ marks

export interface Mark {
  email: string;
  at: Date;
  trace: string;
}

export const markText = (m: Mark, verb = 'Viewed by'): string =>
  `${verb} ${m.email} · ${m.at.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${m.trace}`;

/** Faint diagonal text tiled over the whole picture, plus a plain footer line. */
function tile(canvas: Canvas, ctx: SKRSContext2D, text: string) {
  const size = Math.max(14, Math.round(canvas.width / 55));
  ctx.save();
  ctx.font = `${size}px ${MARK_FONT}`;
  ctx.fillStyle = 'rgba(40, 40, 60, 0.16)';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-Math.PI / 6);
  const step = ctx.measureText(text).width + size * 3;
  const reach = Math.hypot(canvas.width, canvas.height);
  for (let y = -reach / 2, row = 0; y < reach / 2; y += size * 6, row++) {
    for (let x = -reach / 2 - (row % 2) * step / 2; x < reach / 2; x += step) ctx.fillText(text, x, y);
  }
  ctx.restore();
  ctx.save();
  ctx.font = `${Math.max(11, Math.round(size * 0.7))}px ${MARK_FONT}`;
  ctx.fillStyle = 'rgba(40, 40, 60, 0.55)';
  ctx.fillText(text, 12, canvas.height - 10);
  ctx.restore();
}

/** A drawn page with the viewer's watermark. */
export async function watermark(png: Buffer, m: Mark): Promise<Buffer> {
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  tile(canvas, ctx, markText(m));
  return canvas.encode('png');
}

/**
 * A downloaded copy carries who, when and a trace code: PDFs on every page
 * (footer and a faint diagonal line), PNG and JPEG images drawn over.
 * Other types are sent unchanged (THREATS.md V5). Returns null when the
 * file is sent as it is.
 */
export async function stampDownload(bytes: Buffer, mime: string, m: Mark): Promise<Buffer | null> {
  const kind = pageKind(mime);
  const text = markText(m, 'Downloaded by');
  if (kind === 'pdf') {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = pdf.getPages();
    if (pages.length === 0) return null;
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const safe = text.replace(/·/g, '-').replace(/[^\x20-\x7e]/g, '?'); // standard fonts are WinAnsi only
    for (const page of pages) {
      const { width, height } = page.getSize();
      page.drawText(safe, { x: 18, y: 10, size: 7, font, color: rgb(0.3, 0.3, 0.35), opacity: 0.8 });
      page.drawText(safe, { x: width * 0.12, y: height * 0.3, size: Math.max(8, width / 60), font, color: rgb(0.3, 0.3, 0.4), opacity: 0.12, rotate: degrees(30) });
    }
    return Buffer.from(await pdf.save());
  }
  if (kind === 'image') {
    return slot(async () => {
      const img = await loadImage(bytes);
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      tile(canvas, ctx, text);
      return mime === 'image/png' ? canvas.encode('png') : canvas.encode('jpeg', 92);
    });
  }
  return null;
}
