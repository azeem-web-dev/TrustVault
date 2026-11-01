import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { logger } from '../common/logger.js';
import { RedisService } from './redis.service.js';

/** Per-key limits for expensive or sensitive actions. Fails closed if Redis is down. */
@Injectable()
export class RateLimitService {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async hit(key: string, max: number, windowSeconds: number, message = 'Too many requests. Try again later.'): Promise<void> {
    let used;
    try {
      used = await this.redis.consume(`rl:${key}`, windowSeconds);
    } catch (err) {
      logger.error({ err }, 'rate limiter unavailable');
      throw new ServiceUnavailableException('Temporarily unavailable');
    }
    if (used.count > max) {
      throw new HttpException({ message, retryAfterSeconds: used.retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
