import type { PrismaService } from '../db/prisma.service.js';

/**
 * Sign-in abuse alerts (THREATS.md S1, S27), computed from the audit log so
 * they hold even if Redis (where the live throttles keep their counters) is
 * flushed or restarted. Kept apart from AuditAdminService.alerts() on
 * purpose: each rule is one query, and the list can be moved into an alert
 * queue as it is.
 *
 *   auth_abuse_detected    high    the live detectors fired: one IP or network
 *                                  trying many accounts, many networks on one
 *                                  account, an account put under attack
 *   stuffing_from_ip       high    one IP failed sign-in on 6+ accounts
 *   failed_sign_in_burst   medium  one account had 10+ failed sign-ins
 *   sign_in_failure_spike  medium  200+ failed sign-ins in all, or 50+ for
 *                                  emails with no account (a stuffing list)
 *
 * The thresholds count every refusal, including the ones a throttle answered
 * with 429 or "check your email", so slowing an attacker down never hides them.
 */
export const AUTH_ABUSE_THRESHOLDS = { accountsPerIp: 6, failuresPerAccount: 10, failuresTotal: 200, unknownTotal: 50 } as const;

export async function authAbuseAlerts(prisma: PrismaService, since: Date) {
  const [detected, perIp, perAccount, [spike]] = await Promise.all([
    prisma.$queryRaw<{ occurred_at: Date; action: string; reason: string | null; actor_email: string | null; details: Record<string, unknown> | null }[]>`
      SELECT occurred_at, action, reason, actor_email, details FROM audit_events
       WHERE occurred_at >= ${since} AND action IN ('auth.credential_stuffing', 'auth.distributed_guessing', 'auth.account_under_attack')
       ORDER BY seq DESC LIMIT 50`,
    // "Failed" = every refused sign-in except the right password that was sent a confirmation link.
    prisma.$queryRaw<{ ip: string | null; accounts: bigint; n: bigint; last: Date }[]>`
      SELECT ip, count(DISTINCT actor_email) AS accounts, count(*) AS n, max(occurred_at) AS last FROM audit_events
       WHERE occurred_at >= ${since} AND action = 'auth.login' AND outcome = 'DENIED' AND coalesce(reason, '') <> 'stepup_link_sent' AND ip IS NOT NULL
       GROUP BY ip HAVING count(DISTINCT actor_email) >= ${AUTH_ABUSE_THRESHOLDS.accountsPerIp} ORDER BY accounts DESC LIMIT 20`,
    prisma.$queryRaw<{ actor_email: string | null; n: bigint; ips: bigint; last: Date }[]>`
      SELECT actor_email, count(*) AS n, count(DISTINCT ip) AS ips, max(occurred_at) AS last FROM audit_events
       WHERE occurred_at >= ${since} AND action = 'auth.login' AND outcome = 'DENIED' AND coalesce(reason, '') <> 'stepup_link_sent'
       GROUP BY actor_email HAVING count(*) >= ${AUTH_ABUSE_THRESHOLDS.failuresPerAccount} ORDER BY n DESC LIMIT 20`,
    prisma.$queryRaw<{ n: bigint; unknown: bigint; ips: bigint }[]>`
      SELECT count(*) AS n, count(*) FILTER (WHERE reason IN ('unknown_account', 'stepup_unknown_account')) AS unknown, count(DISTINCT ip) AS ips
        FROM audit_events
       WHERE occurred_at >= ${since} AND action = 'auth.login' AND outcome = 'DENIED' AND coalesce(reason, '') <> 'stepup_link_sent'`,
  ]);
  const num = (v: bigint) => Number(v);
  const what: Record<string, string> = {
    many_accounts_from_ip: 'one IP address tried many accounts (credential stuffing); it is refused for an hour',
    many_accounts_from_network: 'one network tried many accounts (credential stuffing); its sign-in limit is lowered',
    many_networks_on_account: 'many networks tried the same account (distributed guessing)',
    many_failed_attempts: 'the account had many failed sign-ins; new devices must confirm by email',
  };
  const spikeRows = spike && (num(spike.n) >= AUTH_ABUSE_THRESHOLDS.failuresTotal || num(spike.unknown) >= AUTH_ABUSE_THRESHOLDS.unknownTotal) ? [spike] : [];
  return [
    ...detected.map((r) => ({
      severity: 'high', kind: 'auth_abuse_detected', at: r.occurred_at,
      message: `${r.actor_email ?? String(r.details?.ip ?? r.details?.network ?? 'unknown')}: ${what[r.reason ?? ''] ?? r.reason ?? r.action}`,
    })),
    ...perIp.map((r) => ({ severity: 'high', kind: 'stuffing_from_ip', at: r.last, message: `${r.ip} failed to sign in to ${num(r.accounts)} different accounts (${num(r.n)} attempts)` })),
    ...perAccount.map((r) => ({ severity: 'medium', kind: 'failed_sign_in_burst', at: r.last, message: `${r.actor_email ?? 'unknown'} had ${num(r.n)} failed sign-ins from ${num(r.ips)} addresses` })),
    ...spikeRows.map((r) => ({ severity: 'medium', kind: 'sign_in_failure_spike', message: `${num(r.n)} failed sign-ins (${num(r.unknown)} for emails with no account) from ${num(r.ips)} addresses` })),
  ];
}
