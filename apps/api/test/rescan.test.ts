import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appDb, as, auditRows, createUser, login, ownerDb, resetState, startApp, withDb, type Session, type TestApp } from './helpers.js';
import { RescanService } from '../src/scanning/rescan.service.js';
import { AuditAdminService } from '../src/audit/audit-admin.service.js';

// The nightly re-scan: files stored clean are scanned again with newer
// signatures, and a version found infected is quarantined.

let t: TestApp;
let rescan: RescanService;
let alice: Session;
let aliceId: string;

beforeAll(async () => {
  t = await startApp();
  await resetState(t.app);
  rescan = t.app.get(RescanService);
  const a = await createUser({ email: `rescan-${Date.now()}@t.io`, role: 'OWNER' });
  aliceId = a.id;
  alice = await login(t, a);
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.clamd.mode = 'normal';
  t.clamd.signatures.clear();
});

/** A text file with a unique marker a later "signature update" can match. */
async function upload(title: string): Promise<{ id: string; marker: string }> {
  const marker = `new-threat-${randomBytes(8).toString('hex')}`;
  const res = await as(t, alice).upload('/api/documents', Buffer.from(`quarterly notes\n${marker}\n`), 'notes.txt', { title, category: 'Rescan' }).expect(201);
  return { id: res.body.id, marker };
}

/** Runs passes until one finishes (an earlier test run may have left a pass half done). */
async function fullPass() {
  for (let i = 0; i < 5; i++) {
    const r = await rescan.run();
    if (r.done) return r;
  }
  throw new Error('rescan never finished');
}

describe('nightly malware re-scan', () => {
  it('finds a virus that had no signature at upload time, and quarantines only that version', async () => {
    const bad = await upload('Looks harmless');
    const good = await upload('Really harmless');
    // Stored, because nothing knew this threat yet.
    await as(t, alice).get(`/api/documents/${bad.id}/download`).expect(200);

    t.clamd.signatures.set(bad.marker, 'Win.Trojan.NewThing-1'); // ClamAV's next update
    const r = await fullPass();
    expect(r.infected).toBeGreaterThanOrEqual(1);
    expect(r.signatures).toMatch(/^ClamAV 1\.4\.3\/\d+/);

    const res = await as(t, alice).get(`/api/documents/${bad.id}/download`).expect(403);
    expect(res.body.message).toMatch(/quarantined.*Win\.Trojan\.NewThing-1/);
    await as(t, alice).get(`/api/documents/${bad.id}/versions/1/download`).expect(403);
    await as(t, alice).get(`/api/documents/${good.id}/download`).expect(200);

    const doc = (await as(t, alice).get(`/api/documents/${bad.id}`).expect(200)).body;
    expect(doc.versions[0].quarantine).toMatchObject({ signature: 'Win.Trojan.NewThing-1' });

    const found = await auditRows(`action = 'document.quarantine' AND document_id = $1`, [bad.id]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ actor_email: 'system', reason: 'malware_detected' });
    const refused = await auditRows(`action = 'document.download' AND reason = 'quarantined' AND document_id = $1`, [bad.id]);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.actor_id).toBe(aliceId);

    const alerts = await t.app.get(AuditAdminService).alerts(1);
    expect(alerts.alerts.some((a) => a.kind === 'malware_found' && 'documentId' in a && a.documentId === bad.id)).toBe(true);
  });

  it('does not quarantine or audit the same version twice', async () => {
    const bad = await upload('Twice');
    t.clamd.signatures.set(bad.marker, 'Win.Trojan.Twice-1');
    await fullPass();
    const again = await fullPass();
    expect(again.alreadyQuarantined).toBeGreaterThanOrEqual(1);
    expect(await auditRows(`action = 'document.quarantine' AND document_id = $1`, [bad.id])).toHaveLength(1);
  });

  it('a new version uploaded clean is downloadable even though an older one is quarantined', async () => {
    const bad = await upload('Fixed later');
    t.clamd.signatures.set(bad.marker, 'Win.Trojan.Old-1');
    await fullPass();
    await as(t, alice).upload(`/api/documents/${bad.id}/versions`, Buffer.from('clean replacement\n'), 'notes.txt').expect(201);
    await as(t, alice).get(`/api/documents/${bad.id}/download`).expect(200); // v2
    await as(t, alice).get(`/api/documents/${bad.id}/versions/1/download`).expect(403);
  });

  it('stops when the scanner is down, assumes nothing is clean, raises an alert, then resumes', async () => {
    const bad = await upload('While down');
    t.clamd.signatures.set(bad.marker, 'Win.Trojan.Down-1');
    t.clamd.mode = 'down';
    const r = await rescan.run();
    expect(r).toMatchObject({ done: false, stoppedBecause: 'malware_scanner_unavailable', infected: 0 });
    const [summary] = (await auditRows(`action = 'malware.rescan'`)).slice(-1);
    expect(summary).toMatchObject({ outcome: 'FAILED', reason: 'malware_scanner_unavailable' });
    const alerts = await t.app.get(AuditAdminService).alerts(1);
    expect(alerts.alerts.some((a) => a.kind === 'rescan_failed')).toBe(true);

    t.clamd.mode = 'normal';
    await fullPass();
    await as(t, alice).get(`/api/documents/${bad.id}/download`).expect(403);
  });

  it('a pass that runs out of time continues where it stopped', async () => {
    await upload('Budget a');
    await upload('Budget b');
    const first = await rescan.run({ budgetMs: 0 }); // stops after one version
    expect(first).toMatchObject({ done: false, stoppedBecause: 'time_budget' });
    expect(first.cursor).toMatch(/^[0-9a-f-]{36}$/);
    const before = t.clamd.scans;
    const rest = await fullPass();
    expect(rest.done).toBe(true);
    // The continuation did not start over from the first version.
    const { rows } = await withDb(ownerDb(), (c) => c.query(`SELECT count(*)::int AS n FROM document_versions v LEFT JOIN version_quarantine q ON q.version_id = v.id WHERE q.version_id IS NULL AND v.id > $1`, [first.cursor]));
    expect(t.clamd.scans - before).toBeLessThanOrEqual(rows[0].n);
  });

  it('reports a stored file that no longer decrypts', async () => {
    const doc = await upload('Tampered');
    await withDb(ownerDb(), async (c) => {
      const { rows } = await c.query(`SELECT b.version_id, b.ciphertext FROM document_blobs b JOIN document_versions v ON v.id = b.version_id WHERE v.document_id = $1`, [doc.id]);
      const original: Buffer = rows[0].ciphertext;
      const flipped = Buffer.from(original);
      flipped[0] = flipped[0]! ^ 0xff;
      await c.query(`UPDATE document_blobs SET ciphertext = $1 WHERE version_id = $2`, [flipped, rows[0].version_id]);
      try {
        const r = await fullPass();
        expect(r.integrityFailures).toBeGreaterThanOrEqual(1);
        const rowsAudit = await auditRows(`action = 'document.integrity' AND document_id = $1`, [doc.id]);
        expect(rowsAudit.at(-1)).toMatchObject({ outcome: 'FAILED', reason: 'decryption_failed' });
      } finally {
        await c.query(`UPDATE document_blobs SET ciphertext = $1 WHERE version_id = $2`, [original, rows[0].version_id]);
      }
    });
  });

  it('the app cannot release or alter a quarantine', async () => {
    await withDb(appDb(), async (c) => {
      await expect(c.query(`DELETE FROM version_quarantine`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`UPDATE version_quarantine SET signature = 'x'`)).rejects.toThrow(/permission denied/);
      // Reading stored blobs directly is still blocked by row-level security.
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM document_blobs`);
      expect(rows[0].n).toBe(0);
    });
  });
});
