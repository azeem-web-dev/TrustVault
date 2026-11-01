import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { Public } from '../auth/decorators.js';
import { RateLimitService } from '../redis/rate-limit.service.js';
import { AuditAdminService } from './audit-admin.service.js';

const QuerySchema = z.strictObject({
  since: z.coerce.bigint().positive().default(1n),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/**
 * Who may call: anyone, without signing in. This is what lets an outside
 * witness (tools/witness.mjs, run on a schedule by GitHub Actions) keep its
 * own copy of every signed audit checkpoint, out of reach of this server.
 *
 * It reveals only checkpoint numbers, hashes, signatures and times: no
 * event content, no names, no document ids. Rate limited per IP.
 */
@Controller('witness')
export class WitnessController {
  constructor(
    @Inject(AuditAdminService) private readonly svc: AuditAdminService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
  ) {}

  @Public()
  @Get('checkpoints')
  async checkpoints(@Req() req: Request, @Query(new ZodPipe(QuerySchema)) q: z.infer<typeof QuerySchema>) {
    await this.limits.hit(`witness:${req.ip ?? 'unknown'}`, 60, 60);
    return this.svc.witnessView(q.since, q.limit);
  }
}
