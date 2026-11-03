/**
 * Runs PDF rasterisation (pdf-render.ts) in a small pool of worker threads,
 * each with a heap cap and a per-page deadline (THREATS.md C13). pdf.js canvas
 * rendering in Node runs to completion without yielding the event loop, so it
 * cannot be timed out from inside: a page that decodes to millions of drawing
 * operations - a few KB on disk - would otherwise freeze the whole API while it
 * is drawn. Here it costs one worker, which is terminated and replaced; the
 * request thread stays responsive for everyone else.
 *
 * Every failure mode refuses the page: deadline passed, worker out of memory,
 * worker crashed. Too many pages waiting is a 503, not an unbounded backlog.
 */
import { Worker } from 'node:worker_threads';
import { ServiceUnavailableException } from '@nestjs/common';

export const RENDER_LIMITS = {
  workers: Math.max(1, Number(process.env.RENDER_WORKERS ?? 2)),
  timeoutMs: Math.max(100, Number(process.env.RENDER_TIMEOUT_MS ?? 10_000)),
  maxQueue: 64,
  heapMb: 512,
};

export class RenderFailed extends Error {}

interface Pending {
  id: number;
  op: 'count' | 'page';
  data: Buffer;
  page: number;
  resolve: (v: number | Buffer) => void;
  reject: (e: Error) => void;
}

interface Slot { worker: Worker; job: Pending | null; timer: NodeJS.Timeout | null }

const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(FROM_SOURCE ? './render-worker.ts' : './render-worker.js', import.meta.url);

const slots: Slot[] = [];
const queue: Pending[] = [];
let nextId = 1;

function spawn(): Slot {
  const worker = new Worker(WORKER_URL, {
    execArgv: FROM_SOURCE ? ['--import', 'tsx'] : [],
    resourceLimits: { maxOldGenerationSizeMb: RENDER_LIMITS.heapMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
  });
  const slot: Slot = { worker, job: null, timer: null };
  worker.unref(); // an idle pool never keeps the process alive
  worker.on('message', (m: { id: number; ok: boolean; count?: number; png?: Uint8Array; message?: string }) => {
    const job = slot.job;
    if (!job || job.id !== m.id) return;
    finish(slot);
    if (m.ok) job.resolve(m.count !== undefined ? m.count : Buffer.from(m.png!.buffer, m.png!.byteOffset, m.png!.byteLength));
    else job.reject(new RenderFailed(m.message ?? 'The page could not be drawn'));
    pump();
  });
  const died = (why: string) => {
    const job = slot.job;
    retire(slot);
    job?.reject(new RenderFailed(why));
    pump();
  };
  worker.on('error', (err: Error & { code?: string }) => {
    died(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'The page needs too much memory to draw' : 'The page could not be drawn');
  });
  worker.on('exit', () => died('The page could not be drawn'));
  slots.push(slot);
  return slot;
}

function finish(slot: Slot): void {
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  slot.job = null;
  slot.worker.unref();
}

function retire(slot: Slot): void {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  slot.job = null;
  slot.worker.removeAllListeners('exit');
  void slot.worker.terminate();
}

function pump(): void {
  while (queue.length) {
    const slot = slots.find((s) => !s.job) ?? (slots.length < RENDER_LIMITS.workers ? spawn() : null);
    if (!slot) return;
    const job = queue.shift()!;
    slot.job = job;
    slot.worker.ref();
    slot.timer = setTimeout(() => {
      retire(slot);
      job.reject(new RenderFailed('The page took too long to draw'));
      pump();
    }, RENDER_LIMITS.timeoutMs);
    slot.worker.postMessage({ id: job.id, op: job.op, data: job.data, page: job.page });
  }
}

function enqueue(op: 'count' | 'page', data: Buffer, page: number): Promise<number | Buffer> {
  if (queue.length >= RENDER_LIMITS.maxQueue) {
    return Promise.reject(new ServiceUnavailableException('Too many pages are being drawn. Try again in a moment.'));
  }
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, op, data, page, resolve, reject });
    pump();
  });
}

/** Number of pages, drawn off-thread under a deadline. */
export async function renderCountPdf(bytes: Buffer): Promise<number> {
  return (await enqueue('count', bytes, 0)) as number;
}

/** One page as a PNG, drawn off-thread under a deadline. */
export async function renderPdfPage(bytes: Buffer, n: number): Promise<Buffer> {
  return (await enqueue('page', bytes, n)) as Buffer;
}

/** For tests: stop every render worker. */
export function stopRenderPool(): void {
  for (const s of [...slots]) retire(s);
}
