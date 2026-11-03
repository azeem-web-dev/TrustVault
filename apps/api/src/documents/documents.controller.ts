import {
  Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { type Actor, currentContext } from '../common/request-context.js';
import { CurrentActor, Roles, StepUp } from '../auth/decorators.js';
import { RateLimitService } from '../redis/rate-limit.service.js';
import { DocumentsService, type UploadedFile as File } from './documents.service.js';
import { countFormulaCells, neutralizeCsv } from '../common/csv.js';
import { sha256 } from '../crypto/file-crypto.js';
import { SharingService } from './sharing.service.js';
import { ViewingService } from './viewing.service.js';
import { CAPTURE_METHODS, CaptureReportService } from './capture-report.service.js';
import { ENV, type Env } from '../config/env.js';
import { DownloadApprovalsService } from './download-approvals.service.js';
import { AccessPolicyService } from './access-policy.service.js';
import { SharePolicySchema } from './policy-input.js';
import { DownloadLifecycleService } from '../risk/download-lifecycle.service.js';
import { UploadRefusalInterceptor } from './upload-refusal.interceptor.js';

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024;

// Multer limits: one file, a few small text fields, nothing else. Bigger
// bodies are cut off while streaming (413), not after buffering.
const upload = FileInterceptor('file', {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8, fieldSize: 4096, parts: 10, headerPairs: 50 },
});

const Uuid = z.uuid({ version: 'v4' });
const Title = z.string().trim().min(1).max(200);
const Category = z.string().trim().min(1).max(60);
const Description = z.string().trim().max(2000);

const CreateSchema = z.strictObject({
  title: Title,
  category: Category,
  description: Description.optional(),
  folderId: Uuid.optional(),
});

const UpdateSchema = z
  .strictObject({ title: Title.optional(), category: Category.optional(), description: Description.nullable().optional(), folderId: Uuid.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const SearchSchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  owner: z.string().trim().max(200).optional(),
  category: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  scope: z.enum(['all', 'mine', 'shared', 'trash']).default('all'),
  folderId: Uuid.optional(),
  page: z.coerce.number().int().min(1).max(400).default(1),
});

const GrantSchema = z
  .strictObject({
    userId: Uuid.optional(),
    groupId: Uuid.optional(),
    level: z.enum(['VIEW', 'READ', 'EDIT', 'MANAGE']),
    expiresAt: z.coerce.date().nullable().optional(),
    fromSuggestion: z.boolean().optional(),
    /** Conditions on the share: time window, networks, download approval (THREATS.md P1-P12). */
    policy: SharePolicySchema.optional(),
  })
  .refine((v) => Boolean(v.userId) !== Boolean(v.groupId), 'Share with exactly one person or one group');

const TransferSchema = z.strictObject({ newOwnerId: Uuid });

const CaptureAttemptSchema = z.strictObject({ method: z.enum(CAPTURE_METHODS), page: z.number().int().min(1).max(500).optional() });
/** Capture reports per person per 10 minutes (THREATS.md V11). */
const CAPTURE_REPORT_LIMIT = 20;

const Reason = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500);
const DownloadRequestSchema = z.strictObject({ reason: Reason, versionNo: z.number().int().min(1).optional() });
const OverrideSchema = z.strictObject({ userId: Uuid, reason: Reason, hours: z.number().int().min(1).max(24).default(4) });
/**
 * ?variant=formulas-disabled: for CSV only, a copy in which every cell a
 * spreadsheet would run as a formula starts with an apostrophe (THREATS.md
 * C7). Without it the stored bytes are sent unchanged, so their SHA-256
 * still matches the upload and the audit trail.
 */
const DownloadSchema = z.strictObject({ variant: z.enum(['formulas-disabled']).optional() });

/** Invalid ids get the same 404 as documents you cannot see. */
function docId(id: string): string {
  if (!Uuid.safeParse(id).success) {
    // Lets the error filter record this refusal: AccessService never saw it.
    const ctx = currentContext();
    if (ctx) ctx.rejectedDocumentId = id;
    throw new NotFoundException('Document not found');
  }
  return id;
}

/**
 * Who may call: any signed-in user, except where noted. Every handler that
 * names a document goes through decide() inside the service; "who may call"
 * below means "who gets past decide()".
 */
@Controller('documents')
export class DocumentsController {
  constructor(
    @Inject(DocumentsService) private readonly docs: DocumentsService,
    @Inject(SharingService) private readonly sharing: SharingService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(ViewingService) private readonly viewing: ViewingService,
    @Inject(ENV) private readonly env: Env,
    @Inject(DownloadApprovalsService) private readonly approvals: DownloadApprovalsService,
    @Inject(AccessPolicyService) private readonly policies: AccessPolicyService,
    @Inject(DownloadLifecycleService) private readonly lifecycle: DownloadLifecycleService,
    @Inject(CaptureReportService) private readonly captures: CaptureReportService,
  ) {}

  /** Search documents I own or hold a live grant on. */
  @Get()
  search(@CurrentActor() actor: Actor, @Query(new ZodPipe(SearchSchema)) q: z.infer<typeof SearchSchema>) {
    return this.docs.search(actor, q);
  }

  /** Categories of documents I can see. */
  @Get('categories')
  async categories(@CurrentActor() actor: Actor) {
    return { categories: await this.docs.categories(actor) };
  }

  /**
   * OWNER role only: upload a new document. A PDF is stored as a rebuilt
   * copy without active content; `sanitized.removed` says what was taken out.
   */
  @Post()
  @Roles('OWNER')
  // Outermost first: every refusal, multer's included, is audited (UploadRefusalInterceptor).
  @UseInterceptors(UploadRefusalInterceptor, upload)
  async create(@CurrentActor() actor: Actor, @UploadedFile() file: File | undefined, @Body(new ZodPipe(CreateSchema)) body: z.infer<typeof CreateSchema>) {
    await this.limits.hit(`upload:${actor.userId}`, 60, 600, 'Too many uploads. Try again in a few minutes.');
    return this.docs.create(actor, file, body);
  }

  /** READ or better. */
  @Get(':id')
  get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.docs.get(actor, docId(id));
  }

  /** EDIT for title/category/description; owner for folderId. */
  @Patch(':id')
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @Body(new ZodPipe(UpdateSchema)) body: z.infer<typeof UpdateSchema>) {
    return this.docs.update(actor, docId(id), body);
  }

  /** EDIT or better: upload a new version. */
  @Post(':id/versions')
  // Outermost first: every refusal, multer's included, is audited (UploadRefusalInterceptor).
  @UseInterceptors(UploadRefusalInterceptor, upload)
  async addVersion(@CurrentActor() actor: Actor, @Param('id') id: string, @UploadedFile() file: File | undefined) {
    await this.limits.hit(`upload:${actor.userId}`, 60, 600, 'Too many uploads. Try again in a few minutes.');
    return this.docs.addVersion(actor, docId(id), file);
  }

  /** READ or better: current version. */
  @Get(':id/download')
  async download(@CurrentActor() actor: Actor, @Param('id') id: string, @Query(new ZodPipe(DownloadSchema)) q: z.infer<typeof DownloadSchema>, @Res() res: Response) {
    await this.limits.hit(`download:${actor.userId}`, 300, 600, 'Too many downloads. Try again in a few minutes.');
    this.send(res, await this.docs.download(actor, docId(id), undefined, q.variant), q.variant);
  }

  /** READ or better: a specific version. */
  @Get(':id/versions/:versionNo/download')
  async downloadVersion(
    @CurrentActor() actor: Actor, @Param('id') id: string, @Param('versionNo', new ParseIntPipe()) versionNo: number,
    @Query(new ZodPipe(DownloadSchema)) q: z.infer<typeof DownloadSchema>, @Res() res: Response,
  ) {
    await this.limits.hit(`download:${actor.userId}`, 300, 600, 'Too many downloads. Try again in a few minutes.');
    this.send(res, await this.docs.download(actor, docId(id), versionNo, q.variant), q.variant);
  }

  /** VIEW or better: how many pages the current version has (THREATS.md V2). */
  @Get(':id/pages')
  pages(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.viewing.pageCount(actor, docId(id));
  }

  /**
   * VIEW or better: one page as a PNG with the viewer's watermark. Never the
   * original bytes; each page is a `document.page_view` audit row with the
   * trace code drawn on it (THREATS.md V2-V4, V7).
   */
  @Get(':id/pages/:n')
  async page(@CurrentActor() actor: Actor, @Param('id') id: string, @Param('n', new ParseIntPipe()) n: number, @Res() res: Response) {
    await this.limits.hit(`pages:${actor.userId}`, this.env.PAGE_VIEW_RATE_LIMIT, 600, 'Too many pages viewed. Try again in a few minutes.');
    const { png, trace } = await this.viewing.page(actor, docId(id), n);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(png.length));
    res.setHeader('Content-Disposition', 'inline; filename="page.png"');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Trace-Code', trace);
    res.end(png);
  }

  /**
   * VIEW or better: the web viewer saw a key press that usually starts a
   * screen capture. Recorded for the owner (history, alert, one email an
   * hour); the answer is an empty 204 whatever happens after the audit row,
   * so the viewer learns nothing (THREATS.md V11).
   */
  @Post(':id/capture-attempt')
  @HttpCode(204)
  async captureAttempt(@CurrentActor() actor: Actor, @Param('id') id: string, @Body(new ZodPipe(CaptureAttemptSchema)) body: z.infer<typeof CaptureAttemptSchema>) {
    await this.limits.hit(`capture:${actor.userId}`, CAPTURE_REPORT_LIMIT, 600, 'Too many requests. Try again later.');
    await this.captures.report(actor, docId(id), body);
  }

  /** READ or better: the key for the Android app's encrypted copy (THREATS.md V6). */
  @Post(':id/offline-key')
  @HttpCode(200)
  offlineKey(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.viewing.offlineKey(actor, docId(id));
  }

  /** Owner only. */
  @Post(':id/trash')
  @HttpCode(204)
  async trash(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.docs.trash(actor, docId(id));
  }

  /** Owner only. */
  @Post(':id/restore')
  @HttpCode(204)
  async restore(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.docs.restore(actor, docId(id));
  }

  /** Owner only, and only from the trash. */
  @Delete(':id')
  @HttpCode(204)
  @StepUp()
  async purge(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.docs.purge(actor, docId(id));
  }

  /** Owner only. */
  @Post(':id/transfer')
  @HttpCode(200)
  @StepUp()
  transfer(@CurrentActor() actor: Actor, @Param('id') id: string, @Body(new ZodPipe(TransferSchema)) body: z.infer<typeof TransferSchema>) {
    return this.docs.transfer(actor, docId(id), body.newOwnerId);
  }

  /** MANAGE or better. */
  @Get(':id/history')
  async history(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return { events: await this.docs.history(actor, docId(id)) };
  }

  /** MANAGE or better: who has access. */
  @Get(':id/access')
  access(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.sharing.list(actor, docId(id));
  }

  /** MANAGE or better (MANAGE level itself: owner only). Create or change a grant. */
  @Put(':id/access')
  grant(@CurrentActor() actor: Actor, @Param('id') id: string, @Body(new ZodPipe(GrantSchema)) body: z.infer<typeof GrantSchema>) {
    return this.sharing.grant(actor, docId(id), body);
  }

  /** MANAGE or better (removing MANAGE: owner only). */
  @Delete(':id/access/:grantId')
  async revoke(@CurrentActor() actor: Actor, @Param('id') id: string, @Param('grantId') grantId: string) {
    if (!Uuid.safeParse(grantId).success) throw new NotFoundException('Grant not found');
    return this.sharing.revoke(actor, docId(id), grantId);
  }

  /** MANAGE or better: suggestions only, never grants anything. */
  @Get(':id/suggestions')
  suggestions(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.sharing.suggestions(actor, docId(id));
  }

  /** READ or better, on a share whose downloads need approval: ask for one version. */
  @Post(':id/download-requests')
  async requestDownload(@CurrentActor() actor: Actor, @Param('id') id: string, @Body(new ZodPipe(DownloadRequestSchema)) body: z.infer<typeof DownloadRequestSchema>) {
    await this.limits.hit(`dlreq:${actor.userId}`, 30, 3600, 'Too many download requests. Try again later.');
    return this.approvals.request(actor, docId(id), body);
  }

  /** READ or better: my requests on this document (and all of them for the owner or nominated approver). */
  @Get(':id/download-requests')
  async downloadRequests(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return { requests: await this.approvals.listForDocument(actor, docId(id)) };
  }

  /** Owner only: an emergency exception to one person's share conditions (at most 24 hours). */
  @Post(':id/overrides')
  @StepUp()
  createOverride(@CurrentActor() actor: Actor, @Param('id') id: string, @Body(new ZodPipe(OverrideSchema)) body: z.infer<typeof OverrideSchema>) {
    return this.policies.createOverride(actor, docId(id), body);
  }

  /** Owner only: end an exception early. */
  @Delete(':id/overrides/:overrideId')
  @HttpCode(204)
  async endOverride(@CurrentActor() actor: Actor, @Param('id') id: string, @Param('overrideId') overrideId: string) {
    if (!Uuid.safeParse(overrideId).success) throw new NotFoundException('Exception not found');
    await this.policies.endOverride(actor, docId(id), overrideId);
  }

  /**
   * Files are always sent as attachments with a locked-down CSP, so even a
   * file that slipped past validation can never run as a page on our origin.
   */
  private send(res: Response, stored: { data: Buffer; fileName: string; mimeType: string; sha256: string; trace: string; stamped: boolean; downloadId?: string; documentId?: string; versionNo?: number }, variant?: 'formulas-disabled') {
    let file = stored;
    if (stored.mimeType.startsWith('text/csv')) {
      if (variant === 'formulas-disabled') {
        const safe = neutralizeCsv(stored.data);
        const dot = stored.fileName.lastIndexOf('.');
        file = { ...stored, data: safe.data, fileName: `${dot > 0 ? stored.fileName.slice(0, dot) : stored.fileName} (formulas disabled).csv` };
        res.setHeader('X-Content-Variant', 'formulas-disabled');
        res.setHeader('X-Content-SHA256', sha256(safe.data).toString('hex'));
        res.setHeader('X-CSV-Formula-Cells', String(safe.changed));
      } else {
        // The original bytes, with a count the client can warn about.
        res.setHeader('X-CSV-Formula-Cells', String(countFormulaCells(stored.data)));
      }
    }
    const ascii = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.data.length));
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, private');
    // Always the hash of the stored version (the integrity anchor). A stamped
    // copy or a formulas-disabled CSV differs from it by design; X-Stamped and
    // X-Content-Variant say so, and X-Trace-Code matches the download's audit row.
    res.setHeader('X-Document-SHA256', stored.sha256);
    res.setHeader('X-Stamped', file.stamped ? 'yes' : 'no');
    res.setHeader('X-Trace-Code', file.trace);
    // Completed / interrupted are recorded after the bytes go (or don't).
    if (file.downloadId) this.lifecycle.track(res, { downloadId: file.downloadId, documentId: file.documentId!, versionNo: file.versionNo!, bytes: file.data.length });
    res.end(file.data);
  }
}
