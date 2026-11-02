import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENV, type Env } from '../config/env.js';
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
  mfa: { required: boolean; enrolled: boolean; methods: ('totp' | 'passkey')[] };
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
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Every failed login takes at least LOGIN_FAILURE_FLOOR_MS. The failure
   * paths already do the same work (one Argon2 verify, one database
   * commit); the floor covers what is left, so the response time does not
   * say whether the email has an account. Measured in docs/LOGIN_TIMING.md.
   */
  async login(rawEmail: string, password: string, previousToken?: string): Promise<LoginResult> {
    const started = performance.now();
    try {
      return await this.attemptLogin(rawEmail, password, previousToken);
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        const wait = started + this.env.LOGIN_FAILURE_FLOOR_MS - performance.now();
        if (wait > 0) await sleep(wait);
      }
      throw err;
    }
  }

  private async attemptLogin(rawEmail: string, password: string, previousToken?: string): Promise<LoginResult> {
    const email = normaliseEmail(rawEmail);
    const ctx = currentContext();
    await this.enforceRateLimits(email, ctx?.ip ?? 'unknown');

    const user = await this.prisma.user.findUnique({ where: { email }, include: { _count: { select: { passkeys: true } } } });
    // Always run a full Argon2 verify, even for unknown accounts (dummy hash),
    // so response time does not reveal which emails exist.
    const passwordOk = await this.passwords.verify(user?.passwordHash ?? null, password);

    const deny = async (reason: string): Promise<never> => {
      await this.audit.record({ action: 'auth.login', outcome: 'DENIED', reason, actorId: user?.id ?? null, actorEmail: email });
      throw new UnauthorizedException(LOGIN_FAILED);
    };

    if (!user) return deny('unknown_account');
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return deny('account_locked');
    // An invitation not yet accepted: its password is random bytes nobody
    // knows, so this only names the reason in the audit log. The person sees
    // the same message as for any other failure.
    if (user.status === 'INVITED') return deny('account_not_activated');
    if (!passwordOk) {
      // Counter, lock and audit row in ONE SQL statement: the same single
      // round trip as every other failure path's audit write. Doing them as
      // separate queries made a wrong password on a real account measurably
      // slower than an unknown email (docs/LOGIN_TIMING.md). The UPDATE's
      // row lock keeps the counter exact when guesses arrive in parallel.
      await this.prisma.$executeRaw`
        WITH u AS (
          UPDATE users
             SET failed_login_count = failed_login_count + 1,
                 locked_until = CASE WHEN failed_login_count + 1 >= ${LOCK_AFTER}
                   THEN now() + make_interval(mins => LEAST(${LOCK_BASE_MINUTES} * power(2, failed_login_count + 1 - ${LOCK_AFTER}), ${LOCK_MAX_MINUTES})::int)
                   ELSE locked_until END
           WHERE id = ${user.id}::uuid
       RETURNING failed_login_count AS failures
        )
        INSERT INTO audit_events (id, actor_id, actor_email, action, outcome, reason, ip, user_agent, request_id)
        SELECT gen_random_uuid(), ${user.id}::uuid, ${email}, 'auth.login', 'DENIED'::"AuditOutcome",
               CASE WHEN failures >= ${LOCK_AFTER}
                 THEN 'wrong_password_locked_' || LEAST(${LOCK_BASE_MINUTES} * power(2, failures - ${LOCK_AFTER}), ${LOCK_MAX_MINUTES})::int || 'm'
                 ELSE 'wrong_password' END,
               ${ctx?.ip ?? null}, ${ctx?.userAgent ?? null}, ${ctx?.requestId ?? null}
          FROM u`;
      throw new UnauthorizedException(LOGIN_FAILED);
    }
    if (user.status !== 'ACTIVE') return deny('account_deactivated');
    if (user.accessExpiresAt && user.accessExpiresAt.getTime() <= Date.now()) return deny('access_expired');

    // Success: new session (a fresh token, never a reused one), counters
    // reset, and the old session from this browser — if any — ended.
    const result = await this.prisma.$transaction(async (tx) => {
      // The password was checked outside this transaction (Argon2 is slow). If
      // an admin reset the password, deactivated the account or it expired in
      // that window, the old password must not yield a session (THREATS.md R9).
      // The row lock orders this against those changes.
      const [now] = await tx.$queryRaw<{ password_hash: string; status: string; access_expires_at: Date | null }[]>`
        SELECT password_hash, status, access_expires_at FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      if (!now || now.password_hash !== user.passwordHash || now.status !== 'ACTIVE' || (now.access_expires_at && now.access_expires_at.getTime() <= Date.now())) {
        return null;
      }
      await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
      if (previousToken) {
        const old = await this.sessions.resolve(previousToken);
        if (old) await this.sessions.revoke(old.sessionId, tx, 'replaced_at_login');
      }
      const session = await this.sessions.create(user.id, { ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null }, tx);
      await this.audit.record({ action: 'auth.login', outcome: 'ALLOWED', actorId: user.id, actorEmail: user.email, targetType: 'user', targetId: user.id }, tx);
      return session;
    });
    if (!result) return deny('credentials_changed_during_login');
    await this.redis.reset(`rl:login:acct:${emailKey(email)}`).catch(() => undefined);

    const methods: ('totp' | 'passkey')[] = [];
    if (user.totpEnabledAt) methods.push('totp');
    if (user._count.passkeys > 0) methods.push('passkey');
    const enrolled = methods.length > 0;
    return {
      session: result,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
      mfa: { required: user.role === 'ADMIN' || enrolled, enrolled, methods },
    };
  }

  async logout(actor: Actor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.sessions.revoke(actor.sessionId, tx, 'logged_out');
      await this.audit.record({ action: 'auth.logout', outcome: 'ALLOWED', targetType: 'session', targetId: actor.sessionId }, tx);
    });
  }

  async me(actor: Actor): Promise<PublicUser> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
    return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
  }

  async changePassword(actor: Actor, current: string, next: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
    if (user.isProtected) throw new ForbiddenException('Demo account passwords cannot be changed');
    if (!(await this.passwords.verify(user.passwordHash, current))) {
      await this.audit.record({ action: 'auth.password_change', outcome: 'DENIED', reason: 'wrong_current_password', targetType: 'user', targetId: user.id });
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await this.passwords.hash(next);
    await this.prisma.$transaction(async (tx) => {
      // The person's access lock first, as every account change takes it (R11).
      await tx.$executeRaw`SELECT tv_lock_user(${user.id}::uuid, true)`;
      // passwordChangedAt makes every older session invalid on its next request;
      // the delete below just cleans them up immediately.
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });
      const ended = await this.sessions.revokeAllForUser(user.id, tx, undefined, 'password_changed');
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
