import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Puts the shared public demo back the way prisma/seed.ts made it
 * (THREATS.md I15, docs/DEMO.md). Run as the schema owner, in one
 * transaction, by infra/server/demo-reset.sh on a systemd timer.
 *
 * Restores: the MFA policy (ADMIN only), role-wide rules (none), the two
 * demo groups' members (and no demo account in any other group), each seed
 * document's owner, status and grants, and no folders for demo accounts.
 *
 * Never touches: the audit log (one 'demo.reset' row is added), documents'
 * files or versions, documents that are not in the seed (they are left
 * where they are), or anything belonging to non-demo accounts.
 *
 * Must match prisma/seed.ts; demo-reset.test.ts checks the names exist there.
 */
export const DEMO_GROUPS: Record<string, string[]> = {
  Finance: ['victor@demo.com'],
  Engineering: ['victor@demo.com', 'oscar@demo.com'],
};

interface SeedGrant { user?: string; group?: string; level: 'READ' | 'EDIT' | 'MANAGE'; days?: number }
export const DEMO_DOCUMENTS: { owner: string; title: string; grants: SeedGrant[] }[] = [
  { owner: 'olivia@demo.com', title: 'Offer letter - Victor Viewer', grants: [{ user: 'victor@demo.com', level: 'READ' }] },
  { owner: 'olivia@demo.com', title: 'Salary bands 2026', grants: [] },
  { owner: 'olivia@demo.com', title: 'Q3 board minutes', grants: [{ group: 'Finance', level: 'READ' }] },
  { owner: 'olivia@demo.com', title: 'Partner NDA - Erin', grants: [{ user: 'erin@demo.com', level: 'READ', days: 30 }] },
  { owner: 'oscar@demo.com', title: 'Architecture review', grants: [{ group: 'Engineering', level: 'EDIT' }, { user: 'olivia@demo.com', level: 'MANAGE' }] },
];

export interface DemoResetSummary {
  rolePoliciesRemoved: number;
  groupMembersAdded: number;
  groupMembersRemoved: number;
  documentsRestored: number;
  ownersRestored: number;
  grantsRemoved: number;
  grantsRestored: number;
  foldersRemoved: number;
  missing: string[];
}

const DAY = 86_400_000;

export async function resetDemo(prisma: PrismaClient, now = new Date()): Promise<DemoResetSummary> {
  return prisma.$transaction(async (tx) => {
    const s: DemoResetSummary = { rolePoliciesRemoved: 0, groupMembersAdded: 0, groupMembersRemoved: 0, documentsRestored: 0, ownersRestored: 0, grantsRemoved: 0, grantsRestored: 0, foldersRemoved: 0, missing: [] };
    const demo = await tx.user.findMany({ where: { isProtected: true }, select: { id: true, email: true } });
    const idOf = new Map(demo.map((u) => [u.email, u.id]));
    const demoIds = [...idOf.values()];
    // The grant and document triggers check who is acting: act as the document's owner.
    const actAs = (userId: string) => tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;

    // 1. Settings that could lock demo accounts out.
    await tx.appSettings.updateMany({ where: { id: 1 }, data: { mfaRequiredRoles: ['ADMIN'], updatedAt: now, updatedById: null } });
    s.rolePoliciesRemoved = (await tx.roleAccessPolicy.deleteMany({})).count;

    // 2. Groups: before grants, so a group grant covers the restored members.
    const groupIds = new Map<string, string>();
    for (const [name, emails] of Object.entries(DEMO_GROUPS)) {
      const g = await tx.group.upsert({ where: { name }, create: { name, description: `${name} team` }, update: {} });
      groupIds.set(name, g.id);
      const want = emails.map((e) => idOf.get(e)).filter((v): v is string => Boolean(v));
      s.groupMembersRemoved += (await tx.groupMember.deleteMany({ where: { groupId: g.id, userId: { notIn: want } } })).count;
      s.groupMembersAdded += (await tx.groupMember.createMany({ data: want.map((userId) => ({ groupId: g.id, userId })), skipDuplicates: true })).count;
    }
    s.groupMembersRemoved += (await tx.groupMember.deleteMany({ where: { userId: { in: demoIds }, groupId: { notIn: [...groupIds.values()] } } })).count;

    // 3. Seed documents: owner, status, grants.
    for (const d of DEMO_DOCUMENTS) {
      const owner = idOf.get(d.owner);
      const doc = await tx.document.findFirst({ where: { title: d.title, ownerId: { in: demoIds } }, select: { id: true, ownerId: true, status: true } });
      if (!owner || !doc) { s.missing.push(d.title); continue; }
      if (doc.ownerId !== owner) {
        await tx.document.update({ where: { id: doc.id }, data: { ownerId: owner } });
        s.ownersRestored++;
      }
      await actAs(owner);
      if (doc.status !== 'ACTIVE') {
        await tx.document.update({ where: { id: doc.id }, data: { status: 'ACTIVE', deletedAt: null } });
        s.documentsRestored++;
      }
      s.grantsRemoved += (await tx.grant.deleteMany({ where: { documentId: doc.id } })).count;
      for (const g of d.grants) {
        const userId = g.user ? idOf.get(g.user) : undefined;
        const groupId = g.group ? groupIds.get(g.group) : undefined;
        if (!userId && !groupId) { s.missing.push(`${d.title}: ${g.user ?? g.group}`); continue; }
        const row = await tx.grant.create({
          data: { documentId: doc.id, userId: userId ?? null, groupId: groupId ?? null, level: g.level, expiresAt: g.days ? new Date(now.getTime() + g.days * DAY) : null, grantedById: owner },
        });
        // A group share covers the members the owner confirmed, as SharingService does.
        if (groupId) await tx.$queryRaw`SELECT tv_confirm_group_members(${row.id}::uuid, ${owner}::uuid)`;
        s.grantsRestored++;
      }
    }

    // 4. Folders only organise; the seed has none for demo accounts.
    s.foldersRemoved = (await tx.folder.deleteMany({ where: { ownerId: { in: demoIds } } })).count;

    // 5. The reset itself is evidence.
    await tx.auditEvent.create({
      data: { action: 'demo.reset', outcome: 'ALLOWED', reason: 'scheduled', actorEmail: 'system', targetType: 'settings', targetId: 'demo', details: { ...s } },
    });
    return s;
  }, { timeout: 60_000 });
}
