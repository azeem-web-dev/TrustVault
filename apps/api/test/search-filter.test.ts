import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { buildSearchWhere, type SearchFilters } from '../src/documents/documents.service.js';
import { ownerDb, withDb } from './helpers.js';

// Search layer 1 on its own. These queries run as the table OWNER, which
// row-level security does not apply to, so the only thing hiding other
// people's documents here is buildSearchWhere(). Remove its access filter
// and these tests fail even though the API (protected by RLS too) would
// still look fine.

let prisma: PrismaClient;
const id = () => randomUUID();
const u = { alice: id(), bob: id(), vic: id(), erin: id() };
const d = { aliceOnly: id(), sharedVic: id(), groupDoc: id(), expired: id(), erinDoc: id(), trashed: id() };
const group = id();

const base: SearchFilters = { scope: 'all', page: 1 };
const titles = async (userId: string, role: 'OWNER' | 'VIEWER' | 'EXTERNAL', f: Partial<SearchFilters> = {}) =>
  (await prisma.document.findMany({ where: buildSearchWhere({ userId, role }, { ...base, ...f }), select: { title: true }, orderBy: { title: 'asc' } })).map((r) => r.title);

beforeAll(() => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_OWNER_URL! }) });
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await withDb(ownerDb(), async (db) => {
    await db.query('TRUNCATE sessions, users, groups CASCADE');
    for (const [k, v] of Object.entries(u)) {
      await db.query(`INSERT INTO users (id, email, display_name, role, password_hash, access_expires_at, updated_at) VALUES ($1, $2, $2, $3, 'x', $4, now())`,
        [v, `${k}@s.io`, k === 'erin' ? 'EXTERNAL' : k === 'vic' ? 'VIEWER' : 'OWNER', k === 'erin' ? new Date(Date.now() + 86_400_000) : null]);
    }
    const doc = (docId: string, owner: string, title: string, status = 'ACTIVE') =>
      db.query(`INSERT INTO documents (id, owner_id, title, category, status, deleted_at, updated_at) VALUES ($1, $2, $3, 'C', $4, $5, now())`,
        [docId, owner, title, status, status === 'DELETED' ? new Date() : null]);
    await doc(d.aliceOnly, u.alice, 'alice-only');
    await doc(d.sharedVic, u.alice, 'shared-with-vic');
    await doc(d.groupDoc, u.alice, 'group-doc');
    await doc(d.expired, u.alice, 'expired-grant');
    await doc(d.erinDoc, u.alice, 'erin-doc');
    await doc(d.trashed, u.alice, 'trashed', 'DELETED');
    await db.query(`INSERT INTO groups (id, name) VALUES ($1, 'G')`, [group]);
    await db.query(`ALTER TABLE grants DISABLE TRIGGER grants_guard; ALTER TABLE group_members DISABLE TRIGGER group_members_guard`);
    const grant = (docId: string, who: { user?: string; group?: string }, expires: Date | null = null) =>
      db.query(`INSERT INTO grants (id, document_id, user_id, group_id, level, expires_at, granted_by_id, updated_at) VALUES ($1, $2, $3, $4, 'READ', $5, $6, now())`,
        [id(), docId, who.user ?? null, who.group ?? null, expires, u.alice]);
    await grant(d.sharedVic, { user: u.vic });
    await grant(d.groupDoc, { group });
    await grant(d.expired, { user: u.vic }, new Date(Date.now() - 60_000));
    await grant(d.erinDoc, { user: u.erin }, new Date(Date.now() + 60_000));
    await grant(d.trashed, { user: u.vic });
    // Erin should never be in a group (trigger), but if she were, the filter must still ignore it.
    await db.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)`, [group, u.vic, u.erin]);
    // The sharer confirmed the group's members (THREATS.md A19).
    await db.query(`INSERT INTO grant_group_members (grant_id, user_id) SELECT g.id, gm.user_id FROM grants g JOIN group_members gm ON gm.group_id = g.group_id`);
    await db.query(`ALTER TABLE grants ENABLE TRIGGER grants_guard; ALTER TABLE group_members ENABLE TRIGGER group_members_guard`);
  });
});

describe('buildSearchWhere: the application-side access filter', () => {
  it('a user with no grants finds nothing of someone else’s', async () => {
    expect(await titles(u.bob, 'OWNER')).toEqual([]);
    expect(await titles(u.bob, 'OWNER', { q: 'alice' })).toEqual([]);
    expect(await titles(u.bob, 'OWNER', { owner: 'alice' })).toEqual([]);
  });

  it('a grantee finds direct and group grants, not expired grants or trashed documents', async () => {
    expect(await titles(u.vic, 'VIEWER')).toEqual(['group-doc', 'shared-with-vic']);
  });

  it('a group member the sharer never confirmed finds nothing through the group (A19)', async () => {
    await withDb(ownerDb(), (db) => db.query(`DELETE FROM grant_group_members WHERE user_id = $1`, [u.vic]));
    expect(await titles(u.vic, 'VIEWER')).toEqual(['shared-with-vic']);
  });

  it('an admin finds nothing, even a document they own or a grant they hold (A17, A20)', async () => {
    expect(await titles(u.vic, 'ADMIN' as 'VIEWER')).toEqual([]);
    expect(await titles(u.alice, 'ADMIN' as 'OWNER')).toEqual([]);
  });

  it('an external user finds only direct grants, never group ones', async () => {
    expect(await titles(u.erin, 'EXTERNAL')).toEqual(['erin-doc']);
  });

  it('the owner finds their own active documents; trash only in the trash scope', async () => {
    expect(await titles(u.alice, 'OWNER')).toHaveLength(5);
    expect(await titles(u.alice, 'OWNER', { scope: 'trash' })).toEqual(['trashed']);
  });

  it('nobody else can see the owner’s trash, even with a grant on the document', async () => {
    expect(await titles(u.vic, 'VIEWER', { scope: 'trash' })).toEqual([]);
  });

  it('"shared with me" excludes documents the caller owns and still applies the access filter', async () => {
    expect(await titles(u.alice, 'OWNER', { scope: 'shared' })).toEqual([]);
    expect(await titles(u.bob, 'OWNER', { scope: 'shared' })).toEqual([]);
  });
});
