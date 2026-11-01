import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAdminService } from '../audit/audit-admin.service.js';
import { logger } from '../common/logger.js';

const QUEUE = 'maintenance';

/**
 * Scheduled maintenance, run through BullMQ so each job runs once even if
 * the API is restarted mid-way:
 *  - every 5 min: sign the audit chain head (checkpoint)
 *  - every hour:   delete expired sessions; verify the full audit chain
 *  - every day:    permanently remove documents in the trash past retention
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
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.JOBS_ENABLED) return;
    const connection = { url: this.env.REDIS_URL, maxRetriesPerRequest: null };
    // BullMQ keys live under the same prefix the Redis ACL allows.
    const prefix = `${this.env.REDIS_PREFIX}bull`;
    this.queue = new Queue(QUEUE, { connection, prefix });
    await this.queue.upsertJobScheduler('checkpoint', { every: 5 * 60_000 }, { name: 'checkpoint' });
    await this.queue.upsertJobScheduler('sessions', { every: 60 * 60_000 }, { name: 'sessions' });
    await this.queue.upsertJobScheduler('verify', { every: 60 * 60_000 }, { name: 'verify' });
    await this.queue.upsertJobScheduler('retention', { every: 24 * 60 * 60_000 }, { name: 'retention' });

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
      case 'retention':
        return this.retention();
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
