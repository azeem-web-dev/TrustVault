import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../common/request-context.js';
import { Prisma } from '../generated/prisma/client.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
export const CATEGORIES = ['extraction', 'access', 'auth', 'session', 'integrity', 'policy', 'system'] as const;
export type Category = (typeof CATEGORIES)[number];
export const STATUSES = ['open', 'acknowledged', 'assigned', 'resolved'] as const;
export const RESOLUTIONS = ['true_positive', 'false_positive', 'benign', 'duplicate'] as const;

export interface NewAlert {
  rule: string;
  category: Category;
  severity: Severity;
  /** Same key, same alert: raising it again is a no-op. */
  dedupKey: string;
  subjectUserId?: string | null;
  subjectEmail?: string | null;
  documentId?: string | null;
  sessionId?: string | null;
  observed?: number | null;
  threshold?: number | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  message: string;
  details?: Record<string, unknown>;
  auditSeq?: bigint | null;
}

export interface RaisedAlert {
  id: string;
  rule: string;
  severity: Severity;
  subjectUserId: string | null;
  subjectEmail: string | null;
  message: string;
  details: Record<string, unknown> | null;
}

export interface AlertFilter {
  status: 'active' | 'all' | (typeof STATUSES)[number];
  severity?: Severity[] | undefined;
  minSeverity?: Severity | undefined;
  category?: Category | undefined;
  rule?: string | undefined;
  subject?: string | undefined;
  subjectUserId?: string | undefined;
  documentId?: string | undefined;
  assignee?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  sort: 'severity' | 'newest';
  cursor?: string | undefined;
  limit: number;
}

type ReviewAction = 'acknowledge' | 'assign' | 'resolve' | 'reopen' | 'comment';

const ALERT_COLUMNS = Prisma.sql`
  a.id::text AS id, a.created_at AS "createdAt", a.created_at::text AS "createdAtExact", a.rule, a.category, a.severity,
  a.severity_rank AS "severityRank", a.subject_user_id::text AS "subjectUserId", a.subject_email AS "subjectEmail",
  a.document_id::text AS "documentId", a.session_id::text AS "sessionId", a.observed::float8 AS observed, a.threshold::float8 AS threshold,
  a.window_start AS "windowStart", a.window_end AS "windowEnd", a.message, a.details, a.audit_seq::text AS "auditSeq",
  s.status, s.assignee_id::text AS "assigneeId", s.assignee_email AS "assigneeEmail", s.resolution, s.updated_at AS "statusUpdatedAt"`;

/**
 * Persistent alerts (THREATS.md L15-L16). Alerts are facts: inserted once,
 * never updated or deleted (the database refuses). Review is a separate,
 * append-only history; the current status is derived from it by a trigger.
 * Listing is complete and paginated: nothing is cut off at "top 20", and
 * the counts per severity always cover every matching alert.
 */
@Injectable()
export class AlertStoreService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Inserts the alerts that are new; returns only those (duplicates are skipped, not lost: the first one stands). */
  async raise(alerts: NewAlert[], tx?: Tx): Promise<RaisedAlert[]> {
    const db = tx ?? this.prisma;
    const out: RaisedAlert[] = [];
    for (const a of alerts) {
      const rows = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO security_alerts (rule, category, severity, dedup_key, subject_user_id, subject_email, document_id, session_id,
                                     observed, threshold, window_start, window_end, message, details, audit_seq)
        VALUES (${a.rule}, ${a.category}, ${a.severity}, ${a.dedupKey.slice(0, 400)}, ${a.subjectUserId ?? null}::uuid, ${a.subjectEmail ?? null},
                ${a.documentId ?? null}::uuid, ${a.sessionId ?? null}::uuid, ${a.observed ?? null}::numeric, ${a.threshold ?? null}::numeric,
                ${a.windowStart ?? null}::timestamptz, ${a.windowEnd ?? null}::timestamptz, ${a.message.slice(0, 1000)},
                ${a.details ? JSON.stringify(a.details) : null}::jsonb, ${a.auditSeq ?? null}::bigint)
        ON CONFLICT (dedup_key) DO NOTHING
        RETURNING id::text AS id`;
      if (rows[0]) {
        out.push({ id: rows[0].id, rule: a.rule, severity: a.severity, subjectUserId: a.subjectUserId ?? null, subjectEmail: a.subjectEmail ?? null, message: a.message, details: a.details ?? null });
      }
    }
    return out;
  }

  private where(f: Omit<AlertFilter, 'sort' | 'cursor' | 'limit'>, actor?: Actor): Prisma.Sql {
    const c: Prisma.Sql[] = [];
    if (f.status === 'active') c.push(Prisma.sql`s.status <> 'resolved'`);
    else if (f.status !== 'all') c.push(Prisma.sql`s.status = ${f.status}`);
    if (f.severity?.length) c.push(Prisma.sql`a.severity IN (${Prisma.join(f.severity)})`);
    if (f.minSeverity) c.push(Prisma.sql`a.severity_rank >= ${SEVERITY_RANK[f.minSeverity]}`);
    if (f.category) c.push(Prisma.sql`a.category = ${f.category}`);
    if (f.rule) c.push(Prisma.sql`a.rule = ${f.rule}`);
    if (f.subjectUserId) c.push(Prisma.sql`a.subject_user_id = ${f.subjectUserId}::uuid`);
    if (f.subject) {
      const like = `%${f.subject.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      c.push(Prisma.sql`(a.subject_email ILIKE ${like} OR a.details ->> 'userEmail' ILIKE ${like})`);
    }
    if (f.documentId) c.push(Prisma.sql`a.document_id = ${f.documentId}::uuid`);
    if (f.assignee) c.push(Prisma.sql`s.assignee_id = ${f.assignee === 'me' ? actor?.userId ?? null : f.assignee}::uuid`);
    if (f.from) c.push(Prisma.sql`a.created_at >= ${f.from}`);
    if (f.to) c.push(Prisma.sql`a.created_at <= ${f.to}`);
    return c.length ? Prisma.sql`WHERE ${Prisma.join(c, ' AND ')}` : Prisma.empty;
  }

  /**
   * One page of alerts plus complete counts. Default order is severity
   * first, then newest: a critical alert is on page one however many low
   * ones arrived after it. Keyset pagination: stable while new alerts arrive.
   */
  async list(f: AlertFilter, actor?: Actor) {
    const where = this.where(f, actor);
    const cursor = f.cursor ? decodeCursor(f.cursor) : null;
    const after = cursor
      ? f.sort === 'severity'
        ? Prisma.sql`(a.severity_rank, a.created_at, a.id) < (${cursor.rank}::smallint, ${cursor.at}::timestamptz, ${cursor.id}::uuid)`
        : Prisma.sql`(a.created_at, a.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
      : null;
    const fullWhere = after ? (where === Prisma.empty ? Prisma.sql`WHERE ${after}` : Prisma.sql`${where} AND ${after}`) : where;
    const order = f.sort === 'severity' ? Prisma.sql`a.severity_rank DESC, a.created_at DESC, a.id DESC` : Prisma.sql`a.created_at DESC, a.id DESC`;
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT ${ALERT_COLUMNS} FROM security_alerts a JOIN security_alert_status s ON s.alert_id = a.id
      ${fullWhere} ORDER BY ${order} LIMIT ${f.limit + 1}`;
    const more = rows.length > f.limit;
    const page = rows.slice(0, f.limit);
    const last = page.at(-1);
    const counts = await this.prisma.$queryRaw<{ severity: string; n: bigint }[]>`
      SELECT a.severity, count(*) AS n FROM security_alerts a JOIN security_alert_status s ON s.alert_id = a.id ${where} GROUP BY a.severity`;
    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    for (const r of counts) bySeverity[r.severity as Severity] = Number(r.n);
    return {
      alerts: page.map(publicAlert),
      total: Object.values(bySeverity).reduce((x, y) => x + y, 0),
      bySeverity,
      nextCursor: more && last ? encodeCursor(Number(last.severityRank), String(last.createdAtExact), String(last.id)) : null,
    };
  }

  /** Overview for the queue header: complete counts, flood indicators, generator health. */
  async summary() {
    const [byStatus, topRules, topSubjects, state] = await Promise.all([
      this.prisma.$queryRaw<{ status: string; severity: string; n: bigint }[]>`
        SELECT s.status, a.severity, count(*) AS n FROM security_alerts a JOIN security_alert_status s ON s.alert_id = a.id GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ rule: string; n: bigint }[]>`
        SELECT a.rule, count(*) AS n FROM security_alerts a JOIN security_alert_status s ON s.alert_id = a.id
         WHERE s.status <> 'resolved' GROUP BY 1 ORDER BY n DESC LIMIT 10`,
      this.prisma.$queryRaw<{ subject_email: string | null; subject_user_id: string; n: bigint; max_rank: number }[]>`
        SELECT max(a.subject_email) AS subject_email, a.subject_user_id::text AS subject_user_id, count(*) AS n, max(a.severity_rank)::int AS max_rank
          FROM security_alerts a JOIN security_alert_status s ON s.alert_id = a.id
         WHERE s.status <> 'resolved' AND a.subject_user_id IS NOT NULL GROUP BY a.subject_user_id ORDER BY max_rank DESC, n DESC LIMIT 10`,
      this.prisma.$queryRaw<{ last_seq: bigint; last_run_at: Date | null; last_ok_at: Date | null; last_error: string | null }[]>`
        SELECT last_seq, last_run_at, last_ok_at, last_error FROM alert_generator_state WHERE id = 1`,
    ]);
    const open: Record<string, number> = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    const statusCounts: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of byStatus) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + Number(r.n);
      if (r.status !== 'resolved') open[r.severity] = (open[r.severity] ?? 0) + Number(r.n);
    }
    const g = state[0];
    const stale = !g?.last_ok_at || Date.now() - g.last_ok_at.getTime() > 10 * 60_000;
    return {
      unresolvedBySeverity: open,
      byStatus: statusCounts,
      topRules: topRules.map((r) => ({ rule: r.rule, count: Number(r.n) })),
      topSubjects: topSubjects.map((r) => ({ userId: r.subject_user_id, email: r.subject_email, count: Number(r.n), maxSeverity: SEVERITIES[4 - r.max_rank] })),
      generator: { lastSeq: g?.last_seq.toString() ?? null, lastRunAt: g?.last_run_at ?? null, lastOkAt: g?.last_ok_at ?? null, lastError: g?.last_error ?? null, stale },
    };
  }

  async get(id: string) {
    const [row] = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT ${ALERT_COLUMNS} FROM security_alerts a JOIN security_alert_status s ON s.alert_id = a.id WHERE a.id = ${id}::uuid`;
    if (!row) throw new NotFoundException('Alert not found');
    const history = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT id::text AS id, at, action, status_after AS "statusAfter", actor_email AS "actorEmail", assignee_email AS "assigneeEmail", resolution, note
        FROM security_alert_events WHERE alert_id = ${id}::uuid ORDER BY id`;
    const related = row.subjectUserId
      ? await this.prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM security_alerts WHERE subject_user_id = ${row.subjectUserId as string}::uuid AND id <> ${id}::uuid AND created_at > now() - interval '30 days'`
      : [{ n: 0n }];
    return { alert: publicAlert(row), history, relatedAlerts30d: Number(related[0]!.n) };
  }

  /** Administrators who can be assigned alerts. */
  async reviewers() {
    const rows = await this.prisma.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true, email: true, displayName: true }, orderBy: { email: 'asc' } });
    return { reviewers: rows };
  }

  /**
   * One review step. Checked here for a clear message, enforced again by the
   * database trigger (which also decides the resulting status), and audited
   * in the same transaction: no review step without its audit record.
   */
  async review(actor: Actor, id: string, action: ReviewAction, input: { note?: string | undefined; assigneeId?: string | undefined; resolution?: (typeof RESOLUTIONS)[number] | undefined }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('tv-alert:' || ${id}, 0))`;
      const [cur] = await tx.$queryRaw<{ status: string; subject_user_id: string | null; rule: string; severity: string }[]>`
        SELECT s.status, a.subject_user_id::text AS subject_user_id, a.rule, a.severity
          FROM security_alerts a JOIN security_alert_status s ON s.alert_id = a.id WHERE a.id = ${id}::uuid`;
      if (!cur) throw new NotFoundException('Alert not found');
      // Nobody closes the case about themselves (a policy change they made,
      // an override they granted, their own sign-in): another admin must.
      if (cur.subject_user_id === actor.userId && (action === 'resolve' || action === 'assign')) {
        throw new ForbiddenException('This alert is about you: another administrator must review it');
      }
      let assignee: { id: string; email: string } | null = null;
      if (action === 'assign') {
        if (!input.assigneeId) throw new BadRequestException('Choose who to assign it to');
        if (input.assigneeId === cur.subject_user_id) throw new BadRequestException('An alert cannot be assigned to the person it is about');
        const u = await tx.user.findUnique({ where: { id: input.assigneeId }, select: { id: true, email: true, role: true, status: true } });
        if (!u || u.role !== 'ADMIN' || u.status !== 'ACTIVE') throw new BadRequestException('Alerts can only be assigned to an active administrator');
        assignee = { id: u.id, email: u.email };
      }
      const allowed: Record<ReviewAction, string[]> = {
        acknowledge: ['open'], assign: ['open', 'acknowledged', 'assigned'], resolve: ['open', 'acknowledged', 'assigned'],
        reopen: ['resolved'], comment: ['open', 'acknowledged', 'assigned', 'resolved'],
      };
      if (!allowed[action].includes(cur.status)) throw new ConflictException(`Cannot ${action} an alert that is ${cur.status}`);
      if (action === 'resolve' && (!input.resolution || (input.note ?? '').trim().length < 5)) throw new BadRequestException('Resolving needs an outcome and a note');
      if ((action === 'reopen' || action === 'comment') && (input.note ?? '').trim().length < 5) throw new BadRequestException('Add a note of at least 5 characters');
      const [ev] = await tx.$queryRaw<{ id: string; status_after: string; at: Date }[]>`
        INSERT INTO security_alert_events (alert_id, action, actor_id, actor_email, assignee_id, assignee_email, resolution, note)
        VALUES (${id}::uuid, ${action}, ${actor.userId}::uuid, ${actor.email}, ${assignee?.id ?? null}::uuid, ${assignee?.email ?? null},
                ${action === 'resolve' ? input.resolution! : null}, ${input.note?.trim() || null})
        RETURNING id::text AS id, status_after, at`;
      await this.audit.record({
        action: `alert.${action}`, outcome: 'ALLOWED', targetType: 'alert', targetId: id,
        details: { rule: cur.rule, severity: cur.severity, from: cur.status, to: ev!.status_after, ...(assignee ? { assignee: assignee.email } : {}), ...(input.resolution && action === 'resolve' ? { resolution: input.resolution } : {}), ...(input.note ? { note: input.note.slice(0, 500) } : {}) },
      }, tx);
      return { id, status: ev!.status_after, eventId: ev!.id, at: ev!.at };
    });
  }

  /** System history entry (e.g. "escalated by email to 3 admins"). Status unchanged. */
  async systemEvent(alertId: string, action: 'escalate' | 'comment', note: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO security_alert_events (alert_id, action, actor_id, actor_email, note) VALUES (${alertId}::uuid, ${action}, NULL, 'system', ${note.slice(0, 2000)})`;
  }
}

function publicAlert(r: Record<string, unknown>) {
  const { severityRank: _rank, createdAtExact: _exact, ...rest } = r;
  void _rank; void _exact;
  return rest;
}

function encodeCursor(rank: number, at: string, id: string): string {
  return Buffer.from(JSON.stringify([rank, at, id]), 'utf8').toString('base64url');
}

function decodeCursor(c: string): { rank: number; at: string; id: string } {
  try {
    const [rank, at, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as [unknown, unknown, unknown];
    if (typeof rank !== 'number' || !Number.isInteger(rank) || typeof at !== 'string' || !/^[0-9][0-9:+\-. T]{9,39}$/.test(at) || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error();
    return { rank, at, id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
