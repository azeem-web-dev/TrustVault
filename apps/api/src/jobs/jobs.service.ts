import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAdminService } from '../audit/audit-admin.service.js';
import { RescanService } from '../scanning/rescan.service.js';
import { DownloadApprovalsService } from '../documents/download-approvals.service.js';
import { KeyLedgerService } from '../keys/key-ledger.service.js';
import { AlertGeneratorService } from '../risk/alert-generator.service.js';
import { logger } from '../common/logger.js';

const QUEUE = 'maintenance';

/**
 * Scheduled maintenance, run through BullMQ so each job runs once even if
 * the API is restarted mid-way:
 *  - every minute: sign the audit chain head if it moved (checkpoint);
 *                  trustvault-anchor.timer publishes it to Sigstore's log;
 *                  copy keyd's key-use ledger and its signed head (also anchored);
 *                  evaluate the alert rules (alerts)
 *  - every hour:   delete expired sessions; verify the full audit chain;
 *                  expire download requests and approvals that ran out;
 *                  reconcile keyd's ledger with the audit log
 *  - every day:    permanently remove documents in the trash past retention;
 *                  re-scan every stored file with the latest malware signatures
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuditAdminService) private readonly auditAdmin: AuditAdminService,
    @Inject(RescanService) private readonly rescan: RescanService,
    @Inject(DownloadApprovalsService) private readonly approvals: DownloadApprovalsService,
    @Inject(KeyLedgerService) private readonly keyLedger: KeyLedgerService,
    @Inject(AlertGeneratorService) private readonly alerts: AlertGeneratorService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.JOBS_ENABLED) return;
    const connection = { url: this.env.REDIS_URL, maxRetriesPerRequest: null };
    // BullMQ keys live under the same prefix the Redis ACL allows.
    const prefix = `${this.env.REDIS_PREFIX}bull`;
    this.queue = new Queue(QUEUE, { connection, prefix });
    await this.queue.upsertJobScheduler('checkpoint', { every: 60_000 }, { name: 'checkpoint' });
    await this.queue.upsertJobScheduler('alerts', { every: 60_000 }, { name: 'alerts' });
    await this.queue.upsertJobScheduler('sessions', { every: 60 * 60_000 }, { name: 'sessions' });
    await this.queue.upsertJobScheduler('verify', { every: 60 * 60_000 }, { name: 'verify' });
    await this.queue.upsertJobScheduler('download-approvals', { every: 60 * 60_000 }, { name: 'download-approvals' });
    await this.queue.upsertJobScheduler('keyd-ledger', { every: 60_000 }, { name: 'keyd-ledger' });
    await this.queue.upsertJobScheduler('keyd-reconcile', { every: 60 * 60_000 }, { name: 'keyd-reconcile' });
    await this.queue.upsertJobScheduler('retention', { every: 24 * 60 * 60_000 }, { name: 'retention' });
    // 04:15 UTC: after the night's signature updates and the 03:30 backup.
    await this.queue.upsertJobScheduler('rescan', { pattern: '15 4 * * *', tz: 'UTC' }, { name: 'rescan' });

    this.worker = new Worker(QUEUE, async (job) => this.run(job.name), { connection, prefix, concurrency: 1 });
    this.worker.on('failed', (job, err) => logger.error({ err, job: job?.name }, 'maintenance job failed'));
  }

  async run(name: string): Promise<unknown> {
    switch (name) {
      case 'checkpoint':
        return this.auditAdmin.checkpoint();
      case 'verify':
        return this.auditAdmin.verify(null);
      case 'sessions': {
        const r = await this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        return { deleted: r.count };
      }
      case 'keyd-ledger':
        return this.keyLedger.mirror();
      case 'keyd-reconcile':
        return this.keyLedger.reconcile();
      case 'retention':
        return this.retention();
      case 'download-approvals':
        return { expired: await this.approvals.expire() };
      case 'rescan':
        return this.rescan.run();
      case 'alerts':
        return this.alerts.run();
      default:
        throw new Error(`unknown job ${name}`);
    }
  }

  /** Purges trash older than TRASH_RETENTION_DAYS and audits each removal. */
  async retention() {
    // Purge and audit in one transaction: no document disappears unrecorded.
    return this.prisma.$transaction(async (tx) => {
      const removed = await tx.$queryRaw<{ id: string; owner_id: string; title: string }[]>`
        SELECT * FROM tv_purge_expired_trash(${this.env.TRASH_RETENTION_DAYS}::int)`;
      for (const d of removed) {
        await this.audit.record({
          action: 'document.purge', outcome: 'ALLOWED', reason: 'retention_policy', actorId: null, actorEmail: 'system',
          targetType: 'document', targetId: d.id, documentId: d.id, details: { title: d.title, ownerId: d.owner_id, retentionDays: this.env.TRASH_RETENTION_DAYS },
        }, tx);
      }
      return { purged: removed.length };
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
