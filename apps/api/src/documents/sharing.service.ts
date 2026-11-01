import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../common/request-context.js';
import type { GrantLevel } from '../generated/prisma/enums.js';
import { AccessService, Level } from './access.js';

export interface GrantInput {
  userId?: string | undefined;
  groupId?: string | undefined;
  level: GrantLevel;
  expiresAt?: Date | null | undefined;
  /** Set when the owner confirmed an access suggestion; recorded in the audit. */
  fromSuggestion?: boolean | undefined;
}

const MAX_GRANT_DAYS = 366;

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
          grantedBy: { select: { displayName: true } },
        },
      });
      return {
        owner: doc.owner,
        grants: grants.map((g) => ({
          id: g.id, level: g.level, expiresAt: g.expiresAt, createdAt: g.createdAt, grantedBy: g.grantedBy.displayName,
          expired: g.expiresAt !== null && g.expiresAt <= new Date(),
          subject: g.user
            ? { type: 'user' as const, id: g.user.id, name: g.user.displayName, email: g.user.email, role: g.user.role, active: g.user.status === 'ACTIVE' }
            : { type: 'group' as const, id: g.group!.id, name: g.group!.name, members: g.group!._count.members },
        })),
      };
    });
  }

  async grant(actor: Actor, documentId: string, input: GrantInput) {
    if (Boolean(input.userId) === Boolean(input.groupId)) throw new BadRequestException('Share with exactly one person or one group');
    if (input.expiresAt) {
      if (input.expiresAt.getTime() <= Date.now()) throw new BadRequestException('Expiry must be in the future');
      if (input.expiresAt.getTime() > Date.now() + MAX_GRANT_DAYS * 86_400_000) throw new BadRequestException('Expiry can be at most one year away');
    }

    return this.prisma.asUser(actor.userId, async (tx) => {
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
        if (target.role === 'EXTERNAL') {
          if (input.level !== 'READ') throw new BadRequestException('External people can only be given READ access');
          // An external grant never outlives the external account.
          const cap = target.accessExpiresAt!;
          if (!expiresAt) throw new BadRequestException('Access for external people must have an expiry date');
          if (expiresAt > cap) expiresAt = cap;
        }
        subject = { type: 'user', id: target.id, email: target.email, role: target.role };
      } else {
        const group = await tx.group.findUnique({ where: { id: input.groupId! }, select: { id: true, name: true } });
        if (!group) throw new BadRequestException('Group not found');
        subject = { type: 'group', id: group.id, name: group.name };
      }

      const existing = await tx.grant.findFirst({
        where: { documentId, ...(input.userId ? { userId: input.userId } : { groupId: input.groupId }) },
        select: { id: true, level: true, expiresAt: true },
      });
      // Only the owner may change or replace a MANAGE grant.
      if (existing?.level === 'MANAGE' && decision.level < Level.OWNER) throw new ForbiddenException('Only the owner can change MANAGE access');

      const saved = existing
        ? await tx.grant.update({ where: { id: existing.id }, data: { level: input.level, expiresAt, grantedById: actor.userId } })
        : await tx.grant.create({
            data: { documentId, userId: input.userId ?? null, groupId: input.groupId ?? null, level: input.level, expiresAt, grantedById: actor.userId },
          });

      await this.audit.record({
        action: existing ? 'access.change' : 'access.grant', outcome: 'ALLOWED', targetType: 'grant', targetId: saved.id, documentId,
        details: {
          subject: subject as never, level: input.level, expiresAt: expiresAt?.toISOString() ?? null,
          previous: existing ? { level: existing.level, expiresAt: existing.expiresAt?.toISOString() ?? null } : null,
          source: input.fromSuggestion ? 'suggestion_confirmed_by_owner' : 'manual',
        },
      }, tx);
      return { id: saved.id };
    });
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
      await tx.grant.delete({ where: { id: grant.id } });
      await this.audit.record({
        action: 'access.revoke', outcome: 'ALLOWED', targetType: 'grant', targetId: grant.id, documentId,
        details: { level: grant.level, subject: grant.userId ? { type: 'user', id: grant.userId, email: grant.user?.email ?? null } : { type: 'group', id: grant.groupId, name: grant.group?.name ?? null } },
      }, tx);
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
          name: g.user?.displayName ?? g.group!.name, detail: g.user?.email ?? 'group', count: 0, level: 'READ' as GrantLevel,
        };
        entry.count += 1;
        if (g.level === 'EDIT') entry.level = 'EDIT'; // never suggest MANAGE
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
