import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../common/request-context.js';
import { NotifyService } from '../mail/notify.service.js';
import { AccessService, Level } from './access.js';

/**
 * Download approvals (THREATS.md P8-P10, checklist item 16).
 *
 * A share can say "downloads need approval". The recipient can still open
 * the document's details; to get the file they ask, with a reason, for one
 * version. The owner — or a manager the owner nominated on that share —
 * approves (for 1-72 hours and 1-10 downloads) or rejects. Nobody decides
 * their own request: checked here, in tv_decide_download(), and by a CHECK
 * constraint. Each download uses one approval in the same transaction that
 * reads the encrypted bytes; the database releases the blob row only to that
 * transaction. Every step is audited: request, approve, reject, use, expire.
 */
@Injectable()
export class DownloadApprovalsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  /** A recipient asks to download one version (default: the current one). */
  async request(actor: Actor, documentId: string, input: { reason: string; versionNo?: number | undefined }) {
    const result = await this.prisma.asUser(actor.userId, async (tx) => {
      // A VIEW holder cannot pass require(..., 'download') until they HAVE an
      // approval, so the request itself is gated on 'view' (they can open the
      // document) plus "they need an approval to get the bytes" (THREATS.md V1):
      // a VIEW grantee always does; a READ+ holder only on a share that asks
      // for one. Someone who can already download freely is told to just do so.
      const decision = await this.access.require(tx, actor, documentId, 'view');
      // An administrator's only view is break-glass (VIEW, emergency look): never
      // a route to the original, so they cannot request one either (THREATS.md V9).
      if (actor.role === 'ADMIN') throw new ForbiddenException('Administrators cannot request downloads');
      const needsApproval = decision.level === Level.VIEW
        || (decision.level >= Level.READ && decision.approvalRequired === true);
      if (!needsApproval) throw new BadRequestException('You can download this document without approval');
      const doc = await tx.document.findUniqueOrThrow({ where: { id: documentId }, select: { title: true, ownerId: true, currentVersionNo: true } });
      const versionNo = input.versionNo ?? doc.currentVersionNo;
      const version = await tx.documentVersion.findUnique({ where: { documentId_versionNo: { documentId, versionNo } }, select: { id: true } });
      if (!version) throw new NotFoundException('Version not found');
      const open = await tx.downloadApproval.findFirst({ where: { requesterId: actor.userId, versionId: version.id, status: 'PENDING' }, select: { id: true } });
      if (open) throw new ConflictException('You already asked to download this version; wait for the answer');
      const row = await tx.downloadApproval.create({
        data: { documentId, versionId: version.id, requesterId: actor.userId, reason: input.reason },
        select: { id: true, createdAt: true },
      }).catch((err: unknown) => {
        if ((err as { code?: string }).code === 'P2002') throw new ConflictException('You already asked to download this version; wait for the answer');
        throw err;
      });
      // Who is told: the owner, and managers nominated on the shares that cover me.
      const nominated = await tx.grant.findMany({
        where: { documentId, downloadApproval: true, downloadApproverId: { not: null } },
        select: { downloadApproverId: true },
      });
      await this.audit.record({
        action: 'download_approval.request', outcome: 'ALLOWED', targetType: 'download_approval', targetId: row.id, documentId,
        details: { versionNo, reason: input.reason },
      }, tx);
      const to = [...new Set([doc.ownerId, ...nominated.map((n) => n.downloadApproverId!)])].filter((u) => u !== actor.userId);
      return { id: row.id, versionNo, title: doc.title, to };
    });
    for (const userId of result.to) this.notify.downloadRequested(userId, actor.email, documentId, result.title, result.versionNo, input.reason);
    return { id: result.id, status: 'PENDING', versionNo: result.versionNo };
  }

  /** Requests on one document: my own, and all of them for whoever may decide. */
  async listForDocument(actor: Actor, documentId: string) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.access.require(tx, actor, documentId, 'view');
      await this.expire(tx);
      const rows = await tx.downloadApproval.findMany({
        where: { documentId }, orderBy: { createdAt: 'desc' }, take: 100,
        select: REQUEST_SELECT,
      });
      return rows.map((r) => this.out(r, actor.userId));
    });
  }

  /** Requests waiting for me to decide (documents I own or was nominated on). */
  async inbox(actor: Actor) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.expire(tx);
      const rows = await tx.downloadApproval.findMany({
        where: { status: 'PENDING', requesterId: { not: actor.userId } }, orderBy: { createdAt: 'asc' }, take: 200,
        select: REQUEST_SELECT,
      });
      return rows.map((r) => this.out(r, actor.userId));
    });
  }

  async decide(actor: Actor, requestId: string, approve: boolean, terms: { hours?: number | undefined; uses?: number | undefined; note?: string | undefined }) {
    const hours = terms.hours ?? 24;
    const uses = terms.uses ?? 1;
    const result = await this.prisma.asUser(actor.userId, async (tx) => {
      const req = await tx.downloadApproval.findUnique({ where: { id: requestId }, select: { id: true, documentId: true, requesterId: true, status: true } });
      const action = approve ? 'download_approval.approve' : 'download_approval.reject';
      if (!req) {
        // Not theirs to see (row-level security) or no such request: same answer, still recorded.
        await this.audit.record({ action, outcome: 'DENIED', reason: 'no_such_request', targetType: 'download_approval', targetId: requestId });
        throw new NotFoundException('Request not found');
      }
      const refuse = async (reason: string, message: string) => {
        await this.audit.record({ action, outcome: 'DENIED', reason, targetType: 'download_approval', targetId: req.id, documentId: req.documentId });
        throw new ForbiddenException(message);
      };
      // Requester is never approver (the database refuses it too).
      if (req.requesterId === actor.userId) await refuse('self_approval', 'You cannot decide your own download request');
      const decision = await this.access.require(tx, actor, req.documentId, 'view');
      if (decision.level < Level.OWNER) {
        const nominated = await tx.grant.count({
          where: {
            documentId: req.documentId, downloadApproval: true, downloadApproverId: actor.userId,
            OR: [{ userId: req.requesterId }, { coveredMembers: { some: { userId: req.requesterId } } }],
          },
        });
        if (decision.level < Level.MANAGE || nominated === 0) await refuse('not_approver', 'Only the owner or the nominated approver can decide this request');
      }
      if (req.status !== 'PENDING') throw new ConflictException(`This request was already ${req.status.toLowerCase()}`);
      let rows: { id: string; status: string; valid_until: Date | null; max_uses: number | null; version_id: string }[];
      try {
        rows = await tx.$queryRaw`
          SELECT id, status::text AS status, valid_until, max_uses, version_id
            FROM tv_decide_download(${requestId}::uuid, ${approve}, ${terms.note ?? null}, ${hours}::int, ${uses}::int)`;
      } catch (err) {
        // The database lock refused (it re-checks everything above).
        const text = String((err as Error).message);
        if (/decide their own|nominated approver/.test(text)) await refuse('database_refused', 'You cannot decide this request');
        if (/already/.test(text)) throw new ConflictException('This request was already decided');
        if (/lasts 1 to 72/.test(text)) throw new BadRequestException('An approval lasts 1 to 72 hours and allows 1 to 10 downloads');
        throw err;
      }
      const row = rows[0]!;
      const version = await tx.documentVersion.findUnique({ where: { id: row.version_id }, select: { versionNo: true, document: { select: { title: true } } } });
      if (row.status === 'EXPIRED') {
        await this.audit.record({ action: 'download_approval.expire', outcome: 'ALLOWED', reason: 'pending_too_long', targetType: 'download_approval', targetId: req.id, documentId: req.documentId }, tx);
        return { expired: true as const };
      }
      await this.audit.record({
        action, outcome: 'ALLOWED', targetType: 'download_approval', targetId: req.id, documentId: req.documentId,
        details: { requesterId: req.requesterId, versionNo: version?.versionNo ?? null, note: terms.note ?? null, ...(approve ? { hours, uses, validUntil: row.valid_until?.toISOString() ?? null } : {}) },
      }, tx);
      return { expired: false as const, row, requesterId: req.requesterId, documentId: req.documentId, title: version?.document.title ?? '', versionNo: version?.versionNo ?? 0 };
    });
    if (result.expired) throw new ConflictException('This request had been waiting more than 7 days and has expired');
    this.notify.downloadDecided(result.requesterId, actor.email, result.documentId, result.title, result.versionNo, approve, result.row.valid_until, result.row.max_uses, terms.note ?? null);
    return { id: requestId, status: result.row.status, validUntil: result.row.valid_until, maxUses: result.row.max_uses };
  }

  /**
   * Uses one approved download of this exact version, inside the caller's
   * transaction. Returns the approval id, or null if there is none to use.
   */
  async consume(tx: Tx, actor: Actor, documentId: string, versionId: string, versionNo: number): Promise<string | null> {
    const live = await tx.downloadApproval.findMany({
      where: { requesterId: actor.userId, versionId, status: 'APPROVED', validUntil: { gt: new Date() } },
      orderBy: { validUntil: 'asc' }, select: { id: true, uses: true, maxUses: true },
    });
    for (const a of live) {
      if (a.maxUses !== null && a.uses >= a.maxUses) continue;
      const used = await tx.$queryRaw<{ n: number | null }[]>`SELECT tv_consume_download(${a.id}::uuid, ${versionId}::uuid) AS n`;
      const n = used[0]?.n ?? null;
      if (n === null) continue;
      await this.audit.record({
        action: 'download_approval.use', outcome: 'ALLOWED', targetType: 'download_approval', targetId: a.id, documentId,
        details: { versionNo, use: n, of: a.maxUses },
      }, tx);
      return a.id;
    }
    return null;
  }

  /** Marks requests and approvals that ran out as EXPIRED, and audits each. */
  async expire(tx?: Tx): Promise<number> {
    const run = async (t: Tx) => {
      const rows = await t.$queryRaw<{ id: string; document_id: string; requester_id: string; was: string }[]>`SELECT id, document_id, requester_id, was::text AS was FROM tv_expire_downloads()`;
      for (const r of rows) {
        await this.audit.record({
          action: 'download_approval.expire', outcome: 'ALLOWED', reason: r.was === 'PENDING' ? 'pending_too_long' : 'approval_window_ended',
          actorId: null, actorEmail: 'system', targetType: 'download_approval', targetId: r.id, documentId: r.document_id,
          details: { requesterId: r.requester_id },
        }, t);
      }
      return rows.length;
    };
    return tx ? run(tx) : this.prisma.$transaction((t) => run(t));
  }

  private out(r: RequestRow, me: string) {
    return {
      id: r.id, status: r.status, reason: r.reason, createdAt: r.createdAt,
      document: { id: r.document.id, title: r.document.title },
      versionNo: r.version.versionNo,
      requester: { id: r.requester.id, name: r.requester.displayName, email: r.requester.email },
      mine: r.requester.id === me,
      decidedBy: r.decidedBy?.displayName ?? null, decidedAt: r.decidedAt, note: r.decisionNote,
      validUntil: r.validUntil, maxUses: r.maxUses, uses: r.uses,
    };
  }
}

const REQUEST_SELECT = {
  id: true, status: true, reason: true, createdAt: true, decidedAt: true, decisionNote: true, validUntil: true, maxUses: true, uses: true,
  document: { select: { id: true, title: true } },
  version: { select: { versionNo: true } },
  requester: { select: { id: true, displayName: true, email: true } },
  decidedBy: { select: { displayName: true } },
} as const;

interface RequestRow {
  id: string; status: string; reason: string; createdAt: Date; decidedAt: Date | null; decisionNote: string | null;
  validUntil: Date | null; maxUses: number | null; uses: number;
  document: { id: string; title: string };
  version: { versionNo: number };
  requester: { id: string; displayName: string; email: string };
  decidedBy: { displayName: string } | null;
}
