import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { KEY_PROVIDER, type KeyProvider } from '../crypto/key-provider.js';
import { blobAad, openFile, sealFile, sha256 } from '../crypto/file-crypto.js';
import type { Actor } from '../common/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AccessService, Level } from './access.js';
import { DownloadApprovalsService } from './download-approvals.service.js';
import { remainingLevel } from './sharing.service.js';
import { detectType, RejectedFile, safeFileName } from './content-check.js';
import { MALWARE_SCANNER, ScannerUnavailable, type MalwareScanner } from '../scanning/malware-scanner.js';

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

export interface SearchFilters {
  q?: string | undefined;
  owner?: string | undefined;
  category?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  scope: 'all' | 'mine' | 'shared' | 'trash';
  folderId?: string | undefined;
  page: number;
}

const PAGE_SIZE = 25;
const LEVEL_NAME: Record<number, string> = { 1: 'READ', 2: 'EDIT', 3: 'MANAGE', 4: 'OWNER' };

const LIST_SELECT = {
  id: true, title: true, category: true, description: true, status: true,
  createdAt: true, updatedAt: true, deletedAt: true, currentVersionNo: true, folderId: true, ownerId: true,
  owner: { select: { id: true, displayName: true, email: true } },
  versions: {
    orderBy: { versionNo: 'desc' }, take: 1,
    select: { versionNo: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
  },
} as const satisfies Prisma.DocumentSelect;

type ListRow = Prisma.DocumentGetPayload<{ select: typeof LIST_SELECT }>;

/**
 * Layer 1 of search: documents the caller owns or holds a live grant on
 * (directly, or through a group unless they are external). Row-level
 * security applies the same rule again in the database (layer 2).
 */
export function accessFilter(actor: Pick<Actor, 'userId' | 'role'>, now: Date = new Date()): Prisma.DocumentWhereInput {
  const me = actor.userId;
  // Admins never see documents through search (THREATS.md A17, A20).
  if (actor.role === 'ADMIN') return { id: { in: [] } };
  const liveGrant: Prisma.GrantWhereInput = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  const mine: Prisma.GrantWhereInput =
    actor.role === 'EXTERNAL'
      ? { userId: me }
      // A group grant counts only for members the sharer confirmed (A19).
      : { OR: [{ userId: me }, { AND: [{ group: { members: { some: { userId: me } } } }, { coveredMembers: { some: { userId: me } } }] }] };
  return { OR: [{ ownerId: me }, { grants: { some: { AND: [liveGrant, mine] } } }] };
}

/** The full search condition. Exported so the access part can be tested without row-level security. */
export function buildSearchWhere(actor: Pick<Actor, 'userId' | 'role'>, f: SearchFilters, now: Date = new Date()): Prisma.DocumentWhereInput {
  const me = actor.userId;
  const and: Prisma.DocumentWhereInput[] = [];
  if (f.scope === 'trash') and.push({ status: 'DELETED', ownerId: me });
  else {
    and.push({ status: 'ACTIVE' }, accessFilter(actor, now));
    if (f.scope === 'mine') and.push({ ownerId: me });
    else if (f.scope === 'shared') and.push({ ownerId: { not: me } });
  }
  if (f.q) and.push({ OR: [{ title: { contains: f.q, mode: 'insensitive' } }, { description: { contains: f.q, mode: 'insensitive' } }] });
  if (f.owner) and.push({ owner: { OR: [{ displayName: { contains: f.owner, mode: 'insensitive' } }, { email: { contains: f.owner, mode: 'insensitive' } }] } });
  if (f.category) and.push({ category: { equals: f.category, mode: 'insensitive' } });
  if (f.from) and.push({ createdAt: { gte: f.from } });
  if (f.to) and.push({ createdAt: { lte: f.to } });
  if (f.folderId) and.push({ folderId: f.folderId, ownerId: me });
  return { AND: and };
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(DownloadApprovalsService) private readonly approvals: DownloadApprovalsService,
  ) {}

  // ------------------------------------------------------------------ search

  /**
   * Search runs with TWO filters: the explicit access filter below (only
   * documents I own or hold a live grant on) and row-level security in the
   * database. Either alone is enough to hide documents I cannot read; both
   * must fail for a leak. Counts are computed on the filtered set, so the
   * number of results never reveals what exists.
   */
  async search(actor: Actor, f: SearchFilters) {
    const me = actor.userId;
    const where = buildSearchWhere(actor, f);

    return this.prisma.asUser(me, async (tx) => {
      const [total, rows] = await Promise.all([
        tx.document.count({ where }),
        tx.document.findMany({
          where, select: LIST_SELECT, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          skip: (f.page - 1) * PAGE_SIZE, take: PAGE_SIZE,
        }),
      ]);
      const levels = await this.levels(tx, rows.map((r) => r.id), me);
      return { total, page: f.page, pageSize: PAGE_SIZE, documents: rows.map((r) => this.toListItem(r, levels.get(r.id) ?? 0, me)) };
    });
  }

  /** Categories of documents I can see (for the search filter). */
  async categories(actor: Actor): Promise<string[]> {
    return this.prisma.asUser(actor.userId, async (tx) => {
      const rows = await tx.document.findMany({ where: { AND: [{ status: 'ACTIVE' }, accessFilter(actor)] }, distinct: ['category'], select: { category: true }, orderBy: { category: 'asc' }, take: 200 });
      return rows.map((r) => r.category);
    });
  }

  // ---------------------------------------------------------------- one doc

  async get(actor: Actor, id: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      const decision = await this.access.require(tx, actor, id, 'view');
      const doc = await tx.document.findUnique({
        where: { id },
        select: {
          ...LIST_SELECT,
          folder: { select: { id: true, name: true } },
          versions: {
            orderBy: { versionNo: 'desc' },
            select: { versionNo: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true, sha256: true, uploadedBy: { select: { displayName: true } }, quarantine: { select: { signature: true, foundAt: true } } },
          },
        },
      });
      if (!doc) throw new NotFoundException('Document not found');
      await this.audit.record({ action: 'document.view', outcome: 'ALLOWED', reason: decision.reason, targetType: 'document', targetId: id, documentId: id }, tx);
      return {
        ...this.toListItem(doc, decision.level, actor.userId),
        // Downloads need an approval from the owner (THREATS.md P8).
        downloadNeedsApproval: decision.approvalRequired === true,
        folder: doc.ownerId === actor.userId ? doc.folder : null,
        versions: doc.versions.map((v) => ({
          versionNo: v.versionNo, fileName: v.fileName, mimeType: v.mimeType, sizeBytes: v.sizeBytes,
          createdAt: v.createdAt, sha256: Buffer.from(v.sha256).toString('hex'), uploadedBy: v.uploadedBy.displayName,
          quarantine: v.quarantine ? { signature: v.quarantine.signature, foundAt: v.quarantine.foundAt } : null,
        })),
      };
    });
  }

  // ----------------------------------------------------------------- upload

  async create(actor: Actor, file: UploadedFile | undefined, meta: { title: string; category: string; description?: string | undefined; folderId?: string | undefined }) {
    const checked = this.checkFile(file);
    const documentId = randomUUID();
    const versionId = randomUUID();
    await this.scanForMalware('document.upload', checked);
    return this.prisma.asUser(actor.userId, async (tx) => {
      if (meta.folderId) await this.ownFolder(tx, actor.userId, meta.folderId);
      await tx.document.create({
        data: { id: documentId, ownerId: actor.userId, title: meta.title, category: meta.category, description: meta.description ?? null, folderId: meta.folderId ?? null },
      });
      await this.storeVersion(tx, actor, documentId, versionId, 1, checked);
      await this.audit.record({
        action: 'document.upload', outcome: 'ALLOWED', targetType: 'document', targetId: documentId, documentId,
        details: { title: meta.title, category: meta.category, versionNo: 1, fileName: checked.fileName, mimeType: checked.type.mime, sizeBytes: checked.buffer.length, sha256: checked.hash.toString('hex') },
      }, tx);
      return { id: documentId };
    });
  }

  async addVersion(actor: Actor, id: string, file: UploadedFile | undefined) {
    const checked = this.checkFile(file);
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, id, 'upload_version');
      // Scanned only after the permission check, so the scanner is not an
      // oracle or a cheap load generator for people with no access.
      await this.scanForMalware('document.upload_version', checked, id);
      // Row lock so two simultaneous uploads cannot both become version N.
      const locked = await tx.$queryRaw<{ current_version_no: number }[]>`SELECT current_version_no FROM documents WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Document not found');
      const versionNo = locked[0]!.current_version_no + 1;
      await this.storeVersion(tx, actor, id, randomUUID(), versionNo, checked);
      await tx.document.update({ where: { id }, data: { currentVersionNo: versionNo } });
      await this.audit.record({
        action: 'document.upload_version', outcome: 'ALLOWED', targetType: 'document', targetId: id, documentId: id,
        details: { versionNo, fileName: checked.fileName, mimeType: checked.type.mime, sizeBytes: checked.buffer.length, sha256: checked.hash.toString('hex') },
      }, tx);
      return { versionNo };
    });
  }

  // --------------------------------------------------------------- download

  /**
   * The authorisation decision for a download is the `access.require(...,
   * 'download')` line below. Remove it and the request still returns 404 —
   * row-level security hides the version and blob rows — but the refusal is
   * no longer audited, and the decide() tests fail.
   */
  async download(actor: Actor, id: string, versionNo?: number) {
    const found = await this.prisma.asUser(actor.userId, async (tx) => {
      const decision = await this.access.require(tx, actor, id, 'download');
      const doc = await tx.document.findUnique({ where: { id }, select: { currentVersionNo: true } });
      const wanted = versionNo ?? doc?.currentVersionNo;
      const version = wanted
        ? await tx.documentVersion.findUnique({ where: { documentId_versionNo: { documentId: id, versionNo: wanted } }, include: { quarantine: true } })
        : null;
      if (!version) {
        await this.audit.record({ action: 'document.download', outcome: 'DENIED', reason: 'no_such_version', targetType: 'document', targetId: id, documentId: id, details: { versionNo: wanted ?? null } });
        throw new NotFoundException('Version not found');
      }
      if (version.quarantine) {
        // The nightly re-scan found malware in this version after it was stored.
        await this.audit.record({
          action: 'document.download', outcome: 'DENIED', reason: 'quarantined', targetType: 'document', targetId: id, documentId: id,
          details: { versionNo: version.versionNo, signature: version.quarantine.signature },
        });
        throw new ForbiddenException(`This version was quarantined: the malware scanner found ${version.quarantine.signature} in it`);
      }
      // Downloads that need approval use one approved download of exactly
      // this version, in this transaction. The database releases the blob
      // row only to the transaction that used the approval (blobs_release).
      let approvalId: string | null = null;
      if (decision.approvalRequired) {
        approvalId = await this.approvals.consume(tx, actor, id, version.id, version.versionNo);
        if (!approvalId) {
          await this.audit.record({ action: 'document.download', outcome: 'DENIED', reason: 'approval_required', targetType: 'document', targetId: id, documentId: id, details: { versionNo: version.versionNo } });
          throw new ForbiddenException({ message: 'Downloading this document needs the owner’s approval. Ask for it with a reason.', code: 'approval_required', versionNo: version.versionNo });
        }
      }
      const blob = await tx.documentBlob.findUnique({ where: { versionId: version.id } });
      if (!blob) {
        await this.audit.record({ action: 'document.download', outcome: 'DENIED', reason: 'no_such_version', targetType: 'document', targetId: id, documentId: id, details: { versionNo: version.versionNo } });
        throw new NotFoundException('Version not found');
      }
      // Audited and committed BEFORE any byte leaves the server: if the
      // audit write fails, nothing is sent.
      await this.audit.record({
        action: 'document.download', outcome: 'ALLOWED', reason: decision.reason, targetType: 'document', targetId: id, documentId: id,
        details: { versionNo: version.versionNo, fileName: version.fileName, sha256: Buffer.from(version.sha256).toString('hex'), ...(approvalId ? { approvalId } : {}) },
      }, tx);
      return { ...version, blob };
    });

    const blob = found.blob;
    let plaintext: Buffer;
    try {
      plaintext = await openFile(this.keys, {
        wrappedKey: Buffer.from(blob.wrappedKey), keyId: blob.keyId, nonce: Buffer.from(blob.nonce),
        authTag: Buffer.from(blob.authTag), ciphertext: Buffer.from(blob.ciphertext),
      }, blobAad(id, found.id, found.versionNo));
    } catch {
      await this.audit.record({ action: 'document.integrity', outcome: 'FAILED', reason: 'decryption_failed', targetType: 'document', targetId: id, documentId: id, details: { versionNo: found.versionNo } });
      throw new InternalServerErrorException('This file failed its integrity check and was not sent');
    }
    if (!sha256(plaintext).equals(Buffer.from(found.sha256))) {
      await this.audit.record({ action: 'document.integrity', outcome: 'FAILED', reason: 'hash_mismatch', targetType: 'document', targetId: id, documentId: id, details: { versionNo: found.versionNo } });
      throw new InternalServerErrorException('This file failed its integrity check and was not sent');
    }
    return { data: plaintext, fileName: found.fileName, mimeType: found.mimeType, sha256: Buffer.from(found.sha256).toString('hex') };
  }

  // ----------------------------------------------------------------- change

  async update(actor: Actor, id: string, patch: { title?: string | undefined; category?: string | undefined; description?: string | null | undefined; folderId?: string | null | undefined }) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      const editing = patch.title !== undefined || patch.category !== undefined || patch.description !== undefined;
      if (editing) await this.access.require(tx, actor, id, 'edit');
      if (patch.folderId !== undefined) {
        await this.access.require(tx, actor, id, 'move_folder');
        if (patch.folderId) await this.ownFolder(tx, actor.userId, patch.folderId);
      }
      const before = await tx.document.findUniqueOrThrow({ where: { id }, select: { title: true, category: true, description: true, folderId: true } });
      const after = await tx.document.update({
        where: { id },
        data: { title: patch.title, category: patch.category, description: patch.description, folderId: patch.folderId },
        select: { title: true, category: true, description: true, folderId: true },
      });
      await this.audit.record({ action: 'document.edit', outcome: 'ALLOWED', targetType: 'document', targetId: id, documentId: id, details: { before, after } }, tx);
      return after;
    });
  }

  async trash(actor: Actor, id: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, id, 'trash');
      await tx.document.update({ where: { id }, data: { status: 'DELETED', deletedAt: new Date() } });
      await this.audit.record({ action: 'document.trash', outcome: 'ALLOWED', targetType: 'document', targetId: id, documentId: id }, tx);
    });
  }

  async restore(actor: Actor, id: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, id, 'restore');
      const doc = await tx.document.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (doc.status !== 'DELETED') throw new BadRequestException('Document is not in the trash');
      await tx.document.update({ where: { id }, data: { status: 'ACTIVE', deletedAt: null } });
      await this.audit.record({ action: 'document.restore', outcome: 'ALLOWED', targetType: 'document', targetId: id, documentId: id }, tx);
    });
  }

  /** Permanent deletion. Only from the trash, only by the owner. The audit trail is kept. */
  async purge(actor: Actor, id: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, id, 'purge');
      const doc = await tx.document.findUniqueOrThrow({ where: { id }, select: { status: true, title: true, currentVersionNo: true } });
      if (doc.status !== 'DELETED') throw new BadRequestException('Move the document to the trash before deleting it permanently');
      await tx.document.delete({ where: { id } });
      await this.audit.record({ action: 'document.purge', outcome: 'ALLOWED', targetType: 'document', targetId: id, documentId: id, details: { title: doc.title, versions: doc.currentVersionNo } }, tx);
    });
  }

  /**
   * Hand a document to another owner. The previous owner keeps no access
   * unless the new owner shares it back: ownership is one person, and a
   * silent leftover permission is exactly the "link still works after they
   * left" problem.
   */
  async transfer(actor: Actor, id: string, newOwnerId: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      // Authorisation first: a stranger must learn nothing, not even "you already own this".
      await this.access.require(tx, actor, id, 'transfer');
      if (newOwnerId === actor.userId) throw new BadRequestException('You already own this document');
      const target = await tx.user.findUnique({ where: { id: newOwnerId }, select: { role: true, status: true, email: true } });
      if (!target || target.role !== 'OWNER' || target.status !== 'ACTIVE') throw new BadRequestException('The new owner must be an active document owner');
      await tx.grant.deleteMany({ where: { documentId: id, userId: newOwnerId } });
      await tx.document.update({ where: { id }, data: { ownerId: newOwnerId, folderId: null } });
      // The former owner can still be covered by a group grant (THREATS.md A15). Say so.
      const stillHas = await remainingLevel(tx, id, actor.userId);
      await this.audit.record({ action: 'document.transfer', outcome: 'ALLOWED', targetType: 'document', targetId: id, documentId: id, details: { from: actor.userId, to: newOwnerId, toEmail: target.email, formerOwnerStillHas: stillHas } }, tx);
      return { stillHas };
    });
  }

  /** Who did what to this document, including refused attempts. Managers and the owner. */
  async history(actor: Actor, id: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, id, 'view_history');
      const rows = await tx.auditEvent.findMany({
        where: { documentId: id }, orderBy: { seq: 'desc' }, take: 300,
        select: { seq: true, occurredAt: true, actorEmail: true, action: true, outcome: true, reason: true, details: true },
      });
      return rows.map((r) => ({ ...r, seq: r.seq.toString() }));
    });
  }

  // ---------------------------------------------------------------- helpers

  private checkFile(file: UploadedFile | undefined) {
    if (!file || !file.buffer?.length) throw new BadRequestException('Choose a file to upload');
    try {
      const type = detectType(file.buffer, file.originalname);
      return { buffer: file.buffer, type, fileName: safeFileName(file.originalname, type), hash: sha256(file.buffer) };
    } catch (err) {
      if (err instanceof RejectedFile) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /**
   * Refuses infected files (422) and refuses everything when the scanner
   * cannot answer (503). Both are audited outside any transaction, so the
   * record survives the failed request.
   */
  private async scanForMalware(action: string, f: ReturnType<DocumentsService['checkFile']>, documentId?: string) {
    const base = { action, targetType: 'document', ...(documentId ? { targetId: documentId, documentId } : {}) };
    const details = { fileName: f.fileName, sha256: f.hash.toString('hex'), sizeBytes: f.buffer.length, scanner: this.scanner.name };
    let result;
    try {
      result = await this.scanner.scan(f.buffer);
    } catch (err) {
      const why = err instanceof ScannerUnavailable ? err.message : 'scanner error';
      await this.audit.record({ ...base, outcome: 'FAILED', reason: 'malware_scanner_unavailable', details: { ...details, error: why } });
      throw new ServiceUnavailableException('Uploads are paused: the malware scanner is not available. Try again shortly.');
    }
    if (!result.clean) {
      await this.audit.record({ ...base, outcome: 'DENIED', reason: 'malware_detected', details: { ...details, signature: result.signature } });
      throw new UnprocessableEntityException('This file was rejected by the malware scanner');
    }
  }

  private async storeVersion(tx: Tx, actor: Actor, documentId: string, versionId: string, versionNo: number, f: ReturnType<DocumentsService['checkFile']>) {
    const sealed = await sealFile(this.keys, f.buffer, blobAad(documentId, versionId, versionNo));
    await tx.documentVersion.create({
      data: { id: versionId, documentId, versionNo, fileName: f.fileName, mimeType: f.type.mime, sizeBytes: f.buffer.length, sha256: new Uint8Array(f.hash), uploadedById: actor.userId },
    });
    await tx.documentBlob.create({
      data: { versionId, wrappedKey: new Uint8Array(sealed.wrappedKey), keyId: sealed.keyId, nonce: new Uint8Array(sealed.nonce), authTag: new Uint8Array(sealed.authTag), ciphertext: new Uint8Array(sealed.ciphertext) },
    });
  }

  private async ownFolder(tx: Tx, userId: string, folderId: string) {
    const folder = await tx.folder.findFirst({ where: { id: folderId, ownerId: userId }, select: { id: true } });
    if (!folder) throw new BadRequestException('Folder not found');
  }

  /** Display-only access level for a list of documents (the decision is always decide()). */
  private async levels(tx: Tx, ids: string[], userId: string): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ id: string; level: number }[]>`
      SELECT id, tv_doc_level(id, ${userId}::uuid) AS level FROM unnest(${ids}::uuid[]) AS id`;
    return new Map(rows.map((r) => [r.id, Number(r.level)]));
  }

  private toListItem(r: ListRow, level: number, me: string) {
    const v = r.versions[0];
    return {
      id: r.id, title: r.title, category: r.category, description: r.description, status: r.status,
      createdAt: r.createdAt, updatedAt: r.updatedAt, deletedAt: r.deletedAt,
      owner: { id: r.owner.id, displayName: r.owner.displayName, email: r.owner.email },
      isOwner: r.ownerId === me,
      myAccess: LEVEL_NAME[level] ?? 'NONE',
      folderId: r.ownerId === me ? r.folderId : null,
      current: v ? { versionNo: v.versionNo, fileName: v.fileName, mimeType: v.mimeType, sizeBytes: v.sizeBytes, createdAt: v.createdAt } : null,
    };
  }
}

export { Level };
