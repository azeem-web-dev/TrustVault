import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimitService } from '../redis/rate-limit.service.js';
import { MailService } from '../mail/mail.service.js';
import { mailTemplates } from '../mail/templates.js';
import { currentContext } from '../common/request-context.js';
import { normaliseEmail } from '../auth/auth.service.js';
import { clientNetwork } from '../auth/client-network.js';

/**
 * Android beta signup. Stores only the address (lowercase), to email the
 * closed-test steps at most once per 24 hours. The answer never depends on
 * whether the address is new, repeated or capped; only the caller's own
 * network can earn a 429. The audit event carries a reason but not the address.
 */
@Injectable()
export class BetaService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async signup(rawEmail: string): Promise<void> {
    const email = normaliseEmail(rawEmail);
    const net = clientNetwork(currentContext()?.ip);
    await this.limits.hit(`beta:ip:${net.ip}`, 5, 900, 'Too many requests. Try again in a few minutes.');
    await this.limits.hit(`beta:net:${net.network}`, 20, 900, 'Too many requests. Try again in a few minutes.');
    // Per address: quietly stop (a 429 would reveal that the address signed up).
    let underLimit = true;
    try {
      await this.limits.hit(`beta:addr:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`, 3, 3600);
    } catch {
      underLimit = false;
    }
    let reason: string;
    if (!underLimit) reason = 'rate_limited';
    else if (!this.mail.enabled) reason = 'mail_off';
    else {
      // One statement: new row, or a repeat only if the last email is over 24h old.
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO beta_signups (email, last_emailed_at, email_count) VALUES (${email}, now(), 1)
        ON CONFLICT (email) DO UPDATE SET last_emailed_at = now(), email_count = beta_signups.email_count + 1
          WHERE beta_signups.last_emailed_at IS NULL OR beta_signups.last_emailed_at < now() - interval '24 hours'
        RETURNING id`;
      if (rows.length === 0) reason = 'already_emailed';
      else {
        this.mail.send({ email, displayName: 'there', isProtected: false }, mailTemplates.betaSteps({ group: this.env.BETA_GROUP_URL, optIn: this.env.BETA_OPTIN_URL, store: this.env.BETA_STORE_URL }));
        reason = 'sent';
      }
    }
    await this.audit.record({ action: 'beta.signup', outcome: reason === 'sent' ? 'ALLOWED' : 'DENIED', reason, actorId: null, actorEmail: null });
  }
}
