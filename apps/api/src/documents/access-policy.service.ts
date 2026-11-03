import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../common/request-context.js';
import type { Role } from '../generated/prisma/enums.js';
import { NotifyService } from '../mail/notify.service.js';
import { AccessService } from './access.js';
import { listOrNull, networkColumns, type WindowInput, windowColumns, windowOut } from './policy-input.js';

const MAX_OVERRIDE_HOURS = 24;

/**
 * Emergency exceptions and organisation-wide role rules (THREATS.md P4, P12).
 *
 * An exception is the owner lifting one share's conditions (time window,
 * network, download approval) for one person on one document, for at most
 * 24 hours, with a written reason. It never raises the level the share
 * gives and never lifts the role rules. It is audited, the person is told,
 * and the owner gets an emailed receipt (so a hijacked owner session that
 * hands out exceptions is noticed).
 *
 * Role rules are set by administrators: a time window and/or networks for
 * everyone with a role, on every document shared with them. They only ever
 * narrow access; owners' own documents are not affected.
 */
@Injectable()
export class AccessPolicyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  async createOverride(actor: Actor, documentId: string, input: { userId: string; reason: string; hours: number }) {
    if (input.hours < 1 || input.hours > MAX_OVERRIDE_HOURS) throw new BadRequestException(`An exception lasts 1 to ${MAX_OVERRIDE_HOURS} hours`);
    const result = await this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, documentId, 'override');
      if (input.userId === actor.userId) throw new BadRequestException('You already have full access to your own document');
      const share = await tx.grant.findFirst({
        where: { documentId, OR: [{ userId: input.userId }, { coveredMembers: { some: { userId: input.userId } } }] },
        select: { id: true },
      });
      if (!share) throw new BadRequestException('That person has no share on this document; an exception only lifts the conditions of a share');
      const target = await tx.user.findUnique({ where: { id: input.userId }, select: { email: true } });
      const expiresAt = new Date(Date.now() + input.hours * 3_600_000);
      const row = await tx.accessOverride.create({
        data: { documentId, userId: input.userId, createdById: actor.userId, reason: input.reason, expiresAt },
        select: { id: true, expiresAt: true },
      });
      const doc = await tx.document.findUniqueOrThrow({ where: { id: documentId }, select: { title: true } });
      await this.audit.record({
        action: 'access.override', outcome: 'ALLOWED', targetType: 'access_override', targetId: row.id, documentId,
        details: { userId: input.userId, userEmail: target?.email ?? null, reason: input.reason, expiresAt: row.expiresAt.toISOString() },
      }, tx);
      return { row, title: doc.title };
    });
    this.notify.overrideGiven(input.userId, actor.userId, actor.email, documentId, result.title, result.row.expiresAt, input.reason);
    return { id: result.row.id, expiresAt: result.row.expiresAt };
  }

  async endOverride(actor: Actor, documentId: string, overrideId: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, documentId, 'override');
      const row = await tx.accessOverride.findFirst({ where: { id: overrideId, documentId }, select: { id: true, userId: true } });
      if (!row) throw new NotFoundException('Exception not found');
      const ended = await tx.$queryRaw<{ ok: boolean }[]>`SELECT tv_end_override(${overrideId}::uuid) AS ok`;
      if (!ended[0]?.ok) throw new BadRequestException('This exception has already ended');
      await this.audit.record({ action: 'access.override_end', outcome: 'ALLOWED', targetType: 'access_override', targetId: row.id, documentId, details: { userId: row.userId } }, tx);
    });
  }

  // ---------------------------------------------------------------- roles

  async listRolePolicies(actor: Actor) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      const rows = await tx.roleAccessPolicy.findMany({ orderBy: { role: 'asc' }, include: { updatedBy: { select: { displayName: true } } } });
      return rows.map((r) => ({
        role: r.role,
        window: windowOut(listOrNull(r.windowDays), r.windowStartMin, r.windowEndMin, r.windowTz),
        networks: listOrNull(r.allowedCidrs),
        updatedBy: r.updatedBy.displayName, updatedAt: r.updatedAt,
      }));
    });
  }

  async setRolePolicy(actor: Actor, role: Role, input: { window?: WindowInput | null | undefined; networks?: string[] | null | undefined }) {
    if (role === 'ADMIN') throw new BadRequestException('Administrators never reach documents through shares; there is nothing to restrict');
    const w = windowColumns(input.window);
    const networks = networkColumns(input.networks);
    return this.prisma.asUser(actor.userId, async (tx) => {
      const before = await tx.roleAccessPolicy.findUnique({ where: { role } });
      await tx.$executeRaw`
        INSERT INTO role_access_policies (role, window_days, window_start_min, window_end_min, window_tz, allowed_cidrs, updated_by_id)
        VALUES (${role}::"Role", ${w.days}::smallint[], ${w.start}::smallint, ${w.end}::smallint, ${w.tz}, ${networks}::text[], ${actor.userId}::uuid)
        ON CONFLICT (role) DO UPDATE SET window_days = EXCLUDED.window_days, window_start_min = EXCLUDED.window_start_min,
          window_end_min = EXCLUDED.window_end_min, window_tz = EXCLUDED.window_tz, allowed_cidrs = EXCLUDED.allowed_cidrs,
          updated_by_id = EXCLUDED.updated_by_id`;
      await this.audit.record({
        action: 'policy.role_set', outcome: 'ALLOWED', targetType: 'role', targetId: role,
        details: {
          role, window: w.days ? { days: w.days, start: w.start, end: w.end, tz: w.tz } : null, networks,
          previous: before ? { window: before.windowTz ? { days: before.windowDays, start: before.windowStartMin, end: before.windowEndMin, tz: before.windowTz } : null, networks: listOrNull(before.allowedCidrs) } : null,
        },
      }, tx);
      return { role, window: windowOut(w.days, w.start, w.end, w.tz), networks };
    });
  }

  async clearRolePolicy(actor: Actor, role: Role) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      const r = await tx.roleAccessPolicy.deleteMany({ where: { role } });
      if (r.count === 0) throw new NotFoundException('No rules for that role');
      await this.audit.record({ action: 'policy.role_clear', outcome: 'ALLOWED', targetType: 'role', targetId: role, details: { role } }, tx);
    });
  }
}
