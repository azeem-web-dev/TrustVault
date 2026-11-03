import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../db/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { render } from '../mail/templates.js';
import { logger } from '../common/logger.js';
import type { RaisedAlert } from './alert-store.service.js';

/**
 * Emails for the detection rules. Like every account email: sent after the
 * fact is committed, never blocking, never to protected demo accounts
 * (MailService refuses them), and never containing document contents.
 */
@Injectable()
export class RiskNotifyService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  /** Tells the person their account was signed in from a device or network it has not used before. */
  async unusualSignIn(userId: string, at: Date, ip: string | null, device: string, newDevice: boolean, newNetwork: boolean): Promise<boolean> {
    if (!this.mail.enabled) return false;
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true, isProtected: true, status: true } });
    if (!u || u.status !== 'ACTIVE') return false;
    const what = newDevice && newNetwork ? 'a new device and network' : newDevice ? 'a new device' : 'a new network';
    return this.mail.send(u, {
      subject: `TrustVault sign-in from ${what}`,
      ...render(u.displayName, {
        title: `Sign-in from ${what}`,
        intro: `Your account was signed in to from ${what} that it has not used in the last 90 days.`,
        lines: [`When: ${at.toUTCString()}`, `Network: ${ip ?? 'unknown address'}`, `Device: ${device}`],
        button: { label: "This wasn't me: reset my password", url: `${this.env.PUBLIC_ORIGIN}/forgot` },
        footer: 'If it was you, there is nothing to do. Your administrators were told as well.',
      }),
    });
  }

  /**
   * Escalation: high and critical alerts are emailed to every active
   * administrator. Returns how many were reached. At most `max` alerts are
   * sent one by one per run; the rest go in one summary mail, so a flood
   * cannot turn into a flood of email that hides the important one.
   */
  async escalate(alerts: RaisedAlert[], max = 10): Promise<number> {
    if (!this.mail.enabled || alerts.length === 0) return 0;
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { email: true, displayName: true, isProtected: true } });
    const reachable = admins.filter((a) => this.mail.canReach(a));
    if (reachable.length === 0) return 0;
    const ordered = [...alerts].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
    const one = ordered.slice(0, max);
    const rest = ordered.slice(max);
    try {
      for (const a of one) {
        for (const admin of reachable) {
          this.mail.send(admin, {
            subject: `[TrustVault ${a.severity.toUpperCase()}] ${a.rule.replace(/_/g, ' ')}`,
            ...render(admin.displayName, {
              title: `${a.severity === 'critical' ? 'Critical' : 'High'} alert: ${a.rule.replace(/_/g, ' ')}`,
              intro: a.message,
              lines: ['Review it in the alert queue: acknowledge, assign or resolve it there. Every step is recorded.'],
              button: { label: 'Open the alert queue', url: `${this.env.PUBLIC_ORIGIN}/admin/alerts?alert=${a.id}` },
              footer: 'You get this because you are a TrustVault administrator.',
            }),
          });
        }
      }
      if (rest.length) {
        for (const admin of reachable) {
          this.mail.send(admin, {
            subject: `[TrustVault] ${rest.length} more high or critical alerts`,
            ...render(admin.displayName, {
              title: `${rest.length} more high or critical alerts`,
              intro: 'More serious alerts were raised at once than are sent one by one. They are all in the queue, highest severity first.',
              lines: rest.slice(0, 20).map((a) => `${a.severity}: ${a.message}`),
              button: { label: 'Open the alert queue', url: `${this.env.PUBLIC_ORIGIN}/admin/alerts` },
              footer: 'You get this because you are a TrustVault administrator.',
            }),
          });
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'alert escalation mail not sent');
    }
    return reachable.length;
  }
}
