import { verify as edVerify } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service.js';
import { authAbuseAlerts } from './auth-abuse-alerts.js';
import { KEY_PROVIDER, ed25519PublicKeyObject, type KeyProvider } from '../crypto/key-provider.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Actor } from '../common/request-context.js';
import { AuditService } from './audit.service.js';

export interface AuditQuery {
  action?: string | undefined;
  outcome?: 'ALLOWED' | 'DENIED' | 'FAILED' | undefined;
  actor?: string | undefined;
  documentId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  before?: bigint | undefined;
  limit: number;
}

/** The exact bytes a checkpoint signature covers. Also used by tools/verify-audit.mjs. */
export const checkpointMessage = (seq: bigint, headHash: Buffer): Buffer =>
  Buffer.from(`tv-checkpoint-v1|${seq.toString()}|${headHash.toString('hex')}`, 'utf8');

const ZERO = Buffer.alloc(32);

@Injectable()
export class AuditAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  async list(q: AuditQuery) {
    const where: Prisma.AuditEventWhereInput = {
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(q.actor ? { actorEmail: { contains: q.actor, mode: 'insensitive' } } : {}),
      ...(q.documentId ? { documentId: q.documentId } : {}),
      ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(q.before ? { seq: { lt: q.before } } : {}),
    };
    const rows = await this.prisma.auditEvent.findMany({ where, orderBy: { seq: 'desc' }, take: q.limit });
    const titles = await this.titles(rows.map((r) => r.documentId).filter((x): x is string => Boolean(x)));
    return {
      events: rows.map((r) => ({
        seq: r.seq.toString(), occurredAt: r.occurredAt, actorId: r.actorId, actorEmail: r.actorEmail,
        action: r.action, outcome: r.outcome, reason: r.reason, targetType: r.targetType, targetId: r.targetId,
        documentId: r.documentId, documentTitle: r.documentId ? (titles.get(r.documentId) ?? null) : null,
        ip: r.ip, userAgent: r.userAgent, requestId: r.requestId, details: r.details,
        hash: Buffer.from(r.hash).toString('hex'),
      })),
      nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.seq.toString() : null,
    };
  }

  /**
   * Full verification: recompute every hash in the database (audit_verify),
   * then check each signed checkpoint still matches the chain and its
   * Ed25519 signature is valid. Any edit, deletion, insertion or
   * truncation after a checkpoint shows up here.
   */
  async verify(actor: Actor | null) {
    const [chain] = await this.prisma.$queryRaw<{ first_bad_seq: bigint | null; checked: bigint }[]>`SELECT * FROM audit_verify()`;
    const { publicKey, keyId } = await this.keys.publicKey();
    const pub = ed25519PublicKeyObject(publicKey);
    const checkpoints = await this.prisma.auditCheckpoint.findMany({ orderBy: { seq: 'asc' } });
    const problems: string[] = [];
    for (const c of checkpoints) {
      const event = await this.prisma.auditEvent.findUnique({ where: { seq: c.seq }, select: { hash: true } });
      if (!event) problems.push(`checkpoint ${c.seq}: event missing (log truncated?)`);
      else if (!Buffer.from(event.hash).equals(Buffer.from(c.headHash))) problems.push(`checkpoint ${c.seq}: chain no longer matches`);
      if (!edVerify(null, checkpointMessage(c.seq, Buffer.from(c.headHash)), pub, Buffer.from(c.signature))) {
        problems.push(`checkpoint ${c.seq}: bad signature`);
      }
    }
    const ok = chain!.first_bad_seq === null && problems.length === 0;
    const result = {
      ok,
      eventsChecked: chain!.checked.toString(),
      firstBadSeq: chain!.first_bad_seq?.toString() ?? null,
      checkpointsChecked: checkpoints.length,
      latestCheckpoint: checkpoints.at(-1) ? { seq: checkpoints.at(-1)!.seq.toString(), createdAt: checkpoints.at(-1)!.createdAt } : null,
      problems,
      signingKey: { keyId, publicKey: publicKey.toString('base64') },
    };
    await this.audit.record({
      action: 'audit.verify', outcome: ok ? 'ALLOWED' : 'FAILED', reason: ok ? undefined : 'verification_failed',
      details: { eventsChecked: result.eventsChecked, firstBadSeq: result.firstBadSeq, problems },
      ...(actor ? {} : { actorId: null, actorEmail: 'system' }),
    });
    return result;
  }

  /** Signs the current chain head. Run by the scheduler every minute (a no-op if nothing happened), or on demand. */
  async checkpoint(): Promise<{ seq: string } | null> {
    const head = await this.prisma.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true, hash: true } });
    if (!head) return null;
    const last = await this.prisma.auditCheckpoint.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } });
    if (last && last.seq >= head.seq) return null;
    const hash = Buffer.from(head.hash);
    const { signature, keyId } = await this.keys.sign(checkpointMessage(head.seq, hash));
    await this.prisma.auditCheckpoint.create({ data: { seq: head.seq, headHash: new Uint8Array(hash), signature: new Uint8Array(signature), keyId } });
    return { seq: head.seq.toString() };
  }

  /**
   * Public view for outside witnesses: signed checkpoints from `since`
   * (inclusive), plus the hash the chain has *now* at `since`. A witness
   * that already holds checkpoint `since` compares both; if the database
   * was rewritten, the current hash there no longer matches what it
   * recorded, because every hash commits to all events before it.
   */
  async witnessView(since: bigint, limit: number) {
    const [checkpoints, anchor, key] = await Promise.all([
      this.prisma.auditCheckpoint.findMany({ where: { seq: { gte: since } }, orderBy: { seq: 'asc' }, take: limit }),
      this.prisma.auditEvent.findUnique({ where: { seq: since }, select: { hash: true } }),
      this.keys.publicKey(),
    ]);
    return {
      format: 'trustvault-witness-v1',
      signingKey: { keyId: key.keyId, publicKey: key.publicKey.toString('base64'), algorithm: 'Ed25519' },
      since: since.toString(),
      eventHashAtSince: anchor ? Buffer.from(anchor.hash).toString('hex') : null,
      checkpoints: checkpoints.map((c) => ({
        seq: c.seq.toString(), headHash: Buffer.from(c.headHash).toString('hex'),
        signature: Buffer.from(c.signature).toString('base64'), keyId: c.keyId, createdAt: c.createdAt.toISOString(),
      })),
      hasMore: checkpoints.length === limit,
    };
  }

  /**
   * Evidence bundle: events in a range with every field the hash covers,
   * the checkpoints, and the public key. tools/verify-audit.mjs checks it
   * offline with nothing but Node — no database, no trust in this server.
   */
  async export(actor: Actor, fromSeq: bigint, toSeq: bigint | undefined) {
    if (toSeq !== undefined && toSeq < fromSeq) throw new BadRequestException('Invalid range');
    const limit = 50_000;
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT e.seq::text AS seq, e.id::text AS id,
             to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
             actor_id::text AS actor_id, actor_email, action, outcome::text AS outcome, reason, target_type, target_id,
             document_id::text AS document_id, ip, user_agent, request_id, details::text AS details,
             encode(prev_hash, 'hex') AS prev_hash, encode(hash, 'hex') AS hash
        FROM audit_events e
       WHERE e.seq >= ${fromSeq} AND (${toSeq ?? null}::bigint IS NULL OR e.seq <= ${toSeq ?? null}::bigint)
       -- e.seq, the bigint column: the output alias "seq" is text and would sort 1, 10, 100, 2...
       ORDER BY e.seq LIMIT ${limit}`;
    if (rows.length === 0) throw new NotFoundException('No events in that range');
    const lastSeq = BigInt(rows.at(-1)!.seq as string);
    const checkpoints = await this.prisma.auditCheckpoint.findMany({ where: { seq: { gte: fromSeq, lte: lastSeq } }, orderBy: { seq: 'asc' } });
    const { publicKey, keyId } = await this.keys.publicKey();
    await this.audit.record({ action: 'audit.export', outcome: 'ALLOWED', details: { fromSeq: fromSeq.toString(), toSeq: lastSeq.toString(), events: rows.length } });
    void actor;
    return {
      format: 'trustvault-audit-bundle-v1',
      exportedAt: new Date().toISOString(),
      genesisPrevHash: fromSeq === 1n ? ZERO.toString('hex') : null,
      events: rows,
      checkpoints: checkpoints.map((c) => ({ seq: c.seq.toString(), headHash: Buffer.from(c.headHash).toString('hex'), signature: Buffer.from(c.signature).toString('base64'), keyId: c.keyId, createdAt: c.createdAt })),
      signingKey: { keyId, publicKey: publicKey.toString('base64'), algorithm: 'Ed25519' },
      verifyWith: 'node tools/verify-audit.mjs <bundle.json> --key <production public key> --rekor --witness <witness branch>/checkpoints.jsonl',
    };
  }

  /**
   * Things worth an administrator's attention, computed from the audit log
   * over the last `hours`. Nothing here blocks anyone; it is for noticing.
   */
  async alerts(hours = 24) {
    const since = new Date(Date.now() - hours * 3_600_000);
    const [deniedByUser, bulkDownloads, afterRevoke, externalGrants, breakGlass, lockouts, integrity, verifyFailures, malware, rescanFailures, deadSessions, impersonation] = await Promise.all([
      this.prisma.$queryRaw<{ actor_email: string | null; n: bigint; documents: bigint }[]>`
        SELECT actor_email, count(*) AS n, count(DISTINCT target_id) AS documents FROM audit_events
         WHERE occurred_at >= ${since} AND outcome = 'DENIED' AND action LIKE 'document.%'
         GROUP BY actor_email HAVING count(*) >= 5 ORDER BY n DESC LIMIT 20`,
      this.prisma.$queryRaw<{ actor_email: string | null; n: bigint; documents: bigint }[]>`
        SELECT actor_email, count(*) AS n, count(DISTINCT document_id) AS documents FROM audit_events
         WHERE occurred_at >= ${since} AND outcome = 'ALLOWED' AND action = 'document.download'
         GROUP BY actor_email, date_trunc('hour', occurred_at) HAVING count(*) >= 20 ORDER BY n DESC LIMIT 20`,
      this.prisma.$queryRaw<{ actor_email: string | null; document_id: string; attempts: bigint; last_attempt: Date }[]>`
        SELECT d.actor_email, d.document_id::text AS document_id, count(*) AS attempts, max(d.occurred_at) AS last_attempt
          FROM audit_events d
         WHERE d.occurred_at >= ${since} AND d.outcome = 'DENIED' AND d.action LIKE 'document.%' AND d.document_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM audit_events r
                        WHERE r.action = 'access.revoke' AND r.document_id = d.document_id AND r.seq < d.seq
                          AND r.details -> 'subject' ->> 'id' = d.actor_id::text)
         GROUP BY d.actor_email, d.document_id ORDER BY last_attempt DESC LIMIT 20`,
      this.prisma.$queryRaw<{ occurred_at: Date; actor_email: string | null; document_id: string | null; subject: string | null; expires_at: string | null }[]>`
        SELECT occurred_at, actor_email, document_id::text AS document_id, details -> 'subject' ->> 'email' AS subject, details ->> 'expiresAt' AS expires_at
          FROM audit_events
         WHERE occurred_at >= ${since} AND action IN ('access.grant', 'access.change') AND details -> 'subject' ->> 'role' = 'EXTERNAL'
         ORDER BY seq DESC LIMIT 20`,
      this.prisma.$queryRaw<{ occurred_at: Date; actor_email: string | null; document_id: string | null; reason: string | null }[]>`
        SELECT occurred_at, actor_email, document_id::text AS document_id, details ->> 'reason' AS reason FROM audit_events
         WHERE occurred_at >= ${since} AND action = 'admin.break_glass' ORDER BY seq DESC LIMIT 20`,
      this.prisma.$queryRaw<{ occurred_at: Date; actor_email: string | null; reason: string | null; ip: string | null }[]>`
        SELECT occurred_at, actor_email, reason, ip FROM audit_events
         WHERE occurred_at >= ${since} AND action = 'auth.login' AND (reason LIKE 'wrong_password_locked%' OR reason LIKE 'rate_limited%')
         ORDER BY seq DESC LIMIT 20`,
      this.prisma.$queryRaw<{ occurred_at: Date; document_id: string | null; reason: string | null }[]>`
        SELECT occurred_at, document_id::text AS document_id, reason FROM audit_events
         WHERE occurred_at >= ${since} AND action = 'document.integrity' ORDER BY seq DESC LIMIT 20`,
      this.prisma.$queryRaw<{ occurred_at: Date; details: unknown }[]>`
        SELECT occurred_at, details FROM audit_events
         WHERE occurred_at >= ${since} AND action = 'audit.verify' AND outcome = 'FAILED' ORDER BY seq DESC LIMIT 5`,
      this.prisma.$queryRaw<{ occurred_at: Date; document_id: string | null; signature: string | null; version_no: string | null }[]>`
        SELECT occurred_at, document_id::text AS document_id, details ->> 'signature' AS signature, details ->> 'versionNo' AS version_no FROM audit_events
         WHERE occurred_at >= ${since} AND action = 'document.quarantine' ORDER BY seq DESC LIMIT 20`,
      this.prisma.$queryRaw<{ occurred_at: Date }[]>`
        SELECT occurred_at FROM audit_events
         WHERE occurred_at >= ${since} AND action = 'malware.rescan' AND outcome = 'FAILED' ORDER BY seq DESC LIMIT 5`,
      // Someone used a session that had been ended on purpose (THREATS.md L10).
      this.prisma.$queryRaw<{ occurred_at: Date; actor_email: string | null; reason: string | null; ip: string | null }[]>`
        SELECT occurred_at, actor_email, reason, ip FROM audit_events
         WHERE occurred_at >= ${since} AND action = 'auth.session_rejected'
           AND reason NOT IN ('session_expired', 'session_idle')
         ORDER BY seq DESC LIMIT 20`,
      // An admin reset someone's password or second factor and that account
      // then signed in: either the person asked, or an admin is impersonating
      // them to read their documents (THREATS.md S15).
      this.prisma.$queryRaw<{ occurred_at: Date; admin_email: string | null; user_email: string | null; reset: string }[]>`
        SELECT l.occurred_at, r.actor_email AS admin_email, l.actor_email AS user_email, r.action AS reset
          FROM audit_events r
          JOIN audit_events l ON l.action = 'auth.login' AND l.outcome = 'ALLOWED' AND l.actor_id::text = r.target_id::text
                             AND l.seq > r.seq AND l.occurred_at <= r.occurred_at + interval '24 hours'
         WHERE r.occurred_at >= ${since}::timestamptz - interval '24 hours' AND l.occurred_at >= ${since}::timestamptz
           AND r.action IN ('user.password_reset', 'user.mfa_reset') AND r.outcome = 'ALLOWED'
         ORDER BY l.seq DESC LIMIT 20`,
    ]);
    const titles = await this.titles([...afterRevoke, ...externalGrants, ...breakGlass, ...integrity, ...malware].map((r) => r.document_id).filter((x): x is string => Boolean(x)));
    const num = (v: bigint) => Number(v);
    const t = (id: string | null) => (id ? (titles.get(id) ?? null) : null);
    return {
      windowHours: hours,
      alerts: [
        ...verifyFailures.map((r) => ({ severity: 'critical', kind: 'audit_verification_failed', at: r.occurred_at, message: 'Audit chain verification failed', details: r.details })),
        ...integrity.map((r) => ({ severity: 'critical', kind: 'file_integrity', at: r.occurred_at, message: `A stored file failed its integrity check (${r.reason})`, documentId: r.document_id, documentTitle: t(r.document_id) })),
        ...malware.map((r) => ({ severity: 'critical', kind: 'malware_found', at: r.occurred_at, message: `Malware (${r.signature ?? '?'}) found in a stored file, version ${r.version_no ?? '?'}; that version is quarantined`, documentId: r.document_id, documentTitle: t(r.document_id) })),
        ...rescanFailures.map((r) => ({ severity: 'high', kind: 'rescan_failed', at: r.occurred_at, message: 'The nightly malware re-scan could not finish: the scanner was not available' })),
        ...impersonation.map((r) => ({ severity: 'high', kind: 'reset_then_sign_in', at: r.occurred_at, message: `${r.user_email ?? 'unknown'} signed in after ${r.admin_email ?? 'an admin'} reset their ${r.reset === 'user.mfa_reset' ? 'second factor' : 'password'}. Check that they asked for it.` })),
        ...deadSessions.map((r) => ({ severity: 'high', kind: 'ended_session_used', at: r.occurred_at, message: `${r.actor_email ?? 'unknown'} tried to use a session that had been ended (${(r.reason ?? '').replace(/_/g, ' ')}) from ${r.ip ?? '?'}` })),
        ...afterRevoke.map((r) => ({ severity: 'high', kind: 'access_after_revoke', at: r.last_attempt, message: `${r.actor_email ?? 'unknown'} tried ${num(r.attempts)}× to reach a document after their access was revoked`, documentId: r.document_id, documentTitle: t(r.document_id) })),
        ...deniedByUser.map((r) => ({ severity: 'high', kind: 'repeated_denials', message: `${r.actor_email ?? 'unknown'} was refused ${num(r.n)} times across ${num(r.documents)} documents` })),
        ...bulkDownloads.map((r) => ({ severity: 'medium', kind: 'bulk_download', message: `${r.actor_email ?? 'unknown'} downloaded ${num(r.n)} files (${num(r.documents)} documents) within one hour` })),
        ...breakGlass.map((r) => ({ severity: 'medium', kind: 'break_glass', at: r.occurred_at, message: `${r.actor_email} used break-glass access: "${r.reason ?? ''}"`, documentId: r.document_id, documentTitle: t(r.document_id) })),
        ...externalGrants.map((r) => ({ severity: 'info', kind: 'external_share', at: r.occurred_at, message: `${r.actor_email} shared a document with external ${r.subject} until ${r.expires_at ?? '?'}`, documentId: r.document_id, documentTitle: t(r.document_id) })),
        ...lockouts.map((r) => ({ severity: 'info', kind: 'login_blocked', at: r.occurred_at, message: `Sign-in blocked for ${r.actor_email ?? 'unknown'} (${r.reason}) from ${r.ip ?? '?'}` })),
        // Sign-in abuse rules (credential stuffing, distributed guessing): auth-abuse-alerts.ts.
        ...(await authAbuseAlerts(this.prisma, since)),
      ],
    };
  }

  /** Break-glass: one hour of READ access for an admin, with a written reason. Alerted and visible to the owner. */
  async breakGlass(actor: Actor, documentId: string, reason: string) {
    const [doc] = await this.prisma.$queryRaw<{ id: string; title: string; owner_id: string; status: string }[]>`SELECT * FROM tv_document_brief(${documentId}::uuid)`;
    if (!doc || doc.status !== 'ACTIVE') throw new NotFoundException('Document not found');
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    return this.prisma.asUser(actor.userId, async (tx) => {
      const row = await tx.breakGlass.create({ data: { adminId: actor.userId, documentId, reason, expiresAt }, select: { id: true, expiresAt: true } });
      await this.audit.record({ action: 'admin.break_glass', outcome: 'ALLOWED', reason: 'emergency_access', targetType: 'document', targetId: documentId, documentId, details: { reason, expiresAt: expiresAt.toISOString(), title: doc.title } }, tx);
      return { id: row.id, documentId, title: doc.title, expiresAt: row.expiresAt };
    });
  }

  private async titles(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)].slice(0, 200);
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ id: string; title: string }[]>`
      SELECT b.id::text AS id, b.title FROM unnest(${unique}::uuid[]) AS u(id), LATERAL tv_document_brief(u.id) b`;
    return new Map(rows.map((r) => [r.id, r.title]));
  }
}
