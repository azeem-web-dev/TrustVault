import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env.js';

// Fixed-window counter: INCR, and set the expiry on the first hit. Done in
// one Lua call so a crash between the two can never leave a key that
// never expires.
const CONSUME = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return {n, ttl}
`;

// Gives one attempt back (a sign-in that succeeded), never below zero and
// never creating a key without an expiry.
const RELEASE = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then return redis.call('DECR', KEYS[1]) end
return 0
`;

// Backoff for one (account, client) pair: refused while the lock key lives;
// otherwise count the attempt, and on going over the limit lock the pair for
// base * 2^(strikes - 1) seconds, capped, remembering strikes for a day.
const PAIR_GATE = `
local ttl = redis.call('TTL', KEYS[1])
if ttl > 0 then return {1, ttl} end
local n = redis.call('INCR', KEYS[2])
if n == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
if n > tonumber(ARGV[2]) then
  local s = redis.call('INCR', KEYS[3])
  redis.call('EXPIRE', KEYS[3], 86400)
  local d = math.floor(math.min(tonumber(ARGV[3]) * 2 ^ (s - 1), tonumber(ARGV[4])))
  redis.call('SET', KEYS[1], s, 'EX', d)
  redis.call('DEL', KEYS[2])
  return {1, d}
end
return {0, 0}
`;

export interface Consumed {
  count: number;
  retryAfterSeconds: number;
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    // keyPrefix matches the Redis ACL for this environment; a key outside the
    // prefix is refused by Redis itself.
    this.client = new Redis(env.REDIS_URL, {
      keyPrefix: env.REDIS_PREFIX,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
  }

  /** Count one hit against `key` in a window of `windowSeconds`. */
  async consume(key: string, windowSeconds: number): Promise<Consumed> {
    const [count, ttl] = (await this.client.eval(CONSUME, 1, key, String(windowSeconds))) as [number, number];
    return { count, retryAfterSeconds: Math.max(ttl, 1) };
  }

  /** Undo one hit on `key` (floor zero). */
  async release(key: string): Promise<void> {
    await this.client.eval(RELEASE, 1, key);
  }

  /**
   * One attempt for a pair with exponential backoff. Returns how long the
   * pair is locked for (0 = go ahead). Locks after `max` attempts in
   * `windowSeconds`; the n-th lock in a day lasts base * 2^(n-1), up to cap.
   */
  async pairGate(base: string, opts: { max: number; windowSeconds: number; lockSeconds: number; maxLockSeconds: number }): Promise<number> {
    const [locked, ttl] = (await this.client.eval(
      PAIR_GATE, 3, `${base}:lock`, `${base}:n`, `${base}:strikes`,
      String(opts.windowSeconds), String(opts.max), String(opts.lockSeconds), String(opts.maxLockSeconds),
    )) as [number, number];
    return locked === 1 ? Math.max(ttl, 1) : 0;
  }

  async reset(key: string): Promise<void> {
    await this.client.del(key);
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
