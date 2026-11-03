import { BadRequestException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENV, type Env } from '../config/env.js';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitService } from '../redis/rate-limit.service.js';
import { currentContext, type Actor } from '../common/request-context.js';
import { PasswordService } from './password.service.js';
import { SessionService, type NewSession } from './session.service.js';
import { MfaPolicyService } from './mfa-policy.service.js';
import { DeviceTrustService } from './device-trust.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { SIGNIN_TOKEN_SHAPE, SignInLinkService } from './signin-link.service.js';
import type { Role } from '../generated/prisma/enums.js';

/** One message for every login failure, so responses never reveal whether an account exists. */
const LOGIN_FAILED = 'Invalid email or password';
const LINK_INVALID = 'This sign-in link is invalid or has expired. Sign in again to get a new one.';

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

/** The account is under attack and this device is not trusted: no session from the password alone. */
export interface StepUpResult {
  stepUp: true;
}

export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

interface LoginUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  totpEnabledAt: Date | null;
  _count: { passkeys: number };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ENV) private readonly env: Env,
    @Inject(MfaPolicyService) private readonly policy: MfaPolicyService,
    @Inject(LoginThrottleService) private readonly throttle: LoginThrottleService,
    @Inject(DeviceTrustService) private readonly devices: DeviceTrustService,
    @Inject(SignInLinkService) private readonly links: SignInLinkService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
  ) {}

  /**
   * Every failed login — and every "check your email" answer while the
   * account is under attack — takes at least LOGIN_FAILURE_FLOOR_MS. The
   * failure paths already do the same work (one Argon2 verify, one audit
   * insert, the same Redis calls); the floor covers what is left, so the
   * response time says neither whether the email has an account nor whether
   * the password was right. Checked by test/timing.test.ts.
   */
  async login(rawEmail: string, password: string, previousToken?: string): Promise<LoginResult | StepUpResult> {
    const started = performance.now();
    const pad = async () => {
      const wait = started + this.env.LOGIN_FAILURE_FLOOR_MS - performance.now();
      if (wait > 0) await sleep(wait);
    };
    try {
      const result = await this.attemptLogin(rawEmail, password, previousToken);
      if ('stepUp' in result) await pad();
      return result;
    } catch (err) {
      if (err instanceof UnauthorizedException) await pad();
      throw err;
    }
  }

  private async attemptLogin(rawEmail: string, password: string, previousToken?: string): Promise<LoginResult | StepUpResult> {
    const email = normaliseEmail(rawEmail);
    const ctx = currentContext();
    const ip = ctx?.ip ?? null;

    // The hash comes from its own function (the app role cannot select the
    // column, THREATS.md A26), looked up by email in parallel so a known and
    // an unknown email cost the same.
    const [user, [stored]] = await Promise.all([
      this.prisma.user.findUnique({ where: { email }, include: { _count: { select: { passkeys: true } } } }),
      this.prisma.$queryRaw<{ hash: string | null }[]>`SELECT tv_password_hash(u.id) AS hash FROM (SELECT NULL::uuid AS id) z LEFT JOIN users u ON u.email = ${email}`,
    ]);
    const passwordHash = user ? (stored?.hash ?? null) : null;
    // A browser this account fully signed in from before (signed cookie,
    // issued after the last password change) skips the per-account step-up.
    const device = this.devices.trustedFor(ctx?.deviceCookie, user);
    // Demo accounts' passwords are published: an extra step would protect
    // nothing and would let anyone stop the demo.
    const gate = await this.throttle.before(email, ip, device, { stepUpAllowed: !user?.isProtected });

    // Always run a full Argon2 verify, even for unknown accounts (dummy hash),
    // so response time does not reveal which emails exist.
    const passwordOk = await this.passwords.verify(passwordHash, password);
    // An invitation not yet accepted has a password of random bytes nobody
    // knows, so `account_not_activated` only names the reason in the audit
    // log. The person sees the same message as for any other failure.
    const problem = !user ? 'unknown_account'
      : user.status === 'INVITED' ? 'account_not_activated'
      : !passwordOk ? 'wrong_password'
      : user.status !== 'ACTIVE' ? 'account_deactivated'
      : user.accessExpiresAt && user.accessExpiresAt.getTime() <= Date.now() ? 'access_expired'
      : null;

    const deny = async (reason: string): Promise<never> => {
      await Promise.all([
        this.audit.record({ action: 'auth.login', outcome: 'DENIED', reason, actorId: user?.id ?? null, actorEmail: email, details: { trustedDevice: gate.trusted } }),
        this.throttle.failed(email, ip, user?.id ?? null),
      ]);
      throw new UnauthorizedException(LOGIN_FAILED);
    };

    if (gate.stepUp) {
      // Under attack, from an untrusted device: the same answer whatever
      // happened, so guessing here teaches nothing. Only the right password
      // for a usable account emails a one-time link (SignInLinkService).
      const reason = problem ? `stepup_${problem}` : await this.links.offer(user!, ip);
      await Promise.all([
        this.audit.record({ action: 'auth.login', outcome: 'DENIED', reason, actorId: user?.id ?? null, actorEmail: email, details: { trustedDevice: false } }),
        problem ? this.throttle.failed(email, ip, user?.id ?? null) : null,
      ]);
      return { stepUp: true };
    }
    if (problem) return deny(problem);

    // Success: new session (a fresh token, never a reused one), and the old
    // session from this browser — if any — ended. The users row is not
    // written: there is no per-account failure counter any more.
    const session = await this.prisma.$transaction(async (tx) => {
      // The password was checked outside this transaction (Argon2 is slow). If
      // an admin reset the password, deactivated the account or it expired in
      // that window, the old password must not yield a session (THREATS.md R9).
      // The row lock orders this against those changes.
      const [now] = await tx.$queryRaw<{ password_hash: string; status: string; access_expires_at: Date | null }[]>`
        SELECT tv_password_hash(id) AS password_hash, status, access_expires_at FROM users WHERE id = ${user!.id}::uuid FOR UPDATE`;
      if (!now || now.password_hash !== passwordHash || now.status !== 'ACTIVE' || (now.access_expires_at && now.access_expires_at.getTime() <= Date.now())) {
        return null;
      }
      return this.openSession(user!, previousToken, tx, gate.trusted ? 'trusted_device' : 'password');
    });
    if (!session) return deny('credentials_changed_during_login');
    await this.throttle.succeeded(gate);
    return this.loginResult(user!, session);
  }

  /**
   * Finish a sign-in with an emailed one-time link (sent while the account
   * was under attack). Gives the session the password would have; the second
   * factor is still needed if the account has one.
   */
  async loginWithLink(token: string, previousToken?: string): Promise<LoginResult> {
    const ip = currentContext()?.ip ?? 'unknown';
    await this.limits.hit(`signin-link:ip:${ip}`, 20, 900, 'Too many attempts. Try again in a few minutes.');
    const refuse = async (reason: string, userId: string | null): Promise<never> => {
      await this.audit.record({ action: 'auth.signin_link', outcome: 'DENIED', reason, actorId: null, actorEmail: null, targetType: 'user', targetId: userId ?? undefined });
      throw new BadRequestException(LINK_INVALID);
    };
    if (!SIGNIN_TOKEN_SHAPE.test(token)) return refuse('malformed_link', null);
    const out = await this.prisma.$transaction(async (tx) => {
      const spent = await this.links.consume(token, tx);
      if (spent.refused !== null) return spent;
      const user = await tx.user.findUniqueOrThrow({ where: { id: spent.userId }, include: { _count: { select: { passkeys: true } } } });
      return { refused: null, user, session: await this.openSession(user, previousToken, tx, 'signin_link') };
    });
    if (out.refused !== null) return refuse(out.refused, out.userId);
    return this.loginResult(out.user, out.session);
  }

  /** New session, the browser's old one ended, `auth.login` ALLOWED: all in the caller's transaction. */
  private async openSession(user: { id: string; email: string }, previousToken: string | undefined, tx: Tx, via: string): Promise<NewSession> {
    const ctx = currentContext();
    if (previousToken) {
      const old = await this.sessions.resolve(previousToken);
      if (old) await this.sessions.revoke(old.sessionId, tx, 'replaced_at_login');
    }
    const session = await this.sessions.create(user.id, { ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null }, tx);
    await this.audit.record({ action: 'auth.login', outcome: 'ALLOWED', actorId: user.id, actorEmail: user.email, targetType: 'user', targetId: user.id, details: { via } }, tx);
    return session;
  }

  private async loginResult(user: LoginUser, session: NewSession): Promise<LoginResult> {
    const methods: ('totp' | 'passkey')[] = [];
    if (user.totpEnabledAt) methods.push('totp');
    if (user._count.passkeys > 0) methods.push('passkey');
    const enrolled = methods.length > 0;
    return {
      session,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
      mfa: { required: MfaPolicyService.isRequired(user.role, enrolled, await this.policy.requiredRoles()), enrolled, methods },
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
    // Someone holding only a stolen session must not get unlimited guesses
    // at the current password (which would let them change it and keep the
    // account).
    await this.limits.hit(`pwchange:${actor.userId}`, 5, 900, 'Too many attempts. Try again later.');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
    if (user.isProtected) throw new ForbiddenException('Demo account passwords cannot be changed');
    const [stored] = await this.prisma.$queryRaw<{ hash: string }[]>`SELECT tv_password_hash(${user.id}::uuid) AS hash`;
    if (!(await this.passwords.verify(stored?.hash ?? null, current))) {
      await this.audit.record({ action: 'auth.password_change', outcome: 'DENIED', reason: 'wrong_current_password', targetType: 'user', targetId: user.id });
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await this.passwords.hash(next);
    // As the person themselves: the database lets only them set their password (A23).
    await this.prisma.asUser(user.id, async (tx) => {
      // The person's access lock first, as every account change takes it (R11).
      await tx.$executeRaw`SELECT tv_lock_user(${user.id}::uuid, true)`;
      // passwordChangedAt makes every older session (and every trusted-device
      // cookie) invalid on its next use; the revoke below just ends the
      // sessions immediately.
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });
      const ended = await this.sessions.revokeAllForUser(user.id, tx, undefined, 'password_changed');
      await this.audit.record({ action: 'auth.password_change', outcome: 'ALLOWED', targetType: 'user', targetId: user.id, details: { sessionsEnded: ended } }, tx);
    });
  }
}
