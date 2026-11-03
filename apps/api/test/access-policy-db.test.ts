import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appDb, ownerDb } from './helpers.js';

// The DATABASE lock for access policies, tested on its own: talking to
// Postgres directly as the app role, with no API code involved. If the
// TypeScript checks were deleted, these rules would still hold
// (THREATS.md P1-P12).

let app: pg.Client;
let owner: pg.Client;
const id = () => randomUUID();
const ids = { alice: id(), bob: id(), vic: id(), mgr: id(), erin: id(), adm: id() };
let doc: string;
let v1: string;
let v2: string;

/** Runs fn in a transaction as `user`, from `ip`, then rolls back. */
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
/** Same, but commits. */
async function asCommit<T>(user: string, fn: () => Promise<T>, ip: string | null = null): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('app.user_id', $1, true)`, [user]);
    if (ip) await app.query(`SELECT set_config('app.client_ip', $1, true)`, [ip]);
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

/** A grant inserted by the schema owner (setup only), with optional conditions. */
async function grant(user: string, lvl: string, cond: { approval?: boolean; approver?: string; days?: number[]; start?: number; end?: number; tz?: string; cidrs?: string[] } = {}) {
  const gid = id();
  await owner.query(
    `INSERT INTO grants (id, document_id, user_id, level, granted_by_id, updated_at, download_approval, download_approver_id, window_days, window_start_min, window_end_min, window_tz, allowed_cidrs)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, $11, $12)`,
    [gid, doc, user, lvl, ids.alice, cond.approval ?? false, cond.approver ?? null, cond.days ?? null, cond.days ? cond.start ?? 0 : null, cond.days ? cond.end ?? 1440 : null, cond.days ? cond.tz ?? 'UTC' : null, cond.cidrs ?? null],
  );
  return gid;
}

/** ISO day of week today in UTC (1 Mon .. 7 Sun), and every other day. */
const todayUtc = () => ((new Date().getUTCDay() + 6) % 7) + 1;
const notToday = () => [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== todayUtc());

async function request(user: string, version: string, reason = 'quarterly audit needs the file') {
  const rid = id();
  await asCommit(user, () => app.query(`INSERT INTO download_approvals (id, document_id, version_id, requester_id, reason) VALUES ($1, $2, $3, $4, $5)`, [rid, doc, version, user, reason]));
  return rid;
}
const decide = (rid: string, approve: boolean, hours = 24, uses = 1) =>
  app.query(`SELECT status::text FROM tv_decide_download($1, $2, NULL, $3, $4)`, [rid, approve, hours, uses]);
const consume = async (rid: string, version: string) => (await app.query(`SELECT tv_consume_download($1, $2) AS n`, [rid, version])).rows[0].n as number | null;

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
  await u(ids.alice, 'alice@p.io', 'OWNER');
  await u(ids.bob, 'bob@p.io', 'OWNER');
  await u(ids.vic, 'vic@p.io', 'VIEWER');
  await u(ids.mgr, 'mgr@p.io', 'VIEWER');
  await u(ids.erin, 'erin@p.io', 'EXTERNAL', new Date(Date.now() + 30 * 86_400_000).toISOString());
  await u(ids.adm, 'adm@p.io', 'ADMIN');
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

const { cases } = JSON.parse(readFileSync(new URL('./fixtures/window-cases.json', import.meta.url), 'utf8')) as {
  cases: { name: string; w: { days: number[]; start: number; end: number; tz: string }; at: string; expect: boolean }[];
};

describe('tv_in_window: the same boundary and daylight-saving cases as the app lock', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const r = await app.query(`SELECT tv_in_window($1::smallint[], $2::smallint, $3::smallint, $4, $5::timestamptz) AS ok`, [c.w.days, c.w.start, c.w.end, c.w.tz, c.at]);
    expect(r.rows[0].ok).toBe(c.expect);
  });

  it('does not depend on the session time zone', async () => {
    await app.query('BEGIN');
    try {
      await app.query(`SET LOCAL timezone = 'Pacific/Kiritimati'`);
      for (const c of cases.slice(0, 12)) {
        const r = await app.query(`SELECT tv_in_window($1::smallint[], $2::smallint, $3::smallint, $4, $5::timestamptz) AS ok`, [c.w.days, c.w.start, c.w.end, c.w.tz, c.at]);
        expect(r.rows[0].ok, c.name).toBe(c.expect);
      }
    } finally {
      await app.query('ROLLBACK');
    }
  });
});

describe('time windows in the database lock', () => {
  it('outside its window a share gives nothing: no document, version or blob', async () => {
    await grant(ids.vic, 'READ', { days: notToday(), tz: 'UTC' });
    await as(ids.vic, async () => {
      expect(await level(ids.vic)).toBe(0);
      expect(await n('SELECT 1 FROM documents')).toBe(0);
      expect(await n('SELECT 1 FROM document_versions')).toBe(0);
      expect(await blobs()).toBe(0);
    });
  });

  it('inside its window the same share works', async () => {
    await grant(ids.vic, 'READ', { days: [todayUtc()], tz: 'UTC' });
    await as(ids.vic, async () => {
      expect(await level(ids.vic)).toBe(2);
      expect(await n('SELECT 1 FROM documents')).toBe(1);
      expect(await blobs()).toBe(2);
    });
  });

  it('an EDIT share outside its window does not lend EDIT through a READ share inside it', async () => {
    await grant(ids.vic, 'EDIT', { days: notToday() });
    const g = id();
    await owner.query(`INSERT INTO groups (id, name) VALUES ($1, 'Ops')`, [g]);
    await owner.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`, [g, ids.vic]);
    const gg = id();
    await owner.query(`INSERT INTO grants (id, document_id, group_id, level, granted_by_id, updated_at) VALUES ($1, $2, $3, 'READ', $4, now())`, [gg, doc, g, ids.alice]);
    await owner.query(`INSERT INTO grant_group_members (grant_id, user_id) VALUES ($1, $2)`, [gg, ids.vic]);
    await as(ids.vic, async () => {
      expect(await level(ids.vic)).toBe(2);
      expect(await n(`UPDATE documents SET title = 'x' WHERE id = $1`, [doc])).toBe(0);
    });
  });

  it('the owner is never limited by the windows on shares', async () => {
    await grant(ids.vic, 'READ', { days: notToday() });
    await as(ids.alice, async () => expect(await level(ids.alice)).toBe(5));
  });

  it('an unknown time zone, an overnight window and a POSIX zone are refused by the database', async () => {
    await expect(grant(ids.vic, 'READ', { days: [1], tz: 'Mars/Olympus' })).rejects.toThrow(/unknown time zone/);
    await expect(grant(ids.vic, 'READ', { days: [1], tz: 'UTC+5' })).rejects.toThrow(/unknown time zone/);
    await expect(grant(ids.vic, 'READ', { days: [1], start: 1320, end: 360 })).rejects.toThrow(/grants_window_shape/);
    await expect(grant(ids.vic, 'READ', { days: [8] })).rejects.toThrow(/grants_window_shape/);
  });
});

describe('network allowlists in the database lock', () => {
  it('IPv4 and IPv6 ranges, on the client address the API set; unknown address means no access', async () => {
    await grant(ids.vic, 'READ', { cidrs: ['10.0.0.0/8', '2001:db8::/32'] });
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(0));                         // no address
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(2), '10.20.30.40');
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(0), '11.0.0.1');
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(2), '2001:db8:1::7');
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(0), '2001:db9::1');
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(0), 'garbage');               // malformed = unknown
    await as(ids.vic, async () => expect(await blobs()).toBe(0), '11.0.0.1');
    await as(ids.vic, async () => expect(await blobs()).toBe(2), '10.0.0.1');
  });

  it('malformed ranges are refused by the database', async () => {
    await expect(grant(ids.vic, 'READ', { cidrs: ['10.0.0.1/8'] })).rejects.toThrow(/cidr/i);
    await expect(grant(ids.vic, 'READ', { cidrs: ['nope'] })).rejects.toThrow(/cidr/i);
  });

  it('role rules: apply on top of every share of people with that role, never to owners of their own documents', async () => {
    await grant(ids.vic, 'READ');
    await owner.query(`INSERT INTO role_access_policies (role, allowed_cidrs, updated_by_id) VALUES ('VIEWER', ARRAY['192.168.0.0/16'], $1)`, [ids.adm]);
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(0), '10.0.0.1');
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(2), '192.168.4.4');
    await owner.query(`INSERT INTO role_access_policies (role, window_days, window_start_min, window_end_min, window_tz, updated_by_id) VALUES ('OWNER', $1, 0, 1440, 'UTC', $2)`, [notToday(), ids.adm]);
    await as(ids.alice, async () => expect(await level(ids.alice)).toBe(5));
  });

  it('only an active admin may change role rules, in their own name', async () => {
    const insert = () => app.query(`INSERT INTO role_access_policies (role, allowed_cidrs, updated_by_id) VALUES ('VIEWER', ARRAY['10.0.0.0/8'], tv_current_user())`);
    await as(ids.vic, async () => expect(insert()).rejects.toThrow(/row-level security/));
    await as(ids.alice, async () => expect(insert()).rejects.toThrow(/row-level security/));
    await as(ids.adm, async () => expect(await n(`INSERT INTO role_access_policies (role, allowed_cidrs, updated_by_id) VALUES ('VIEWER', ARRAY['10.0.0.0/8'], tv_current_user())`)).toBe(1));
    await as(ids.adm, async () => expect(app.query(`INSERT INTO role_access_policies (role, allowed_cidrs, updated_by_id) VALUES ('ADMIN', ARRAY['10.0.0.0/8'], tv_current_user())`)).rejects.toThrow(/role_policy_not_admin/));
  });
});

describe('download approval in the database lock', () => {
  it('a share that needs approval shows the document and versions, never the blob', async () => {
    await grant(ids.vic, 'READ', { approval: true });
    await as(ids.vic, async () => {
      expect(await level(ids.vic)).toBe(2);
      expect(await n('SELECT 1 FROM documents')).toBe(1);
      expect(await n('SELECT 1 FROM document_versions')).toBe(2);
      expect(await blobs()).toBe(0);
    });
  });

  it('an approved request releases that version only, only to the requester, only in the transaction that used it, only once', async () => {
    await grant(ids.vic, 'READ', { approval: true });
    await grant(ids.bob, 'READ', { approval: true });
    const rid = await request(ids.vic, v1);
    await asCommit(ids.alice, () => decide(rid, true, 24, 1));
    // Approved but not used: still nothing.
    await as(ids.vic, async () => expect(await blobs()).toBe(0));
    // Another person cannot use it.
    await as(ids.bob, async () => {
      expect(await consume(rid, v1)).toBeNull();
      expect(await blobs()).toBe(0);
    });
    // Not for another version.
    await as(ids.vic, async () => {
      expect(await consume(rid, v2)).toBeNull();
      expect(await blobs()).toBe(0);
    });
    // Used: v1 only, in this transaction.
    await asCommit(ids.vic, async () => {
      expect(await consume(rid, v1)).toBe(1);
      expect((await app.query('SELECT version_id FROM document_blobs')).rows.map((r) => r.version_id)).toEqual([v1]);
    });
    // A later transaction: nothing again, and the single use is spent.
    await as(ids.vic, async () => {
      expect(await blobs()).toBe(0);
      expect(await consume(rid, v1)).toBeNull();
    });
    expect((await owner.query('SELECT status::text, uses FROM download_approvals WHERE id = $1', [rid])).rows[0]).toEqual({ status: 'USED', uses: 1 });
  });

  it('N uses: exactly N transactions get the bytes', async () => {
    await grant(ids.vic, 'READ', { approval: true });
    const rid = await request(ids.vic, v2);
    await asCommit(ids.alice, () => decide(rid, true, 1, 3));
    for (let i = 1; i <= 3; i++) await asCommit(ids.vic, async () => expect(await consume(rid, v2)).toBe(i));
    await as(ids.vic, async () => expect(await consume(rid, v2)).toBeNull());
  });

  it('nobody approves their own request: the function refuses, the app role cannot UPDATE, and the CHECK holds even for the schema owner', async () => {
    await grant(ids.mgr, 'MANAGE', { approval: true });
    const rid = await request(ids.mgr, v1);
    await as(ids.mgr, async () => expect(decide(rid, true)).rejects.toThrow(/own download request/));
    await as(ids.mgr, async () => expect(app.query(`UPDATE download_approvals SET status = 'APPROVED', decided_by_id = $1, decided_at = now(), valid_until = now() + interval '1 hour', max_uses = 1 WHERE id = $2`, [ids.mgr, rid])).rejects.toThrow(/permission denied/));
    await expect(owner.query(`UPDATE download_approvals SET status = 'APPROVED', decided_by_id = requester_id, decided_at = now(), valid_until = now() + interval '1 hour', max_uses = 1 WHERE id = $1`, [rid])).rejects.toThrow(/download_approvals_not_self/);
  });

  it('only the owner or the nominated manager decides; another manager and the app role directly cannot', async () => {
    await grant(ids.mgr, 'MANAGE');
    const other = id();
    await owner.query(`INSERT INTO users (id, email, display_name, role, password_hash, updated_at) VALUES ($1, 'm2@p.io', 'm2', 'VIEWER', 'x', now())`, [other]);
    await owner.query(`INSERT INTO grants (id, document_id, user_id, level, granted_by_id, updated_at) VALUES ($1, $2, $3, 'MANAGE', $4, now())`, [id(), doc, other, ids.alice]);
    await grant(ids.vic, 'READ', { approval: true, approver: ids.mgr });
    const rid = await request(ids.vic, v1);
    await as(other, async () => expect(decide(rid, true)).rejects.toThrow(/owner or the nominated approver/));
    await as(ids.bob, async () => expect(decide(rid, true)).rejects.toThrow(/owner or the nominated approver/));
    await as(ids.vic, async () => expect(n(`DELETE FROM download_approvals WHERE id = $1`, [rid])).rejects.toThrow(/permission denied/));
    await asCommit(ids.mgr, async () => expect((await decide(rid, true)).rows[0].status).toBe('APPROVED'));
    await as(ids.alice, async () => expect(decide(rid, false)).rejects.toThrow(/already approved/));
  });

  it('a new request is always pending and unused, whatever the app sends', async () => {
    await grant(ids.vic, 'READ', { approval: true });
    const rid = id();
    await asCommit(ids.vic, () => app.query(
      `INSERT INTO download_approvals (id, document_id, version_id, requester_id, reason, status, decided_by_id, decided_at, valid_until, max_uses)
       VALUES ($1, $2, $3, $4, 'please, it is urgent', 'APPROVED', $5, now(), now() + interval '1 hour', 10)`, [rid, doc, v1, ids.vic, ids.alice]));
    expect((await owner.query('SELECT status::text, decided_by_id, max_uses FROM download_approvals WHERE id = $1', [rid])).rows[0]).toEqual({ status: 'PENDING', decided_by_id: null, max_uses: null });
    // Nobody asks in someone else's name, or for a version of another document.
    await as(ids.vic, async () => expect(app.query(`INSERT INTO download_approvals (id, document_id, version_id, requester_id, reason) VALUES ($1, $2, $3, $4, 'in bob''s name please')`, [id(), doc, v1, ids.bob])).rejects.toThrow(/row-level security/));
  });

  it('an expired approval releases nothing; expiry is recorded as EXPIRED', async () => {
    await grant(ids.vic, 'READ', { approval: true });
    const rid = await request(ids.vic, v1);
    await asCommit(ids.alice, () => decide(rid, true, 1, 1));
    await owner.query(`UPDATE download_approvals SET decided_at = now() - interval '2 hours', valid_until = now() - interval '1 hour' WHERE id = $1`, [rid]);
    await as(ids.vic, async () => expect(await consume(rid, v1)).toBeNull());
    const old = await request(ids.vic, v2);
    await owner.query(`UPDATE download_approvals SET created_at = now() - interval '8 days' WHERE id = $1`, [old]);
    const expired = (await app.query('SELECT id, was::text FROM tv_expire_downloads() ORDER BY was')).rows;
    expect(expired).toEqual(expect.arrayContaining([{ id: rid, was: 'APPROVED' }, { id: old, was: 'PENDING' }]));
    expect((await owner.query(`SELECT count(*)::int AS c FROM download_approvals WHERE status = 'EXPIRED'`)).rows[0].c).toBe(2);
  });

  it('revocation is immediate: an approval used after the share is removed releases nothing', async () => {
    const gid = await grant(ids.vic, 'READ', { approval: true });
    const rid = await request(ids.vic, v1);
    await asCommit(ids.alice, () => decide(rid, true, 24, 5));
    await asCommit(ids.vic, async () => { expect(await consume(rid, v1)).toBe(1); expect(await blobs()).toBe(1); });
    await asCommit(ids.alice, () => app.query('DELETE FROM grants WHERE id = $1', [gid]));
    await as(ids.vic, async () => {
      expect(await consume(rid, v1)).toBeNull();
      expect(await blobs()).toBe(0);
      expect(await n('SELECT 1 FROM documents')).toBe(0);
    });
    expect((await owner.query('SELECT status::text FROM download_approvals WHERE id = $1', [rid])).rows[0].status).toBe('CANCELLED');
  });

  it('a share without the condition, or the uploader of the version, gets the blob without approval', async () => {
    await grant(ids.vic, 'READ', { approval: true });
    const g = id();
    await owner.query(`INSERT INTO groups (id, name) VALUES ($1, 'Free')`, [g]);
    await owner.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`, [g, ids.vic]);
    const gg = id();
    await owner.query(`INSERT INTO grants (id, document_id, group_id, level, granted_by_id, updated_at) VALUES ($1, $2, $3, 'READ', $4, now())`, [gg, doc, g, ids.alice]);
    await owner.query(`INSERT INTO grant_group_members (grant_id, user_id) VALUES ($1, $2)`, [gg, ids.vic]);
    await as(ids.vic, async () => expect(await blobs()).toBe(2));
  });
});

describe('emergency exceptions in the database lock', () => {
  it('only the owner gives one, for at most 24 hours, to someone with a share; it lifts the share conditions until it ends', async () => {
    await grant(ids.vic, 'READ', { approval: true, days: notToday() });
    const ins = (by: string, hours: number) => app.query(
      `INSERT INTO access_overrides (id, document_id, user_id, created_by_id, reason, expires_at) VALUES ($1, $2, $3, $4, 'payroll deadline tonight', now() + make_interval(hours => $5))`,
      [id(), doc, ids.vic, by, hours]);
    await as(ids.vic, async () => expect(ins(ids.vic, 1)).rejects.toThrow(/only the owner can give an exception/));
    await as(ids.bob, async () => expect(ins(ids.bob, 1)).rejects.toThrow(/only the owner can give an exception/));
    await as(ids.vic, async () => expect(ins(ids.alice, 1)).rejects.toThrow(/row-level security/));   // in the owner's name
    await as(ids.alice, async () => expect(ins(ids.alice, 25)).rejects.toThrow(/24 hours/));
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(0));
    const oid = id();
    await asCommit(ids.alice, () => app.query(
      `INSERT INTO access_overrides (id, document_id, user_id, created_by_id, reason, expires_at) VALUES ($1, $2, $3, $4, 'payroll deadline tonight', now() + interval '2 hours')`,
      [oid, doc, ids.vic, ids.alice]));
    await as(ids.vic, async () => { expect(await level(ids.vic)).toBe(2); expect(await blobs()).toBe(2); });
    // Role rules still apply.
    await owner.query(`INSERT INTO role_access_policies (role, allowed_cidrs, updated_by_id) VALUES ('VIEWER', ARRAY['10.0.0.0/8'], $1)`, [ids.adm]);
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(0), '8.8.8.8');
    await owner.query(`DELETE FROM role_access_policies`);
    // Only the owner ends it; then the conditions are back.
    await as(ids.vic, async () => expect((await app.query('SELECT tv_end_override($1) AS ok', [oid])).rows[0].ok).toBe(false));
    await asCommit(ids.alice, async () => expect((await app.query('SELECT tv_end_override($1) AS ok', [oid])).rows[0].ok).toBe(true));
    await as(ids.vic, async () => expect(await level(ids.vic)).toBe(0));
  });
});

describe('who may change the conditions on a share', () => {
  it('a manager cannot loosen conditions the owner set; the owner can', async () => {
    await grant(ids.mgr, 'MANAGE');
    const gid = await grant(ids.vic, 'READ', { approval: true });
    await as(ids.mgr, async () => {
      await expect(app.query(`UPDATE grants SET download_approval = false, granted_by_id = $1 WHERE id = $2`, [ids.mgr, gid])).rejects.toThrow(/only the owner can change the conditions/);
    });
    await as(ids.alice, async () => {
      expect(await n(`UPDATE grants SET download_approval = false, granted_by_id = $1 WHERE id = $2`, [ids.alice, gid])).toBe(1);
    });
  });

  it('the nominated approver must be able to manage the document and cannot be the grantee', async () => {
    await expect(grant(ids.vic, 'READ', { approval: true, approver: ids.bob })).rejects.toThrow(/nominated approver must be able to manage/);
    const own = await grant(ids.mgr, 'MANAGE');
    await expect(owner.query(`UPDATE grants SET download_approval = true, download_approver_id = user_id WHERE id = $1`, [own])).rejects.toThrow(/grants_approver_not_grantee/);
    await expect(grant(ids.vic, 'READ', { approval: false, approver: ids.mgr })).rejects.toThrow(/grants_approver_needs_approval/);
  });
});
