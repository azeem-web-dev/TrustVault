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

  /** Tells the person a document was shared with them (named people only, not groups). */
  sharedWithYou(granteeId: string, sharerName: string, documentId: string, title: string, level: string, expiresAt: Date | null): void {
    this.fire(async () => {
      const u = await this.person(granteeId);
      if (u && u.status === 'ACTIVE') {
        this.mail.send(u, mailTemplates.sharedWithYou(u.displayName, sharerName, title, level, expiresAt, `${this.env.PUBLIC_ORIGIN}/documents/${documentId}`));
      }
    });
  }
}
