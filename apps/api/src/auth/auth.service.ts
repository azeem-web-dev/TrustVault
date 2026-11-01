import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RedisService } from '../redis/redis.service.js';
import { currentContext, type Actor } from '../common/request-context.js';
import { logger } from '../common/logger.js';
import { PasswordService } from './password.service.js';
import { SessionService, type NewSession } from './session.service.js';
import type { Role } from '../generated/prisma/enums.js';

/** One message for every login failure, so responses never reveal whether an account exists. */
const LOGIN_FAILED = 'Invalid email or password';

/** Per IP: 20 attempts per 15 minutes. Per account: 10 per 15 minutes. */
const IP_LIMIT = { max: 20, windowSeconds: 15 * 60 };
const ACCOUNT_LIMIT = { max: 10, windowSeconds: 15 * 60 };
/** After 5 consecutive failures the account locks, doubling each time, up to 24h. */
const LOCK_AFTER = 5;
const LOCK_BASE_MINUTES = 15;
const LOCK_MAX_MINUTES = 24 * 60;

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface LoginResult {
  session: NewSession;
  user: PublicUser;
}

export const normaliseEmail = (email: string): string => email.trim().toLowerCase();
const emailKey = (email: string): string => createHash('sha256').update(email).digest('hex').slice(0, 32);

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async login(rawEmail: string, password: string, previousToken?: string): Promise<LoginResult> {
    const email = normaliseEmail(rawEmail);
    const ctx = currentContext();
    await this.enforceRateLimits(email, ctx?.ip ?? 'unknown');

    const user = await this.prisma.user.findUnique({ where: { email } });
    // Always run a full Argon2 verify, even for unknown accounts (dummy hash),
    // so response time does not reveal which emails exist.
    const passwordOk = await this.passwords.verify(user?.passwordHash ?? null, password);

    const deny = async (reason: string): Promise<never> => {
      await this.audit.record({ action: 'auth.login', outcome: 'DENIED', reason, actorId: user?.id ?? null, actorEmail: email });
      throw new UnauthorizedException(LOGIN_FAILED);
    };

    if (!user) return deny('unknown_account');
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return deny('account_locked');
    if (!passwordOk) {
      // Atomic increment: parallel wrong guesses each count, none are lost.
      const { failedLoginCount: failures } = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      const lockMinutes = failures >= LOCK_AFTER
        ? Math.min(LOCK_BASE_MINUTES * 2 ** (failures - LOCK_AFTER), LOCK_MAX_MINUTES)
        : 0;
      if (lockMinutes > 0) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { lockedUntil: new Date(Date.now() + lockMinutes * 60_000) },
        });
      }
      return deny(lockMinutes > 0 ? `wrong_password_locked_${lockMinutes}m` : 'wrong_password');
    }
    if (user.status !== 'ACTIVE') return deny('account_deactivated');
    if (user.accessExpiresAt && user.accessExpiresAt.getTime() <= Date.now()) return deny('access_expired');

    // Success: new session (a fresh token, never a reused one), counters
    // reset, and the old session from this browser — if any — ended.
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
      if (previousToken) {
        const old = await this.sessions.resolve(previousToken);
        if (old) await this.sessions.revoke(old.sessionId, tx);
      }
      const session = await this.sessions.create(user.id, { ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null }, tx);
      await this.audit.record({ action: 'auth.login', outcome: 'ALLOWED', actorId: user.id, actorEmail: user.email, targetType: 'user', targetId: user.id }, tx);
      return session;
    });
    await this.redis.reset(`rl:login:acct:${emailKey(email)}`).catch(() => undefined);

    return { session: result, user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } };
  }

  async logout(actor: Actor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.sessions.revoke(actor.sessionId, tx);
      await this.audit.record({ action: 'auth.logout', outcome: 'ALLOWED', targetType: 'session', targetId: actor.sessionId }, tx);
    });
  }

  async me(actor: Actor): Promise<PublicUser> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
    return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
  }

  async changePassword(actor: Actor, current: string, next: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
    if (!(await this.passwords.verify(user.passwordHash, current))) {
      await this.audit.record({ action: 'auth.password_change', outcome: 'DENIED', reason: 'wrong_current_password', targetType: 'user', targetId: user.id });
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await this.passwords.hash(next);
    await this.prisma.$transaction(async (tx) => {
      // passwordChangedAt makes every older session invalid on its next request;
      // the delete below just cleans them up immediately.
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });
      const ended = await this.sessions.revokeAllForUser(user.id, tx);
      await this.audit.record({ action: 'auth.password_change', outcome: 'ALLOWED', targetType: 'user', targetId: user.id, details: { sessionsEnded: ended } }, tx);
    });
  }

  private async enforceRateLimits(email: string, ip: string): Promise<void> {
    let ipHits, acctHits;
    try {
      [ipHits, acctHits] = await Promise.all([
        this.redis.consume(`rl:login:ip:${ip}`, IP_LIMIT.windowSeconds),
        this.redis.consume(`rl:login:acct:${emailKey(email)}`, ACCOUNT_LIMIT.windowSeconds),
      ]);
    } catch (err) {
      // Fail closed: without the limiter, logins would be open to brute force.
      logger.error({ err }, 'rate limiter unavailable');
      throw new ServiceUnavailableException('Sign-in temporarily unavailable');
    }
    const blocked = ipHits.count > IP_LIMIT.max ? ipHits : acctHits.count > ACCOUNT_LIMIT.max ? acctHits : null;
    if (blocked) {
      await this.audit.record({ action: 'auth.login', outcome: 'DENIED', reason: ipHits.count > IP_LIMIT.max ? 'rate_limited_ip' : 'rate_limited_account', actorId: null, actorEmail: email });
      throw new HttpException({ message: 'Too many attempts. Try again later.', retryAfterSeconds: blocked.retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
