import { Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { Public, Roles } from '../auth/decorators.js';
import { RateLimitService } from '../redis/rate-limit.service.js';
import { KeyLedgerService } from './key-ledger.service.js';

const EntriesSchema = z.strictObject({
  before: z.coerce.bigint().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const WitnessSchema = z.strictObject({
  since: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/** Who may call: ADMIN only, after a second factor. Nothing here changes data except the audit record of a reconciliation. */
@Controller('admin/keyd')
@Roles('ADMIN')
export class KeydAdminController {
  constructor(@Inject(KeyLedgerService) private readonly svc: KeyLedgerService) {}

  /** Key generations, ticket key ids, and how many wrapped values use each key id. */
  @Get('status')
  status() {
    return this.svc.status();
  }

  /** keyd's key-use ledger as mirrored by the API, newest first. */
  @Get('ledger')
  ledger(@Query(new ZodPipe(EntriesSchema)) q: z.infer<typeof EntriesSchema>) {
    return this.svc.entries(q.before, q.limit);
  }

  /** Mirror keyd's ledger now and reconcile it with the audit log (also runs hourly). */
  @Post('reconcile')
  @HttpCode(200)
  reconcile() {
    return this.svc.reconcile();
  }
}

/**
 * Who may call: anyone, like /witness/checkpoints. Signed heads of keyd's
 * ledger only: sequence numbers, hashes, signatures, times. Rate limited per IP.
 */
@Controller('witness')
export class KeydWitnessController {
  constructor(
    @Inject(KeyLedgerService) private readonly svc: KeyLedgerService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
  ) {}

  @Public()
  @Get('keyd-ledger')
  async checkpoints(@Req() req: Request, @Query(new ZodPipe(WitnessSchema)) q: z.infer<typeof WitnessSchema>) {
    await this.limits.hit(`witness:${req.ip ?? 'unknown'}`, 60, 60);
    return this.svc.witnessView(q.since, q.limit);
  }
}
