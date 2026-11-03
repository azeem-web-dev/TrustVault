import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { countPages, drawPage } from '../src/documents/pages.js';
import { RENDER_LIMITS, stopRenderPool } from '../src/documents/render-pool.js';

// THREATS.md C13 (DoS): pdf.js canvas rendering in Node runs to completion
// without yielding the event loop and cannot be interrupted from inside. A page
// whose content stream decodes to millions of trivial drawing operations is a
// few KB on disk but takes minutes to draw. It must be drawn off-thread under a
// wall-clock deadline, so the request thread stays responsive for everyone else.

afterAll(() => stopRenderPool());

/** A one-page PDF whose content stream is `ops` trivial path operations. */
async function opBomb(ops: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const stream = doc.context.flateStream('1 0 0 RG 0 0 m 612 792 l S\n'.repeat(ops));
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function normalPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawText('A perfectly ordinary document.', { x: 50, y: 700, size: 14 });
  return Buffer.from(await doc.save());
}

describe('PDF render DoS (off-thread, deadline)', () => {
  it('draws and counts an ordinary PDF correctly', async () => {
    const pdf = await normalPdf();
    expect(await countPages('ok-count', 'pdf', pdf)).toBe(1);
    const png = await drawPage('ok-draw', 'pdf', pdf, 1);
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  }, 30_000);

  it('refuses a drawing bomb at the deadline instead of freezing the event loop', async () => {
    const bomb = await opBomb(2_000_000); // would take ~500s to draw in-thread
    expect(bomb.length).toBeLessThan(200_000); // tiny on disk

    const saved = RENDER_LIMITS.timeoutMs;
    RENDER_LIMITS.timeoutMs = 1500; // keep the test fast; the worker is already warm
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 50); // only advances if the event loop is free
    const started = Date.now();
    try {
      await expect(drawPage('bomb-v', 'pdf', bomb, 1)).rejects.toThrow(/took too long to draw/);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(6000); // bounded by the deadline, NOT minutes
      // The event loop kept running while the worker was busy drawing.
      expect(ticks).toBeGreaterThan(5);
    } finally {
      clearInterval(iv);
      RENDER_LIMITS.timeoutMs = saved;
    }
  }, 30_000);
});
