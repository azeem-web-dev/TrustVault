import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { DEMO_DOCUMENTS, DEMO_GROUPS, resetDemo } from '../src/cli/demo-reset.js';
import { ORIGIN, ownerDb, withDb } from './helpers.js';

// The scheduled demo reset (THREATS.md I15, docs/DEMO.md), run against the
// real seed: whatever a visitor changed in shared state comes back, the
// audit log only grows, and the reset is itself recorded.

const OWNER_URL = process.env.TEST_DATABASE_OWNER_URL!;
let prisma: PrismaClient;

const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  withDb(ownerDb(), async (db) => (await db.query(sql, params)).rows as T[]);
const idOf = async (email: string) => (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))[0]!.id;
const docId = async (title: string) => (await q<{ id: string }>('SELECT id FROM documents WHERE title = $1', [title]))[0]!.id;
const level = async (title: string, email: string) =>
  (await q<{ l: number }>('SELECT tv_doc_level($1::uuid, $2::uuid) AS l', [await docId(title), await idOf(email)]))[0]!.l;
const auditCount = async () => Number((await q<{ n: string }>('SELECT count(*) AS n FROM audit_events'))[0]!.n);

beforeAll(async () => {
  await q('TRUNCATE sessions, users, groups, beta_signups CASCADE');
  await q(`UPDATE app_settings SET mfa_required_roles = '{ADMIN}', updated_by_id = NULL`);
  execFileSync('npx', ['tsx', 'prisma/seed.ts'], {
    stdio: 'pipe',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_ENV: 'test', KEY_PROVIDER: 'local', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_OWNER_URL: OWNER_URL },
  });
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL, options: '-c TimeZone=UTC' }) });
}, 120_000);
afterAll(async () => { await prisma?.$disconnect(); });

describe('the seed', () => {
  it('a group share in the seed reaches the group members (Victor sees three documents)', async () => {
    expect(await level('Offer letter - Victor Viewer', 'victor@demo.com')).toBeGreaterThan(0);
    expect(await level('Q3 board minutes', 'victor@demo.com')).toBeGreaterThan(0);
    expect(await level('Architecture review', 'victor@demo.com')).toBeGreaterThan(0);
    expect(await level('Salary bands 2026', 'victor@demo.com')).toBe(0);
  });

  it('the reset names only documents and groups the seed creates', () => {
    const seed = readFileSync('prisma/seed.ts', 'utf8');
    for (const d of DEMO_DOCUMENTS) expect(seed).toContain(`title: '${d.title}'`);
    for (const g of Object.keys(DEMO_GROUPS)) expect(seed).toContain(`group('${g}'`);
  });
});

describe('demo reset', () => {
  it('undoes what a visitor changed, keeps the audit log, and records itself', async () => {
    const [olivia, victor, oscar] = await Promise.all(['olivia@demo.com', 'victor@demo.com', 'oscar@demo.com'].map(idOf));
    const salary = await docId('Salary bands 2026');
    const nda = await docId('Partner NDA - Erin');
    // What one visitor could do with the published logins:
    await q(`UPDATE app_settings SET mfa_required_roles = '{ADMIN,VIEWER}'`);
    await q(`INSERT INTO role_access_policies (role, allowed_cidrs, updated_by_id) VALUES ('VIEWER', '{10.0.0.0/8}', $1)`, [await idOf('admin@demo.com')]);
    await q(`DELETE FROM group_members WHERE user_id = $1 AND group_id = (SELECT id FROM groups WHERE name = 'Finance')`, [victor]);
    await q(`INSERT INTO groups (id, name) VALUES (gen_random_uuid(), 'Visitors')`);
    await q(`INSERT INTO group_members (group_id, user_id) SELECT id, $1 FROM groups WHERE name = 'Visitors'`, [oscar]);
    await q(`INSERT INTO grants (id, document_id, user_id, level, granted_by_id, updated_at) VALUES (gen_random_uuid(), $1, $2, 'READ', $3, now())`, [salary, victor, olivia]);
    await q('DELETE FROM grants WHERE document_id = $1', [nda]);
    await q(`UPDATE documents SET status = 'DELETED', deleted_at = now() WHERE id = $1`, [salary]);
    await q(`INSERT INTO folders (id, owner_id, name) VALUES (gen_random_uuid(), $1, 'Judge folder')`, [olivia]);
    await q(`UPDATE documents SET folder_id = (SELECT id FROM folders WHERE name = 'Judge folder') WHERE id = $1`, [salary]);
    await q(`UPDATE documents SET owner_id = $1 WHERE title = 'Q3 board minutes'`, [oscar]);
    const before = await auditCount();

    const s = await resetDemo(prisma);

    expect(s.missing).toEqual([]);
    expect(s).toMatchObject({ rolePoliciesRemoved: 1, documentsRestored: 1, ownersRestored: 1, foldersRemoved: 1 });
    expect((await q<{ r: string[] }>('SELECT mfa_required_roles::text[] AS r FROM app_settings WHERE id = 1'))[0]!.r).toEqual(['ADMIN']);
    expect(await q('SELECT 1 FROM role_access_policies')).toHaveLength(0);
    expect(await q(`SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE g.name = 'Visitors'`)).toHaveLength(0);
    expect(await level('Salary bands 2026', 'victor@demo.com')).toBe(0);
    expect(await level('Q3 board minutes', 'victor@demo.com')).toBeGreaterThan(0);
    expect(await level('Partner NDA - Erin', 'erin@demo.com')).toBeGreaterThan(0);
    expect(await level('Salary bands 2026', 'olivia@demo.com')).toBeGreaterThan(0);
    expect((await q<{ owner_id: string }>(`SELECT owner_id FROM documents WHERE title = 'Q3 board minutes'`))[0]!.owner_id).toBe(olivia);
    expect(await q('SELECT 1 FROM folders WHERE owner_id = $1', [olivia])).toHaveLength(0);
    // The audit log only grew, by exactly the reset's own row.
    expect(await auditCount()).toBe(before + 1);
    const [row] = await q<{ action: string; outcome: string; actor_email: string }>(`SELECT action, outcome, actor_email FROM audit_events ORDER BY seq DESC LIMIT 1`);
    expect(row).toEqual({ action: 'demo.reset', outcome: 'ALLOWED', actor_email: 'system' });
  });

  it('running it again changes nothing but adds another record', async () => {
    const before = await auditCount();
    const s = await resetDemo(prisma);
    expect(s).toMatchObject({ rolePoliciesRemoved: 0, groupMembersAdded: 0, groupMembersRemoved: 0, documentsRestored: 0, ownersRestored: 0, foldersRemoved: 0, missing: [] });
    expect(s.grantsRestored).toBe(5);
    expect(await auditCount()).toBe(before + 1);
  });
});
