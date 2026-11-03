import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Actor } from '../common/request-context.js';
import { CurrentActor, Roles } from '../auth/decorators.js';
import { AlertStoreService, CATEGORIES, RESOLUTIONS, SEVERITIES, STATUSES } from './alert-store.service.js';
import { AlertGeneratorService } from './alert-generator.service.js';
import { RiskSettingsService } from './risk-settings.service.js';
import { DownloadLimitsService } from './download-limits.service.js';

const QueueSchema = z.strictObject({
  status: z.enum(['active', 'all', ...STATUSES]).default('active'),
  severity: z.string().trim().max(60).optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(SEVERITIES)).optional()),
  minSeverity: z.enum(SEVERITIES).optional(),
  category: z.enum(CATEGORIES).optional(),
  rule: z.string().trim().regex(/^[a-z_]{2,60}$/).optional(),
  subject: z.string().trim().min(1).max(254).optional(),
  subjectUserId: z.uuid().optional(),
  documentId: z.uuid().optional(),
  assignee: z.union([z.literal('me'), z.uuid()]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['severity', 'newest']).default('severity'),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const Note = z.string().trim().max(2000);
const AckSchema = z.strictObject({ note: Note.optional() });
const AssignSchema = z.strictObject({ assigneeId: z.uuid(), note: Note.optional() });
const ResolveSchema = z.strictObject({ resolution: z.enum(RESOLUTIONS), note: Note.min(5, 'Say what you found (at least 5 characters)') });
const NoteSchema = z.strictObject({ note: Note.min(5, 'Add a note of at least 5 characters') });

const SettingsSchema = z.strictObject({
  values: z.record(z.string(), z.number()),
  reason: z.string().trim().min(10, 'Explain the change in at least 10 characters').max(500),
});

const OverrideSchema = z.strictObject({
  userId: z.uuid(),
  dailyLimit: z.number().int().min(1).max(100_000),
  sessionLimit: z.number().int().min(1).max(100_000),
  reason: z.string().trim().min(20, 'Explain the legitimate need in at least 20 characters').max(500),
  expiresAt: z.coerce.date(),
});

const OverrideListSchema = z.strictObject({ userId: z.uuid().optional() });

/**
 * Alert review, detection thresholds and download limits. ADMIN only, after
 * a second factor (the guard enforces both). Every change is audited.
 */
@Controller('admin')
@Roles('ADMIN')
export class RiskController {
  constructor(
    @Inject(AlertStoreService) private readonly alerts: AlertStoreService,
    @Inject(AlertGeneratorService) private readonly generator: AlertGeneratorService,
    @Inject(RiskSettingsService) private readonly settings: RiskSettingsService,
    @Inject(DownloadLimitsService) private readonly limits: DownloadLimitsService,
  ) {}

  /** Every alert, filtered and paginated; severity first by default. */
  @Get('alert-queue')
  list(@CurrentActor() actor: Actor, @Query(new ZodPipe(QueueSchema)) q: z.infer<typeof QueueSchema>) {
    return this.alerts.list(q, actor);
  }

  @Get('alert-queue/summary')
  summary() {
    return this.alerts.summary();
  }

  @Get('alert-queue/reviewers')
  reviewers() {
    return this.alerts.reviewers();
  }

  /** Evaluate the rules now instead of waiting for the next minute. */
  @Post('alert-queue/evaluate')
  @HttpCode(200)
  async evaluate() {
    return { run: await this.generator.run() };
  }

  @Get('alert-queue/:id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.alerts.get(id);
  }

  @Post('alert-queue/:id/acknowledge')
  @HttpCode(200)
  acknowledge(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(AckSchema)) b: z.infer<typeof AckSchema>) {
    return this.alerts.review(actor, id, 'acknowledge', b);
  }

  @Post('alert-queue/:id/assign')
  @HttpCode(200)
  assign(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(AssignSchema)) b: z.infer<typeof AssignSchema>) {
    return this.alerts.review(actor, id, 'assign', b);
  }

  @Post('alert-queue/:id/resolve')
  @HttpCode(200)
  resolve(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(ResolveSchema)) b: z.infer<typeof ResolveSchema>) {
    return this.alerts.review(actor, id, 'resolve', b);
  }

  @Post('alert-queue/:id/reopen')
  @HttpCode(200)
  reopen(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(NoteSchema)) b: z.infer<typeof NoteSchema>) {
    return this.alerts.review(actor, id, 'reopen', b);
  }

  @Post('alert-queue/:id/comment')
  @HttpCode(200)
  comment(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(NoteSchema)) b: z.infer<typeof NoteSchema>) {
    return this.alerts.review(actor, id, 'comment', b);
  }

  // ------------------------------------------------------- thresholds

  @Get('risk-settings')
  getSettings() {
    return this.settings.describe();
  }

  /** Change thresholds or hard limits. Audited with before/after; raises a policy alert. */
  @Put('risk-settings')
  putSettings(@CurrentActor() actor: Actor, @Body(new ZodPipe(SettingsSchema)) b: z.infer<typeof SettingsSchema>) {
    return this.settings.update(actor, b.values, b.reason);
  }

  // ------------------------------------------------------ download limits

  @Get('download-limits/overrides')
  overrides(@Query(new ZodPipe(OverrideListSchema)) q: z.infer<typeof OverrideListSchema>) {
    return this.limits.listOverrides(q.userId);
  }

  /** Raise one person's limits for a while (at most 14 days), with a reason. Audited; raises a policy alert. */
  @Post('download-limits/overrides')
  grant(@CurrentActor() actor: Actor, @Body(new ZodPipe(OverrideSchema)) b: z.infer<typeof OverrideSchema>) {
    return this.limits.grantOverride(actor, b);
  }

  @Post('download-limits/overrides/:id/revoke')
  @HttpCode(204)
  async revoke(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.limits.revokeOverride(actor, id);
  }

  @Get('download-limits/usage/:userId')
  usage(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.limits.usage(userId);
  }
}
