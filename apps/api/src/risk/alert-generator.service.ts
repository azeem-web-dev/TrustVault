import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService, type Tx } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { logger } from '../common/logger.js';
import { AlertStoreService, type NewAlert, type RaisedAlert } from './alert-store.service.js';
import { RiskSettingsService, type RiskValues } from './risk-settings.service.js';
import { RiskNotifyService } from './risk-notify.service.js';
import { baselineAlert, coverageAlert, dayKey, hourKey, offHoursAlert, peerAlert, volumeAlerts } from './rules.js';
import { deviceLabel, ipPrefix } from './net.js';

const H = 3_600_000;
const D = 24 * H;
/** Audit events read per batch, and batches per run (the rest waits for the next run, never skipped). */
const BATCH = 2000;
const MAX_BATCHES = 25;
const FLOOD_RULES = ['alert_flood', 'alert_flood_document', 'alert_flood_global'];

interface AuditRow {
  seq: bigint;
  occurred_at: Date;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  outcome: string;
  reason: string | null;
  target_id: string | null;
  document_id: string | null;
  ip: string | null;
  user_agent: string | null;
  details: Record<string, unknown> | null;
}

export interface RunResult {
  scannedEvents: number;
  raised: number;
  bySeverity: Record<string, number>;
  escalated: number;
  backlog: boolean;
}

/**
 * Turns the audit log and the download facts into persistent alerts
 * (THREATS.md L15-L16, S25-S26). Runs every minute through the job queue,
 * and on demand. Two parts:
 *
 *  1. Event rules: reads every audit event after its watermark, in order,
 *     in batches. The watermark moves in the same transaction as the alerts
 *     it produced, so a crash re-reads rather than skips. Nothing is limited
 *     to a "top 20".
 *  2. Window rules: evaluated against `now` over the download facts — hour,
 *     day, week and a long window per person; per session; against the
 *     person's own baseline and their role's peers; share of accessible
 *     documents taken; unusual hours; several accounts on one network.
 *
 * Then flood detection over the alerts themselves, and escalation by email.
 */
@Injectable()
export class AlertGeneratorService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AlertStoreService) private readonly store: AlertStoreService,
    @Inject(RiskSettingsService) private readonly settings: RiskSettingsService,
    @Inject(RiskNotifyService) private readonly notify: RiskNotifyService,
  ) {}

  async run(now: Date = new Date()): Promise<RunResult | null> {
    let raised: RaisedAlert[] = [];
    let scanned = 0;
    let backlog = false;
    const signIns: { alert: RaisedAlert; userId: string; at: Date; ip: string | null; device: string; newDevice: boolean; newNetwork: boolean }[] = [];
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // One generator at a time across every API process; a second caller just returns.
        const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended('tv-alert-generator', 0)) AS ok`;
        if (!lock!.ok) return null;
        const s = await this.settings.values(tx);
        const out: RaisedAlert[] = [];

        // 1. Event rules over the audit log, from the watermark.
        const [state] = await tx.$queryRaw<{ last_seq: bigint }[]>`SELECT last_seq FROM alert_generator_state WHERE id = 1`;
        let last = state!.last_seq;
        for (let i = 0; i < MAX_BATCHES; i++) {
          const rows = await tx.$queryRaw<AuditRow[]>`
            SELECT seq, occurred_at, actor_id::text AS actor_id, actor_email, action, outcome::text AS outcome, reason, target_id,
                   document_id::text AS document_id, ip, user_agent, details
              FROM audit_events WHERE seq > ${last} ORDER BY seq LIMIT ${BATCH}`;
          for (const e of rows) {
            const found = await this.eventAlerts(tx, e);
            const inserted = await this.store.raise(found.alerts, tx);
            out.push(...inserted);
            if (found.signIn) {
              const a = inserted.find((x) => x.rule === 'unusual_sign_in');
              if (a) signIns.push({ alert: a, ...found.signIn });
            }
          }
          scanned += rows.length;
          if (rows.length) last = rows.at(-1)!.seq;
          if (rows.length < BATCH) break;
          if (i === MAX_BATCHES - 1) backlog = true;
        }
        await tx.$executeRaw`UPDATE alert_generator_state SET last_seq = ${last}, last_run_at = now(), last_ok_at = now(), last_error = NULL WHERE id = 1`;

        // 2. Window rules.
        out.push(...(await this.store.raise(await this.windowAlerts(tx, s, now), tx)));

        // 3. Alerts about the alerts: floods.
        out.push(...(await this.store.raise(await this.floodAlerts(tx, s, now), tx)));
        return out;
      }, { maxWait: 10_000, timeout: 120_000 });
      if (result === null) return null;
      raised = result;
    } catch (err) {
      await this.recordFailure(err as Error);
      throw err;
    }

    // After commit: tell people. A mail failure never undoes an alert.
    const serious = raised.filter((a) => a.severity === 'high' || a.severity === 'critical');
    let escalated = 0;
    if (serious.length) {
      escalated = await this.notify.escalate(serious).catch(() => 0);
      for (const a of serious) {
        await this.store.systemEvent(a.id, 'escalate', escalated ? `Emailed to ${escalated} administrator(s)` : 'Not emailed (mail is off or no administrator can receive it); visible in the queue')
          .catch((err: unknown) => logger.warn({ err: (err as Error).message }, 'escalation history not written'));
      }
    }
    for (const si of signIns) {
      await this.notify.unusualSignIn(si.userId, si.at, si.ip, si.device, si.newDevice, si.newNetwork).catch(() => false);
    }
    const bySeverity: Record<string, number> = {};
    for (const a of raised) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
    return { scannedEvents: scanned, raised: raised.length, bySeverity, escalated, backlog };
  }

  /** A failed run is visible: recorded on the state row and, once per outage, in the audit log. */
  private async recordFailure(err: Error): Promise<void> {
    logger.error({ err }, 'alert generator failed');
    try {
      const [was] = await this.prisma.$queryRaw<{ last_error: string | null }[]>`SELECT last_error FROM alert_generator_state WHERE id = 1`;
      await this.prisma.$executeRaw`UPDATE alert_generator_state SET last_run_at = now(), last_error = ${err.message.slice(0, 500)} WHERE id = 1`;
      if (!was?.last_error) {
        await this.audit.record({ action: 'alert.generator', outcome: 'FAILED', reason: 'run_failed', actorId: null, actorEmail: 'system', details: { error: err.message.slice(0, 500) } });
      }
    } catch (e) {
      logger.error({ err: e }, 'could not record alert generator failure');
    }
  }

  // ------------------------------------------------------------ event rules

  private async eventAlerts(tx: Tx, e: AuditRow): Promise<{ alerts: NewAlert[]; signIn?: { userId: string; at: Date; ip: string | null; device: string; newDevice: boolean; newNetwork: boolean } }> {
    const seq = e.seq;
    const base = { auditSeq: seq, windowEnd: e.occurred_at };
    const by = e.actor_email ?? 'unknown';
    const title = typeof e.details?.title === 'string' ? e.details.title : null;
    const day = dayKey(e.occurred_at);
    switch (e.action) {
      case 'audit.verify':
        if (e.outcome !== 'FAILED') break;
        return { alerts: [{ ...base, rule: 'audit_verification_failed', category: 'integrity', severity: 'critical', dedupKey: `audit_verification_failed|${seq}`, message: 'Audit chain verification failed', details: e.details ?? {} }] };
      case 'document.integrity':
        if (e.outcome !== 'FAILED') break;
        return { alerts: [{ ...base, rule: 'file_integrity', category: 'integrity', severity: 'critical', documentId: e.document_id, dedupKey: `file_integrity|${seq}`, message: `A stored file failed its integrity check (${e.reason ?? '?'})` }] };
      case 'document.quarantine':
        return { alerts: [{ ...base, rule: 'malware_found', category: 'integrity', severity: 'critical', documentId: e.document_id, dedupKey: `malware_found|${seq}`, message: `Malware (${String(e.details?.signature ?? '?')}) found in a stored file, version ${String(e.details?.versionNo ?? '?')}; that version is quarantined` }] };
      case 'malware.rescan':
        if (e.outcome !== 'FAILED') break;
        return { alerts: [{ ...base, rule: 'rescan_failed', category: 'system', severity: 'high', dedupKey: `rescan_failed|${seq}`, message: 'The nightly malware re-scan could not finish: the scanner was not available' }] };
      case 'alert.generator':
        if (e.outcome !== 'FAILED') break;
        return { alerts: [{ ...base, rule: 'alert_generator_failed', category: 'system', severity: 'high', dedupKey: `alert_generator_failed|${seq}`, message: `The alert generator failed and recovered: ${String(e.details?.error ?? '').slice(0, 200)}` }] };
      case 'auth.session_rejected':
        if (e.reason === 'session_expired' || e.reason === 'session_idle') break;
        return { alerts: [{ ...base, rule: 'ended_session_used', category: 'session', severity: 'high', subjectUserId: e.actor_id, subjectEmail: e.actor_email, sessionId: e.target_id && isUuid(e.target_id) ? e.target_id : null, dedupKey: `ended_session_used|${seq}`, message: `${by} tried to use a session that had been ended (${(e.reason ?? '').replace(/_/g, ' ')}) from ${e.ip ?? '?'}` }] };
      case 'admin.break_glass':
        if (e.outcome !== 'ALLOWED') break;
        return { alerts: [{ ...base, rule: 'break_glass', category: 'access', severity: 'medium', subjectUserId: e.actor_id, subjectEmail: e.actor_email, documentId: e.document_id, dedupKey: `break_glass|${seq}`, message: `${by} used break-glass access: "${String(e.details?.reason ?? '')}"`, details: { title } }] };
      case 'access.grant':
      case 'access.change': {
        const subject = e.details?.subject as { role?: string; email?: string } | undefined;
        if (e.outcome !== 'ALLOWED' || subject?.role !== 'EXTERNAL') break;
        return { alerts: [{ ...base, rule: 'external_share', category: 'access', severity: 'info', subjectUserId: e.actor_id, subjectEmail: e.actor_email, documentId: e.document_id, dedupKey: `external_share|${seq}`, message: `${by} shared a document with external ${subject.email ?? '?'} until ${String(e.details?.expiresAt ?? '?')}` }] };
      }
      case 'alert.policy_change':
        return { alerts: [{ ...base, rule: 'alert_policy_changed', category: 'policy', severity: 'medium', subjectUserId: e.actor_id, subjectEmail: e.actor_email, dedupKey: `alert_policy_changed|${seq}`, message: `${by} changed detection thresholds or download limits`, details: e.details ?? {} }] };
      case 'download.limit_override':
        return { alerts: [{ ...base, rule: 'download_limit_override', category: 'policy', severity: 'medium', subjectUserId: e.actor_id, subjectEmail: e.actor_email, dedupKey: `download_limit_override|${seq}`, message: `${by} raised the download limit of ${String(e.details?.userEmail ?? '?')} to ${String(e.details?.dailyLimit ?? '?')} a day until ${String(e.details?.expiresAt ?? '?')}: "${String(e.details?.reason ?? '')}"`, details: { ...(e.details ?? {}), userEmail: e.details?.userEmail ?? null } }] };
      case 'auth.login':
        if (e.outcome === 'DENIED' && e.reason && (e.reason.startsWith('wrong_password_locked') || e.reason.startsWith('rate_limited'))) {
          // Aggregated: one alert per account per hour, however many attempts.
          return { alerts: [{ ...base, rule: 'login_blocked', category: 'auth', severity: 'info', subjectUserId: e.actor_id, subjectEmail: e.actor_email, dedupKey: `login_blocked|${e.actor_email ?? '?'}|${hourKey(e.occurred_at)}`, message: `Sign-in blocked for ${by} (${e.reason}) from ${e.ip ?? '?'}` }] };
        }
        if (e.outcome === 'ALLOWED' && e.actor_id) return this.signInAlerts(tx, e);
        break;
      default:
        break;
    }
    if (e.action.startsWith('document.') && e.outcome === 'DENIED' && e.actor_id) {
      const alerts: NewAlert[] = [];
      if (e.reason === 'download_limit_daily' || e.reason === 'download_limit_session') {
        alerts.push({ ...base, rule: 'download_limit_hit', category: 'extraction', severity: 'medium', subjectUserId: e.actor_id, subjectEmail: e.actor_email, dedupKey: `download_limit_hit|${e.actor_id}|${e.reason}|${day}`, message: `${by} reached the hard ${e.reason === 'download_limit_daily' ? 'daily' : 'per-session'} download limit and was refused`, details: e.details ?? {} });
      }
      if (e.document_id) {
        const [revoked] = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM audit_events r
           WHERE r.action = 'access.revoke' AND r.document_id = ${e.document_id}::uuid AND r.seq < ${seq}
             AND r.details -> 'subject' ->> 'id' = ${e.actor_id}`;
        if (Number(revoked!.n) > 0) {
          alerts.push({ ...base, rule: 'access_after_revoke', category: 'access', severity: 'high', subjectUserId: e.actor_id, subjectEmail: e.actor_email, documentId: e.document_id, dedupKey: `access_after_revoke|${e.actor_id}|${e.document_id}|${day}`, message: `${by} tried to reach a document after their access was revoked` });
        }
      }
      // Repeated refusals: 5 or more in 24 hours, one alert per person per day.
      const [denied] = await tx.$queryRaw<{ n: bigint; docs: bigint }[]>`
        SELECT count(*) AS n, count(DISTINCT target_id) AS docs FROM audit_events
         WHERE actor_id = ${e.actor_id}::uuid AND outcome = 'DENIED' AND action LIKE 'document.%'
           AND coalesce(reason, '') NOT LIKE 'download_limit_%'
           AND occurred_at > ${e.occurred_at}::timestamptz - interval '24 hours' AND seq <= ${seq}`;
      // Hard-limit refusals have their own alert (download_limit_hit) and are not access denials.
      if (Number(denied!.n) >= 5 && !e.reason?.startsWith('download_limit_')) {
        alerts.push({ ...base, rule: 'repeated_denials', category: 'access', severity: 'high', subjectUserId: e.actor_id, subjectEmail: e.actor_email, observed: Number(denied!.n), threshold: 5, dedupKey: `repeated_denials|${e.actor_id}|${day}`, message: `${by} was refused ${Number(denied!.n)} times across ${Number(denied!.docs)} documents within 24 hours` });
      }
      return { alerts };
    }
    return { alerts: [] };
  }

  /**
   * A successful sign-in, against the account's own last 90 days: a device
   * kind or network (IP prefix) it never used is unusual; the same account
   * live from two networks at once is noted; a sign-in right after an admin
   * reset the password or second factor is flagged (THREATS.md S15, S25-S26).
   * We have no location data, so there is no "impossible travel" rule.
   */
  private async signInAlerts(tx: Tx, e: AuditRow) {
    const alerts: NewAlert[] = [];
    const userId = e.actor_id!;
    const by = e.actor_email ?? 'unknown';
    const device = deviceLabel(e.user_agent);
    const prefix = ipPrefix(e.ip);
    const prior = await tx.$queryRaw<{ ip: string | null; user_agent: string | null }[]>`
      SELECT ip, user_agent FROM audit_events
       WHERE actor_id = ${userId}::uuid AND action = 'auth.login' AND outcome = 'ALLOWED'
         AND seq < ${e.seq} AND occurred_at > ${e.occurred_at}::timestamptz - interval '90 days'
       ORDER BY seq DESC LIMIT 500`;
    let signIn: { userId: string; at: Date; ip: string | null; device: string; newDevice: boolean; newNetwork: boolean } | undefined;
    if (prior.length > 0) {
      const devices = new Set(prior.map((p) => deviceLabel(p.user_agent)));
      const prefixes = new Set(prior.map((p) => ipPrefix(p.ip)).filter(Boolean));
      const newDevice = !devices.has(device);
      const newNetwork = prefix !== null && !prefixes.has(prefix);
      if (newDevice || newNetwork) {
        const what = newDevice && newNetwork ? 'a new device and network' : newDevice ? 'a new device' : 'a new network';
        alerts.push({
          rule: 'unusual_sign_in', category: 'session', severity: newDevice && newNetwork ? 'medium' : 'low', subjectUserId: userId, subjectEmail: e.actor_email,
          auditSeq: e.seq, windowEnd: e.occurred_at, dedupKey: `unusual_sign_in|${e.seq}`,
          message: `${by} signed in from ${what} (${device}, ${prefix ?? 'unknown network'})`,
          details: { device, network: prefix, newDevice, newNetwork, knownDevices: [...devices].slice(0, 10), knownNetworks: prefixes.size },
        });
        signIn = { userId, at: e.occurred_at, ip: e.ip, device, newDevice, newNetwork };
      }
    }
    // Same account live from another network at the same time.
    const idle = this.env.SESSION_IDLE_MINUTES;
    const live = await tx.$queryRaw<{ id: string; ip: string | null; user_agent: string | null }[]>`
      SELECT id::text AS id, ip, user_agent FROM sessions
       WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > now()
         AND last_seen_at > now() - make_interval(mins => ${idle}::int)
         -- Sessions that existed when this sign-in happened, not later ones
         -- (this event may be read a minute after the fact). The sign-in's
         -- own session is created just before its audit event.
         AND created_at <= ${e.occurred_at}::timestamptz`;
    const others = live.filter((l) => { const p = ipPrefix(l.ip); return p !== null && prefix !== null && p !== prefix; });
    if (others.length > 0) {
      const sameKind = others.some((o) => deviceLabel(o.user_agent) === device);
      const nets = [...new Set([prefix, ...others.map((o) => ipPrefix(o.ip))])].sort();
      alerts.push({
        rule: 'concurrent_sessions', category: 'session', severity: sameKind ? 'medium' : 'low', subjectUserId: userId, subjectEmail: e.actor_email,
        auditSeq: e.seq, windowEnd: e.occurred_at, dedupKey: `concurrent_sessions|${userId}|${dayKey(e.occurred_at)}|${nets.join(',')}`,
        message: `${by} is signed in from ${nets.length} networks at once (${nets.join(', ')})${sameKind ? ', on the same kind of device: a shared or stolen session?' : ''}`,
        details: { networks: nets, sameKindOfDevice: sameKind, liveSessions: live.length },
      });
    }
    // Sign-in within 24 hours of an admin resetting this account.
    const [reset] = await tx.$queryRaw<{ actor_email: string | null; action: string }[]>`
      SELECT actor_email, action FROM audit_events
       WHERE action IN ('user.password_reset', 'user.mfa_reset') AND outcome = 'ALLOWED' AND target_id = ${userId}
         AND seq < ${e.seq} AND occurred_at > ${e.occurred_at}::timestamptz - interval '24 hours'
       ORDER BY seq DESC LIMIT 1`;
    if (reset) {
      alerts.push({
        rule: 'reset_then_sign_in', category: 'auth', severity: 'high', subjectUserId: userId, subjectEmail: e.actor_email, auditSeq: e.seq, windowEnd: e.occurred_at,
        dedupKey: `reset_then_sign_in|${e.seq}`,
        message: `${by} signed in after ${reset.actor_email ?? 'an admin'} reset their ${reset.action === 'user.mfa_reset' ? 'second factor' : 'password'}. Check that they asked for it.`,
      });
    }
    return { alerts, ...(signIn ? { signIn } : {}) };
  }

  // ----------------------------------------------------------- window rules

  async windowAlerts(tx: Tx, s: RiskValues, now: Date): Promise<NewAlert[]> {
    const out: NewAlert[] = [];
    const longStart = new Date(now.getTime() - s.long_window_days * D);
    const volume = await tx.$queryRaw<{ user_id: string; email: string; role: string; hour: bigint; day: bigint; week: bigint; long: bigint; docs: bigint }[]>`
      SELECT f.user_id::text AS user_id, u.email, u.role::text AS role,
             count(*) FILTER (WHERE f.occurred_at > ${now}::timestamptz - interval '1 hour') AS hour,
             count(*) FILTER (WHERE f.occurred_at > ${now}::timestamptz - interval '24 hours') AS day,
             count(*) FILTER (WHERE f.occurred_at > ${now}::timestamptz - interval '7 days') AS week,
             count(*) AS long, count(DISTINCT f.document_id) AS docs
        FROM download_facts f JOIN users u ON u.id = f.user_id
       WHERE f.kind = 'download' AND f.occurred_at > ${longStart} AND f.occurred_at <= ${now}
       GROUP BY f.user_id, u.email, u.role`;
    for (const v of volume) {
      const row = { userId: v.user_id, email: v.email, hour: Number(v.hour), day: Number(v.day), week: Number(v.week), long: Number(v.long), distinctDocsLong: Number(v.docs) };
      out.push(...volumeAlerts(row, s, now));
      // Share of everything they can open.
      if (row.distinctDocsLong >= Math.ceil(s.coverage_min_docs * s.coverage_fraction)) {
        const [acc] = await tx.$queryRaw<{ n: bigint }[]>`SELECT tv_accessible_document_count(${v.user_id}::uuid) AS n`;
        const a = coverageAlert(v.user_id, v.email, row.distinctDocsLong, Number(acc!.n), s, now);
        if (a) out.push(a);
      }
    }

    // View-only pages read fast (THREATS.md V7): copying by screenshots
    // before access ends. Same thresholds as the live view's bulk_page_views.
    const pageRuns = await tx.$queryRaw<{ user_id: string; email: string; pages: bigint; docs: bigint }[]>`
      SELECT f.user_id::text AS user_id, u.email, count(*) AS pages, count(DISTINCT f.document_id) AS docs
        FROM download_facts f JOIN users u ON u.id = f.user_id
       WHERE f.kind = 'page_view' AND f.occurred_at > ${now}::timestamptz - interval '10 minutes' AND f.occurred_at <= ${now}
       GROUP BY f.user_id, u.email
      HAVING count(*) > ${this.env.PAGE_VIEW_ALERT_PAGES} OR count(DISTINCT f.document_id) > ${this.env.PAGE_VIEW_ALERT_DOCUMENTS}`;
    for (const r of pageRuns) {
      out.push({
        rule: 'bulk_page_views', category: 'extraction', severity: 'high',
        dedupKey: `bulk_page_views:${r.user_id}:${Math.floor(now.getTime() / 600_000)}`,
        subjectUserId: r.user_id, subjectEmail: r.email, observed: Number(r.pages), threshold: this.env.PAGE_VIEW_ALERT_PAGES,
        windowStart: new Date(now.getTime() - 600_000), windowEnd: now,
        message: `${r.email} viewed ${Number(r.pages)} pages of ${Number(r.docs)} document${Number(r.docs) === 1 ? '' : 's'} within 10 minutes. Every page carries their watermark and trace code.`,
      });
    }

    // Baseline and unusual hours: per-day and per-hour-of-day history.
    const active = volume.filter((v) => Number(v.day) > 0);
    if (active.length) {
      const ids = active.map((v) => v.user_id);
      const hist = await tx.$queryRaw<{ user_id: string; d: number; h: number; n: bigint }[]>`
        SELECT user_id::text AS user_id,
               floor(extract(epoch FROM (${now}::timestamptz - occurred_at)) / 86400)::int AS d,
               extract(hour FROM occurred_at AT TIME ZONE 'UTC')::int AS h, count(*) AS n
          FROM download_facts
         WHERE kind = 'download' AND user_id = ANY(${ids}::uuid[]) AND occurred_at > ${now}::timestamptz - interval '31 days' AND occurred_at <= ${now}
         GROUP BY 1, 2, 3`;
      for (const v of active) {
        const mine = hist.filter((r) => r.user_id === v.user_id);
        const perDay = new Map<number, number>();
        const usualHours = new Set<number>();
        const recentHours: number[] = [];
        for (const r of mine) {
          if (r.d === 0) { for (let i = 0; i < Number(r.n); i++) recentHours.push(r.h); continue; }
          if (r.d > 30) continue;
          perDay.set(r.d, (perDay.get(r.d) ?? 0) + Number(r.n));
          usualHours.add(r.h);
        }
        const b = baselineAlert(v.user_id, v.email, Number(v.day), [...perDay.values()], perDay.size, s, now);
        if (b) out.push(b);
        const o = offHoursAlert(v.user_id, v.email, usualHours, recentHours, perDay.size, s, now);
        if (o) out.push(o);
      }
    }

    // Peers: same role, every active account counts (zero weeks included).
    const weekly = await tx.$queryRaw<{ user_id: string; email: string; role: string; week: bigint }[]>`
      SELECT u.id::text AS user_id, u.email, u.role::text AS role, count(f.id) AS week
        FROM users u LEFT JOIN download_facts f ON f.user_id = u.id AND f.kind = 'download'
             AND f.occurred_at > ${now}::timestamptz - interval '7 days' AND f.occurred_at <= ${now}
       WHERE u.status = 'ACTIVE' AND u.role <> 'ADMIN'
       GROUP BY u.id, u.email, u.role`;
    for (const w of weekly) {
      if (Number(w.week) < s.peer_min) continue;
      const peers = weekly.filter((p) => p.role === w.role && p.user_id !== w.user_id).map((p) => Number(p.week));
      const a = peerAlert(w.user_id, w.email, w.role, Number(w.week), peers, s, now);
      if (a) out.push(a);
    }

    // Per session: volume, and one session used from more than one network.
    const sessions = await tx.$queryRaw<{ session_id: string; user_id: string; email: string; n: bigint; nets: string[] }[]>`
      SELECT f.session_id::text AS session_id, f.user_id::text AS user_id, u.email, count(*) AS n,
             array_agg(DISTINCT f.ip_prefix) FILTER (WHERE f.ip_prefix IS NOT NULL) AS nets
        FROM download_facts f JOIN users u ON u.id = f.user_id
       WHERE f.kind = 'download' AND f.session_id IS NOT NULL AND f.occurred_at > ${now}::timestamptz - interval '24 hours' AND f.occurred_at <= ${now}
       GROUP BY f.session_id, f.user_id, u.email`;
    for (const x of sessions) {
      const n = Number(x.n);
      if (n >= s.session_alert) {
        out.push({
          rule: 'session_download_volume', category: 'extraction', severity: 'medium', subjectUserId: x.user_id, subjectEmail: x.email, sessionId: x.session_id,
          observed: n, threshold: s.session_alert, windowEnd: now, dedupKey: `session_download_volume|${x.session_id}`,
          message: `${x.email} downloaded ${n} files in one sign-in session (alert at ${s.session_alert})`,
        });
      }
      if ((x.nets ?? []).length > 1) {
        out.push({
          rule: 'session_network_changed', category: 'session', severity: 'medium', subjectUserId: x.user_id, subjectEmail: x.email, sessionId: x.session_id,
          observed: x.nets.length, windowEnd: now, dedupKey: `session_network_changed|${x.session_id}|${x.nets.length}`,
          message: `${x.email} downloaded from ${x.nets.length} different networks within one session (${x.nets.join(', ')}): a moved phone, or a copied session cookie?`,
          details: { networks: x.nets },
        });
      }
    }

    // Several accounts, one network, each busy but under the personal
    // thresholds: extraction spread across identities.
    const elevated = Math.max(1, Math.floor(s.day_alert / 4));
    const shared = await tx.$queryRaw<{ ip_prefix: string; users: number; total: bigint; emails: string[] }[]>`
      WITH per AS (
        SELECT f.ip_prefix, f.user_id, count(*) AS n FROM download_facts f
         WHERE f.kind = 'download' AND f.ip_prefix IS NOT NULL AND f.occurred_at > ${now}::timestamptz - interval '24 hours' AND f.occurred_at <= ${now}
         GROUP BY 1, 2)
      SELECT per.ip_prefix, count(*)::int AS users, sum(per.n)::bigint AS total, array_agg(u.email ORDER BY per.n DESC) AS emails
        FROM per JOIN users u ON u.id = per.user_id
       WHERE per.n >= ${elevated}
       GROUP BY per.ip_prefix HAVING count(*) >= 2 AND sum(per.n) >= ${s.shared_network_alert}`;
    for (const x of shared) {
      out.push({
        rule: 'shared_network_extraction', category: 'extraction', severity: 'high', observed: Number(x.total), threshold: s.shared_network_alert,
        windowStart: new Date(now.getTime() - D), windowEnd: now, dedupKey: `shared_network_extraction|${x.ip_prefix}|${dayKey(now)}`,
        message: `${x.users} accounts downloaded ${Number(x.total)} files in 24 hours from one network (${x.ip_prefix}): ${x.emails.slice(0, 5).join(', ')}${x.users > 5 ? '…' : ''}`,
        details: { network: x.ip_prefix, accounts: x.emails, perAccountFloor: elevated },
      });
    }
    return out;
  }

  /**
   * Many alerts about one person or document, or a burst overall, is itself
   * an alert (high): someone may be tripping low rules on purpose to bury
   * a real one. The queue sorts by severity, so the flood alert and anything
   * critical stay on top either way.
   */
  async floodAlerts(tx: Tx, s: RiskValues, now: Date): Promise<NewAlert[]> {
    const out: NewAlert[] = [];
    const bySubject = await tx.$queryRaw<{ subject_user_id: string; email: string | null; n: bigint }[]>`
      SELECT subject_user_id::text AS subject_user_id, max(subject_email) AS email, count(*) AS n FROM security_alerts
       WHERE created_at > now() - interval '24 hours' AND subject_user_id IS NOT NULL AND rule <> ALL(${FLOOD_RULES})
       GROUP BY subject_user_id HAVING count(*) >= ${s.flood_per_subject}`;
    for (const r of bySubject) {
      out.push({
        rule: 'alert_flood', category: 'system', severity: 'high', subjectUserId: r.subject_user_id, subjectEmail: r.email, observed: Number(r.n), threshold: s.flood_per_subject,
        windowEnd: now, dedupKey: `alert_flood|${r.subject_user_id}|${dayKey(now)}`,
        message: `${Number(r.n)} alerts about ${r.email ?? 'one account'} within 24 hours: look at them together`,
      });
    }
    const byDoc = await tx.$queryRaw<{ document_id: string; n: bigint }[]>`
      SELECT document_id::text AS document_id, count(*) AS n FROM security_alerts
       WHERE created_at > now() - interval '24 hours' AND document_id IS NOT NULL AND rule <> ALL(${FLOOD_RULES})
       GROUP BY document_id HAVING count(*) >= ${s.flood_per_subject}`;
    for (const r of byDoc) {
      out.push({
        rule: 'alert_flood_document', category: 'system', severity: 'high', documentId: r.document_id, observed: Number(r.n), threshold: s.flood_per_subject,
        windowEnd: now, dedupKey: `alert_flood_document|${r.document_id}|${dayKey(now)}`,
        message: `${Number(r.n)} alerts about one document within 24 hours`,
      });
    }
    const [g] = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM security_alerts WHERE created_at > now() - interval '1 hour' AND rule <> ALL(${FLOOD_RULES})`;
    const globalLimit = s.flood_per_subject * 5;
    if (Number(g!.n) >= globalLimit) {
      out.push({
        rule: 'alert_flood_global', category: 'system', severity: 'high', observed: Number(g!.n), threshold: globalLimit, windowEnd: now,
        dedupKey: `alert_flood_global|${hourKey(now)}`,
        message: `${Number(g!.n)} alerts within one hour. The queue is sorted by severity: check the critical and high ones first.`,
      });
    }
    return out;
  }
}

const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
