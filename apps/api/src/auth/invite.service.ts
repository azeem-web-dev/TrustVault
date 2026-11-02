import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitService } from '../redis/rate-limit.service.js';
import { MailService } from '../mail/mail.service.js';
import { mailTemplates } from '../mail/templates.js';
import { currentContext, type Actor } from '../common/request-context.js';
import type { Role } from '../generated/prisma/enums.js';
import { PasswordSchema, PasswordService } from './password.service.js';

const sha256 = (v: string) => new Uint8Array(createHash('sha256').update(v).digest());
const INVALID = 'This invitation link is invalid or has expired. Ask your administrator to send a new one.';
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,60}$/;

/**
 * Accounts are created by invitation (THREATS.md S18).
 *
 * - The admin gives an email, a role and maybe an end date. The account
 *   starts INVITED, with a password hash of random bytes nobody knows, so it
 *   can neither sign in nor be given access (every check wants ACTIVE).
 * - The person gets a link with a 256-bit random token in the URL fragment.
 *   Only its SHA-256 is stored (in password_reset_tokens, purpose INVITE).
 *   It works once, expires (INVITE_LINK_HOURS), and sending again cancels
 *   earlier links. Reset links and invitation links never work for each other.
 * - Accepting sets the name and password the person chose and makes the
 *   account ACTIVE. The admin never knows the password. Admins still enrol a
 *   second factor at their first sign-in.
 */
@Injectable()
export class InviteService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}

  /** A password hash for a password nobody knows: an invited account cannot sign in. */
  unusablePasswordHash(): Promise<string> {
    return this.passwords.hash(randomBytes(32).toString('base64url'));
  }

  /** Admin: email the invitation (for a new account, or again). Earlier links stop working. */
  async send(actor: Actor, userId: string, again: boolean): Promise<{ sent: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true, role: true, status: true, isProtected: true, accessExpiresAt: true } });
    if (!user) throw new NotFoundException('User not found');
    if (user.status !== 'INVITED') throw new BadRequestException(user.status === 'ACTIVE' ? 'This person has already accepted their invitation' : 'Reactivate the account first');
    const reachable = this.mail.canReach(user);
    const token = reachable ? await this.issue(user.id, actor.userId) : null;
    const sent = token !== null;
    if (token) {
      const url = `${this.env.PUBLIC_ORIGIN}/invite#token=${token}`;
      this.mail.send(user, mailTemplates.invitation(user.displayName, url, user.role, this.env.INVITE_LINK_HOURS, user.accessExpiresAt));
    }
    await this.audit.record({
      action: 'user.invite', outcome: sent ? 'ALLOWED' : 'DENIED', reason: sent ? undefined : !reachable ? (user.isProtected ? 'demo_account' : 'mail_off') : 'not_invited',
      targetType: 'user', targetId: user.id, details: { email: user.email, role: user.role, again },
    });
    return { sent };
  }

  /** New link, under the user's row lock; null if the account stopped being INVITED meanwhile. */
  private async issue(userId: string, requestedBy: string): Promise<string | null> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.env.INVITE_LINK_HOURS * 3_600_000);
    return this.prisma.$transaction(async (tx) => {
      const [u] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      if (u?.status !== 'INVITED') return null;
      // A new link cancels any earlier one.
      await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null, purpose: 'INVITE' }, data: { usedAt: new Date() } });
      await tx.passwordResetToken.create({ data: { userId, tokenHash: sha256(token), expiresAt, requestedBy, purpose: 'INVITE' } });
      return token;
    });
  }

  /**
   * Anyone holding a valid link: who the invitation is for, so the page can
   * say "Joining as …". It tells the link holder only what the email told them.
   */
  async check(token: string): Promise<{ email: string; role: Role; accessExpiresAt: Date | null }> {
    await this.hitLimit();
    if (!TOKEN_SHAPE.test(token)) return this.refuse('auth.invite_check', 'malformed_link', null);
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(token) },
      select: { purpose: true, usedAt: true, expiresAt: true, user: { select: { id: true, email: true, role: true, status: true, isProtected: true, accessExpiresAt: true } } },
    });
    const reason = linkProblem(row && { purpose: row.purpose, used_at: row.usedAt, expires_at: row.expiresAt })
      ?? (row!.user.status !== 'INVITED' || row!.user.isProtected ? 'not_eligible' : null);
    if (reason) return this.refuse('auth.invite_check', reason, row?.user.id ?? null);
    return { email: row!.user.email, role: row!.user.role, accessExpiresAt: row!.user.accessExpiresAt };
  }

  /** Anyone holding a valid link: choose a name and password; the account becomes ACTIVE. */
  async accept(token: string, displayName: string, password: string): Promise<void> {
    await this.hitLimit();
    const parsed = PasswordSchema.safeParse(password);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]!.message);
    if (!TOKEN_SHAPE.test(token)) return this.refuse('auth.invite_accepted', 'malformed_link', null);
    const hash = await this.passwords.hash(password);
    const result = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string; user_id: string; purpose: string; expires_at: Date; used_at: Date | null }[]>`
        SELECT id, user_id, purpose, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ${sha256(token)} FOR UPDATE`;
      const problem = linkProblem(row ?? null);
      if (problem) return { refused: problem, userId: row?.user_id ?? null };
      const [u] = await tx.$queryRaw<{ id: string; email: string; status: string; is_protected: boolean }[]>`
        SELECT id, email, status, is_protected FROM users WHERE id = ${row!.user_id}::uuid FOR UPDATE`;
      if (!u || u.status !== 'INVITED' || u.is_protected) return { refused: 'not_eligible', userId: row!.user_id };
      const now = new Date();
      // This link and any other outstanding invitation for the account are spent.
      await tx.passwordResetToken.updateMany({ where: { userId: u.id, usedAt: null, purpose: 'INVITE' }, data: { usedAt: now } });
      await tx.user.update({
        where: { id: u.id },
        data: { displayName, passwordHash: hash, passwordChangedAt: now, status: 'ACTIVE', activatedAt: now, failedLoginCount: 0, lockedUntil: null },
      });
      await this.audit.record({ action: 'auth.invite_accepted', outcome: 'ALLOWED', actorId: u.id, actorEmail: u.email, targetType: 'user', targetId: u.id }, tx);
      return { refused: null, userId: u.id, email: u.email };
    });
    if (result.refused) return this.refuse('auth.invite_accepted', result.refused, result.userId);
    this.mail.send({ email: result.email!, displayName, isProtected: false }, mailTemplates.welcome(displayName, this.env.PUBLIC_ORIGIN));
  }

  /** Per IP, shared by check and accept. Guessing a 256-bit token is hopeless anyway; this keeps the noise down. */
  private async hitLimit(): Promise<void> {
    const ip = currentContext()?.ip ?? 'unknown';
    await this.limits.hit(`invite:ip:${ip}`, 20, 900, 'Too many attempts. Try again in a few minutes.');
  }

  /** Every refusal is recorded and gets the same answer. */
  private async refuse(action: string, reason: string, userId: string | null): Promise<never> {
    await this.audit.record({ action, outcome: 'DENIED', reason, actorId: null, actorEmail: null, targetType: 'user', targetId: userId ?? undefined });
    throw new BadRequestException(INVALID);
  }
}

/** Why a stored link cannot be used as an invitation, or null if it can. */
function linkProblem(row: { purpose: string; used_at: Date | null; expires_at: Date } | null): string | null {
  if (!row) return 'unknown_link';
  if (row.purpose !== 'INVITE') return 'wrong_link_type';
  if (row.used_at) return 'link_used';
  if (row.expires_at.getTime() <= Date.now()) return 'link_expired';
  return null;
}
