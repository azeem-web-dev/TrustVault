/**
 * Worker thread entry for upload checks (content-inspector.ts starts it).
 * Parsing hostile files happens here, under the worker's own heap limit
 * and the parent's deadline, never on the thread that serves requests.
 */
import { parentPort } from 'node:worker_threads';
import { detectType, RejectedFile } from './content-check.js';

interface Job { id: number; data: Uint8Array; name: string }

parentPort!.on('message', async (job: Job) => {
  try {
    const type = await detectType(Buffer.from(job.data.buffer, job.data.byteOffset, job.data.byteLength), job.name);
    parentPort!.postMessage({ id: job.id, ok: true, type });
  } catch (err) {
    // Anything other than a deliberate refusal (a parser bug, a stack
    // overflow on a deeply nested file) is still a refusal: fail closed.
    const rejected = err instanceof RejectedFile;
    parentPort!.postMessage({ id: job.id, ok: false, message: rejected ? err.message : 'The file could not be checked and was not accepted' });
  }
});
