import { randomBytes } from 'node:crypto';
import { Inject, Injectable, InternalServerErrorException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { KEY_PROVIDER, type KeyProvider } from '../crypto/key-provider.js';
import { blobAad, openFile, sha256 } from '../crypto/file-crypto.js';
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
    }).catch((err: unknown) => this.accessEnded(err, actor, id, 'document.page_view'));
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
    return this.prisma.asUser(actor.userId, async (tx) => {
      const decision = await this.access.require(tx, actor, id, 'offline_key');
      let row = await tx.offlineKey.findUnique({ where: { documentId_userId: { documentId: id, userId: actor.userId } } });
      let created = false;
      if (!row) {
        const { wrapped, keyId } = await this.keys.wrap(randomBytes(32), offlineAad(id, actor.userId));
        row = await tx.offlineKey.create({ data: { documentId: id, userId: actor.userId, wrappedKey: new Uint8Array(wrapped), keyId } });
        created = true;
      }
      const key = await this.keys.unwrap(Buffer.from(row.wrappedKey), row.keyId, offlineAad(id, actor.userId));
      await this.audit.record({
        action: 'document.offline_key', outcome: 'ALLOWED', reason: decision.reason, targetType: 'document', targetId: id, documentId: id,
        details: { created },
      }, tx);
      return { documentId: id, key: key.toString('base64'), algorithm: 'AES-256-GCM' };
    }).catch((err: unknown) => this.accessEnded(err, actor, id, 'document.offline_key'));
  }

  // ---------------------------------------------------------------- helpers

  /**
   * The database refuses an ALLOWED row once access has lapsed (an expiry
   * nobody committed, THREATS.md R11): nothing is sent, and the refusal is
   * recorded like any other.
   */
  private async accessEnded(err: unknown, actor: Actor, id: string, action: string): Promise<never> {
    if (!String((err as Error)?.message).includes('access ended during the request')) throw err;
    await this.audit.record({ action, outcome: 'DENIED', reason: 'access_ended_during_request', targetType: 'document', targetId: id, documentId: id });
    throw new NotFoundException('Document not found');
  }

  /**
   * The current version, decrypted. decide() first; then the encrypted
   * blob comes through tv_render_source(), which itself requires VIEW for
   * the current user, because a VIEW grantee cannot read document_blobs.
   */
  private async source(actor: Actor, id: string): Promise<Source> {
    const found = await this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, id, 'view_pages');
      return this.loadSource(tx, id);
    });
    if (!found) throw new NotFoundException('Version not found');
    const kind = pageKind(found.mime_type);
    if (!kind) return { versionId: found.version_id, versionNo: found.version_no, kind: null, bytes: Buffer.alloc(0) };
    let bytes: Buffer;
    try {
      bytes = await openFile(this.keys, {
        wrappedKey: Buffer.from(found.wrapped_key), keyId: found.key_id, nonce: Buffer.from(found.nonce),
        authTag: Buffer.from(found.auth_tag), ciphertext: Buffer.from(found.ciphertext),
      }, blobAad(id, found.version_id, found.version_no));
    } catch {
      await this.audit.record({ action: 'document.integrity', outcome: 'FAILED', reason: 'decryption_failed', targetType: 'document', targetId: id, documentId: id, details: { versionNo: found.version_no, during: 'page_view' } });
      throw new InternalServerErrorException('This file failed its integrity check and was not shown');
    }
    if (!sha256(bytes).equals(Buffer.from(found.sha256))) {
      await this.audit.record({ action: 'document.integrity', outcome: 'FAILED', reason: 'hash_mismatch', targetType: 'document', targetId: id, documentId: id, details: { versionNo: found.version_no, during: 'page_view' } });
      throw new InternalServerErrorException('This file failed its integrity check and was not shown');
    }
    return { versionId: found.version_id, versionNo: found.version_no, kind, bytes };
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
