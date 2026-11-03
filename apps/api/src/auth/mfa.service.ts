import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { ENV, type Env } from '../config/env.js';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RedisService } from '../redis/redis.service.js';
import { RateLimitService } from '../redis/rate-limit.service.js';
import { KEY_PROVIDER, type KeyProvider } from '../crypto/key-provider.js';
import { currentContext, type Actor } from '../common/request-context.js';
import { base32Encode, matchTotp, newTotpSecret, otpauthUri } from './totp.js';
import { SessionService, type NewSession } from './session.service.js';
import { MfaPolicyService } from './mfa-policy.service.js';
import { expectedPasskeyOrigins } from './passkey-origins.js';
import { DeviceTrustService } from './device-trust.service.js';

const totpAad = (userId: string) => `tv-totp-v1|${userId}`;

/** Stored form of a wrapped secret: [key id length][key id][wrapped bytes]. */
export const packWrapped = (keyId: string, wrapped: Buffer): Buffer => {
  const id = Buffer.from(keyId, 'utf8');
  return Buffer.concat([Buffer.from([id.length]), id, wrapped]);
};
export const unpackWrapped = (stored: Buffer): { keyId: string; wrapped: Buffer } => {
  const n = stored[0] ?? 0;
  return { keyId: stored.subarray(1, 1 + n).toString('utf8'), wrapped: stored.subarray(1 + n) };
};
const CHALLENGE_TTL = 300;

/**
 * Second factor: an authenticator-app code (TOTP) or a passkey. Required
 * for every ADMIN, and for anyone who has enrolled one. Until it is
 * presented the session is "password" level and can only reach the
 * sign-in, enrolment and sign-out routes (see SecurityGuard).
 *
 * Passing the second factor issues a brand-new session token: the
 * password-only token stops working, so it is worth nothing if stolen.
 */
@Injectable()
export class MfaService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(MfaPolicyService) private readonly policy: MfaPolicyService,
    @Inject(DeviceTrustService) private readonly devices: DeviceTrustService,
  ) {}

  /** The web origin, plus the Android app's signing-key origin(s) (THREATS.md S22). */
  private get origins(): string[] {
    return expectedPasskeyOrigins(this.env);
  }

  private get rpID(): string {
    return new URL(this.env.PUBLIC_ORIGIN).hostname;
  }

  async status(actor: Actor) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { totpEnabledAt: true, passkeys: { select: { id: true, name: true, createdAt: true, lastUsedAt: true }, orderBy: { createdAt: 'asc' } } },
    });
    const roles = await this.policy.requiredRoles();
    return {
      required: MfaPolicyService.isRequired(actor.role, u.totpEnabledAt !== null || u.passkeys.length > 0, roles),
      /** Required because of the account's role (so the last factor cannot be removed). */
      requiredByRole: MfaPolicyService.isRequired(actor.role, false, roles),
      satisfied: actor.authLevel === 'mfa',
      /** Risky actions need a factor newer than this many minutes (step-up). */
      stepUpMinutes: this.env.STEP_UP_MINUTES,
      stepUpFresh: actor.mfaVerifiedAt !== null && Date.now() - actor.mfaVerifiedAt.getTime() <= this.env.STEP_UP_MINUTES * 60_000,
      totp: u.totpEnabledAt !== null,
      passkeys: u.passkeys,
    };
  }

  // ------------------------------------------------------------------ TOTP

  /** Starts enrolment: a new secret, stored encrypted, not active until confirmed with a code. */
  async setupTotp(actor: Actor) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true, totpEnabledAt: true, isProtected: true } });
    if (user.isProtected) throw new ForbiddenException('Demo accounts cannot change their second factor');
    if (user.totpEnabledAt) throw new ConflictException('An authenticator app is already set up');
    await this.requireMfaIfEnrolled(actor);
    const secret = newTotpSecret();
    const { wrapped, keyId } = await this.keys.wrap(secret, totpAad(actor.userId));
    // As the person themselves: only they may set their own second factor (THREATS.md A23).
    await this.prisma.asUser(actor.userId, (tx) => tx.user.update({ where: { id: actor.userId }, data: { totpSecretEnc: new Uint8Array(packWrapped(keyId, wrapped)), totpLastStep: null }, select: { id: true } }));
    const b32 = base32Encode(secret);
    return { secret: b32, otpauthUri: otpauthUri(b32, user.email) };
  }

  /** Confirms enrolment with a first code; the session becomes MFA level. */
  async enableTotp(actor: Actor, code: string): Promise<NewSession> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { totpEnabledAt: true } });
    if (user.totpEnabledAt) throw new ConflictException('An authenticator app is already set up');
    const [secret] = await this.prisma.$queryRaw<{ s: Buffer | null }[]>`SELECT tv_totp_secret(${actor.userId}::uuid) AS s`;
    if (!secret?.s) throw new BadRequestException('Start the setup first');
    await this.checkCode(actor, code, 'mfa.totp_enable');
    return this.prisma.asUser(actor.userId, async (tx) => {
      await tx.user.update({ where: { id: actor.userId }, data: { totpEnabledAt: new Date() } });
      await this.audit.record({ action: 'mfa.totp_enable', outcome: 'ALLOWED', targetType: 'user', targetId: actor.userId }, tx);
      return this.upgrade(actor, tx);
    });
  }

  /** Second step of sign-in with an authenticator code. */
  async verifyTotp(actor: Actor, code: string): Promise<NewSession> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { totpEnabledAt: true } });
    if (!user.totpEnabledAt) throw new BadRequestException('No authenticator app is set up');
    await this.checkCode(actor, code, 'mfa.totp_verify');
    return this.prisma.$transaction(async (tx) => {
      await this.audit.record({ action: 'mfa.totp_verify', outcome: 'ALLOWED', targetType: 'user', targetId: actor.userId }, tx);
      return this.upgrade(actor, tx);
    });
  }

  private async checkCode(actor: Actor, code: string, action: string): Promise<void> {
    await this.mfaLimit(actor, 'Too many codes tried. Wait five minutes.');
    // The sealed secret, through its function (the app role cannot select the column, A26).
    const [row] = await this.prisma.$queryRaw<{ s: Buffer }[]>`SELECT tv_totp_secret(${actor.userId}::uuid) AS s`;
    const stored = unpackWrapped(Buffer.from(row!.s));
    const secret = await this.keys.unwrap(stored.wrapped, stored.keyId, totpAad(actor.userId)).catch(() => null);
    const step = secret ? matchTotp(secret, code) : null;
    secret?.fill(0);
    // Atomic "newer than the last accepted step": a code works once.
    const accepted = step !== null
      ? (await this.prisma.$executeRaw`UPDATE users SET totp_last_step = ${step}
           WHERE id = ${actor.userId}::uuid AND (totp_last_step IS NULL OR totp_last_step < ${step})`) === 1
      : false;
    if (!accepted) {
      await this.audit.record({ action, outcome: 'DENIED', reason: step === null ? 'wrong_code' : 'code_replayed', targetType: 'user', targetId: actor.userId });
      // Same text for wrong and reused codes; the audit row says which.
      throw new UnauthorizedException({ message: 'That code didn’t match. Type the newest 6 digits your app shows. If it keeps failing, set your phone’s date and time to automatic: codes depend on the clock.', code: 'wrong_code' });
    }
  }

  // -------------------------------------------------------------- passkeys

  async passkeyRegistrationOptions(actor: Actor) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { email: true, displayName: true, isProtected: true, passkeys: { select: { credentialId: true, transports: true } } },
    });
    if (user.isProtected) throw new ForbiddenException('Demo accounts cannot add passkeys');
    await this.requireMfaIfEnrolled(actor);
    const options = await generateRegistrationOptions({
      rpName: 'TrustVault',
      rpID: this.rpID,
      userName: user.email,
      userDisplayName: user.displayName,
      userID: new TextEncoder().encode(actor.userId),
      attestationType: 'none',
      excludeCredentials: user.passkeys.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    await this.redis.client.set(`webauthn:reg:${actor.sessionId}`, options.challenge, 'EX', CHALLENGE_TTL);
    return options;
  }

  async passkeyRegister(actor: Actor, response: RegistrationResponseJSON, name: string): Promise<NewSession | null> {
    await this.requireMfaIfEnrolled(actor);
    const expectedChallenge = await this.redis.client.getdel(`webauthn:reg:${actor.sessionId}`);
    if (!expectedChallenge) throw new BadRequestException('The passkey request expired. Try again.');
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: this.origins, expectedRPID: this.rpID, requireUserVerification: true });
    } catch {
      verification = null;
    }
    if (!verification?.verified || !verification.registrationInfo) {
      await this.audit.record({ action: 'mfa.passkey_register', outcome: 'DENIED', reason: 'verification_failed', targetType: 'user', targetId: actor.userId });
      throw new BadRequestException('The passkey could not be verified');
    }
    const { credential } = verification.registrationInfo;
    const wasEnrolled = actor.authLevel === 'mfa';
    // As the person themselves: only they may add their own passkey (A23).
    return this.prisma.asUser(actor.userId, async (tx) => {
      await tx.passkey.create({
        data: { userId: actor.userId, credentialId: credential.id, publicKey: new Uint8Array(credential.publicKey), counter: BigInt(credential.counter), transports: credential.transports ?? [], name },
      });
      await this.audit.record({ action: 'mfa.passkey_register', outcome: 'ALLOWED', targetType: 'user', targetId: actor.userId, details: { name } }, tx);
      // First factor ever enrolled: this proves possession, upgrade the session.
      return wasEnrolled ? null : this.upgrade(actor, tx);
    });
  }

  async passkeyAuthOptions(actor: Actor) {
    const passkeys = await this.prisma.passkey.findMany({ where: { userId: actor.userId }, select: { credentialId: true, transports: true } });
    if (passkeys.length === 0) throw new BadRequestException('No passkey is registered');
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransportFuture[] })),
      userVerification: 'required',
    });
    await this.redis.client.set(`webauthn:auth:${actor.sessionId}`, options.challenge, 'EX', CHALLENGE_TTL);
    return options;
  }

  async passkeyVerify(actor: Actor, response: AuthenticationResponseJSON): Promise<NewSession> {
    return this.checkPasskey(actor, response, 'mfa.passkey_verify', (tx) => this.upgrade(actor, tx));
  }

  /** Checks an assertion against the challenge issued to this session, then runs `then` in the same transaction. */
  private async checkPasskey<T>(actor: Actor, response: AuthenticationResponseJSON, action: string, then: (tx: Tx) => Promise<T>): Promise<T> {
    await this.mfaLimit(actor, 'Too many attempts. Wait five minutes.');
    const expectedChallenge = await this.redis.client.getdel(`webauthn:auth:${actor.sessionId}`);
    if (!expectedChallenge) throw new BadRequestException('The passkey request expired. Try again.');
    const passkey = await this.prisma.passkey.findFirst({ where: { userId: actor.userId, credentialId: response.id } });
    let verification;
    try {
      verification = passkey
        ? await verifyAuthenticationResponse({
            response, expectedChallenge, expectedOrigin: this.origins, expectedRPID: this.rpID, requireUserVerification: true,
            credential: { id: passkey.credentialId, publicKey: new Uint8Array(passkey.publicKey), counter: Number(passkey.counter), transports: passkey.transports as AuthenticatorTransportFuture[] },
          })
        : null;
    } catch {
      verification = null;
    }
    if (!passkey || !verification?.verified) {
      await this.audit.record({ action, outcome: 'DENIED', reason: passkey ? 'verification_failed' : 'unknown_credential', targetType: 'user', targetId: actor.userId });
      throw new UnauthorizedException('The passkey could not be verified');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.passkey.update({ where: { id: passkey.id }, data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() } });
      await this.audit.record({ action, outcome: 'ALLOWED', targetType: 'user', targetId: actor.userId, details: { method: 'passkey', passkey: passkey.name } }, tx);
      return then(tx);
    });
  }

  // --------------------------------------------------------------- step-up

  /**
   * Re-verification for risky actions (THREATS.md S20): a fresh TOTP code or
   * passkey assertion moves this session's mfa_verified_at to now. Same rate
   * limit, replay rule and audit as sign-in. Only for a session that has
   * already passed its second factor; the token is not rotated (see
   * SessionService.markStepUp).
   */
  async stepUp(actor: Actor, proof: { code: string } | { response: AuthenticationResponseJSON }): Promise<void> {
    if (actor.authLevel !== 'mfa') throw new ForbiddenException({ message: 'Finish signing in first', code: 'mfa_required' });
    const mark = async (tx: Tx) => {
      if (!(await this.sessions.markStepUp(actor.sessionId, tx))) throw new UnauthorizedException('Your session ended. Sign in again.');
    };
    if ('code' in proof) {
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { totpEnabledAt: true } });
      if (!user.totpEnabledAt) throw new BadRequestException('No authenticator app is set up. Use your passkey.');
      await this.checkCode(actor, proof.code, 'mfa.step_up');
      await this.prisma.$transaction(async (tx) => {
        await mark(tx);
        await this.audit.record({ action: 'mfa.step_up', outcome: 'ALLOWED', targetType: 'user', targetId: actor.userId, details: { method: 'totp' } }, tx);
      });
      return;
    }
    await this.checkPasskey(actor, proof.response, 'mfa.step_up', mark);
  }

  async removePasskey(actor: Actor, id: string): Promise<void> {
    if (actor.authLevel !== 'mfa') throw new ForbiddenException('Confirm your second factor first');
    await this.prisma.asUser(actor.userId, async (tx) => {
      const user = await this.lockFactors(tx, actor.userId);
      if (!user.passkeys.some((p) => p.id === id)) throw new NotFoundException('Passkey not found');
      if (!user.totpEnabledAt && user.passkeys.length === 1) await this.refuseLastFactor(actor, tx);
      await tx.passkey.delete({ where: { id } });
      await this.audit.record({ action: 'mfa.passkey_remove', outcome: 'ALLOWED', targetType: 'user', targetId: actor.userId, details: { passkeyId: id } }, tx);
    });
  }

  /** Turns the authenticator app off. Step-up is enforced by the route (@StepUp). */
  async removeTotp(actor: Actor): Promise<void> {
    if (actor.authLevel !== 'mfa') throw new ForbiddenException('Confirm your second factor first');
    await this.prisma.asUser(actor.userId, async (tx) => {
      const user = await this.lockFactors(tx, actor.userId);
      if (user.isProtected) throw new ForbiddenException('Demo accounts cannot change their second factor');
      if (!user.totpEnabledAt) throw new NotFoundException('No authenticator app is set up');
      if (user.passkeys.length === 0) await this.refuseLastFactor(actor, tx);
      await tx.user.update({ where: { id: actor.userId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null } });
      await this.audit.record({ action: 'mfa.totp_remove', outcome: 'ALLOWED', targetType: 'user', targetId: actor.userId }, tx);
    });
  }

  // ---------------------------------------------------------------- shared

  /**
   * The user row is locked so two removals at once cannot both pass the
   * "keeps one factor" check and leave a required account with none.
   */
  private async lockFactors(tx: Tx, userId: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    return tx.user.findUniqueOrThrow({ where: { id: userId }, select: { isProtected: true, totpEnabledAt: true, passkeys: { select: { id: true } } } });
  }

  /** Admins, and roles in the MFA policy, must keep at least one factor. */
  private async refuseLastFactor(actor: Actor, tx: Tx): Promise<void> {
    if (MfaPolicyService.isRequired(actor.role, false, await this.policy.requiredRoles(tx))) {
      throw new BadRequestException(actor.role === 'ADMIN' ? 'Admins must keep at least one second factor' : 'Your role must keep at least one second factor');
    }
  }

  /**
   * Limits on second-factor attempts (THREATS.md S7, S27). Five per session
   * per 5 minutes and ten per account per 15 minutes bound guessing. Someone
   * who has the password could spend the account's budget to keep its owner
   * out, so a trusted device of this account (DeviceTrustService) has its
   * own budget instead and is never held up by a stranger's guesses.
   */
  private async mfaLimit(actor: Actor, message: string): Promise<void> {
    const device = this.devices.verify(currentContext()?.deviceCookie);
    if (device && device.userId === actor.userId) {
      await this.limits.hit(`mfa:dev:${actor.userId}:${device.deviceId}`, 5, 300, message);
      return;
    }
    await this.limits.hit(`mfa:s:${actor.sessionId}`, 5, 300, message);
    await this.limits.hit(`mfa:${actor.userId}`, 10, 900, message);
  }

  /** Someone who already has a second factor must use it before adding another. */
  private async requireMfaIfEnrolled(actor: Actor): Promise<void> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { totpEnabledAt: true, _count: { select: { passkeys: true } } } });
    if ((u.totpEnabledAt || u._count.passkeys > 0) && actor.authLevel !== 'mfa') {
      throw new ForbiddenException('Confirm your existing second factor first');
    }
  }

  /** Replace the password-level session with a new MFA-level one. */
  private async upgrade(actor: Actor, tx: Tx): Promise<NewSession> {
    const ctx = currentContext();
    // Re-check everything under the user row lock that admin resets and
    // deactivation also take: if the password-only session was ended, or the
    // account changed, while the code was being checked, no full session is
    // issued (THREATS.md R9).
    const [u] = await tx.$queryRaw<{ status: string; access_expires_at: Date | null; password_changed_at: Date; totp: boolean; passkeys: number }[]>`
      SELECT status, access_expires_at, password_changed_at, totp_enabled_at IS NOT NULL AS totp,
             (SELECT count(*)::int FROM passkeys p WHERE p.user_id = users.id) AS passkeys
        FROM users WHERE id = ${actor.userId}::uuid FOR UPDATE`;
    const [s] = await tx.$queryRaw<{ created_at: Date }[]>`SELECT created_at FROM sessions WHERE id = ${actor.sessionId}::uuid`;
    const ended = (await this.sessions.revoke(actor.sessionId, tx, 'replaced_after_second_factor')) !== 1;
    if (ended || !u || !s || u.status !== 'ACTIVE' || (u.access_expires_at && u.access_expires_at.getTime() <= Date.now())
        || s.created_at.getTime() < u.password_changed_at.getTime() || (!u.totp && u.passkeys === 0)) {
      throw new UnauthorizedException('Your session ended. Sign in again.');
    }
    return this.sessions.create(actor.userId, { ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null, authLevel: 'mfa' }, tx);
  }
}
