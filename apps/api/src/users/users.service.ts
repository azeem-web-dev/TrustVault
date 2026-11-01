import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { normaliseEmail } from '../auth/auth.service.js';
import type { Actor } from '../common/request-context.js';
import type { Role } from '../generated/prisma/enums.js';

export interface AdminUserView {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'ACTIVE' | 'DEACTIVATED';
  accessExpiresAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
  deactivatedAt: Date | null;
}

const VIEW = {
  id: true, email: true, displayName: true, role: true, status: true,
  accessExpiresAt: true, lockedUntil: true, createdAt: true, deactivatedAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  list(): Promise<AdminUserView[]> {
    return this.prisma.user.findMany({ select: VIEW, orderBy: { createdAt: 'asc' } });
  }

  async create(input: { email: string; displayName: string; role: Role; password: string; accessExpiresAt?: Date | undefined }): Promise<AdminUserView> {
    const email = normaliseEmail(input.email);
    checkExternalExpiry(input.role, input.accessExpiresAt ?? null);
    const passwordHash = await this.passwords.hash(input.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email, displayName: input.displayName.trim(), role: input.role, passwordHash,
            accessExpiresAt: input.accessExpiresAt ?? null,
          },
          select: VIEW,
        });
        await this.audit.record({ action: 'user.create', outcome: 'ALLOWED', targetType: 'user', targetId: user.id, details: { email, role: input.role } }, tx);
        return user;
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ConflictException('A user with that email already exists');
      throw err;
    }
  }

  async update(actor: Actor, id: string, patch: { displayName?: string | undefined; role?: Role | undefined; accessExpiresAt?: Date | null | undefined }): Promise<AdminUserView> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockUser(tx, id);
      const role = patch.role ?? before.role;
      const accessExpiresAt = patch.accessExpiresAt !== undefined ? patch.accessExpiresAt : before.accessExpiresAt;
      checkExternalExpiry(role, accessExpiresAt);
      if (patch.role && patch.role !== before.role) {
        if (id === actor.userId) throw new BadRequestException('You cannot change your own role');
        if (before.role === 'ADMIN') await this.ensureAnotherAdmin(tx, id);
      }
      const user = await tx.user.update({
        where: { id },
        data: { displayName: patch.displayName?.trim(), role, accessExpiresAt },
        select: VIEW,
      });
      // A role change alters what the person may do, so their existing
      // sessions end now rather than carrying the old role.
      const roleChanged = role !== before.role;
      const ended = roleChanged ? await this.sessions.revokeAllForUser(id, tx) : 0;
      await this.audit.record({
        action: 'user.update', outcome: 'ALLOWED', targetType: 'user', targetId: id,
        details: { from: { role: before.role, displayName: before.displayName, accessExpiresAt: before.accessExpiresAt?.toISOString() ?? null }, to: { role, displayName: user.displayName, accessExpiresAt: accessExpiresAt?.toISOString() ?? null }, sessionsEnded: ended },
      }, tx);
      return user;
    });
  }

  async deactivate(actor: Actor, id: string): Promise<AdminUserView> {
    if (id === actor.userId) throw new BadRequestException('You cannot deactivate your own account');
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockUser(tx, id);
      if (before.status === 'DEACTIVATED') return before;
      if (before.role === 'ADMIN') await this.ensureAnotherAdmin(tx, id);
      const user = await tx.user.update({ where: { id }, data: { status: 'DEACTIVATED', deactivatedAt: new Date() }, select: VIEW });
      const ended = await this.sessions.revokeAllForUser(id, tx);
      await this.audit.record({ action: 'user.deactivate', outcome: 'ALLOWED', targetType: 'user', targetId: id, details: { sessionsEnded: ended } }, tx);
      return user;
    });
  }

  async reactivate(id: string): Promise<AdminUserView> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockUser(tx, id);
      if (before.status === 'ACTIVE') return before;
      const user = await tx.user.update({ where: { id }, data: { status: 'ACTIVE', deactivatedAt: null, failedLoginCount: 0, lockedUntil: null }, select: VIEW });
      await this.audit.record({ action: 'user.reactivate', outcome: 'ALLOWED', targetType: 'user', targetId: id }, tx);
      return user;
    });
  }

  async resetPassword(actor: Actor, id: string, password: string): Promise<void> {
    if (id === actor.userId) throw new BadRequestException('Use the change-password page for your own account');
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, id);
      await tx.user.update({ where: { id }, data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
      const ended = await this.sessions.revokeAllForUser(id, tx);
      await this.audit.record({ action: 'user.password_reset', outcome: 'ALLOWED', targetType: 'user', targetId: id, details: { sessionsEnded: ended } }, tx);
    });
  }

  /** Row lock so two admins editing the same user cannot interleave. */
  private async lockUser(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('User not found');
    return tx.user.findUniqueOrThrow({ where: { id }, select: { ...VIEW } });
  }

  /**
   * Refuse to remove the last active admin. All active admin rows are locked
   * first, so two admins demoting each other at the same moment cannot both
   * succeed and leave nobody in charge.
   */
  private async ensureAnotherAdmin(tx: Tx, exceptId: string): Promise<void> {
    const admins = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND id <> ${exceptId}::uuid FOR UPDATE`;
    if (admins.length === 0) throw new ConflictException('At least one active admin must remain');
  }
}

function checkExternalExpiry(role: Role, expiresAt: Date | null): void {
  if (role === 'EXTERNAL') {
    if (!expiresAt) throw new BadRequestException('External accounts need an access expiry date');
    if (expiresAt.getTime() <= Date.now()) throw new BadRequestException('Access expiry must be in the future');
  }
}
