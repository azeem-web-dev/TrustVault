import { Inject, Injectable } from '@nestjs/common';
import type { AuditOutcome } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { currentContext } from '../common/request-context.js';

export interface AuditInput {
  action: string;
  outcome: AuditOutcome;
  reason?: string;
  targetType?: string;
  targetId?: string;
  documentId?: string;
  details?: Prisma.InputJsonValue;
  /** Override the actor taken from the request (e.g. a failed login). */
  actorId?: string | null;
  actorEmail?: string | null;
}

/**
 * Writes audit events. Ordering, timestamps and the hash chain are assigned
 * by the database trigger; this service only supplies the content.
 *
 * Pass `tx` to write inside the same transaction as the action being
 * recorded: if the audit insert fails, the action rolls back too. Refusals
 * are written without `tx` so they are kept even though the request fails.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(input: AuditInput, tx?: Tx): Promise<void> {
    const ctx = currentContext();
    const db = tx ?? this.prisma;
    await db.auditEvent.create({
      data: {
        action: input.action,
        outcome: input.outcome,
        reason: input.reason ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        documentId: input.documentId ?? null,
        details: input.details ?? undefined,
        actorId: input.actorId !== undefined ? input.actorId : (ctx?.actor?.userId ?? null),
        actorEmail: input.actorEmail !== undefined ? input.actorEmail : (ctx?.actor?.email ?? null),
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
        requestId: ctx?.requestId ?? null,
      },
    });
  }
}
