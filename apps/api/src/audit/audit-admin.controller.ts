import { Body, Controller, Get, HttpCode, Inject, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, Roles, StepUp } from '../auth/decorators.js';
import { AuditAdminService } from './audit-admin.service.js';

const ListSchema = z.strictObject({
  action: z.string().trim().max(60).optional(),
  outcome: z.enum(['ALLOWED', 'DENIED', 'FAILED']).optional(),
  actor: z.string().trim().max(254).optional(),
  documentId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  before: z.coerce.bigint().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ExportSchema = z.strictObject({
  fromSeq: z.coerce.bigint().positive().default(1n),
  toSeq: z.coerce.bigint().positive().optional(),
});

const AlertsSchema = z.strictObject({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) });

const BreakGlassSchema = z.strictObject({
  documentId: z.uuid(),
  reason: z.string().trim().min(20, 'Explain in at least 20 characters why you need emergency access').max(500),
});

/** Who may call every route here: ADMIN only, after a second factor. */
@Controller('admin')
@Roles('ADMIN')
export class AuditAdminController {
  constructor(@Inject(AuditAdminService) private readonly svc: AuditAdminService) {}

  /** Document activity and permission changes, filterable, newest first. */
  @Get('audit')
  list(@Query(new ZodPipe(ListSchema)) q: z.infer<typeof ListSchema>) {
    return this.svc.list(q);
  }

  /** Recompute the whole hash chain and check every signed checkpoint. */
  @Post('audit/verify')
  @HttpCode(200)
  verify(@CurrentActor() actor: Actor) {
    return this.svc.verify(actor);
  }

  /** Sign the current chain head now (also runs every minute when there are new events). */
  @Post('audit/checkpoint')
  @HttpCode(200)
  async checkpoint() {
    return { checkpoint: await this.svc.checkpoint() };
  }

  /** Download an evidence bundle that tools/verify-audit.mjs can check offline. */
  @Get('audit/export')
  async export(@CurrentActor() actor: Actor, @Query(new ZodPipe(ExportSchema)) q: z.infer<typeof ExportSchema>, @Res() res: Response) {
    const bundle = await this.svc.export(actor, q.fromSeq, q.toSeq);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="trustvault-audit-${bundle.events[0]!.seq}-${bundle.events.at(-1)!.seq}.json"`);
    res.end(JSON.stringify(bundle, null, 2));
  }

  /** Things worth noticing over the last N hours. */
  @Get('alerts')
  alerts(@Query(new ZodPipe(AlertsSchema)) q: z.infer<typeof AlertsSchema>) {
    return this.svc.alerts(q.hours);
  }

  /** Emergency one-hour READ access to one document, with a written reason. Alerted. */
  @Post('break-glass')
  @StepUp()
  breakGlass(@CurrentActor() actor: Actor, @Body(new ZodPipe(BreakGlassSchema)) body: z.infer<typeof BreakGlassSchema>) {
    return this.svc.breakGlass(actor, body.documentId, body.reason);
  }
}
