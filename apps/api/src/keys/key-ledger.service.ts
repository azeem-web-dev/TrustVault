import { verify as edVerify } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { KEY_PROVIDER, ed25519PublicKeyObject, type KeyProvider } from '../crypto/key-provider.js';
import { ledgerHeadMessage, verifyLedgerRun, ZERO_HASH, type LedgerEntry } from '../crypto/key-ledger.js';

const SYSTEM = { actorId: null, actorEmail: 'system' } as const;
/** Audit events younger than this are not yet expected to have their ledger entry. */
const GRACE_MS = 120_000;
/** More document unwraps than this by one user within the reconciled window is reported. */
export const UNWRAP_VOLUME_ALERT = 200;
/** Refusals a correctly working API never causes: someone is probing keyd. */
const HOSTILE_REFUSALS = new Set([
  'ticket required', 'bad ticket mac', 'unknown ticket key', 'malformed ticket', 'ticket user does not fit its action',
  'ticket lifetime too long', 'ticket issued in the future', 'ticket is for another document version',
  'ticket is for another wrapped key', 'totp unwraps take no ticket',
]);

export type Finding = {
  severity: 'critical' | 'warning' | 'info';
  kind: string;
  message: string;
  ledgerSeq?: number;
  auditSeq?: string;
  tid?: string | null;
  userId?: string | null;
  documentId?: string | null;
};

interface MirrorRow {
  epoch: string;
  seq: number;
  hash: string;
}

/**
 * Keeps the API's copy of keyd's key-use ledger and reconciles it with the
 * audit log (THREATS.md K5-K8, docs/KEYS.md "Reconciliation").
 *
 *  - mirror(): copies new ledger entries into keyd_ledger_entries after
 *    re-checking every hash link, and stores keyd's signed head (verified
 *    against the pinned ledger key) in keyd_ledger_checkpoints, which the
 *    anchor publishes to Sigstore Rekor like audit checkpoints.
 *  - reconcile(): every key release keyd recorded must match an ALLOWED
 *    audit event of the right action, user, document and seq, and a ticket
 *    the database issued; every ticketed ALLOWED audit event must have a
 *    key release (or a recorded refusal). Anything else is a finding,
 *    written to the audit log as keyd.reconcile FAILED and shown in alerts.
 *
 * Each keyd ledger file is one chain ("epoch", named by its first entry's
 * hash). A new epoch means keyd's state directory was replaced or lost:
 * that is reported, never silently accepted.
 */
@Injectable()
export class KeyLedgerService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  /** Copies new ledger entries and the signed head. Returns what happened and any problems. */
  async mirror({ maxEntries = 20_000 }: { maxEntries?: number } = {}) {
    const problems: string[] = [];
    const [genesis] = await this.keys.ledgerRead(1, 1);
    if (!genesis) return { epoch: null, mirrored: 0, headSeq: 0, problems: ['the key service ledger is empty'] };
    if (genesis.seq !== 1 || genesis.prev !== ZERO_HASH || verifyLedgerRun(0, ZERO_HASH, [genesis])) {
      problems.push('the key service ledger does not start with a valid genesis entry');
      return this.finishMirror(genesis.hash, 0, 0, problems);
    }
    const epoch = genesis.hash;
    const [last] = await this.prisma.$queryRaw<MirrorRow[]>`
      SELECT epoch, seq::int AS seq, hash FROM keyd_ledger_entries WHERE epoch = ${epoch} ORDER BY seq DESC LIMIT 1`;
    if (!last) {
      const [other] = await this.prisma.$queryRaw<MirrorRow[]>`SELECT epoch, seq::int AS seq, hash FROM keyd_ledger_entries ORDER BY n DESC LIMIT 1`;
      if (other) problems.push(`the key service started a new ledger; the previous one (${other.epoch.slice(0, 12)}…) was last mirrored at entry ${other.seq}. Entries after that are lost.`);
    }
    let seq = last?.seq ?? 0;
    let hash = last?.hash ?? ZERO_HASH;
    let mirrored = 0;
    while (mirrored < maxEntries) {
      const page = await this.keys.ledgerRead(seq + 1, 500);
      if (page.length === 0) break;
      const bad = verifyLedgerRun(seq, hash, page);
      if (bad) {
        problems.push(`key service ledger does not verify: ${bad}`);
        break;
      }
      await this.insertEntries(epoch, page);
      mirrored += page.length;
      seq = page.at(-1)!.seq;
      hash = page.at(-1)!.hash;
    }
    return this.finishMirror(epoch, seq, mirrored, problems);
  }

  private async finishMirror(epoch: string, seq: number, mirrored: number, problems: string[]) {
    const head = await this.keys.ledgerHead();
    const sigOk = (() => {
      try {
        return edVerify(null, ledgerHeadMessage(head.seq, head.headHash), ed25519PublicKeyObject(Buffer.from(head.publicKey, 'base64')), Buffer.from(head.signature, 'base64'));
      } catch {
        return false;
      }
    })();
    if (!sigOk) problems.push('the key service ledger head signature does not verify');
    const [pinned] = await this.prisma.$queryRaw<{ public_key: string }[]>`SELECT public_key FROM keyd_ledger_checkpoints ORDER BY created_at ASC, seq ASC LIMIT 1`;
    if (pinned && pinned.public_key !== head.publicKey) problems.push('the key service ledger signing key changed from the first one recorded');
    if (head.seq < seq) problems.push(`the key service ledger head (${head.seq}) is behind what was already mirrored (${seq})`);
    if (sigOk && problems.length === 0 && head.seq > 0 && head.seq <= seq) {
      const [atHead] = await this.prisma.$queryRaw<{ hash: string }[]>`SELECT hash FROM keyd_ledger_entries WHERE epoch = ${epoch} AND seq = ${head.seq}`;
      if (!atHead || atHead.hash !== head.headHash) problems.push(`the signed ledger head ${head.seq} does not match the mirrored entry`);
      else {
        await this.prisma.$executeRaw`
          INSERT INTO keyd_ledger_checkpoints (epoch, seq, head_hash, signature, public_key, key_id)
          VALUES (${epoch}, ${head.seq}, ${head.headHash}, ${head.signature}, ${head.publicKey}, ${head.keyId})
          ON CONFLICT DO NOTHING`;
      }
    }
    if (problems.length) {
      await this.audit.record({ ...SYSTEM, action: 'keyd.ledger', outcome: 'FAILED', reason: 'ledger_problem', details: { epoch, mirroredTo: seq, problems } });
    }
    return { epoch, mirrored, headSeq: head.seq, problems };
  }

  private async insertEntries(epoch: string, entries: LedgerEntry[]) {
    await this.prisma.$transaction(async (tx) => {
      for (const e of entries) {
        await tx.$executeRaw`
          INSERT INTO keyd_ledger_entries (epoch, seq, ts_ms, event, action, tid, user_id, document_id, version_id, audit_event_id, audit_seq, key_id, aad_sha256, result, detail, prev_hash, hash)
          VALUES (${epoch}, ${e.seq}, ${e.ts}, ${e.event}, ${e.action}, ${e.tid}, ${e.user}, ${e.doc}, ${e.ver}, ${e.audit_id}, ${e.audit_seq}, ${e.key_id}, ${e.aad_sha256}, ${e.result}, ${e.detail}, ${e.prev}, ${e.hash})`;
      }
    });
  }

  /** Mirror, then compare everything new since the last reconciliation. */
  async reconcile({ graceMs = GRACE_MS }: { graceMs?: number } = {}) {
    const mirror = await this.mirror();
    const prev = await this.prisma.auditEvent.findFirst({ where: { action: 'keyd.reconcile' }, orderBy: { seq: 'desc' }, select: { details: true } });
    const cur = (prev?.details ?? {}) as { ledgerTo?: string; auditTo?: string };
    const ledgerFrom = BigInt(cur.ledgerTo ?? '0');
    const auditFrom = BigInt(cur.auditTo ?? '0');
    const [maxN] = await this.prisma.$queryRaw<{ n: bigint }[]>`SELECT coalesce(max(n), 0)::bigint AS n FROM keyd_ledger_entries`;
    const ledgerTo = maxN!.n;
    // The database's clock: the same one that stamped the events.
    const [maxSeq] = await this.prisma.$queryRaw<{ seq: bigint }[]>`
      SELECT coalesce(max(seq), ${auditFrom})::bigint AS seq FROM audit_events
       WHERE seq > ${auditFrom} AND occurred_at <= clock_timestamp() - make_interval(secs => ${graceMs / 1000}::float8)`;
    const auditTo = maxSeq!.seq;
    const findings: Finding[] = mirror.problems.map((m) => ({ severity: 'critical', kind: 'ledger_integrity', message: m }));

    // A. Key released without a matching ALLOWED audit event.
    const noAudit = await this.prisma.$queryRaw<{ seq: number; tid: string | null; user_id: string | null; document_id: string | null; action: string | null; audit_seq: bigint | null; why: string }[]>`
      SELECT l.seq::int AS seq, l.tid, l.user_id, l.document_id, l.action, l.audit_seq,
             CASE WHEN ae.id IS NULL THEN 'no such audit event'
                  WHEN ae.seq <> l.audit_seq THEN 'audit seq differs'
                  WHEN ae.outcome <> 'ALLOWED' THEN 'audit event is not ALLOWED'
                  WHEN ae.action <> coalesce(ua.audit_action, CASE l.action WHEN 'reencrypt' THEN 'keys.reencrypt_version' END) THEN 'audit action differs'
                  WHEN ae.document_id::text IS DISTINCT FROM l.document_id THEN 'audit document differs'
                  ELSE 'audit user differs' END AS why
        FROM keyd_ledger_entries l
        LEFT JOIN audit_events ae ON ae.id::text = l.audit_event_id
        LEFT JOIN unwrap_actions ua ON ua.action = l.action
       WHERE l.n > ${ledgerFrom} AND l.n <= ${ledgerTo} AND l.event = 'unwrap' AND l.result = 'ok'
         AND (ae.id IS NULL OR ae.seq <> l.audit_seq OR ae.outcome <> 'ALLOWED'
              OR ae.action IS DISTINCT FROM coalesce(ua.audit_action, CASE l.action WHEN 'reencrypt' THEN 'keys.reencrypt_version' END)
              OR ae.document_id::text IS DISTINCT FROM l.document_id OR ae.actor_id::text IS DISTINCT FROM l.user_id)
       ORDER BY l.n LIMIT 500`;
    for (const r of noAudit) findings.push({ severity: 'critical', kind: 'release_without_audit', message: `keyd released a document key (${r.action}) with no matching audit event: ${r.why}`, ledgerSeq: r.seq, tid: r.tid, userId: r.user_id, documentId: r.document_id, auditSeq: r.audit_seq?.toString() });

    // B. Key released on a ticket the database has no record of issuing
    //    (minted with a stolen ticket key, or issued in a rolled-back transaction).
    const noTicket = await this.prisma.$queryRaw<{ seq: number; tid: string | null; user_id: string | null; document_id: string | null }[]>`
      SELECT l.seq::int AS seq, l.tid, l.user_id, l.document_id
        FROM keyd_ledger_entries l
        LEFT JOIN unwrap_tickets t ON t.id::text = l.tid
       WHERE l.n > ${ledgerFrom} AND l.n <= ${ledgerTo} AND l.event = 'unwrap'
         AND (t.id IS NULL OR t.version_id::text IS DISTINCT FROM l.version_id OR t.action IS DISTINCT FROM l.action
              OR t.user_id::text IS DISTINCT FROM l.user_id OR t.audit_event_id::text IS DISTINCT FROM l.audit_event_id)
       ORDER BY l.n LIMIT 500`;
    for (const r of noTicket) findings.push({ severity: 'critical', kind: 'release_without_issued_ticket', message: 'keyd accepted a ticket the database has no matching record of', ledgerSeq: r.seq, tid: r.tid, userId: r.user_id, documentId: r.document_id });

    // C. The same ticket released twice (keyd refuses this; a hit means keyd itself misbehaved).
    const twice = await this.prisma.$queryRaw<{ tid: string; n: bigint }[]>`
      SELECT tid, count(*) AS n FROM keyd_ledger_entries
       WHERE event = 'unwrap' AND result = 'ok' AND tid IN (SELECT tid FROM keyd_ledger_entries WHERE n > ${ledgerFrom} AND n <= ${ledgerTo} AND event = 'unwrap')
       GROUP BY tid HAVING count(*) > 1 LIMIT 100`;
    for (const r of twice) findings.push({ severity: 'critical', kind: 'ticket_used_twice', message: `ticket used ${Number(r.n)} times`, tid: r.tid });

    // D. Refusals, failures, restarts.
    const events = await this.prisma.$queryRaw<{ event: string; result: string; user_id: string | null; n: bigint; suppressed: bigint }[]>`
      SELECT event, result, user_id, count(*) AS n,
             coalesce(sum(CASE WHEN detail LIKE 'suppressed=%' THEN substr(detail, 12)::bigint ELSE 0 END), 0)::bigint AS suppressed
        FROM keyd_ledger_entries
       WHERE n > ${ledgerFrom} AND n <= ${ledgerTo} AND (event IN ('refuse', 'start') OR (event IN ('unwrap', 'totp_unwrap') AND result <> 'ok'))
       GROUP BY event, result, user_id ORDER BY count(*) DESC LIMIT 200`;
    for (const r of events) {
      const n = Number(r.n);
      const extra = Number(r.suppressed) ? ` (+${Number(r.suppressed)} not individually recorded)` : '';
      if (r.event === 'start') findings.push({ severity: 'info', kind: 'keyd_restarted', message: `keyd started ${n}×` });
      else if (r.event === 'refuse' && HOSTILE_REFUSALS.has(r.result)) findings.push({ severity: 'critical', kind: 'keyd_probe', message: `keyd refused ${n} request(s): ${r.result}${extra}`, userId: r.user_id });
      else if (r.event === 'refuse') findings.push({ severity: 'warning', kind: 'keyd_refusal', message: `keyd refused ${n} request(s): ${r.result}${extra}`, userId: r.user_id });
      else findings.push({ severity: 'warning', kind: 'unwrap_failed', message: `${n} ${r.event} attempt(s) failed: ${r.result}`, userId: r.user_id });
    }

    // E. Unusual volume per user in the window.
    const volume = await this.prisma.$queryRaw<{ user_id: string; n: bigint }[]>`
      SELECT user_id, count(*) AS n FROM keyd_ledger_entries
       WHERE n > ${ledgerFrom} AND n <= ${ledgerTo} AND event = 'unwrap' AND result = 'ok' AND user_id IS NOT NULL
       GROUP BY user_id HAVING count(*) > ${UNWRAP_VOLUME_ALERT} LIMIT 50`;
    for (const r of volume) findings.push({ severity: 'warning', kind: 'unwrap_volume', message: `${Number(r.n)} document keys released for one user since the last reconciliation`, userId: r.user_id });

    // F. The other direction: a ticketed ALLOWED event with no key release in
    //    the ledger. Fine if keyd refused it (recorded above) or was down;
    //    otherwise the file was produced without keyd (cached key?).
    //    And an ALLOWED event of a ticketed action with no ticket at all,
    //    after tickets were introduced: bytes released outside the protocol.
    //    A first Android copy key is freshly generated here and handed over
    //    without unwrapping any stored ciphertext (viewing.service offlineKey,
    //    `created:true`), so it has no ticket and no ledger entry BY DESIGN;
    //    it is not a key release and must not read as one, or the reconciler
    //    cries wolf on every first open and real release_without_ticket hits
    //    drown in the noise.
    const auditSide = await this.prisma.$queryRaw<{ seq: bigint; action: string; actor_id: string | null; document_id: string | null; has_ticket: boolean; ledger: string | null }[]>`
      SELECT ae.seq, ae.action, ae.actor_id::text AS actor_id, ae.document_id::text AS document_id,
             (t.id IS NOT NULL) AS has_ticket,
             (SELECT l.result FROM keyd_ledger_entries l WHERE l.audit_event_id = ae.id::text ORDER BY l.n LIMIT 1) AS ledger
        FROM audit_events ae
        LEFT JOIN unwrap_tickets t ON t.audit_event_id = ae.id
       WHERE ae.seq > ${auditFrom} AND ae.seq <= ${auditTo} AND ae.outcome = 'ALLOWED'
         AND ae.action IN (SELECT audit_action FROM unwrap_actions UNION SELECT 'keys.reencrypt_version')
         AND NOT (ae.action = 'document.offline_key' AND (ae.details ->> 'created') = 'true')
         AND ae.occurred_at >= coalesce((SELECT min(issued_at) FROM unwrap_tickets), 'infinity'::timestamptz)
         AND (t.id IS NULL OR NOT EXISTS (SELECT 1 FROM keyd_ledger_entries l WHERE l.audit_event_id = ae.id::text AND l.event = 'unwrap' AND l.result = 'ok'))
       ORDER BY ae.seq LIMIT 500`;
    for (const r of auditSide) {
      if (!r.has_ticket) findings.push({ severity: 'critical', kind: 'release_without_ticket', message: `${r.action} was recorded as ALLOWED without an unwrap ticket`, auditSeq: r.seq.toString(), userId: r.actor_id, documentId: r.document_id });
      else if (r.ledger === null) findings.push({ severity: 'warning', kind: 'ticket_not_used', message: `${r.action} was ticketed but keyd recorded no use of the ticket (key service down, or the request died)`, auditSeq: r.seq.toString(), userId: r.actor_id, documentId: r.document_id });
    }

    const critical = findings.filter((f) => f.severity === 'critical').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const [counts] = await this.prisma.$queryRaw<{ unwraps: bigint; refusals: bigint; totp: bigint; rewraps: bigint }[]>`
      SELECT count(*) FILTER (WHERE event = 'unwrap' AND result = 'ok') AS unwraps, count(*) FILTER (WHERE event = 'refuse') AS refusals,
             count(*) FILTER (WHERE event = 'totp_unwrap') AS totp, count(*) FILTER (WHERE event = 'rewrap') AS rewraps
        FROM keyd_ledger_entries WHERE n > ${ledgerFrom} AND n <= ${ledgerTo}`;
    const result = {
      ok: critical === 0,
      epoch: mirror.epoch,
      ledgerFrom: ledgerFrom.toString(), ledgerTo: ledgerTo.toString(),
      auditFrom: auditFrom.toString(), auditTo: auditTo.toString(),
      counts: { unwraps: Number(counts!.unwraps), refusals: Number(counts!.refusals), totpUnwraps: Number(counts!.totp), rewraps: Number(counts!.rewraps) },
      critical, warnings,
      findings: findings.slice(0, 200),
      findingsTotal: findings.length,
    };
    await this.audit.record({
      ...SYSTEM, action: 'keyd.reconcile', outcome: critical ? 'FAILED' : 'ALLOWED',
      reason: critical ? 'unmatched_key_use' : warnings ? 'warnings' : 'clean',
      details: { ...result, findings: result.findings.slice(0, 50) },
    });
    return result;
  }

  /** Signed ledger heads for outside witnesses and the Rekor anchor. Public, like audit checkpoints. */
  async witnessView(since: number, limit: number) {
    const rows = await this.prisma.$queryRaw<{ n: bigint; epoch: string; seq: bigint; head_hash: string; signature: string; public_key: string; key_id: string; created_at: Date }[]>`
      SELECT n, epoch, seq, head_hash, signature, public_key, key_id, created_at FROM keyd_ledger_checkpoints
       WHERE n >= ${since} ORDER BY n LIMIT ${limit}`;
    const [first] = await this.prisma.$queryRaw<{ public_key: string; key_id: string }[]>`SELECT public_key, key_id FROM keyd_ledger_checkpoints ORDER BY n LIMIT 1`;
    return {
      format: 'trustvault-keyd-ledger-v1',
      signingKey: first ? { keyId: first.key_id, publicKey: first.public_key, algorithm: 'Ed25519' } : null,
      checkpoints: rows.map((r) => ({ n: r.n.toString(), epoch: r.epoch, seq: r.seq.toString(), headHash: r.head_hash, signature: r.signature, keyId: r.key_id, createdAt: r.created_at.toISOString() })),
      hasMore: rows.length === limit,
    };
  }

  /** Mirrored entries for administrators (newest first). */
  async entries(before: bigint | undefined, limit: number) {
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT n, epoch, seq, ts_ms, event, action, tid, user_id, document_id, version_id, audit_event_id, audit_seq, key_id, result, detail, hash
        FROM keyd_ledger_entries WHERE (${before ?? null}::bigint IS NULL OR n < ${before ?? null}::bigint)
       ORDER BY n DESC LIMIT ${limit}`;
    return rows.map((r) => ({ ...r, n: String(r.n), seq: String(r.seq), audit_seq: r.audit_seq === null ? null : String(r.audit_seq), at: new Date(Number(r.ts_ms)).toISOString(), ts_ms: undefined }));
  }

  async status() {
    const s = await this.keys.status();
    const blobs = await this.prisma.$queryRaw<{ key_id: string; n: bigint }[]>`SELECT * FROM tv_key_usage()`;
    return { ...s, wrappedValues: blobs.map((b) => ({ keyId: b.key_id, count: Number(b.n) })) };
  }
}
