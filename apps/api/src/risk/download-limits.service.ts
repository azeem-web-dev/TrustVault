import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { currentContext, type Actor } from '../common/request-context.js';
import { RiskSettingsService } from './risk-settings.service.js';
import { ipPrefix } from './net.js';

export interface EffectiveLimits {
  daily: number;
  session: number;
  overrideId: string | null;
  overrideExpiresAt: Date | null;
}

export interface QuotaCheck {
  allowed: boolean;
  reason: 'download_limit_daily' | 'download_limit_session' | null;
  usedDay: number;
  usedSession: number;
  limits: EffectiveLimits;
}

/** Pure: is one more download allowed with these counts and limits? */
export function quotaDecision(usedDay: number, usedSession: number, limits: EffectiveLimits): QuotaCheck {
  if (usedDay >= limits.daily) return { allowed: false, reason: 'download_limit_daily', usedDay, usedSession, limits };
  if (usedSession >= limits.session) return { allowed: false, reason: 'download_limit_session', usedDay, usedSession, limits };
  return { allowed: true, reason: null, usedDay, usedSession, limits };
}

/**
 * Hard download limits (THREATS.md U9): per person per rolling 24 hours,
 * and per sign-in session. Checked inside the download transaction, after
 * the access decision and BEFORE the download is audited and any byte is
 * released. A per-person advisory lock makes check-and-record atomic, so
 * parallel requests cannot all slip in under the limit.
 */
@Injectable()
export class DownloadLimitsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RiskSettingsService) private readonly settings: RiskSettingsService,
  ) {}

  async effective(tx: Tx, userId: string): Promise<EffectiveLimits> {
    const s = await this.settings.values(tx);
    // The most generous live override wins; an expired or revoked one is ignored.
    const [o] = await tx.$queryRaw<{ id: string; daily_limit: number; session_limit: number; expires_at: Date }[]>`
      SELECT id::text AS id, daily_limit, session_limit, expires_at FROM download_limit_overrides
       WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > now()
       ORDER BY daily_limit DESC, expires_at DESC LIMIT 1`;
    return o
      ? { daily: o.daily_limit, session: o.session_limit, overrideId: o.id, overrideExpiresAt: o.expires_at }
      : { daily: s.download_daily_limit, session: s.download_session_limit, overrideId: null, overrideExpiresAt: null };
  }

  /**
   * Allow-and-record, or refuse with 429. On success the download fact is
   * written in `tx`, the same transaction as the ALLOWED audit event, so a
   * counted download and an audited one are the same thing. A refusal is
   * audited outside `tx` (kept although the request fails).
   */
  async enforce(tx: Tx, actor: Actor, documentId: string, versionNo: number): Promise<QuotaCheck> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('tv-download-quota:' || ${actor.userId}, 0))`;
    const limits = await this.effective(tx, actor.userId);
    const [c] = await tx.$queryRaw<{ day: bigint; session: bigint }[]>`
      SELECT count(*) AS day, count(*) FILTER (WHERE session_id = ${actor.sessionId}::uuid) AS session
        FROM download_facts
       WHERE user_id = ${actor.userId}::uuid AND kind = 'download' AND occurred_at > now() - interval '24 hours'`;
    const check = quotaDecision(Number(c!.day), Number(c!.session), limits);
    if (!check.allowed) {
      await this.audit.record({
        action: 'document.download', outcome: 'DENIED', reason: check.reason!, targetType: 'document', targetId: documentId, documentId,
        details: { versionNo, usedDay: check.usedDay, usedSession: check.usedSession, dailyLimit: limits.daily, sessionLimit: limits.session, overrideId: limits.overrideId },
      });
      const which = check.reason === 'download_limit_daily' ? `${limits.daily} downloads in 24 hours` : `${limits.session} downloads in one session`;
      throw new HttpException(
        { message: `Download limit reached (${which}). Ask an administrator if you need more for legitimate work.`, code: check.reason },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const ip = currentContext()?.ip ?? null;
    await tx.$executeRaw`
      INSERT INTO download_facts (user_id, session_id, document_id, version_no, ip, ip_prefix, kind)
      VALUES (${actor.userId}::uuid, ${actor.sessionId}::uuid, ${documentId}::uuid, ${versionNo}, ${ip}, ${ipPrefix(ip)}, 'download')`;
    return check;
  }

  // ------------------------------------------------------------ overrides

  async listOverrides(userId?: string) {
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT o.id::text AS id, o.user_id::text AS "userId", u.email AS "userEmail", o.daily_limit AS "dailyLimit", o.session_limit AS "sessionLimit",
             o.reason, g.email AS "grantedBy", o.created_at AS "createdAt", o.expires_at AS "expiresAt",
             o.revoked_at AS "revokedAt", r.email AS "revokedBy",
             (o.revoked_at IS NULL AND o.expires_at > now()) AS active
        FROM download_limit_overrides o
        JOIN users u ON u.id = o.user_id
        JOIN users g ON g.id = o.granted_by
        LEFT JOIN users r ON r.id = o.revoked_by
       WHERE (${userId ?? null}::uuid IS NULL OR o.user_id = ${userId ?? null}::uuid)
       ORDER BY o.created_at DESC LIMIT 200`;
    return { overrides: rows };
  }

  /**
   * An admin raises one person's limits for a while, with a written reason
   * (e.g. a legitimate migration or audit). Audited; the generator raises a
   * policy alert other admins see. At most 14 days (the database enforces it).
   */
  async grantOverride(actor: Actor, input: { userId: string; dailyLimit: number; sessionLimit: number; reason: string; expiresAt: Date }) {
    if (input.userId === actor.userId) throw new BadRequestException('You cannot raise your own download limit');
    const target = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true, role: true, status: true } });
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'ADMIN') throw new BadRequestException('Administrators do not download documents');
    if (input.expiresAt.getTime() > Date.now() + 14 * 86_400_000) throw new BadRequestException('An override lasts at most 14 days');
    if (input.expiresAt.getTime() <= Date.now()) throw new BadRequestException('An override must end in the future');
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string; created_at: Date; expires_at: Date }[]>`
        INSERT INTO download_limit_overrides (user_id, daily_limit, session_limit, reason, granted_by, expires_at)
        VALUES (${input.userId}::uuid, ${input.dailyLimit}, ${input.sessionLimit}, ${input.reason}, ${actor.userId}::uuid, ${input.expiresAt})
        RETURNING id::text AS id, created_at, expires_at`;
      await this.audit.record({
        action: 'download.limit_override', outcome: 'ALLOWED', targetType: 'user', targetId: input.userId,
        details: { overrideId: row!.id, userEmail: target.email, dailyLimit: input.dailyLimit, sessionLimit: input.sessionLimit, reason: input.reason, expiresAt: row!.expires_at.toISOString() },
      }, tx);
      return { id: row!.id, userId: input.userId, dailyLimit: input.dailyLimit, sessionLimit: input.sessionLimit, createdAt: row!.created_at, expiresAt: row!.expires_at };
    });
  }

  async revokeOverride(actor: Actor, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE download_limit_overrides SET revoked_at = now(), revoked_by = ${actor.userId}::uuid
         WHERE id = ${id}::uuid AND revoked_at IS NULL`;
      if (n === 0) throw new NotFoundException('No such live override');
      const [o] = await tx.$queryRaw<{ user_id: string }[]>`SELECT user_id::text AS user_id FROM download_limit_overrides WHERE id = ${id}::uuid`;
      await this.audit.record({ action: 'download.limit_override_revoke', outcome: 'ALLOWED', targetType: 'user', targetId: o!.user_id, details: { overrideId: id } }, tx);
    });
  }

  /** What a person has used and may still use; for the admin view. */
  async usage(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const limits = await this.effective(tx, userId);
      const [c] = await tx.$queryRaw<{ day: bigint; week: bigint }[]>`
        SELECT count(*) FILTER (WHERE occurred_at > now() - interval '24 hours') AS day, count(*) AS week
          FROM download_facts WHERE user_id = ${userId}::uuid AND kind = 'download' AND occurred_at > now() - interval '7 days'`;
      return { userId, limits, used: { last24h: Number(c!.day), last7d: Number(c!.week) } };
    });
  }
}
