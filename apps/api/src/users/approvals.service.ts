import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotifyService } from '../mail/notify.service.js';
import type { Actor } from '../common/request-context.js';
import type { ApprovalAction } from '../generated/prisma/enums.js';

export interface ApprovalRequest {
  action: ApprovalAction;
  targetUserId?: string | undefined;
  documentId?: string | undefined;
  reason: string;
}

/** The view an admin gets of a request: who asked, for what, and where it stands. */
const VIEW = {
  id: true, action: true, reason: true, createdAt: true, expiresAt: true, approvedAt: true, rejectedAt: true, consumedAt: true,
  requestedBy: { select: { id: true, email: true, displayName: true } },
  approvedBy: { select: { id: true, email: true, displayName: true } },
  rejectedBy: { select: { id: true, email: true, displayName: true } },
  targetUser: { select: { id: true, email: true, displayName: true, role: true } },
  targetDocumentId: true,
} as const;

const NO_SECOND_ADMIN = 'This needs a second active administrator to approve it, and there is no other. Invite or reactivate another admin first.';

/**
 * Two administrators for the actions that can open someone else's account or
 * documents (THREATS.md S15, S19): clearing an OWNER's or ADMIN's second
 * factor, and break-glass.
 *
 * One admin asks, with a reason. A different active admin approves or
 * rejects. The admin who asked then carries out the action, which uses the
 * approval: once, for exactly the person or document named, within 24 hours.
 * The requester carries it out (not the approver) so the person acting is the
 * person who asked, row-level security still sees them as themselves, and a
 * break-glass hour starts only when it is actually used.
 *
 * The database checks every rule again (20261103310000_admin_approvals).
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  async request(actor: Actor, input: ApprovalRequest) {
    const target = input.action === 'MFA_RESET' ? { targetUserId: input.targetUserId } : { documentId: input.documentId };
    if (input.action === 'MFA_RESET' ? !input.targetUserId || input.documentId : !input.documentId || input.targetUserId) {
      throw new BadRequestException(input.action === 'MFA_RESET' ? 'Name the person whose second factor to reset' : 'Name the document');
    }
    return this.prisma.asUser(actor.userId, async (tx) => {
      // Locks every other active admin row: a request cannot be made while the
      // only other admin is being deactivated in the same instant.
      const others = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND id <> ${actor.userId}::uuid FOR SHARE`;
      if (others.length === 0) {
        await this.audit.record({ action: 'admin.approval_requested', outcome: 'DENIED', reason: 'no_second_admin', details: { action: input.action, ...target } });
        throw new ConflictException({ message: NO_SECOND_ADMIN, code: 'no_second_admin' });
      }
      let title: string | null = null;
      if (input.action === 'MFA_RESET') {
        if (input.targetUserId === actor.userId) throw new BadRequestException('Another admin must ask to reset your second factor');
        const u = await tx.user.findUnique({ where: { id: input.targetUserId! }, select: { role: true, isProtected: true } });
        if (!u) throw new NotFoundException('User not found');
        if (u.isProtected) throw new ForbiddenException('This is a protected demo account and cannot be changed');
        if (u.role !== 'OWNER' && u.role !== 'ADMIN') throw new BadRequestException('A viewer’s or external’s second factor is reset directly, without approval');
      } else {
        const [doc] = await tx.$queryRaw<{ title: string; status: string }[]>`SELECT title, status FROM tv_document_brief(${input.documentId!}::uuid)`;
        if (!doc || doc.status !== 'ACTIVE') throw new NotFoundException('Document not found');
        title = doc.title;
      }
      const row = await tx.adminApproval.create({
        data: {
          action: input.action, reason: input.reason, requestedById: actor.userId,
          targetUserId: input.targetUserId ?? null, targetDocumentId: input.documentId ?? null,
          // Placeholder: the database sets created_at and expires_at itself.
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        select: VIEW,
      });
      await this.audit.record({
        action: 'admin.approval_requested', outcome: 'ALLOWED', targetType: 'approval', targetId: row.id,
        documentId: input.documentId,
        details: { action: input.action, reason: input.reason, ...target, ...(title ? { title } : {}), expiresAt: row.expiresAt.toISOString() },
      }, tx);
      return this.view(row);
    });
  }

  /** Requests, newest first. Open ones past their expiry are marked and recorded as expired on the way. */
  async list(actor: Actor) {
    return this.prisma.asUser(actor.userId, async (tx) => {
      await this.noteExpired(tx);
      const rows = await tx.adminApproval.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: VIEW });
      const titles = await this.titles(tx, rows.map((r) => r.targetDocumentId).filter((x): x is string => Boolean(x)));
      return rows.map((r) => ({ ...this.view(r), documentTitle: r.targetDocumentId ? (titles.get(r.targetDocumentId) ?? null) : null }));
    });
  }

  async approve(actor: Actor, id: string) {
    const result = await this.answer(actor, id, 'approve');
    // The owner hears at once that an admin may now open their document.
    if (result.action === 'BREAK_GLASS' && result.targetDocumentId) {
      this.notify.breakGlassApproved(result.targetDocumentId, result.requestedBy.email, actor.email, result.reason);
    }
    return this.view(result);
  }

  async reject(actor: Actor, id: string) {
    return this.view(await this.answer(actor, id, 'reject'));
  }

  /**
   * Uses an approval for `action` on exactly `target`, in the caller's
   * transaction (which must say who is asking). Throws, after recording why,
   * if it is not the requester's, not approved, already used, expired, or for
   * something else. The database repeats every check.
   */
  async use(tx: Tx, actor: Actor, approvalId: string, action: ApprovalAction, target: { userId?: string; documentId?: string }) {
    const [row] = await tx.$queryRaw<{ id: string; action: ApprovalAction; target_user_id: string | null; target_document_id: string | null; requested_by: string; approved_by: string | null; approved_at: Date | null; rejected_at: Date | null; consumed_at: Date | null; expires_at: Date }[]>`
      SELECT id, action, target_user_id, target_document_id, requested_by, approved_by, approved_at, rejected_at, consumed_at, expires_at
        FROM admin_approvals WHERE id = ${approvalId}::uuid FOR UPDATE`;
    const problem =
      !row ? 'unknown_approval'
      : row.requested_by !== actor.userId ? 'not_your_request'
      : row.action !== action ? 'wrong_action'
      : (target.userId ?? null) !== row.target_user_id || (target.documentId ?? null) !== row.target_document_id ? 'wrong_target'
      : row.rejected_at ? 'rejected'
      : !row.approved_at ? 'not_approved'
      : row.consumed_at ? 'already_used'
      : row.expires_at.getTime() <= Date.now() ? 'expired'
      : null;
    if (problem) {
      // Recorded outside the failing transaction, so the attempt is kept.
      await this.audit.record({ action: 'admin.approval_used', outcome: 'DENIED', reason: problem, targetType: 'approval', targetId: approvalId, documentId: target.documentId, details: { action, ...target } });
      throw new ForbiddenException({ message: USE_REFUSED[problem], code: 'approval_not_usable' });
    }
    await tx.adminApproval.update({ where: { id: approvalId }, data: { consumedAt: new Date() } });
    await this.audit.record({
      action: 'admin.approval_used', outcome: 'ALLOWED', targetType: 'approval', targetId: approvalId, documentId: target.documentId,
      details: { action, ...target, requestedBy: row!.requested_by, approvedBy: row!.approved_by },
    }, tx);
  }

  private async answer(actor: Actor, id: string, how: 'approve' | 'reject') {
    const auditAction = how === 'approve' ? 'admin.approval_approved' : 'admin.approval_rejected';
    const refused = async (reason: string, message: string, documentId?: string): Promise<never> => {
      await this.audit.record({ action: auditAction, outcome: 'DENIED', reason, targetType: 'approval', targetId: id, documentId });
      throw new ConflictException({ message, code: reason });
    };
    const outcome = await this.prisma.asUser(actor.userId, async (tx) => {
      await this.noteExpired(tx);
      const [row] = await tx.$queryRaw<{ requested_by: string; approved_at: Date | null; rejected_at: Date | null; expires_at: Date; target_document_id: string | null }[]>`
        SELECT requested_by, approved_at, rejected_at, expires_at, target_document_id FROM admin_approvals WHERE id = ${id}::uuid FOR UPDATE`;
      if (!row) throw new NotFoundException('Request not found');
      const doc = row.target_document_id ?? undefined;
      if (row.requested_by === actor.userId) return { updated: null, refused: { code: 'own_request', message: 'You cannot answer your own request: another administrator must', doc } };
      if (row.approved_at || row.rejected_at) return { updated: null, refused: { code: 'already_answered', message: 'This request has already been answered', doc } };
      if (row.expires_at.getTime() <= Date.now()) return { updated: null, refused: { code: 'expired', message: 'This request has expired. Ask again if it is still needed.', doc } };
      const updated = await tx.adminApproval.update({
        where: { id },
        data: how === 'approve' ? { approvedById: actor.userId, approvedAt: new Date() } : { rejectedById: actor.userId, rejectedAt: new Date() },
        select: { ...VIEW, targetDocumentId: true },
      });
      await this.audit.record({
        action: auditAction, outcome: 'ALLOWED', targetType: 'approval', targetId: id, documentId: doc,
        details: { action: updated.action, requestedBy: updated.requestedBy.email, reason: updated.reason, targetUserId: updated.targetUser?.id ?? null, documentId: updated.targetDocumentId },
      }, tx);
      return { updated, refused: null };
    });
    if (outcome.refused) return refused(outcome.refused.code, outcome.refused.message, outcome.refused.doc);
    return outcome.updated!;
  }

  /** Marks open requests past their expiry, once each, and records it. */
  private async noteExpired(tx: Tx): Promise<void> {
    const lapsed = await tx.$queryRaw<{ id: string; action: string; requested_by: string; target_document_id: string | null; target_user_id: string | null; approved_at: Date | null }[]>`
      UPDATE admin_approvals SET expiry_recorded_at = now()
       WHERE expiry_recorded_at IS NULL AND expires_at <= now() AND consumed_at IS NULL AND rejected_at IS NULL
      RETURNING id, action, requested_by, target_document_id, target_user_id, approved_at`;
    for (const r of lapsed) {
      await this.audit.record({
        action: 'admin.approval_expired', outcome: 'ALLOWED', reason: r.approved_at ? 'approved_never_used' : 'never_answered',
        targetType: 'approval', targetId: r.id, documentId: r.target_document_id ?? undefined,
        details: { action: r.action, requestedBy: r.requested_by, targetUserId: r.target_user_id },
      }, tx);
    }
  }

  private async titles(tx: Tx, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ id: string; title: string }[]>`
      SELECT b.id::text AS id, b.title FROM unnest(${[...new Set(ids)]}::uuid[]) AS u(id), LATERAL tv_document_brief(u.id) b`;
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  private view<T extends { approvedAt: Date | null; rejectedAt: Date | null; consumedAt: Date | null; expiresAt: Date }>(r: T) {
    const status = r.consumedAt ? 'USED' : r.rejectedAt ? 'REJECTED' : r.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : r.approvedAt ? 'APPROVED' : 'PENDING';
    return { ...r, status };
  }
}

const USE_REFUSED: Record<string, string> = {
  unknown_approval: 'No such approval',
  not_your_request: 'Only the administrator who asked can use this approval',
  wrong_action: 'This approval is for a different action',
  wrong_target: 'This approval is for a different person or document',
  rejected: 'This request was rejected',
  not_approved: 'This request is still waiting for another administrator to approve it',
  already_used: 'This approval has already been used',
  expired: 'This approval has expired. Ask again if it is still needed.',
};
