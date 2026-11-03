import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { logger } from '../common/logger.js';
import { RedisService } from '../redis/redis.service.js';
import { clientNetwork } from './client-network.js';
import type { TrustedDevice } from './device-trust.service.js';

/**
 * Sign-in throttles and abuse detection (THREATS.md S1, S9, S19).
 *
 * The old rule — five wrong passwords lock the account — let anyone who
 * knows an email address lock its owner out. Nothing here can do that.
 * Instead every limit is scoped to something the attacker controls, and the
 * one limit that is per account does not block, it asks for more proof:
 *
 *   per client IP          20 attempts / 15 min                     → 429
 *   per network (/24, /48) 100 attempts / 15 min, 20 once flagged   → 429
 *   per (account, client)  5 attempts / 15 min, then locked 15 min,
 *                          doubling per lock up to 24 h             → 429
 *     (client = the IPv4 address, or the IPv6 /64)
 *   per account            more than 10 attempts in an hour from
 *                          untrusted devices puts the account
 *                          "under attack": until it cools down, a
 *                          sign-in from an untrusted device answers
 *                          202 "check your email" whatever the
 *                          password; only the right password
 *                          actually emails a one-time link
 *   per trusted device     10 attempts / 15 min; within that, the
 *                          device skips all of the above
 *
 * Every key is the SHA-256 of the email, so an unknown address is
 * throttled exactly like a real one and the answers never differ.
 *
 * Detection, on every failed attempt: the distinct accounts tried from one
 * IP and one network, and the distinct networks trying one account, in the
 * last hour (HyperLogLog). Crossing a threshold writes one audit event per
 * hour (auth.credential_stuffing, auth.distributed_guessing,
 * auth.account_under_attack), which the admin alerts list, and tightens the
 * limits: the IP is refused for an hour, the network's limit drops to 20.
 *
 * Redis down → sign-in refused (503): without the limiter, guessing would be
 * unlimited.
 */
export const LIMITS = {
  ip: { max: 20, windowSeconds: 15 * 60 },
  network: { max: 100, flaggedMax: 20, windowSeconds: 15 * 60 },
  pair: { max: 5, windowSeconds: 15 * 60, lockSeconds: 15 * 60, maxLockSeconds: 24 * 3600 },
  account: { soft: 10, windowSeconds: 3600 },
  device: { max: 10, windowSeconds: 15 * 60 },
  /** Sign-in confirmation emails per account per hour. */
  linkMails: { max: 3, windowSeconds: 3600 },
  detect: { windowSeconds: 3600, accountsPerIp: 6, accountsPerNetwork: 20, networksPerAccount: 4 },
} as const;

export const emailKey = (email: string): string => createHash('sha256').update(email).digest('hex').slice(0, 32);

const TOO_MANY = 'Too many attempts. Try again later.';

// PFADD, give a new key its expiry, PFCOUNT — one round trip.
const HLL_ADD = `
redis.call('PFADD', KEYS[1], ARGV[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return redis.call('PFCOUNT', KEYS[1])
`;

export interface LoginGate {
  /** A trusted device for this account, within its own budget: no per-account step-up. */
  trusted: boolean;
  /** The account is under attack and this device is not trusted: the password alone gives no session. */
  stepUp: boolean;
  readonly ek: string;
  readonly pairKey: string;
  readonly deviceKey: string | null;
}

@Injectable()
export class LoginThrottleService {
  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Before the password is checked. Throws 429 (or 503); otherwise says how to treat the attempt. */
  async before(email: string, ip: string | null, device: TrustedDevice | null, opts: { stepUpAllowed: boolean }): Promise<LoginGate> {
    const ek = emailKey(email);
    const net = clientNetwork(ip);
    const pairKey = `rl:login:pair:${ek}:${net.client}`;
    try {
      if (device) {
        const deviceKey = `rl:login:dev:${ek}:${device.deviceId}`;
        const used = await this.redis.consume(deviceKey, LIMITS.device.windowSeconds);
        if (used.count <= LIMITS.device.max) return { trusted: true, stepUp: false, ek, pairKey, deviceKey };
        // Over its own budget the cookie stops helping: treated like any other device.
      }
      const c = this.redis.client;
      const [blockTtl, netFlagged, ipHits, netHits, acctHits] = await Promise.all([
        c.ttl(`rl:login:block:${net.ip}`),
        c.exists(`rl:login:flag:net:${net.network}`),
        this.redis.consume(`rl:login:ip:${net.ip}`, LIMITS.ip.windowSeconds),
        this.redis.consume(`rl:login:net:${net.network}`, LIMITS.network.windowSeconds),
        this.redis.consume(`rl:login:acct:${ek}`, LIMITS.account.windowSeconds),
      ]);
      // Recorded once an hour per account, even if this very attempt is refused below.
      const underAttack = acctHits.count > LIMITS.account.soft;
      if (underAttack && (await c.set(`rl:login:flag:acct:${ek}`, '1', 'EX', LIMITS.account.windowSeconds, 'NX')) === 'OK') {
        await this.audit.record({
          action: 'auth.account_under_attack', outcome: 'DENIED', reason: 'many_failed_attempts', actorId: null, actorEmail: email,
          details: { attemptsLastHour: acctHits.count, ip: net.ip, network: net.network },
        });
      }
      if (blockTtl > 0) return await this.refuse(email, 'rate_limited_stuffing_ip', blockTtl);
      if (ipHits.count > LIMITS.ip.max) return await this.refuse(email, 'rate_limited_ip', ipHits.retryAfterSeconds);
      const netMax = netFlagged ? LIMITS.network.flaggedMax : LIMITS.network.max;
      if (netHits.count > netMax) return await this.refuse(email, 'rate_limited_network', netHits.retryAfterSeconds);
      const locked = await this.redis.pairGate(pairKey, LIMITS.pair);
      if (locked > 0) return await this.refuse(email, 'rate_limited_pair', locked);
      return { trusted: false, stepUp: underAttack && opts.stepUpAllowed, ek, pairKey, deviceKey: null };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      logger.error({ err }, 'rate limiter unavailable');
      throw new ServiceUnavailableException('Sign-in temporarily unavailable');
    }
  }

  /** The password (and account) checked out: give back what this attempt used. */
  async succeeded(gate: LoginGate): Promise<void> {
    await Promise.all([
      this.redis.reset(`${gate.pairKey}:n`),
      gate.deviceKey ? this.redis.reset(gate.deviceKey) : gate.trusted ? null : this.redis.release(`rl:login:acct:${gate.ek}`),
    ]).catch((err) => logger.warn({ err }, 'could not clear sign-in counters'));
  }

  /**
   * A failed attempt (wrong password, unknown or unusable account). Feeds the
   * detectors; never throws (the caller is already refusing).
   */
  async failed(email: string, ip: string | null, userId: string | null): Promise<void> {
    const ek = emailKey(email);
    const net = clientNetwork(ip);
    const w = String(LIMITS.detect.windowSeconds);
    try {
      const c = this.redis.client;
      const [perIp, perNet, perAcct] = (await Promise.all([
        c.eval(HLL_ADD, 1, `rl:login:seen:ip:${net.ip}`, ek, w),
        c.eval(HLL_ADD, 1, `rl:login:seen:net:${net.network}`, ek, w),
        c.eval(HLL_ADD, 1, `rl:login:seen:acct:${ek}`, net.network, w),
      ])) as [number, number, number];
      const once = async (key: string) => (await c.set(key, '1', 'EX', LIMITS.detect.windowSeconds, 'NX')) === 'OK';
      if (perIp >= LIMITS.detect.accountsPerIp && (await once(`rl:login:flag:ip:${net.ip}`))) {
        // One address trying many accounts: credential stuffing or spraying. Refuse it for an hour.
        await c.set(`rl:login:block:${net.ip}`, '1', 'EX', LIMITS.detect.windowSeconds);
        await this.audit.record({ action: 'auth.credential_stuffing', outcome: 'DENIED', reason: 'many_accounts_from_ip', actorId: null, actorEmail: null, details: { ip: net.ip, network: net.network, accounts: perIp } });
      }
      if (perNet >= LIMITS.detect.accountsPerNetwork && (await once(`rl:login:flag:net:${net.network}`))) {
        await this.audit.record({ action: 'auth.credential_stuffing', outcome: 'DENIED', reason: 'many_accounts_from_network', actorId: null, actorEmail: null, details: { ip: net.ip, network: net.network, accounts: perNet } });
      }
      if (perAcct >= LIMITS.detect.networksPerAccount && (await once(`rl:login:flag:spread:${ek}`))) {
        await this.audit.record({
          action: 'auth.distributed_guessing', outcome: 'DENIED', reason: 'many_networks_on_account', actorId: null, actorEmail: email,
          targetType: userId ? 'user' : undefined, targetId: userId ?? undefined, details: { networks: perAcct, ip: net.ip },
        });
      }
    } catch (err) {
      logger.warn({ err }, 'sign-in abuse detection failed');
    }
  }

  /** One more sign-in confirmation email for this account this hour? */
  async mayEmailLink(email: string): Promise<boolean> {
    try {
      const used = await this.redis.consume(`rl:login:linkmail:${emailKey(email)}`, LIMITS.linkMails.windowSeconds);
      return used.count <= LIMITS.linkMails.max;
    } catch {
      return false;
    }
  }

  private async refuse(email: string, reason: string, retryAfterSeconds: number): Promise<never> {
    await this.audit.record({ action: 'auth.login', outcome: 'DENIED', reason, actorId: null, actorEmail: email });
    throw new HttpException({ message: TOO_MANY, retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
