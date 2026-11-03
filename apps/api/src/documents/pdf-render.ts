/**
 * PDF rasterisation with pdf.js + Skia. This is the ONLY CPU-heavy, native,
 * non-yielding step in the view/preview path: pdf.js canvas rendering in Node
 * runs to completion without releasing the event loop, so a page whose content
 * stream decodes to millions of drawing operations (a few KB on disk) freezes
 * the whole API for as long as it takes to draw - it cannot be interrupted by a
 * timer in the same thread (THREATS.md C13).
 *
 * So this module is loaded only inside the render worker (render-worker.ts),
 * which the pool (render-pool.ts) runs with a heap cap and terminates on a
 * wall-clock deadline. Nothing here runs on the request thread.
 */
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';

const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'));
const FONTS_DIR = join(PDFJS_DIR, 'standard_fonts') + '/';

/** Width of a drawn page in pixels (about 150 dpi for A4). */
export const PAGE_WIDTH = 1240;
/** Hard cap on one page's pixels, whatever shape the page claims to be. */
export const MAX_PIXELS = 1240 * 4000;
/** Largest embedded image pdf.js will decode (an image bomb inside a PDF). */
const MAX_IMAGE_PIXELS = 40_000_000;

export function fit(w: number, h: number): number {
  let scale = PAGE_WIDTH / w;
  if (w * scale * h * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (w * h));
  return scale;
}

async function openPdf(bytes: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // getDocument() never runs a PDF's scripts; no XFA forms, no system
  // fonts, everything read from pdf.js's own folder (THREATS.md V8).
  // maxImageSize bounds a tiny-file/huge-image XObject decode bomb.
  const task = getDocument({
    data: new Uint8Array(bytes), enableXfa: false, disableFontFace: true, useSystemFonts: false,
    standardFontDataUrl: FONTS_DIR, cMapUrl: join(PDFJS_DIR, 'cmaps') + '/', cMapPacked: true,
    wasmUrl: join(PDFJS_DIR, 'wasm') + '/', stopAtErrors: false, verbosity: 0, maxImageSize: MAX_IMAGE_PIXELS,
  });
  return { task, doc: await task.promise };
}

/** Number of pages pdf.js reports. */
export async function countPdfPages(bytes: Buffer): Promise<number> {
  const { task, doc } = await openPdf(bytes);
  try { return doc.numPages; } finally { await task.destroy(); }
}

/** Page `n` (1-based) as a PNG, without watermark. */
export async function drawPdfPage(bytes: Buffer, n: number): Promise<Buffer> {
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
