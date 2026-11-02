import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { InviteService } from '../auth/invite.service.js';
import { normaliseEmail } from '../auth/auth.service.js';
import type { Actor } from '../common/request-context.js';
import type { Role } from '../generated/prisma/enums.js';

export interface AdminUserView {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'ACTIVE' | 'DEACTIVATED' | 'INVITED';
  accessExpiresAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
  deactivatedAt: Date | null;
  activatedAt: Date | null;
  isProtected: boolean;
  totpEnabledAt: Date | null;
}

const VIEW = {
  id: true, email: true, displayName: true, role: true, status: true,
  accessExpiresAt: true, lockedUntil: true, createdAt: true, deactivatedAt: true, activatedAt: true, isProtected: true, totpEnabledAt: true,
} as const;

/** Published demo accounts (README) must stay usable for every visitor. THREATS.md I8. */
function assertNotProtected(u: { isProtected: boolean }): void {
  if (u.isProtected) throw new ForbiddenException('This is a protected demo account and cannot be changed');
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(InviteService) private readonly invites: InviteService,
  ) {}

  list(): Promise<AdminUserView[]> {
    return this.prisma.user.findMany({ select: VIEW, orderBy: { createdAt: 'asc' } });
  }

  /**
   * Creates an INVITED account (THREATS.md S18). The admin chooses no
   * password: the account gets one nobody knows, and the person picks their
   * own name and password from the emailed link (InviteService).
   */
  async create(actor: Actor, input: { email: string; role: Role; accessExpiresAt?: Date | undefined }): Promise<AdminUserView> {
    const email = normaliseEmail(input.email);
    checkExternalExpiry(input.role, input.accessExpiresAt ?? null);
    const passwordHash = await this.invites.unusablePasswordHash();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            // A placeholder until they choose their own name.
            email, displayName: email.split('@')[0]!.slice(0, 100) || email, role: input.role, passwordHash,
            status: 'INVITED', activatedAt: null, createdById: actor.userId,
            accessExpiresAt: input.accessExpiresAt ?? null,
          },
          select: VIEW,
        });
        await this.audit.record({ action: 'user.create', outcome: 'ALLOWED', targetType: 'user', targetId: user.id, details: { email, role: input.role, status: 'INVITED' } }, tx);
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
      assertNotProtected(before);
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
      // A changed access end date also ends sessions: an external whose access
      // had lapsed must not find an old cookie working again once it is
      // extended (THREATS.md R9).
      const expiryChanged = (accessExpiresAt?.getTime() ?? null) !== (before.accessExpiresAt?.getTime() ?? null);
      const ended = roleChanged || expiryChanged
        ? await this.sessions.revokeAllForUser(id, tx, undefined, roleChanged ? 'role_changed' : 'access_expiry_changed')
        : 0;
      // Admins never read documents, and only owners own them (THREATS.md A17,
      // A20): leaving OWNER is refused while the person owns documents;
      // becoming ADMIN or EXTERNAL drops their grants and groups; leaving
      // ADMIN ends any break-glass window. Done in the database, same lock.
      const promotion = roleChanged
        ? await tx.$queryRaw<{ r: { grantsRemoved: number; groupsLeft: number; breakGlassEnded: number } }[]>`SELECT tv_after_role_change(${id}::uuid, ${before.role}::"Role") AS r`.then(
            (rows) => rows[0]!.r,
            (err: unknown) => {
              if (String((err as Error).message).includes('before changing their role')) {
                throw new BadRequestException('This person owns documents. Transfer or delete them before changing their role.');
              }
              throw err;
            },
          )
        : null;
      await this.audit.record({
        action: 'user.update', outcome: 'ALLOWED', targetType: 'user', targetId: id,
        details: { from: { role: before.role, displayName: before.displayName, accessExpiresAt: before.accessExpiresAt?.toISOString() ?? null }, to: { role, displayName: user.displayName, accessExpiresAt: accessExpiresAt?.toISOString() ?? null }, sessionsEnded: ended, ...(promotion ? { promotion } : {}) },
      }, tx);
      return user;
    });
  }

  async deactivate(actor: Actor, id: string): Promise<AdminUserView> {
    if (id === actor.userId) throw new BadRequestException('You cannot deactivate your own account');
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockUser(tx, id);
      assertNotProtected(before);
      if (before.status === 'DEACTIVATED') return before;
      if (before.role === 'ADMIN') await this.ensureAnotherAdmin(tx, id);
      const user = await tx.user.update({ where: { id }, data: { status: 'DEACTIVATED', deactivatedAt: new Date() }, select: VIEW });
      const ended = await this.sessions.revokeAllForUser(id, tx, undefined, 'deactivated');
      // Outstanding invitation and reset links die with the account: this is
      // also how an admin cancels an invitation.
      const links = await tx.passwordResetToken.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: new Date() } });
      // An admin's open break-glass window must not outlive the account (A21).
      await tx.$queryRaw`SELECT tv_end_break_glass(${id}::uuid)`;
      await this.audit.record({ action: 'user.deactivate', outcome: 'ALLOWED', targetType: 'user', targetId: id, details: { sessionsEnded: ended, linksCancelled: links.count, wasInvited: before.status === 'INVITED' } }, tx);
      return user;
    });
  }

  async reactivate(id: string): Promise<AdminUserView> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockUser(tx, id);
      if (before.status !== 'DEACTIVATED') return before;
      // Someone who never accepted their invitation goes back to INVITED, not
      // ACTIVE: nobody knows their password. The admin sends the invitation again.
      const status = before.activatedAt ? 'ACTIVE' : 'INVITED';
      const user = await tx.user.update({ where: { id }, data: { status, deactivatedAt: null, failedLoginCount: 0, lockedUntil: null }, select: VIEW });
      await this.audit.record({ action: 'user.reactivate', outcome: 'ALLOWED', targetType: 'user', targetId: id, details: { status } }, tx);
      return user;
    });
  }

  async resetPassword(actor: Actor, id: string, password: string): Promise<void> {
    if (id === actor.userId) throw new BadRequestException('Use the change-password page for your own account');
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lockUser(tx, id);
      assertNotProtected(before);
      // An invited person chooses their own password from their link.
      if (!before.activatedAt) throw new BadRequestException('This person has not accepted their invitation yet');
      await tx.user.update({ where: { id }, data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
      const ended = await this.sessions.revokeAllForUser(id, tx, undefined, 'password_reset_by_admin');
      await this.audit.record({ action: 'user.password_reset', outcome: 'ALLOWED', targetType: 'user', targetId: id, details: { sessionsEnded: ended } }, tx);
    });
  }

  /** Clears a user's TOTP and passkeys (lost phone). They must enrol again; their sessions end. */
  async resetMfa(actor: Actor, id: string): Promise<void> {
    if (id === actor.userId) throw new BadRequestException('Another admin must reset your second factor');
    await this.prisma.$transaction(async (tx) => {
      assertNotProtected(await this.lockUser(tx, id));
      await tx.user.update({ where: { id }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null } });
      const removed = await tx.passkey.deleteMany({ where: { userId: id } });
      const ended = await this.sessions.revokeAllForUser(id, tx, undefined, 'second_factor_reset_by_admin');
      await this.audit.record({ action: 'user.mfa_reset', outcome: 'ALLOWED', targetType: 'user', targetId: id, details: { passkeysRemoved: removed.count, sessionsEnded: ended } }, tx);
    });
  }

  /**
   * The person's access lock, then their row, so two admins editing the same
   * user cannot interleave and none of the person's document requests is
   * half-way through a decision (THREATS.md R11). Access lock first: the
   * order every path uses. NO KEY UPDATE, not UPDATE, so it never blocks the
   * foreign-key checks of someone sharing with this person meanwhile.
   */
  private async lockUser(tx: Tx, id: string) {
    await tx.$executeRaw`SELECT tv_lock_user(${id}::uuid, true)`;
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
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
      SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND id <> ${exceptId}::uuid FOR NO KEY UPDATE`;
    if (admins.length === 0) throw new ConflictException('At least one active admin must remain');
  }
}

function checkExternalExpiry(role: Role, expiresAt: Date | null): void {
  if (role === 'EXTERNAL') {
    if (!expiresAt) throw new BadRequestException('External accounts need an access expiry date');
    if (expiresAt.getTime() <= Date.now()) throw new BadRequestException('Access expiry must be in the future');
  }
}
