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
