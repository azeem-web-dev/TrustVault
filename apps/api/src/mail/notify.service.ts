import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../db/prisma.service.js';
import { logger } from '../common/logger.js';
import { MailService } from './mail.service.js';
import { mailTemplates } from './templates.js';

/**
 * Account notices. Each one is sent after the change it reports has been
 * committed, never awaited by the request, and never sent to demo accounts.
 */
@Injectable()
export class NotifyService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  private async person(userId: string) {
    return this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true, isProtected: true, status: true } });
  }

  private fire(work: () => Promise<void>): void {
    if (!this.mail.enabled) return;
    work().catch((err: unknown) => logger.warn({ err: (err as Error).message }, 'notice not sent'));
  }

  signIn(userId: string, ip: string | null, device: string | null): void {
    this.fire(async () => {
      const u = await this.person(userId);
      if (u) this.mail.send(u, mailTemplates.newSignIn(u.displayName, new Date(), ip, device, this.env.PUBLIC_ORIGIN));
    });
  }

  passwordChanged(userId: string, how: string): void {
    this.fire(async () => {
      const u = await this.person(userId);
      if (u) this.mail.send(u, mailTemplates.passwordChanged(u.displayName, how, new Date(), this.env.PUBLIC_ORIGIN));
    });
  }

  secondFactorChanged(userId: string, what: string): void {
    this.fire(async () => {
      const u = await this.person(userId);
      if (u) this.mail.send(u, mailTemplates.secondFactorChanged(u.displayName, what, new Date(), this.env.PUBLIC_ORIGIN));
    });
  }

  /**
   * Tells a document's owner, as soon as a second admin approves it, that an
   * administrator may now open their document for an hour (THREATS.md S19).
   */
  breakGlassApproved(documentId: string, requester: string, approver: string, reason: string): void {
    this.fire(async () => {
      const [doc] = await this.prisma.$queryRaw<{ title: string; owner_id: string }[]>`SELECT title, owner_id FROM tv_document_brief(${documentId}::uuid)`;
      if (!doc) return;
      const u = await this.person(doc.owner_id);
      if (u && u.status === 'ACTIVE') {
        this.mail.send(u, mailTemplates.breakGlassApproved(u.displayName, doc.title, requester, approver, reason, `${this.env.PUBLIC_ORIGIN}/documents/${documentId}`));
      }
    });
  }

  /**
   * Tells a document's owner that someone viewing it pressed a screen-capture
   * key (THREATS.md V11). Never sent to the viewer; never to a demo owner
   * (MailService refuses protected accounts).
   */
  captureAttempt(ownerId: string, viewerId: string, documentId: string, title: string, method: string, at: Date): void {
    if (ownerId === viewerId) return;
    this.fire(async () => {
      const [o, v] = await Promise.all([this.person(ownerId), this.person(viewerId)]);
      if (o && v && o.status === 'ACTIVE') {
        this.mail.send(o, mailTemplates.captureAttempt(o.displayName, v.displayName, v.email, title, method, at, `${this.env.PUBLIC_ORIGIN}/documents/${documentId}#history`));
      }
    });
  }

  /** Tells the person a document was shared with them (named people only, not groups). */
  sharedWithYou(granteeId: string, sharerName: string, documentId: string, title: string, level: string, expiresAt: Date | null): void {
    this.fire(async () => {
      const u = await this.person(granteeId);
      if (u && u.status === 'ACTIVE') {
        this.mail.send(u, mailTemplates.sharedWithYou(u.displayName, sharerName, title, level, expiresAt, `${this.env.PUBLIC_ORIGIN}/documents/${documentId}`));
      }
    });
  }

  /** The owner (or a nominated approver) hears that a download waits for them. */
  downloadRequested(approverId: string, requester: string, documentId: string, title: string, versionNo: number, reason: string): void {
    this.fire(async () => {
      const u = await this.person(approverId);
      if (u && u.status === 'ACTIVE') {
        this.mail.send(u, mailTemplates.downloadRequested(u.displayName, requester, title, versionNo, reason, `${this.env.PUBLIC_ORIGIN}/approvals`));
      }
    });
  }

  downloadDecided(requesterId: string, decider: string, documentId: string, title: string, versionNo: number, approved: boolean, validUntil: Date | null, uses: number | null, note: string | null): void {
    this.fire(async () => {
      const u = await this.person(requesterId);
      if (u && u.status === 'ACTIVE') {
        this.mail.send(u, mailTemplates.downloadDecided(u.displayName, decider, title, versionNo, approved, validUntil, uses, note, `${this.env.PUBLIC_ORIGIN}/documents/${documentId}`));
      }
    });
  }

  /** An emergency exception: the person is told, and the owner gets a receipt. */
  overrideGiven(userId: string, ownerId: string, ownerName: string, documentId: string, title: string, until: Date, reason: string): void {
    this.fire(async () => {
      const [u, o] = await Promise.all([this.person(userId), this.person(ownerId)]);
      const url = `${this.env.PUBLIC_ORIGIN}/documents/${documentId}`;
      if (u && u.status === 'ACTIVE') this.mail.send(u, mailTemplates.overrideGiven(u.displayName, ownerName, title, until, reason, url));
      if (o && u) this.mail.send(o, mailTemplates.overrideReceipt(o.displayName, u.displayName, title, until, reason, url));
    });
  }
}
