import { Inject, Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { ENV, type Env } from '../config/env.js';
import { logger } from '../common/logger.js';

export interface Recipient {
  email: string;
  displayName: string;
  /** Published demo accounts: their addresses belong to other people, so they never get mail. */
  isProtected: boolean;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends account emails (reset links, sign-in and security notices, shares).
 *
 * - Never to the published demo accounts: their @demo.com addresses belong
 *   to someone else.
 * - Never blocks or fails the request that caused it: sending happens after
 *   the change is committed, and a failure is logged, not thrown. The email
 *   is a courtesy; the audit log is the record.
 * - Never contains document contents. A share notice names the document
 *   only to the person it was shared with.
 */
@Injectable()
export class MailService {
  private readonly transport: Transporter | null;
  /** Messages kept by MAIL_TRANSPORT=memory (tests). */
  readonly outbox: MailMessage[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {
    this.transport =
      env.MAIL_TRANSPORT === 'smtp'
        ? nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_PORT === 465,
            auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
            requireTLS: true,
            tls: { minVersion: 'TLSv1.2' },
            connectionTimeout: 10_000,
            socketTimeout: 20_000,
          })
        : null;
  }

  get enabled(): boolean {
    return this.env.MAIL_TRANSPORT !== 'off';
  }

  /** Can this person receive mail at all? */
  canReach(r: Pick<Recipient, 'isProtected'>): boolean {
    return this.enabled && !r.isProtected;
  }

  /** Queue a message without waiting for it. Returns whether it was accepted for sending. */
  send(r: Recipient, message: Omit<MailMessage, 'to'>): boolean {
    if (!this.canReach(r)) return false;
    const full: MailMessage = { to: r.email, ...message };
    if (this.env.MAIL_TRANSPORT === 'memory') {
      this.outbox.push(full);
      return true;
    }
    void this.deliver(full);
    return true;
  }

  private async deliver(m: MailMessage, attempt = 1): Promise<void> {
    try {
      await this.transport!.sendMail({ from: this.env.MAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html });
    } catch (err) {
      // Never log the message body: a reset link is a credential.
      logger.warn({ err: (err as Error).message, subject: m.subject, attempt }, 'mail delivery failed');
      if (attempt < 3) setTimeout(() => void this.deliver(m, attempt + 1), attempt * 30_000).unref();
    }
  }
}
