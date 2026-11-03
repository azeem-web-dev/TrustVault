/**
 * Worker thread entry for PDF rasterisation (render-pool.ts starts it).
 * pdf.js canvas rendering blocks its thread until the page is fully drawn and
 * cannot be interrupted from inside; running it here lets the pool cap its heap
 * and terminate it on a deadline, so a drawing bomb costs one worker, never the
 * API event loop (THREATS.md C13).
 */
import { parentPort } from 'node:worker_threads';
import { countPdfPages, drawPdfPage } from './pdf-render.js';

interface Job { id: number; op: 'count' | 'page'; data: Uint8Array; page: number }

parentPort!.on('message', async (job: Job) => {
  try {
    const bytes = Buffer.from(job.data.buffer, job.data.byteOffset, job.data.byteLength);
    if (job.op === 'count') {
      parentPort!.postMessage({ id: job.id, ok: true, count: await countPdfPages(bytes) });
    } else {
      const png = new Uint8Array(await drawPdfPage(bytes, job.page));
      parentPort!.postMessage({ id: job.id, ok: true, png }, [png.buffer]);
    }
  } catch (err) {
    parentPort!.postMessage({ id: job.id, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
});
