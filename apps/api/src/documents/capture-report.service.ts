import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { currentContext, type Actor } from '../common/request-context.js';
import { logger } from '../common/logger.js';
import { NotifyService } from '../mail/notify.service.js';
import { AlertStoreService } from '../risk/alert-store.service.js';
import { deviceLabel } from '../risk/net.js';
import { AccessService } from './access.js';

export const CAPTURE_METHODS = ['printscreen', 'snip_shortcut', 'mac_shortcut', 'print_shortcut'] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

const METHOD_LABEL: Record<CaptureMethod, string> = {
  printscreen: 'Print Screen key',
  snip_shortcut: 'Windows snipping shortcut (Win+Shift+S)',
  mac_shortcut: 'macOS screenshot shortcut (Cmd+Shift+3/4/5)',
  print_shortcut: 'print shortcut (Ctrl+P / Cmd+P)',
};

/** One alert and one owner email per viewer and document within this long; later attempts attach to the alert. */
const QUIET_MS = 3_600_000;

/**
 * A viewer's browser saw a key press that usually starts a screen capture
 * (THREATS.md V11). A web page cannot stop the capture; this records it so
 * the owner and the admins know:
 *
 *  - decide() at VIEW, both locks, like a page view: no access is the same
 *    404 as any other document route, and nothing below happens;
 *  - a `document.capture_attempt` audit row (it shows in the document's
 *    History and the admin audit log);
 *  - after commit, one `capture_attempt` alert (medium) per viewer and
 *    document per hour, later attempts attached to it as notes;
 *  - with a new alert, one email to the owner. Never to the viewer, never
 *    when the viewer is the owner, never to a demo owner.
 *
 * Alert and email failures are logged, never returned: the viewer gets the
 * same empty 204 whatever happens after the audit row.
 */
@Injectable()
export class CaptureReportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AlertStoreService) private readonly alerts: AlertStoreService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  async report(actor: Actor, id: string, input: { method: CaptureMethod; page?: number | undefined }): Promise<void> {
    const device = deviceLabel(currentContext()?.userAgent);
    const at = new Date();
    const found = await this.prisma.asUser(actor.userId, async (tx) => {
      const decision = await this.access.require(tx, actor, id, 'capture_attempt');
      const doc = await tx.document.findUnique({ where: { id }, select: { title: true, ownerId: true } });
      if (!doc) throw new NotFoundException('Document not found');
      const event = await this.audit.record({
        action: 'document.capture_attempt', outcome: 'ALLOWED', reason: input.method, targetType: 'document', targetId: id, documentId: id,
        details: { method: input.method, page: input.page ?? null, userAgent: device, access: decision.reason },
      }, tx);
      return { ...doc, seq: event.seq };
    });
    if (found.ownerId === actor.userId) return; // the owner capturing their own document: recorded, nothing more

    try {
      const fresh = await this.alertOnce(actor, id, found.title, input, found.seq, at);
      if (fresh) this.notify.captureAttempt(found.ownerId, actor.userId, id, found.title, METHOD_LABEL[input.method], at);
    } catch (err) {
      logger.warn({ err: (err as Error).message, documentId: id }, 'capture attempt not alerted');
    }
  }

  /**
   * A new alert unless one for this viewer and document was raised in the
   * last hour; then the attempt is attached to that one as a note. Returns
   * whether a new alert was raised. Its own transaction, after the audit
   * row committed; the advisory lock makes parallel reports agree.
   */
  private async alertOnce(actor: Actor, id: string, title: string, input: { method: CaptureMethod; page?: number | undefined }, seq: bigint, at: Date): Promise<boolean> {
    const where = input.page ? ` (page ${input.page})` : '';
    const existing = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tv-capture:${actor.userId}:${id}`}, 0))`;
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM security_alerts
         WHERE rule = 'capture_attempt' AND subject_user_id = ${actor.userId}::uuid AND document_id = ${id}::uuid
           AND created_at > clock_timestamp() - make_interval(secs => ${QUIET_MS / 1000})
         ORDER BY created_at DESC LIMIT 1`;
      if (row) return row.id;
      await this.alerts.raise([{
        rule: 'capture_attempt', category: 'extraction', severity: 'medium',
        dedupKey: `capture_attempt:${actor.userId}:${id}:${at.getTime()}`,
        subjectUserId: actor.userId, subjectEmail: actor.email, documentId: id, auditSeq: seq,
        message: `${actor.email} pressed a screen-capture key (${METHOD_LABEL[input.method]})${where} while viewing “${title}”. The capture itself cannot be blocked in a browser; the pages carry their watermark and trace code.`,
        details: { method: input.method, page: input.page ?? null, userEmail: actor.email },
      }], tx);
      return null;
    });
    if (!existing) return true;
    await this.alerts.systemEvent(existing, 'comment', `Another capture attempt: ${METHOD_LABEL[input.method]}${where} at ${at.toISOString()} (audit #${seq}).`);
    return false;
  }
}
