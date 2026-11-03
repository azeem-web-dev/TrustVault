import {
  Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { type Actor, currentContext } from '../common/request-context.js';
import { CurrentActor, Roles } from '../auth/decorators.js';
import { RateLimitService } from '../redis/rate-limit.service.js';
import { DocumentsService, type UploadedFile as File } from './documents.service.js';
import { SharingService } from './sharing.service.js';
import { DownloadApprovalsService } from './download-approvals.service.js';
import { AccessPolicyService } from './access-policy.service.js';
import { SharePolicySchema } from './policy-input.js';

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
    level: z.enum(['READ', 'EDIT', 'MANAGE']),
    expiresAt: z.coerce.date().nullable().optional(),
    fromSuggestion: z.boolean().optional(),
    /** Conditions on the share: time window, networks, download approval (THREATS.md P1-P12). */
    policy: SharePolicySchema.optional(),
  })
  .refine((v) => Boolean(v.userId) !== Boolean(v.groupId), 'Share with exactly one person or one group');

const TransferSchema = z.strictObject({ newOwnerId: Uuid });

const Reason = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500);
const DownloadRequestSchema = z.strictObject({ reason: Reason, versionNo: z.number().int().min(1).optional() });
const OverrideSchema = z.strictObject({ userId: Uuid, reason: Reason, hours: z.number().int().min(1).max(24).default(4) });

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
    @Inject(DownloadApprovalsService) private readonly approvals: DownloadApprovalsService,
    @Inject(AccessPolicyService) private readonly policies: AccessPolicyService,
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

  /** OWNER role only: upload a new document. */
  @Post()
  @Roles('OWNER')
  @UseInterceptors(upload)
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
  @UseInterceptors(upload)
  async addVersion(@CurrentActor() actor: Actor, @Param('id') id: string, @UploadedFile() file: File | undefined) {
    await this.limits.hit(`upload:${actor.userId}`, 60, 600, 'Too many uploads. Try again in a few minutes.');
    return this.docs.addVersion(actor, docId(id), file);
  }

  /** READ or better: current version. */
  @Get(':id/download')
  async download(@CurrentActor() actor: Actor, @Param('id') id: string, @Res() res: Response) {
    await this.limits.hit(`download:${actor.userId}`, 300, 600, 'Too many downloads. Try again in a few minutes.');
    this.send(res, await this.docs.download(actor, docId(id)));
  }

  /** READ or better: a specific version. */
  @Get(':id/versions/:versionNo/download')
  async downloadVersion(@CurrentActor() actor: Actor, @Param('id') id: string, @Param('versionNo', new ParseIntPipe()) versionNo: number, @Res() res: Response) {
    await this.limits.hit(`download:${actor.userId}`, 300, 600, 'Too many downloads. Try again in a few minutes.');
    this.send(res, await this.docs.download(actor, docId(id), versionNo));
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
  async purge(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.docs.purge(actor, docId(id));
  }

  /** Owner only. */
  @Post(':id/transfer')
  @HttpCode(200)
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
  private send(res: Response, file: { data: Buffer; fileName: string; mimeType: string; sha256: string }) {
    const ascii = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.data.length));
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Document-SHA256', file.sha256);
    res.end(file.data);
  }
}
