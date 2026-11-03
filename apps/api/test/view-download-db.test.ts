import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appDb, ownerDb } from './helpers.js';

// The DATABASE lock for a VIEW holder's approved download (THREATS.md V1),
// tested on its own: talking to Postgres directly as the app role, no API code.
// If the TypeScript checks were deleted these rules would still hold: a VIEW
// holder gets the bytes only with a usable approval, bound to user + version,
// and only while the VIEW grant is still live.

let app: pg.Client;
let owner: pg.Client;
const id = () => randomUUID();
const ids = { alice: id(), bob: id(), vic: id(), mgr: id(), adm: id() };
let doc: string;
let v1: string;
let v2: string;

async function as<T>(user: string | null, fn: () => Promise<T>, ip: string | null = null): Promise<T> {
  await app.query('BEGIN');
  try {
    if (user) await app.query(`SELECT set_config('app.user_id', $1, true)`, [user]);
    if (ip) await app.query(`SELECT set_config('app.client_ip', $1, true)`, [ip]);
    return await fn();
  } finally {
    await app.query('ROLLBACK');
  }
}
async function asCommit<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('app.user_id', $1, true)`, [user]);
    const r = await fn();
    await app.query('COMMIT');
    return r;
  } catch (err) {
    await app.query('ROLLBACK');
    throw err;
  }
}

const n = async (sql: string, params: unknown[] = []) => Number((await app.query(sql, params)).rowCount);
const level = async (user: string) => Number((await app.query('SELECT tv_doc_level($1, $2) AS l', [doc, user])).rows[0].l);
const blobs = () => n('SELECT 1 FROM document_blobs');
const todayUtc = () => ((new Date().getUTCDay() + 6) % 7) + 1;
const notToday = () => [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== todayUtc());

async function grant(user: string, lvl: string, cond: { approval?: boolean; approver?: string; days?: number[]; tz?: string } = {}) {
  const gid = id();
  await owner.query(
    `INSERT INTO grants (id, document_id, user_id, level, granted_by_id, updated_at, download_approval, download_approver_id, window_days, window_start_min, window_end_min, window_tz)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, $11)`,
    [gid, doc, user, lvl, ids.alice, cond.approval ?? false, cond.approver ?? null, cond.days ?? null, cond.days ? 0 : null, cond.days ? 1440 : null, cond.days ? cond.tz ?? 'UTC' : null],
  );
  return gid;
}

/** The app role inserts a request as `user` (the insert policy is what we test). */
async function request(user: string, version: string): Promise<string> {
  const rid = id();
  await asCommit(user, () => app.query(`INSERT INTO download_approvals (id, document_id, version_id, requester_id, reason) VALUES ($1, $2, $3, $4, 'quarterly audit needs the file')`, [rid, doc, version, user]));
  return rid;
}
const decide = (rid: string, approve: boolean, hours = 24, uses = 1) =>
  app.query(`SELECT status::text FROM tv_decide_download($1, $2, NULL, $3, $4)`, [rid, approve, hours, uses]);
const consume = async (rid: string, version: string) => (await app.query(`SELECT tv_consume_download($1, $2) AS n`, [rid, version])).rows[0].n as number | null;

/** A download ticket for the current user, with a matching audit event in the same tx. */
async function issueDownloadTicket(user: string, version: string, versionNo: number): Promise<string> {
  const { rows: [e] } = await app.query<{ id: string }>(
    `INSERT INTO audit_events (id, actor_id, actor_email, action, outcome, document_id, details) VALUES (gen_random_uuid(), $1, 'x', 'document.download', 'ALLOWED', $2, $3) RETURNING id`,
    [user, doc, JSON.stringify({ versionNo })]);
  return (await app.query<{ ticket: string }>(`SELECT tv_issue_unwrap_ticket($1, 'download', $2) AS ticket`, [version, e!.id])).rows[0]!.ticket;
}
const errOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as Error).message; } };

beforeAll(async () => {
  app = appDb();
  owner = ownerDb();
  await app.connect();
  await owner.connect();
});
afterAll(async () => {
  await app.end();
  await owner.end();
});
beforeEach(async () => {
  await owner.query('TRUNCATE sessions, users, groups, role_access_policies CASCADE');
  const u = (uid: string, email: string, role: string, exp: string | null = null) =>
    owner.query(`INSERT INTO users (id, email, display_name, role, password_hash, updated_at, access_expires_at) VALUES ($1, $2, $2, $3, 'x', now(), $4)`, [uid, email, role, exp]);
  await u(ids.alice, 'alice@vdb.io', 'OWNER');
  await u(ids.bob, 'bob@vdb.io', 'OWNER');
  await u(ids.vic, 'vic@vdb.io', 'VIEWER');
  await u(ids.mgr, 'mgr@vdb.io', 'VIEWER');
  await u(ids.adm, 'adm@vdb.io', 'ADMIN');
  doc = id();
  v1 = id();
  v2 = id();
  await owner.query(`INSERT INTO documents (id, owner_id, title, category, updated_at, current_version_no) VALUES ($1, $2, 'Payroll', 'HR', now(), 2)`, [doc, ids.alice]);
  for (const [vid, no] of [[v1, 1], [v2, 2]] as const) {
    await owner.query(`INSERT INTO document_versions (id, document_id, version_no, file_name, mime_type, size_bytes, sha256, uploaded_by_id)
                       VALUES ($1, $2, $3, 'p.pdf', 'application/pdf', 10, decode(repeat('00', 32), 'hex'), $4)`, [vid, doc, no, ids.alice]);
    await owner.query(`INSERT INTO document_blobs (version_id, wrapped_key, key_id, nonce, auth_tag, ciphertext)
                       VALUES ($1, '\\x00', 'k', decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), '\\x00')`, [vid]);
  }
});

describe('a VIEW holder downloads one version by approval, in the database lock', () => {
  it('may open a request (insert policy accepts VIEW); a non-holder may not', async () => {
    await grant(ids.vic, 'VIEW');
    await asCommit(ids.vic, async () => expect(await n(`INSERT INTO download_approvals (id, document_id, version_id, requester_id, reason) VALUES ($1, $2, $3, $4, 'please, for the audit')`, [id(), doc, v1, ids.vic])).toBe(1));
    // bob has no grant at all: the insert policy (tv_doc_level >= 1) refuses.
    await as(ids.bob, async () => expect(app.query(`INSERT INTO download_approvals (id, document_id, version_id, requester_id, reason) VALUES ($1, $2, $3, $4, 'i have no access here')`, [id(), doc, v1, ids.bob])).rejects.toThrow(/row-level security/));
  });

  it('a VIEW share shows the document and versions, never the blob, until an approval is used', async () => {
    await grant(ids.vic, 'VIEW');
    await as(ids.vic, async () => {
      expect(await level(ids.vic)).toBe(1);
      expect(await n('SELECT 1 FROM documents')).toBe(1);
      expect(await n('SELECT 1 FROM document_versions')).toBe(2);
      expect(await blobs()).toBe(0);
    });
  });

  it('an approved request releases that version only, to the requester only, in the consuming transaction only, once; and mints the keyd ticket', async () => {
    await grant(ids.vic, 'VIEW');
    const rid = await request(ids.vic, v1);
    await asCommit(ids.alice, () => decide(rid, true, 24, 1));
    // Approved but not used: still nothing.
    await as(ids.vic, async () => expect(await blobs()).toBe(0));
    // The keyd download ticket is refused until an approval is spent in this tx.
    // (The ALLOWED-download backstop catches it first, with its own message.)
    await as(ids.vic, async () => expect(await errOf(issueDownloadTicket(ids.vic, v1, 1))).toMatch(/no access|access ended during the request/));
    // Wrong version: no use.
    await as(ids.vic, async () => expect(await consume(rid, v2)).toBeNull());
    // Used for v1 in this transaction: the blob appears AND the ticket mints.
    await asCommit(ids.vic, async () => {
      expect(await consume(rid, v1)).toBe(1);
      expect((await app.query('SELECT version_id FROM document_blobs')).rows.map((r) => r.version_id)).toEqual([v1]);
      expect(await issueDownloadTicket(ids.vic, v1, 1)).toMatch(/^tv-unwrap-ticket-v1\|/);
    });
    // A later transaction: nothing, and the single use is spent.
    await as(ids.vic, async () => { expect(await blobs()).toBe(0); expect(await consume(rid, v1)).toBeNull(); });
    expect((await owner.query('SELECT status::text, uses FROM download_approvals WHERE id = $1', [rid])).rows[0]).toEqual({ status: 'USED', uses: 1 });
  });

  it('N uses: exactly N transactions get the bytes', async () => {
    await grant(ids.vic, 'VIEW');
    const rid = await request(ids.vic, v2);
    await asCommit(ids.alice, () => decide(rid, true, 1, 3));
    for (let i = 1; i <= 3; i++) await asCommit(ids.vic, async () => expect(await consume(rid, v2)).toBe(i));
    await as(ids.vic, async () => expect(await consume(rid, v2)).toBeNull());
  });

  it('a VIEW holder without any approval cannot get the bytes or a ticket, even by direct SQL', async () => {
    await grant(ids.vic, 'VIEW');
    await as(ids.vic, async () => {
      expect(await blobs()).toBe(0);
      // Faking a consumed approval is impossible: there is no approval row, so
      // the ALLOWED-download backstop refuses the audit row before the ticket.
      expect(await errOf(issueDownloadTicket(ids.vic, v1, 1))).toMatch(/no access|access ended during the request/);
    });
  });

  it('revoking the VIEW grant is immediate: an approval used after the grant is removed releases nothing', async () => {
    const gid = await grant(ids.vic, 'VIEW');
    const rid = await request(ids.vic, v1);
    await asCommit(ids.alice, () => decide(rid, true, 24, 5));
    await asCommit(ids.vic, async () => { expect(await consume(rid, v1)).toBe(1); expect(await blobs()).toBe(1); });
    await asCommit(ids.alice, () => app.query('DELETE FROM grants WHERE id = $1', [gid]));
    await as(ids.vic, async () => {
      expect(await consume(rid, v1)).toBeNull();
      expect(await blobs()).toBe(0);
    });
    expect((await owner.query('SELECT status::text FROM download_approvals WHERE id = $1', [rid])).rows[0].status).toBe('CANCELLED');
  });

  it('an ended access window stops it: the grant gives level 0, so the approval cannot be spent', async () => {
    await grant(ids.vic, 'VIEW', { days: notToday(), tz: 'UTC' });
    // While approved (window ignored at decide time? no — request/approve are not window-gated), the consume re-checks tv_doc_level.
    const rid = id();
    await owner.query(`INSERT INTO download_approvals (id, document_id, version_id, requester_id, reason, status, decided_by_id, decided_at, valid_until, max_uses) VALUES ($1, $2, $3, $4, 'approved earlier in the window', 'APPROVED', $5, now(), now() + interval '1 hour', 3)`, [rid, doc, v1, ids.vic, ids.alice]);
    await as(ids.vic, async () => {
      expect(await level(ids.vic)).toBe(0);           // outside the window
      expect(await consume(rid, v1)).toBeNull();
      expect(await blobs()).toBe(0);
    });
  });

  it('an expired approval releases nothing', async () => {
    await grant(ids.vic, 'VIEW');
    const rid = await request(ids.vic, v1);
    await asCommit(ids.alice, () => decide(rid, true, 1, 1));
    await owner.query(`UPDATE download_approvals SET decided_at = now() - interval '2 hours', valid_until = now() - interval '1 hour' WHERE id = $1`, [rid]);
    await as(ids.vic, async () => expect(await consume(rid, v1)).toBeNull());
  });

  it('nobody decides their own request: a VIEW holder cannot approve themselves', async () => {
    await grant(ids.vic, 'VIEW', { approval: true });
    const rid = await request(ids.vic, v1);
    await as(ids.vic, async () => expect(decide(rid, true)).rejects.toThrow(/own download request/));
  });

  it('a nominated manager may decide a VIEW holder’s request; an unrelated owner may not', async () => {
    await grant(ids.mgr, 'MANAGE');
    await grant(ids.vic, 'VIEW', { approval: true, approver: ids.mgr });
    const rid = await request(ids.vic, v1);
    await as(ids.bob, async () => expect(decide(rid, true)).rejects.toThrow(/owner or the nominated approver/));
    await asCommit(ids.mgr, async () => expect((await decide(rid, true)).rows[0].status).toBe('APPROVED'));
  });
});
