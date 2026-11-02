import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitService } from '../redis/rate-limit.service.js';
import { MailService } from '../mail/mail.service.js';
import { mailTemplates } from '../mail/templates.js';
import { currentContext, type Actor } from '../common/request-context.js';
import { PasswordSchema, PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { normaliseEmail } from './auth.service.js';

const sha256 = (v: string) => new Uint8Array(createHash('sha256').update(v).digest());
const INVALID = 'This link is invalid or has expired. Ask for a new one.';

/**
 * Password reset by email link (THREATS.md S16, S17).
 *
 * - Asking for a link always gets the same answer, so it cannot tell anyone
 *   which emails have accounts. The attempt is audited either way.
 * - The link carries a 256-bit random token in the URL fragment (never sent
 *   to a server or a Referer). Only its SHA-256 is stored. It works once,
 *   expires, and asking again cancels earlier links.
 * - Using it sets the password, signs the person out everywhere and emails
 *   them. It does not remove a second factor: an admin still needs theirs.
 * - Demo accounts (published, protected) can never be reset this way.
 * - An admin can send a link but never sees or sets the new password, which
 *   closes the impersonation route in THREATS.md S15.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /** Anyone: "email me a link". Same answer whatever happens. */
  async request(rawEmail: string): Promise<void> {
    const email = normaliseEmail(rawEmail);
    const ip = currentContext()?.ip ?? 'unknown';
    await this.limits.hit(`reset:ip:${ip}`, 10, 900, 'Too many reset requests. Try again in a few minutes.');
    // Per address: quietly stop sending (a 429 here would reveal that the address exists).
    let underLimit = true;
    try {
      await this.limits.hit(`reset:acct:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`, 3, 3600);
    } catch {
      underLimit = false;
    }
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, email: true, displayName: true, status: true, isProtected: true, accessExpiresAt: true } });
    const eligible = Boolean(user && user.status === 'ACTIVE' && !user.isProtected && !(user.accessExpiresAt && user.accessExpiresAt.getTime() <= Date.now()));
    const reason = !user ? 'no_account' : !eligible ? 'not_eligible' : !underLimit ? 'rate_limited' : !this.mail.canReach(user) ? 'mail_off' : 'sent';
    if (reason === 'sent') await this.issue(user!, null);
    await this.audit.record({
      action: 'auth.reset_requested', outcome: reason === 'sent' ? 'ALLOWED' : 'DENIED', reason,
      actorId: null, actorEmail: email, targetType: 'user', targetId: user?.id,
    });
  }

  /** Admin: email the person a link. The admin never learns the new password. */
  async adminSend(actor: Actor, userId: string): Promise<{ sent: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true, status: true, isProtected: true } });
    if (!user) throw new NotFoundException('User not found');
    if (user.status === 'INVITED') throw new BadRequestException('This person has not accepted their invitation yet. Send the invitation again instead.');
    if (user.status !== 'ACTIVE') throw new BadRequestException('Reactivate the account first');
    const sent = this.mail.canReach(user);
    if (sent) await this.issue(user, actor.userId);
    await this.audit.record({ action: 'user.reset_link_sent', outcome: sent ? 'ALLOWED' : 'DENIED', reason: sent ? undefined : user.isProtected ? 'demo_account' : 'mail_off', targetType: 'user', targetId: user.id, details: { email: user.email } });
    return { sent };
  }

  private async issue(user: { id: string; email: string; displayName: string; isProtected: boolean }, requestedBy: string | null): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.env.RESET_LINK_MINUTES * 60_000);
    await this.prisma.$transaction([
      // A new link cancels any earlier one.
      this.prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null, purpose: 'RESET' }, data: { usedAt: new Date() } }),
      this.prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt, requestedBy, purpose: 'RESET' } }),
    ]);
    const url = `${this.env.PUBLIC_ORIGIN}/reset#token=${token}`;
    this.mail.send(user, mailTemplates.resetLink(user.displayName, url, this.env.RESET_LINK_MINUTES, requestedBy !== null));
  }

  /** Anyone holding a valid link: set a new password. */
  async reset(token: string, newPassword: string): Promise<void> {
    const parsed = PasswordSchema.safeParse(newPassword);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]!.message);
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
      await this.audit.record({ action: 'auth.password_reset_link', outcome: 'DENIED', reason: 'malformed_link', actorId: null, actorEmail: null });
      throw new BadRequestException(INVALID);
    }
    const hash = await this.passwords.hash(newPassword);
    const user = await this.prisma.$transaction(async (tx) => {
      // The person's access lock before any row lock, the order every account
      // change uses (THREATS.md R11).
      const [owner] = await tx.$queryRaw<{ user_id: string }[]>`SELECT user_id FROM password_reset_tokens WHERE token_hash = ${sha256(token)}`;
      if (owner) await tx.$executeRaw`SELECT tv_lock_user(${owner.user_id}::uuid, true)`;
      const [row] = await tx.$queryRaw<{ id: string; user_id: string; purpose: string; expires_at: Date; used_at: Date | null }[]>`
        SELECT id, user_id, purpose, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ${sha256(token)} FOR UPDATE`;
      if (!row) return { refused: 'unknown_link', userId: null };
      // An invitation link is not a reset link (InviteService), and the reverse.
      if (row.purpose !== 'RESET') return { refused: 'wrong_link_type', userId: row.user_id };
      if (row.used_at || row.expires_at.getTime() <= Date.now()) return { refused: row.used_at ? 'link_used' : 'link_expired', userId: row.user_id };
      const [u] = await tx.$queryRaw<{ id: string; email: string; display_name: string; status: string; is_protected: boolean }[]>`
        SELECT id, email, display_name, status, is_protected FROM users WHERE id = ${row.user_id}::uuid FOR UPDATE`;
      if (!u || u.status !== 'ACTIVE' || u.is_protected) return { refused: 'not_eligible', userId: row.user_id };
      await tx.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
      await tx.user.update({ where: { id: u.id }, data: { passwordHash: hash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
      const ended = await this.sessions.revokeAllForUser(u.id, tx, undefined, 'password_reset_by_link');
      await this.audit.record({ action: 'auth.password_reset_link', outcome: 'ALLOWED', actorId: u.id, actorEmail: u.email, targetType: 'user', targetId: u.id, details: { sessionsEnded: ended } }, tx);
      return { refused: null, userId: u.id, email: u.email, name: u.display_name };
    });
    if (user.refused) {
      await this.audit.record({ action: 'auth.password_reset_link', outcome: 'DENIED', reason: user.refused, actorId: null, actorEmail: null, targetType: 'user', targetId: user.userId ?? undefined });
      throw new BadRequestException(INVALID);
    }
    this.mail.send({ email: user.email!, displayName: user.name!, isProtected: false }, mailTemplates.passwordChanged(user.name!, 'with a reset link', new Date(), this.env.PUBLIC_ORIGIN));
  }
}
