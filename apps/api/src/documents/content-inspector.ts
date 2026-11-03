/**
 * Runs upload checks (content-check.ts) in a small pool of worker threads,
 * each with a heap cap and a per-file deadline (THREATS.md C5). A file that
 * makes the parser loop, recurse or allocate without end costs one worker,
 * which is terminated and replaced; the API thread never parses it.
 *
 * Every failure mode refuses the file: deadline passed, worker out of
 * memory, worker crashed. Too many files waiting is a 503, not an accept.
 * PDF sanitization (pdf-sanitize.ts) runs in the same job, so the rebuild
 * and the re-inspection of its output count against the same deadline
 * and heap cap as the check itself.
 */
import { Worker } from 'node:worker_threads';
import { ServiceUnavailableException } from '@nestjs/common';
import { RejectedFile, type CheckResult, type RefusalCode } from './content-check.js';

export const INSPECTOR_LIMITS = {
  workers: Math.max(1, Number(process.env.CONTENT_CHECK_WORKERS ?? 2)),
  timeoutMs: Math.max(100, Number(process.env.CONTENT_CHECK_TIMEOUT_MS ?? 15_000)),
  maxQueue: 32,
  heapMb: 512,
};

interface Pending {
  id: number;
  data: Buffer;
  name: string;
  /** Tests only (stallForTest): the worker spins instead of checking. */
  stall?: boolean;
  resolve: (t: CheckResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  job: Pending | null;
  timer: NodeJS.Timeout | null;
}

// From source (tests, `npm run dev`) the worker is TypeScript and needs the
// tsx loader; from the build it is plain JavaScript.
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(FROM_SOURCE ? './content-worker.ts' : './content-worker.js', import.meta.url);

const slots: Slot[] = [];
const queue: Pending[] = [];
let nextId = 1;

function spawn(): Slot {
  const worker = new Worker(WORKER_URL, {
    execArgv: FROM_SOURCE ? ['--import', 'tsx'] : [],
    resourceLimits: { maxOldGenerationSizeMb: INSPECTOR_LIMITS.heapMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
  });
  const slot: Slot = { worker, job: null, timer: null };
  worker.unref(); // an idle pool never keeps the process alive
  worker.on('message', (m: { id: number; ok: boolean; type?: CheckResult['type']; sanitized?: { data: Uint8Array; removed: string[] }; message?: string; code?: RefusalCode }) => {
    const job = slot.job;
    if (!job || job.id !== m.id) return;
    finish(slot);
    if (m.ok) {
      const sanitized = m.sanitized ? { data: Buffer.from(m.sanitized.data.buffer, m.sanitized.data.byteOffset, m.sanitized.data.byteLength), removed: m.sanitized.removed } : undefined;
      job.resolve({ type: m.type!, ...(sanitized ? { sanitized } : {}) });
    } else job.reject(new RejectedFile(m.message ?? 'The file could not be checked and was not accepted', m.code ?? 'check_failed'));
    pump();
  });
  const died = (why: string) => {
    const job = slot.job;
    retire(slot);
    job?.reject(new RejectedFile(why, 'check_failed'));
    pump();
  };
  worker.on('error', (err: Error & { code?: string }) => {
    died(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'The file needs too much memory to check and was not accepted' : 'The file could not be checked and was not accepted');
  });
  worker.on('exit', () => died('The file could not be checked and was not accepted'));
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
    const slot = slots.find((s) => !s.job) ?? (slots.length < INSPECTOR_LIMITS.workers ? spawn() : null);
    if (!slot) return;
    const job = queue.shift()!;
    slot.job = job;
    slot.worker.ref(); // keep the process up while a check is running
    slot.timer = setTimeout(() => {
      retire(slot);
      job.reject(new RejectedFile('The file took too long to check and was not accepted', 'check_failed'));
      pump();
    }, INSPECTOR_LIMITS.timeoutMs);
    slot.worker.postMessage({ id: job.id, data: job.data, name: job.name, stall: job.stall === true });
  }
}

/**
 * Checks an upload in a worker. Resolves with the type and, for a PDF, the
 * rebuilt bytes to store. Rejects with RejectedFile (refuse) or 503 (overloaded).
 */
export function inspectUpload(data: Buffer, name: string): Promise<CheckResult> {
  if (queue.length >= INSPECTOR_LIMITS.maxQueue) {
    return Promise.reject(new ServiceUnavailableException('Too many files are being checked. Try again in a moment.'));
  }
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, data, name, resolve, reject });
    pump();
  });
}

/**
 * For tests: a job whose worker busy-loops forever, so the deadline path
 * (terminate, refuse, replace the worker) is exercised deterministically
 * whatever the machine load. Not reachable through inspectUpload().
 */
export function stallForTest(): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, data: Buffer.alloc(0), name: 'stall', stall: true, resolve, reject });
    pump();
  });
}

/** For tests: stop every worker. */
export async function stopInspector(): Promise<void> {
  for (const s of [...slots]) retire(s);
}
