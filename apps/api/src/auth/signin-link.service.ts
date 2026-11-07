import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { mailTemplates } from '../mail/templates.js';
import { LoginThrottleService } from './login-throttle.service.js';

const sha256 = (v: string) => new Uint8Array(createHash('sha256').update(v).digest());
export const SIGNIN_TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,60}$/;

/**
 * One-time links that finish a sign-in while an account is under attack
 * (THREATS.md S27). The right password from an untrusted device emails one;
 * opening it gives the same session the password would have (the second
 * factor is still asked for if the account has one).
 *
 * Same storage and guarantees as reset and invitation links: a 256-bit
 * token in the URL fragment, only its SHA-256 stored (purpose SIGNIN), one
 * use, expiry (SIGNIN_LINK_MINUTES), a new link cancels earlier ones, and a
 * password change after the link was sent voids it.
 */
@Injectable()
export class SignInLinkService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(LoginThrottleService) private readonly throttle: LoginThrottleService,
  ) {}

  /** Email a link if the person can get mail and is under the hourly cap. Returns the audit reason. */
  async offer(user: { id: string; email: string; displayName: string; isProtected: boolean }, ip: string | null): Promise<'stepup_link_sent' | 'stepup_link_not_sent' | 'stepup_link_demo_mode'> {
    // Shared demo: the caller records the refused sign-in with this reason; no link is made or sent.
    if (this.env.DEMO_MODE) return 'stepup_link_demo_mode';
    if (!this.mail.canReach(user) || !(await this.throttle.mayEmailLink(user.email))) return 'stepup_link_not_sent';
    const token = randomBytes(32).toString('base64url');
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null, purpose: 'SIGNIN' }, data: { usedAt: new Date() } }),
      this.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + this.env.SIGNIN_LINK_MINUTES * 60_000), purpose: 'SIGNIN' },
      }),
    ]);
    this.mail.send(user, mailTemplates.signInLink(user.displayName, `${this.env.PUBLIC_ORIGIN}/signin-link#token=${token}`, this.env.SIGNIN_LINK_MINUTES, ip, new Date()));
    return 'stepup_link_sent';
  }

  /**
   * Inside the caller's transaction: spend the link, under row locks on the
   * link and the user (so two clicks race to one winner, and a password
   * change or deactivation in flight is seen). Returns the user id, or why not.
   */
  async consume(token: string, tx: Tx): Promise<{ userId: string; refused: null } | { userId: string | null; refused: string }> {
    const [row] = await tx.$queryRaw<{ id: string; user_id: string; purpose: string; expires_at: Date; used_at: Date | null; created_at: Date }[]>`
      SELECT id, user_id, purpose, expires_at, used_at, created_at FROM password_reset_tokens WHERE token_hash = ${sha256(token)} FOR UPDATE`;
    if (!row) return { userId: null, refused: 'unknown_link' };
    if (row.purpose !== 'SIGNIN') return { userId: row.user_id, refused: 'wrong_link_type' };
    if (row.used_at) return { userId: row.user_id, refused: 'link_used' };
    if (row.expires_at.getTime() <= Date.now()) return { userId: row.user_id, refused: 'link_expired' };
    const [u] = await tx.$queryRaw<{ status: string; access_expires_at: Date | null; password_changed_at: Date }[]>`
      SELECT status, access_expires_at, password_changed_at FROM users WHERE id = ${row.user_id}::uuid FOR UPDATE`;
    if (!u || u.status !== 'ACTIVE' || (u.access_expires_at && u.access_expires_at.getTime() <= Date.now())) return { userId: row.user_id, refused: 'not_eligible' };
    if (u.password_changed_at.getTime() > row.created_at.getTime()) return { userId: row.user_id, refused: 'password_changed' };
    await tx.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    return { userId: row.user_id, refused: null };
  }
}
