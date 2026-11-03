import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../common/request-context.js';
import type { GrantLevel } from '../generated/prisma/enums.js';
import { AccessService, Level } from './access.js';
import { NotifyService } from '../mail/notify.service.js';
import { listOrNull, networkColumns, type SharePolicyInput, windowColumns, windowOut } from './policy-input.js';

export interface GrantInput {
  userId?: string | undefined;
  groupId?: string | undefined;
  level: GrantLevel;
  expiresAt?: Date | null | undefined;
  /** Set when the owner confirmed an access suggestion; recorded in the audit. */
  fromSuggestion?: boolean | undefined;
  /** Conditions on the share (THREATS.md P1-P12). Omitted on an existing share: unchanged. */
  policy?: SharePolicyInput | undefined;
}

const MAX_GRANT_DAYS = 366;
const SUGGEST_ORDER: GrantLevel[] = ['VIEW', 'READ', 'EDIT'];

const LEVEL_NAME = ['NONE', 'VIEW', 'READ', 'EDIT', 'MANAGE', 'OWNER'] as const;

/** What a person can still do on a document, from the database lock (live). */
export async function remainingLevel(tx: Tx, documentId: string, userId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ l: number }[]>`SELECT tv_doc_level(${documentId}::uuid, ${userId}::uuid) AS l`;
  const l = rows[0]?.l ?? 0;
  return l > 0 ? LEVEL_NAME[l]! : null;
}

/**
 * Granting and revoking. The rules are checked here (clear error messages,
 * first lock) and again by the grants_guard trigger and row-level security
 * in the database (second lock). Revocation is a row delete: decide() and
 * tv_doc_level() both read grants live on every request, so nothing issued
 * earlier keeps working.
 */
@Injectable()
export class SharingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  async list(actor: Actor, documentId: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, documentId, 'view_access');
      const doc = await tx.document.findUniqueOrThrow({ where: { id: documentId }, select: { owner: { select: { id: true, displayName: true, email: true } } } });
      const grants = await tx.grant.findMany({
        where: { documentId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, level: true, expiresAt: true, createdAt: true,
          user: { select: { id: true, displayName: true, email: true, role: true, status: true } },
          group: { select: { id: true, name: true, _count: { select: { members: true } } } },
          _count: { select: { coveredMembers: true } },
          grantedBy: { select: { displayName: true } },
          downloadApproval: true, windowDays: true, windowStartMin: true, windowEndMin: true, windowTz: true, allowedCidrs: true,
          downloadApprover: { select: { id: true, displayName: true } },
        },
      });
      // Emergency exceptions: visible to the owner (row-level security).
      const overrides = await tx.accessOverride.findMany({
        where: { documentId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, reason: true, createdAt: true, expiresAt: true, user: { select: { id: true, displayName: true, email: true } } },
      });
      return {
        owner: doc.owner,
        overrides,
        grants: grants.map((g) => ({
          id: g.id, level: g.level, expiresAt: g.expiresAt, createdAt: g.createdAt, grantedBy: g.grantedBy.displayName,
          expired: g.expiresAt !== null && g.expiresAt <= new Date(),
          policy: {
            downloadApproval: g.downloadApproval,
            approver: g.downloadApprover ? { id: g.downloadApprover.id, name: g.downloadApprover.displayName } : null,
            window: windowOut(listOrNull(g.windowDays), g.windowStartMin, g.windowEndMin, g.windowTz),
            networks: listOrNull(g.allowedCidrs),
          },
          subject: g.user
            ? { type: 'user' as const, id: g.user.id, name: g.user.displayName, email: g.user.email, role: g.user.role, active: g.user.status === 'ACTIVE' }
            : { type: 'group' as const, id: g.group!.id, name: g.group!.name, members: g.group!._count.members, covered: g._count.coveredMembers, pending: Math.max(0, g.group!._count.members - g._count.coveredMembers) },
        })),
      };
    });
  }

  async grant(actor: Actor, documentId: string, input: GrantInput) {
    if (Boolean(input.userId) === Boolean(input.groupId)) throw new BadRequestException('Share with exactly one person or one group');
    // Validated before any transaction: clear messages, nothing half-written.
    const policy = input.policy ? {
      downloadApproval: input.policy.downloadApproval,
      approverId: input.policy.downloadApproval ? (input.policy.approverId ?? null) : null,
      window: windowColumns(input.policy.window),
      networks: networkColumns(input.policy.networks),
    } : null;
    if (input.policy?.approverId && !input.policy.downloadApproval) throw new BadRequestException('Nominate an approver only when downloads need approval');
    if (policy?.approverId && policy.approverId === input.userId) throw new BadRequestException('The person receiving the share cannot approve their own downloads');
    if (input.expiresAt) {
      if (input.expiresAt.getTime() <= Date.now()) throw new BadRequestException('Expiry must be in the future');
      if (input.expiresAt.getTime() > Date.now() + MAX_GRANT_DAYS * 86_400_000) throw new BadRequestException('Expiry can be at most one year away');
    }

    const result = await this.prisma.asUser(actor.userId, async (tx) => {
      const decision = await this.access.require(tx, actor, documentId, 'share');
      if (input.userId === actor.userId) throw new BadRequestException('You cannot change your own access');
      if (input.level === 'MANAGE' && decision.level < Level.OWNER) throw new ForbiddenException('Only the owner can give MANAGE access');

      const doc = await tx.document.findUniqueOrThrow({ where: { id: documentId }, select: { ownerId: true, title: true } });
      let expiresAt = input.expiresAt ?? null;
      let subject: Record<string, unknown>;

      if (input.userId) {
        if (input.userId === actor.userId) throw new BadRequestException('You cannot change your own access');
        if (input.userId === doc.ownerId) throw new BadRequestException('The owner already has full access');
        const target = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true, role: true, status: true, accessExpiresAt: true } });
        if (!target || target.status !== 'ACTIVE') throw new BadRequestException('That person does not have an active account');
        if (target.role === 'ADMIN') throw new BadRequestException('Administrators cannot be given access to documents');
        if (target.role === 'EXTERNAL') {
          // Externals: VIEW or READ. The apps suggest VIEW first (THREATS.md V10).
          if (input.level !== 'VIEW' && input.level !== 'READ') throw new BadRequestException('External people can only be given View only or Download access');
          // An external grant never outlives the external account.
          const cap = target.accessExpiresAt!;
          if (!expiresAt) throw new BadRequestException('Access for external people must have an expiry date');
          if (expiresAt > cap) expiresAt = cap;
        }
        subject = { type: 'user', id: target.id, email: target.email, role: target.role };
      } else {
        const group = await tx.group.findUnique({ where: { id: input.groupId! }, select: { id: true, name: true } });
        if (!group) throw new BadRequestException('Group not found');
        // A manager sharing with their own group would keep access through it
        // after the owner revokes them (THREATS.md R7). Only the owner may.
        if (decision.level < Level.OWNER && await tx.groupMember.findUnique({ where: { groupId_userId: { groupId: group.id, userId: actor.userId } }, select: { userId: true } })) {
          throw new ForbiddenException('Only the owner can share with a group you belong to');
        }
        subject = { type: 'group', id: group.id, name: group.name };
      }

      const existing = await tx.grant.findFirst({
        where: { documentId, ...(input.userId ? { userId: input.userId } : { groupId: input.groupId }) },
        select: { id: true, level: true, expiresAt: true, downloadApproval: true, windowDays: true, allowedCidrs: true },
      });
      // Only the owner may change or replace a MANAGE grant.
      if (existing?.level === 'MANAGE' && decision.level < Level.OWNER) throw new ForbiddenException('Only the owner can change MANAGE access');
      // Only the owner may change the conditions on an existing share; a
      // manager could otherwise lift what the owner set (THREATS.md P11).
      const hadConditions = Boolean(existing && (existing.downloadApproval || listOrNull(existing.windowDays) || listOrNull(existing.allowedCidrs)));
      if (hadConditions && policy && decision.level < Level.OWNER) throw new ForbiddenException('Only the owner can change the conditions on a share');
      if (policy?.approverId) {
        const approverLevel = await tx.$queryRaw<{ l: number }[]>`SELECT tv_doc_level(${documentId}::uuid, ${policy.approverId}::uuid) AS l`;
        if ((approverLevel[0]?.l ?? 0) < Level.MANAGE) throw new BadRequestException('The approver must be someone who can manage this document');
      }

      const saved = existing
        ? await tx.grant.update({ where: { id: existing.id }, data: { level: input.level, expiresAt, grantedById: actor.userId } })
        : await tx.grant.create({
            data: { documentId, userId: input.userId ?? null, groupId: input.groupId ?? null, level: input.level, expiresAt, grantedById: actor.userId },
          });

      if (policy) {
        // Raw SQL: a NULL list means "no rule", which the client cannot express for list columns.
        await tx.$executeRaw`
          UPDATE grants SET download_approval = ${policy.downloadApproval}, download_approver_id = ${policy.approverId}::uuid,
                 window_days = ${policy.window.days}::smallint[], window_start_min = ${policy.window.start}::smallint,
                 window_end_min = ${policy.window.end}::smallint, window_tz = ${policy.window.tz},
                 allowed_cidrs = ${policy.networks}::text[]
           WHERE id = ${saved.id}::uuid`;
      }

      // A group share covers the members there now; anyone added later waits
      // for the owner or a manager to confirm (THREATS.md A19).
      const covered = input.groupId
        ? (await tx.$queryRaw<{ n: number }[]>`SELECT tv_confirm_group_members(${saved.id}::uuid, ${actor.userId}::uuid) AS n`)[0]!.n
        : null;
      await this.audit.record({
        action: existing ? 'access.change' : 'access.grant', outcome: 'ALLOWED', targetType: 'grant', targetId: saved.id, documentId,
        details: {
          subject: subject as never, level: input.level, expiresAt: expiresAt?.toISOString() ?? null,
          previous: existing ? { level: existing.level, expiresAt: existing.expiresAt?.toISOString() ?? null } : null,
          source: input.fromSuggestion ? 'suggestion_confirmed_by_owner' : 'manual',
          ...(policy ? { policy: { downloadApproval: policy.downloadApproval, approverId: policy.approverId, window: policy.window.days ? { days: policy.window.days, start: policy.window.start, end: policy.window.end, tz: policy.window.tz } : null, networks: policy.networks } } : {}),
          ...(covered !== null ? { membersCovered: covered } : {}),
        },
      }, tx);
      return { id: saved.id, notice: input.userId && !existing ? { granteeId: input.userId, title: doc.title, level: input.level, expiresAt } : null };
    });
    // A person (not a group) newly given access hears about it, after the commit.
    if (result.notice) {
      const n = result.notice;
      this.notify.sharedWithYou(n.granteeId, actor.email, documentId, n.title, n.level, n.expiresAt);
    }
    return { id: result.id };
  }

  async revoke(actor: Actor, documentId: string, grantId: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      const decision = await this.access.require(tx, actor, documentId, 'share');
      const grant = await tx.grant.findFirst({
        where: { id: grantId, documentId },
        select: { id: true, level: true, userId: true, groupId: true, user: { select: { email: true } }, group: { select: { name: true } } },
      });
      if (!grant) throw new NotFoundException('Grant not found');
      if (grant.level === 'MANAGE' && decision.level < Level.OWNER && grant.userId !== actor.userId) {
        throw new ForbiddenException('Only the owner can remove MANAGE access');
      }
      // Open download requests and approvals of this person on this document
      // are cancelled with the share (trigger grants_cancel_approvals).
      const approvalsCancelled = grant.userId
        ? await tx.downloadApproval.count({ where: { documentId, requesterId: grant.userId, status: { in: ['PENDING', 'APPROVED'] } } })
        : 0;
      await tx.grant.delete({ where: { id: grant.id } });
      // Revoking a person's own grant does not touch group grants that also
      // cover them. Say so instead of claiming their access is gone (R7).
      const stillHas = grant.userId ? await remainingLevel(tx, documentId, grant.userId) : null;
      await this.audit.record({
        action: 'access.revoke', outcome: 'ALLOWED', targetType: 'grant', targetId: grant.id, documentId,
        details: { level: grant.level, stillHas, approvalsCancelled, subject: grant.userId ? { type: 'user', id: grant.userId, email: grant.user?.email ?? null } : { type: 'group', id: grant.groupId, name: grant.group?.name ?? null } },
      }, tx);
      return { stillHas };
    });
  }

  /**
   * Access suggestions. Looks at who this owner has shared documents of the
   * same category with before, and proposes those people or groups. This is
   * a suggestion only: it never creates a grant. The owner confirms each one
   * through the normal grant call, and both the suggestion and the decision
   * are written to the audit log.
   */
  async suggestions(actor: Actor, documentId: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, documentId, 'share');
      const doc = await tx.document.findUniqueOrThrow({ where: { id: documentId }, select: { ownerId: true, category: true } });
      const current = await tx.grant.findMany({ where: { documentId }, select: { userId: true, groupId: true } });
      const taken = new Set(current.flatMap((g) => [g.userId, g.groupId]).filter(Boolean) as string[]);
      taken.add(doc.ownerId);
      taken.add(actor.userId);

      // Grants on this owner's other documents in the same category. Visible
      // to the caller only if they can manage those documents (RLS).
      const similar = await tx.grant.findMany({
        where: { document: { ownerId: doc.ownerId, category: { equals: doc.category, mode: 'insensitive' }, status: 'ACTIVE', id: { not: documentId } } },
        select: {
          level: true,
          user: { select: { id: true, displayName: true, email: true, role: true, status: true } },
          group: { select: { id: true, name: true } },
        },
        take: 500,
      });

      const score = new Map<string, { type: 'user' | 'group'; id: string; name: string; detail: string; count: number; level: GrantLevel }>();
      for (const g of similar) {
        if (g.user && (g.user.status !== 'ACTIVE' || g.user.role === 'EXTERNAL')) continue; // never suggest externals or inactive accounts
        const key = g.user?.id ?? g.group?.id;
        if (!key || taken.has(key)) continue;
        const entry = score.get(key) ?? {
          type: g.user ? 'user' as const : 'group' as const, id: key,
          name: g.user?.displayName ?? g.group!.name, detail: g.user?.email ?? 'group', count: 0, level: 'VIEW' as GrantLevel,
        };
        entry.count += 1;
        // The highest level used before; never MANAGE (a MANAGE grant suggests READ, as before).
        const seen = g.level === 'MANAGE' ? 'READ' : g.level;
        if (SUGGEST_ORDER.indexOf(seen) > SUGGEST_ORDER.indexOf(entry.level)) entry.level = seen;
        score.set(key, entry);
      }
      const suggestions = [...score.values()].sort((a, b) => b.count - a.count).slice(0, 5).map((s) => ({
        ...s,
        why: `You shared ${s.count} other "${doc.category}" document${s.count === 1 ? '' : 's'} with ${s.type === 'group' ? 'this group' : 'them'}`,
      }));

      await this.audit.record({
        action: 'access.suggest', outcome: 'ALLOWED', targetType: 'document', targetId: documentId, documentId,
        details: { suggested: suggestions.map((s) => ({ type: s.type, id: s.id, level: s.level })) },
      }, tx);
      return { suggestions };
    });
  }
}
