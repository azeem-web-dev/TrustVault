import { randomBytes } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, InternalServerErrorException, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { KEY_PROVIDER, type KeyProvider } from '../crypto/key-provider.js';
import { blobAad, openFile, sha256 } from '../crypto/file-crypto.js';
import { issueUnwrapTicket, isTicketRefusal, keyServiceRefusal, ticketRefusalReason } from '../crypto/tickets.js';
import type { Actor } from '../common/request-context.js';
import { AccessService } from './access.js';
import { countPages, drawPage, pageKind, traceCode, watermark, type PageKind } from './pages.js';

const offlineAad = (documentId: string, userId: string) => `tv-offline-v1|${documentId}|${userId}`;

export const NO_PREVIEW = 'Preview is not available for this file type. Ask the owner for download access.';

interface Source {
  versionId: string;
  versionNo: number;
  kind: PageKind | null;
  bytes: Buffer;
}

/**
 * A drawn version stays decrypted in memory for this long, per person, so
 * paging through a document is one key release (one keyd ticket, one
 * 'document.render' row), not one per page: keyd allows 60 unwraps a minute
 * per person. Every page is still decided and audited on its own, so a
 * revoke stops the next page at once; the cache only saves the decryption.
 */
const RENDER_CACHE_MS = 120_000;
const RENDER_CACHE_ENTRIES = 32;

/**
 * View-only pages and the Android app's per-document keys.
 *
 * Pages: decide() needs VIEW ('view_pages'), the file is decrypted and drawn
 * here, and each page is sent as a PNG with the viewer's email, the time
 * and a trace code drawn across it. The trace code is in that page's audit
 * row, committed before the image is sent, so a leaked screenshot leads
 * back to one person and one moment (THREATS.md V2-V4).
 */
@Injectable()
export class ViewingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  private readonly rendered = new Map<string, { bytes: Buffer; until: number }>();

  /** How many pages the current version has, or why it cannot be shown. */
  async pageCount(actor: Actor, id: string) {
    const src = await this.source(actor, id);
    if (!src.kind) return { versionNo: src.versionNo, pages: 0, preview: false, message: NO_PREVIEW };
    const pages = await this.safely(id, src.versionNo, () => countPages(src.versionId, src.kind!, src.bytes));
    return { versionNo: src.versionNo, pages, preview: true, message: null };
  }

  /** One watermarked page of the current version. */
  async page(actor: Actor, id: string, n: number): Promise<{ png: Buffer; trace: string }> {
    const src = await this.source(actor, id);
    if (!src.kind) throw new UnprocessableEntityException(NO_PREVIEW);
    const total = await this.safely(id, src.versionNo, () => countPages(src.versionId, src.kind!, src.bytes));
    if (n < 1 || n > total) throw new NotFoundException('Page not found');
    const base = await this.safely(id, src.versionNo, () => drawPage(src.versionId, src.kind!, src.bytes, n));

    const trace = traceCode();
    const at = new Date();
    const png = await watermark(base, { email: actor.email, at, trace });
    // Decided again and audited in one transaction, committed before the
    // image is sent: a revoke that landed while the page was being drawn
    // wins (THREATS.md V2).
    await this.prisma.asUser(actor.userId, async (tx) => {
      const decision = await this.access.require(tx, actor, id, 'view_pages');
      await this.audit.record({
        action: 'document.page_view', outcome: 'ALLOWED', reason: decision.reason, targetType: 'document', targetId: id, documentId: id,
        details: { page: n, pages: total, versionNo: src.versionNo, trace, at: at.toISOString() },
      }, tx);
    }).catch((err: unknown) => this.refused(err, id, 'document.page_view'));
    return { png, trace };
  }

  /**
   * The key the Android app uses for its encrypted copy of this document.
   * READ or better ('offline_key'); asked for on every open, so a copy
   * left on a phone stays shut once access ends. The database lock agrees:
   * offline_keys rows are visible only at READ or better, and are deleted
   * when a grant change drops someone below READ (THREATS.md V6).
   */
  async offlineKey(actor: Actor, id: string) {
    const aad = offlineAad(id, actor.userId);
    const got = await this.prisma.asUser(actor.userId, async (tx) => {
      const decision = await this.access.require(tx, actor, id, 'offline_key');
      const doc = await tx.document.findUnique({ where: { id }, select: { currentVersionNo: true } });
      const version = doc ? await tx.documentVersion.findUnique({ where: { documentId_versionNo: { documentId: id, versionNo: doc.currentVersionNo } }, select: { id: true, versionNo: true } }) : null;
      if (!version) throw new NotFoundException('Document not found');
      const row = await tx.offlineKey.findUnique({ where: { documentId_userId: { documentId: id, userId: actor.userId } } });
      if (!row) {
        // A new copy key: generated here, so no key release is needed to hand it over.
        const key = randomBytes(32);
        const { wrapped, keyId } = await this.keys.wrap(key, aad);
        await tx.offlineKey.create({ data: { documentId: id, userId: actor.userId, wrappedKey: new Uint8Array(wrapped), keyId } });
        await this.audit.record({
          action: 'document.offline_key', outcome: 'ALLOWED', reason: decision.reason, targetType: 'document', targetId: id, documentId: id,
          details: { created: true, versionNo: version.versionNo },
        }, tx);
        return { key, wrapped: null, keyId: null, ticket: null };
      }
      // An existing one: keyd opens it only against a database ticket for
      // this person and document, backed by this ALLOWED row (docs/KEYS.md).
      const event = await this.audit.record({
        action: 'document.offline_key', outcome: 'ALLOWED', reason: decision.reason, targetType: 'document', targetId: id, documentId: id,
        details: { created: false, versionNo: version.versionNo },
      }, tx);
      const ticket = await issueUnwrapTicket(tx, version.id, 'offline_key', event.id);
      return { key: null, wrapped: Buffer.from(row.wrappedKey), keyId: row.keyId, ticket };
    }).catch((err: unknown) => this.refused(err, id, 'document.offline_key'));
    let key: Buffer;
    if (got.key) key = got.key;
    else {
      try {
        key = await this.keys.unwrap(got.wrapped!, got.keyId!, aad, got.ticket!);
      } catch (err) {
        await this.keyServiceSaidNo(err, id, 'document.offline_key');
        throw err;
      }
    }
    try {
      return { documentId: id, key: key.toString('base64'), algorithm: 'AES-256-GCM' };
    } finally {
      key.fill(0);
    }
  }

  // ---------------------------------------------------------------- helpers

  /**
   * The database refuses an ALLOWED row once access has lapsed (an expiry
   * nobody committed, THREATS.md R11), or refuses the key ticket: nothing is
   * sent, and the refusal is recorded like any other.
   */
  private async refused(err: unknown, id: string, action: string): Promise<never> {
    if (String((err as Error)?.message).includes('access ended during the request')) {
      await this.audit.record({ action, outcome: 'DENIED', reason: 'access_ended_during_request', targetType: 'document', targetId: id, documentId: id });
      throw new NotFoundException('Document not found');
    }
    if (isTicketRefusal(err)) {
      await this.audit.record({ action, outcome: 'DENIED', reason: 'key_ticket_refused', targetType: 'document', targetId: id, documentId: id, details: { refusal: ticketRefusalReason(err) } });
      throw new NotFoundException('Document not found');
    }
    throw err;
  }

  /** keyd refused a valid-looking ticket (rate limit...) or is down: say so, record it. */
  private async keyServiceSaidNo(err: unknown, id: string, action: string): Promise<void> {
    const refusal = keyServiceRefusal(err);
    if (!refusal) return;
    await this.audit.record({ action, outcome: refusal === 'key_service_unavailable' ? 'FAILED' : 'DENIED', reason: 'key_service_refused', targetType: 'document', targetId: id, documentId: id, details: { refusal } });
    if (refusal === 'rate_limited') throw new HttpException('Too many files opened in a short time. Try again in a minute.', HttpStatus.TOO_MANY_REQUESTS);
    throw new ServiceUnavailableException('The key service did not release this file. Try again shortly.');
  }

  /**
   * The current version, decrypted. decide() first; then the encrypted
   * blob comes through tv_render_source(), which itself requires VIEW for
   * the current user, because a VIEW grantee cannot read document_blobs.
   */
  private async source(actor: Actor, id: string): Promise<Source> {
    const found = await this.prisma.asUser(actor.userId, async (tx) => {
      const decision = await this.access.require(tx, actor, id, 'view_pages');
      const row = await this.loadSource(tx, id);
      if (!row) return null;
      if (!pageKind(row.mime_type)) return { row, ticket: null, cached: null };
      const hit = this.rendered.get(`${actor.userId}|${row.version_id}`);
      if (hit && hit.until > Date.now()) return { row, ticket: null, cached: hit.bytes };
      // One key release per drawn version: its own ALLOWED row backs the
      // keyd ticket (unwrap_actions 'view_page', VIEW or better).
      const event = await this.audit.record({
        action: 'document.render', outcome: 'ALLOWED', reason: decision.reason, targetType: 'document', targetId: id, documentId: id,
        details: { versionNo: row.version_no },
      }, tx);
      const ticket = await issueUnwrapTicket(tx, row.version_id, 'view_page', event.id);
      return { row, ticket, cached: null };
    }).catch((err: unknown) => this.refused(err, id, 'document.view_pages'));
    if (!found) throw new NotFoundException('Version not found');
    const { row } = found;
    const kind = pageKind(row.mime_type);
    if (!kind) return { versionId: row.version_id, versionNo: row.version_no, kind: null, bytes: Buffer.alloc(0) };
    if (found.cached) return { versionId: row.version_id, versionNo: row.version_no, kind, bytes: found.cached };
    let bytes: Buffer;
    try {
      bytes = await openFile(this.keys, {
        wrappedKey: Buffer.from(row.wrapped_key), keyId: row.key_id, nonce: Buffer.from(row.nonce),
        authTag: Buffer.from(row.auth_tag), ciphertext: Buffer.from(row.ciphertext),
      }, blobAad(id, row.version_id, row.version_no), found.ticket!);
    } catch (err) {
      await this.keyServiceSaidNo(err, id, 'document.view_pages');
      await this.audit.record({ action: 'document.integrity', outcome: 'FAILED', reason: 'decryption_failed', targetType: 'document', targetId: id, documentId: id, details: { versionNo: row.version_no, during: 'page_view' } });
      throw new InternalServerErrorException('This file failed its integrity check and was not shown');
    }
    if (!sha256(bytes).equals(Buffer.from(row.sha256))) {
      await this.audit.record({ action: 'document.integrity', outcome: 'FAILED', reason: 'hash_mismatch', targetType: 'document', targetId: id, documentId: id, details: { versionNo: row.version_no, during: 'page_view' } });
      throw new InternalServerErrorException('This file failed its integrity check and was not shown');
    }
    this.remember(`${actor.userId}|${row.version_id}`, bytes);
    return { versionId: row.version_id, versionNo: row.version_no, kind, bytes };
  }

  private remember(key: string, bytes: Buffer): void {
    const now = Date.now();
    for (const [k, v] of this.rendered) if (v.until <= now) this.rendered.delete(k);
    while (this.rendered.size >= RENDER_CACHE_ENTRIES) this.rendered.delete(this.rendered.keys().next().value!);
    this.rendered.set(key, { bytes, until: now + RENDER_CACHE_MS });
  }

  private async loadSource(tx: Tx, id: string) {
    const doc = await tx.document.findUnique({ where: { id }, select: { currentVersionNo: true } });
    if (!doc) return null;
    const version = await tx.documentVersion.findUnique({ where: { documentId_versionNo: { documentId: id, versionNo: doc.currentVersionNo } }, select: { id: true } });
    if (!version) return null;
    const [row] = await tx.$queryRaw<{
      document_id: string; version_no: number; mime_type: string; wrapped_key: Uint8Array; key_id: string;
      nonce: Uint8Array; auth_tag: Uint8Array; ciphertext: Uint8Array; sha256: Uint8Array;
    }[]>`SELECT * FROM tv_render_source(${version.id}::uuid)`;
    // No row: quarantined, or the database lock disagrees with decide().
    return row ? { ...row, version_id: version.id } : null;
  }

  /** A file pdf.js cannot draw is answered plainly, and recorded. */
  private async safely<T>(id: string, versionNo: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      await this.audit.record({ action: 'document.page_view', outcome: 'FAILED', reason: 'render_failed', targetType: 'document', targetId: id, documentId: id, details: { versionNo, error: String((err as Error)?.message ?? err).slice(0, 200) } });
      throw new UnprocessableEntityException('This file could not be shown as pages');
    }
  }
}
