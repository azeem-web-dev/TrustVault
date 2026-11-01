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

  async reset(key: string): Promise<void> {
    await this.client.del(key);
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
