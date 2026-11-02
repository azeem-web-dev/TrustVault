import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createUser, login, PDF, resetState, startApp, type TestApp } from './helpers.js';

// docs/VERIFY.md is a specification a customer can implement without our
// code. tools/independent-verify/verify.py was written from it alone. Here
// both it and tools/verify-audit.mjs check a bundle exported by the real API
// from a real database, plus tampered copies, and must give the same answer.

const NODE_VERIFIER = resolve(__dirname, '../../../tools/verify-audit.mjs');
const PY_VERIFIER = resolve(__dirname, '../../../tools/independent-verify/verify.py');
const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
  await resetState(t.app);
});
afterAll(async () => {
  await t.close();
});

function both(file: string, args: string[]): { node: number | null; python: number | null; out: string } {
  const n = spawnSync(process.execPath, [NODE_VERIFIER, file, ...args], { encoding: 'utf8' });
  const p = spawnSync(PYTHON, ['-I', PY_VERIFIER, file, ...args], { encoding: 'utf8' });
  if (p.error) throw new Error(`cannot run ${PYTHON}: ${p.error.message}`);
  return { node: n.status, python: p.status, out: `${n.stdout}${n.stderr}\n${p.stdout}${p.stderr}` };
}

describe('independent verifier (docs/VERIFY.md)', () => {
  it('agrees with the project verifier on a real exported bundle, valid and tampered', async () => {
    // Activity with the awkward cases: non-ASCII titles, NULL and JSON fields, refusals, several versions.
    const o = await createUser({ email: 'owner-iv@t.io', role: 'OWNER', displayName: 'Zoë Owner' });
    const v = await createUser({ email: 'viewer-iv@t.io', role: 'VIEWER' });
    const adm = await createUser({ email: 'admin-iv@t.io', role: 'ADMIN' });
    const [so, sv, sa] = await Promise.all([login(t, o), login(t, v), login(t, adm)]);
    const ids: string[] = [];
    for (const title of ['Board minutes — März', 'Contract «draft»', 'Plain report']) {
      const r = await as(t, so).upload('/api/documents', PDF, 'file.pdf', { title, category: 'Legal' });
      expect(r.status).toBe(201);
      ids.push(r.body.id as string);
    }
    await as(t, so).upload(`/api/documents/${ids[0]}/versions`, Buffer.concat([PDF, Buffer.from('% v2\n')]), 'file-v2.pdf').expect(201);
    const g = await as(t, so).put(`/api/documents/${ids[0]}/access`, { userId: v.id, level: 'READ' });
    await as(t, sv).get(`/api/documents/${ids[0]}/download`).expect(200);
    await as(t, sv).get(`/api/documents/${ids[1]}/download`).expect(404); // refused, audited
    await as(t, so).delete(`/api/documents/${ids[0]}/access/${g.body.id}`).expect(200);
    await as(t, sa).post('/api/admin/audit/checkpoint').expect(200);

    const res = await as(t, sa).get('/api/admin/audit/export?fromSeq=1').buffer(true);
    expect(res.status).toBe(200);
    const bundle = JSON.parse(res.text);
    const key = bundle.signingKey.publicKey as string;
    const dir = mkdtempSync(join(tmpdir(), 'tv-iv-'));
    const write = (name: string, b: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(b)); return f; };

    // The bundle as exported. Its last event(s) (the export itself) come after the newest
    // checkpoint; both verifiers accept that because it was exported within 5 minutes.
    const good = write('good.json', bundle);
    let r = both(good, ['--key', key]);
    expect(r.node, r.out).toBe(0);
    expect(r.python, r.out).toBe(0);

    r = both(good, []);
    expect([r.node, r.python], r.out).toEqual([2, 2]);

    const edited = structuredClone(bundle);
    const mid = edited.events[Math.floor(edited.events.length / 2)];
    mid.actor_email = 'someone-else@t.io';
    r = both(write('edited.json', edited), ['--key', key]);
    expect([r.node, r.python], r.out).toEqual([1, 1]);

    const details = structuredClone(bundle);
    const withDetails = details.events.find((e: { details: string | null }) => e.details && e.details.includes(': '));
    expect(withDetails).toBeTruthy();
    // Same JSON, different bytes (re-serialised without spaces): must fail. Verifiers hash the text, not the value.
    withDetails.details = JSON.stringify(JSON.parse(withDetails.details));
    r = both(write('reserialised.json', details), ['--key', key]);
    expect([r.node, r.python], r.out).toEqual([1, 1]);

    const removed = structuredClone(bundle);
    removed.events.splice(3, 1);
    r = both(write('removed.json', removed), ['--key', key]);
    expect([r.node, r.python], r.out).toEqual([1, 1]);

    const resigned = structuredClone(bundle);
    resigned.checkpoints.at(-1).signature = Buffer.alloc(64, 1).toString('base64');
    r = both(write('badsig.json', resigned), ['--key', key]);
    expect([r.node, r.python], r.out).toEqual([1, 1]);

    const otherKey = Buffer.alloc(32, 9).toString('base64');
    r = both(good, ['--key', otherKey]);
    expect([r.node, r.python], r.out).toEqual([1, 1]);
  });
});
