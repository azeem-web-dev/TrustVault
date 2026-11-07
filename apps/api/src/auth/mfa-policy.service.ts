import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../common/request-context.js';
import type { Role } from '../generated/prisma/enums.js';
import { ENV, type Env } from '../config/env.js';
import { demoModeRefusal } from '../common/demo-mode.js';

const ORDER: Role[] = ['ADMIN', 'OWNER', 'VIEWER', 'EXTERNAL'];

/**
 * Which roles must use a second factor (THREATS.md S21). ADMIN always; the
 * others are an admin setting stored in app_settings.
 *
 * Read on every request (one indexed single-row read), never cached: a
 * policy change binds every existing session on its next request. A session
 * that already passed a second factor stays valid; a password-only session
 * of a newly covered role is sent to enrol (SecurityGuard step 4).
 */
@Injectable()
export class MfaPolicyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async requiredRoles(tx?: Tx): Promise<Role[]> {
    const row = await (tx ?? this.prisma).appSettings.findUnique({ where: { id: 1 }, select: { mfaRequiredRoles: true } });
    // A missing row fails safe to the minimum, never to "nobody".
    return normalise(row?.mfaRequiredRoles ?? ['ADMIN']);
  }

  /** The rule itself: a covered role, or anyone who has enrolled a factor. */
  static isRequired(role: Role, enrolled: boolean, roles: readonly Role[]): boolean {
    return role === 'ADMIN' || roles.includes(role) || enrolled;
  }

  async update(actor: Actor, roles: Role[]): Promise<Role[]> {
    if (!roles.includes('ADMIN')) throw new BadRequestException('Administrators always need a second factor');
    const to = normalise(roles);
    // Shared demo: the published owner, viewer and external accounts cannot
    // enrol a factor (they are protected), so covering their role locks them out.
    if (this.env.DEMO_MODE && to.some((r) => r !== 'ADMIN')) {
      await this.audit.record({ action: 'settings.mfa_policy', outcome: 'DENIED', reason: 'demo_mode', targetType: 'settings', targetId: 'mfa_policy', details: { to } });
      throw demoModeRefusal('requiring a second factor for roles other than ADMIN');
    }
    return this.prisma.asUser(actor.userId, async (tx) => {
      // Row lock: two admins changing it at once are applied one after the other.
      const [row] = await tx.$queryRaw<{ roles: Role[] }[]>`SELECT mfa_required_roles::text[] AS roles FROM app_settings WHERE id = 1 FOR UPDATE`;
      const from = normalise(row?.roles ?? ['ADMIN']);
      await tx.appSettings.update({ where: { id: 1 }, data: { mfaRequiredRoles: to, updatedAt: new Date(), updatedById: actor.userId } });
      await this.audit.record({ action: 'settings.mfa_policy', outcome: 'ALLOWED', targetType: 'settings', targetId: 'mfa_policy', details: { from, to } }, tx);
      return to;
    });
  }
}

/**
 * Emailed codes count as a second factor for this account (THREATS.md S30).
 * Never for an ADMIN (their mailbox must not be enough to become them) or a
 * demo account (they get no mail); the database refuses both as well.
 */
export function emailCodesOn(u: { role: Role; emailOtpEnabledAt: Date | null; isProtected: boolean }): boolean {
  return u.emailOtpEnabledAt !== null && u.role !== 'ADMIN' && !u.isProtected;
}

function normalise(roles: readonly Role[]): Role[] {
  const set = new Set<Role>(['ADMIN', ...roles]);
  return ORDER.filter((r) => set.has(r));
}
