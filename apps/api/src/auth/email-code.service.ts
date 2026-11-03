import { createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { logger } from '../common/logger.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * What a code is for. A code is bound to its purpose and to the session that
 * asked for it: a sign-in code cannot turn the method on, a step-up code
 * cannot finish a sign-in, and no code works from another session.
 */
export type EmailCodePurpose = 'signin' | 'enable' | 'stepup';

export const EMAIL_CODE_TTL_SECONDS = 600;
export const EMAIL_CODE_MAX_TRIES = 5;

export type EmailCodeResult = 'ok' | 'no_code' | 'wrong_code' | 'too_many_tries' | 'code_used';

// One attempt, atomically: nothing if there is no live code (so a guess can
// never create a key without an expiry), else count the try and hand back
// what is needed to check it.
const TRY = `
local v = redis.call('HMGET', KEYS[1], 'uid', 'salt', 'mac')
if not v[1] then return nil end
local n = redis.call('HINCRBY', KEYS[1], 'tries', 1)
return {n, v[1], v[2], v[3]}
`;

/**
 * Emailed one-time codes (THREATS.md S30): 6 digits from the CSPRNG, kept
 * only as HMAC-SHA256(server key, purpose | session | user | per-code salt
 * | code) in Redis for 10 minutes. One code per (purpose, session): asking
 * again replaces the previous one. Five wrong tries and it is gone. A right
 * code is deleted as it is accepted, and only the request that deletes it
 * wins, so two requests racing with the same code cannot both pass.
 *
 * The HMAC key lives only in the API's memory, so a copy of Redis alone
 * does not let anyone try the million possible codes offline.
 */
@Injectable()
export class EmailCodeService {
  private readonly key: Buffer;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {
    if (env.DEVICE_TRUST_KEY) {
      this.key = Buffer.from(hkdfSync('sha256', Buffer.from(env.DEVICE_TRUST_KEY, 'base64'), Buffer.alloc(0), 'tv-email-code-v1', 32));
    } else if (env.NODE_ENV !== 'production' && env.LOCAL_MASTER_KEY) {
      this.key = Buffer.from(hkdfSync('sha256', Buffer.from(env.LOCAL_MASTER_KEY, 'base64'), Buffer.alloc(0), 'tv-email-code-v1', 32));
    } else {
      // Codes live 10 minutes; a restart only means "send a new code".
      this.key = randomBytes(32);
      if (env.NODE_ENV === 'production') logger.warn('DEVICE_TRUST_KEY not set: emailed codes are forgotten on restart');
    }
  }

  private redisKey(purpose: EmailCodePurpose, sessionId: string): string {
    return `emailcode:${purpose}:${sessionId}`;
  }

  private mac(purpose: EmailCodePurpose, sessionId: string, userId: string, salt: string, code: string): Buffer {
    return createHmac('sha256', this.key).update(`tv-email-code-v1|${purpose}|${sessionId}|${userId}|${salt}|${code}`).digest();
  }

  /** A new code for this purpose and session; any earlier one stops working. Returns the code to email. */
  async issue(userId: string, sessionId: string, purpose: EmailCodePurpose): Promise<string> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('base64url');
    const key = this.redisKey(purpose, sessionId);
    await this.redis.client.multi()
      .del(key)
      .hset(key, { uid: userId, salt, mac: this.mac(purpose, sessionId, userId, salt, code).toString('base64url'), tries: 0 })
      .expire(key, EMAIL_CODE_TTL_SECONDS)
      .exec();
    return code;
  }

  /** Checks and, if right, spends the code. Never says more than the result. */
  async consume(userId: string, sessionId: string, purpose: EmailCodePurpose, code: string): Promise<EmailCodeResult> {
    const key = this.redisKey(purpose, sessionId);
    const got = (await this.redis.client.eval(TRY, 1, key)) as [number, string, string, string] | null;
    if (!got) return 'no_code';
    const [tries, uid, salt, stored] = got;
    if (tries > EMAIL_CODE_MAX_TRIES) {
      await this.redis.client.del(key);
      return 'too_many_tries';
    }
    const expected = Buffer.from(stored, 'base64url');
    const presented = this.mac(purpose, sessionId, userId, salt, code);
    const match = uid === userId && expected.length === presented.length && timingSafeEqual(expected, presented);
    if (!match) {
      // The fifth wrong try ends the code.
      if (tries >= EMAIL_CODE_MAX_TRIES) await this.redis.client.del(key);
      return 'wrong_code';
    }
    // One use: only the request that deletes it may pass.
    return (await this.redis.client.del(key)) === 1 ? 'ok' : 'code_used';
  }

  /** Drops any live code of this session (the method was turned off, or the session ended). */
  async discard(sessionId: string, purposes: EmailCodePurpose[] = ['signin', 'enable', 'stepup']): Promise<void> {
    await this.redis.client.del(...purposes.map((p) => this.redisKey(p, sessionId)));
  }
}

/** r***@gmail.com: enough to recognise the mailbox, not to learn the address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
