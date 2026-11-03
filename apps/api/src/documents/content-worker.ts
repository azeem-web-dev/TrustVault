/**
 * Worker thread entry for upload checks (content-inspector.ts starts it).
 * Parsing hostile files - and rebuilding PDFs (pdf-sanitize.ts) - happens
 * here, under the worker's own heap limit and the parent's deadline, never
 * on the thread that serves requests.
 */
import { parentPort } from 'node:worker_threads';
import { checkUpload, RejectedFile } from './content-check.js';

interface Job { id: number; data: Uint8Array; name: string; stall?: boolean }

parentPort!.on('message', async (job: Job) => {
  // Tests only (stallForTest): spin until the parent's deadline terminates us.
  if (job.stall) for (;;) { /* busy */ }
  try {
    const result = await checkUpload(Buffer.from(job.data.buffer, job.data.byteOffset, job.data.byteLength), job.name);
    const sanitized = result.sanitized ? { data: new Uint8Array(result.sanitized.data), removed: result.sanitized.removed } : undefined;
    parentPort!.postMessage({ id: job.id, ok: true, type: result.type, sanitized });
  } catch (err) {
    // Anything other than a deliberate refusal (a parser bug, a stack
    // overflow on a deeply nested file) is still a refusal: fail closed.
    const rejected = err instanceof RejectedFile;
    parentPort!.postMessage({
      id: job.id, ok: false,
      message: rejected ? err.message : 'The file could not be checked and was not accepted',
      code: rejected ? err.code : 'check_failed',
    });
  }
});
