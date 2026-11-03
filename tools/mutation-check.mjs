#!/usr/bin/env node
// Mutation check for the authorisation code.
//
// The judges will "take one authorisation check out of your code and run
// your tests". This script does exactly that, for every check we can name:
// it removes or disables one rule, runs the relevant tests, and expects them
// to FAIL. A mutation that leaves the tests green is a check nothing tests.
//
//   node tools/mutation-check.mjs            (from the repo root; needs the test DB)
//   node tools/mutation-check.mjs --only 7   (one mutation)
//
// Source files are always restored, even on Ctrl-C. Database mutations are
// applied to the TEST database only and reverted afterwards.
// The report is written to docs/MUTATION_REPORT.md.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const API = join(ROOT, 'apps/api');

const code = (name, file, find, replace, tests) => ({ kind: 'code', name, file, find, replace, tests });
const sql = (name, apply, revert, tests) => ({ kind: 'sql', name, apply, revert, tests });

const ACCESS = 'src/documents/access.ts';
const GUARD = 'src/auth/security.guard.ts';
const SESSION = 'src/auth/session.service.ts';

const MUTATIONS = [
  // --- decide(): the TypeScript authorisation decision ---------------------
  code('decide: action needs a level (remove the level comparison)', ACCESS,
    "if (level < needed) return { allowed: false, level, reason: `needs_${Level[needed].toLowerCase()}` };", '',
    ['test/access.unit.test.ts', 'test/documents.test.ts']),
  code('decide: expired grants are ignored', ACCESS,
    'if (g.expiresAt && new Date(g.expiresAt) <= now) continue;', '', ['test/access.unit.test.ts']),
  code('decide: externals get nothing through groups', ACCESS,
    "if (g.viaGroup && user.role === 'EXTERNAL') continue;", '', ['test/access.unit.test.ts']),
  code('decide: externals capped at READ', ACCESS,
    "if (user.role === 'EXTERNAL') level = Math.min(level, Level.READ);", '', ['test/access.unit.test.ts']),
  code('decide: deleted documents hidden from non-owners', ACCESS,
    "if (doc.status !== 'ACTIVE') return { level: Level.NONE, reason: 'document_deleted' };", '', ['test/access.unit.test.ts']),
  code('decide: inactive users get nothing', ACCESS,
    "if (user.status !== 'ACTIVE') return { level: Level.NONE, reason: 'user_inactive' };", '', ['test/access.unit.test.ts']),
  code('require(): refuse when decide() says no', ACCESS,
    'if (!decision.allowed) {', 'if (false) {', ['test/documents.test.ts']),
  code('download: the authorisation line itself', 'src/documents/documents.service.ts',
    "const decision = await this.access.require(tx, actor, id, 'download');", "const decision = { reason: 'grant' };",
    ['test/documents.test.ts']),
  code('sharing: only the owner grants MANAGE', 'src/documents/sharing.service.ts',
    "if (input.level === 'MANAGE' && decision.level < Level.OWNER) throw new ForbiddenException('Only the owner can give MANAGE access');", '',
    ['test/documents.test.ts']),
  code('search: application-side access filter', 'src/documents/documents.service.ts',
    "and.push({ status: 'ACTIVE' }, accessFilter(actor, now));", "and.push({ status: 'ACTIVE' });",
    ['test/search-filter.test.ts']),

  // --- request guard ----------------------------------------------------------
  code('guard: Origin check on state-changing requests', GUARD,
    'if (origin !== undefined && origin !== this.env.PUBLIC_ORIGIN) {', 'if (false) {', ['test/auth.test.ts']),
  code('guard: CSRF token check', GUARD,
    "if (mutating && !SessionService.csrfMatches(actor.csrfToken, req.get('x-csrf-token'))) {", 'if (false) {', ['test/auth.test.ts']),
  code('guard: second factor required', GUARD,
    "if (actor.mfaRequired && actor.authLevel !== 'mfa' && !partialOk) {", 'if (false) {', ['test/admin-mfa.test.ts']),
  code('guard: account role check', GUARD,
    'if (roles && !roles.includes(actor.role)) {', 'if (false) {', ['test/auth.test.ts']),

  // --- sessions and sign-in ---------------------------------------------------
  code('session: deactivated users are signed out', SESSION,
    ": user.status !== 'ACTIVE' ? 'user_inactive'", ": false ? 'user_inactive'", ['test/auth.test.ts']),
  code('session: password change invalidates older sessions', SESSION,
    ": session.createdAt.getTime() < user.passwordChangedAt.getTime() ? 'password_changed'", ": false ? 'password_changed'", ['test/auth.test.ts']),
  code('mfa: a TOTP code works only once', 'src/auth/mfa.service.ts',
    'AND (totp_last_step IS NULL OR totp_last_step < ${step})', '', ['test/admin-mfa.test.ts']),
  code('uploads: PDFs with JavaScript refused', 'src/documents/content-check.ts',
    'if (/\\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\\b/.test(text)) {', 'if (false) {', ['test/documents.test.ts']),
  code('users: protected demo accounts cannot be changed', 'src/users/users.service.ts',
    "if (u.isProtected) throw new ForbiddenException('This is a protected demo account and cannot be changed');", '',
    ['test/admin-mfa.test.ts']),
  code('mfa: a passkey assertion must verify', 'src/auth/mfa.service.ts',
    'if (!passkey || !verification?.verified) {', 'if (!passkey) {', ['test/passkeys.test.ts']),

  // --- malware scanning -------------------------------------------------------
  code('uploads: infected files refused', 'src/documents/documents.service.ts',
    'if (!result.clean) {', 'if (false) {', ['test/documents.test.ts']),
  code('uploads: no answer from the scanner means no upload', 'src/scanning/malware-scanner.ts',
    "throw new ScannerUnavailable(`unexpected scanner reply: ${reply.slice(0, 120) || '(empty)'}`);", 'return { clean: true };',
    ['test/scanner.unit.test.ts', 'test/documents.test.ts']),

  // --- outside witness for the audit chain ------------------------------------
  code('witness: a witnessed checkpoint may not change', '../../tools/witness.mjs',
    'else if (s.headHash !== w.headHash || s.signature !== w.signature) problems.push(', 'else if (false) problems.push(',
    ['test/witness.test.ts']),
  code('witness: the chain at the last witnessed seq must be unchanged', '../../tools/witness.mjs',
    'if (last && server.eventHashAtLast !== last.headHash) {', 'if (false) {', ['test/witness.test.ts']),
  code('verify-audit: bundles must agree with the witness', '../../tools/verify-audit.mjs',
    'if (chainHash !== w.headHash) problems.push(', 'if (false) problems.push(', ['test/witness.test.ts']),
  code('anchor: a log receipt must be for this exact checkpoint', '../../tools/rekor.mjs',
    'if (parsed.digest !== checkpointDigest(c) || parsed.signature !== c.signature)', 'if (false)', ['test/anchor.test.ts']),
  code('anchor: log receipts must be signed by the pinned log key', '../../tools/rekor.mjs',
    'if (!e || !verifySet(e, rekorKeyPem)) return null;', 'if (!e) return null;', ['test/anchor.test.ts']),
  code('witness: every public log entry must match a server checkpoint', '../../tools/witness.mjs',
    '    if (!c) problems.push(', '    if (!c) continue;\n    if (false) problems.push(',['test/anchor.test.ts']),
  code('witness: a checkpoint unpublished for an hour raises the alarm', '../../tools/witness.mjs',
    'if (!byDigest.has(checkpointDigest(c)) && now - new Date(c.createdAt) > ANCHOR_DEADLINE_MS) {', 'if (false) {', ['test/anchor.test.ts']),
  code('verify-audit: a full bundle must match every earlier public entry', '../../tools/verify-audit.mjs',
    '    if (fromGenesis && !partial) {\n      if (asEvent) problems.push(', '    if (false) {\n      if (asEvent) problems.push(', ['test/anchor.test.ts']),
  code('downloads: a quarantined version is never sent', 'src/documents/documents.service.ts',
    'if (version.quarantine) {', 'if (false) {', ['test/rescan.test.ts']),
  code('rescan: a file found infected is quarantined', 'src/scanning/rescan.service.ts',
    'if (scan.clean) return;', 'return;', ['test/rescan.test.ts']),

  // --- the database's own locks ---------------------------------------------
  sql('database: row-level security on documents',
    'ALTER TABLE documents DISABLE ROW LEVEL SECURITY', 'ALTER TABLE documents ENABLE ROW LEVEL SECURITY', ['test/rls.test.ts']),
  sql('database: grant rules trigger (no MANAGE from managers, external limits)',
    'ALTER TABLE grants DISABLE TRIGGER grants_guard', 'ALTER TABLE grants ENABLE TRIGGER grants_guard', ['test/rls.test.ts']),
  sql('database: audit log append-only trigger',
    'ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete', 'ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete',
    ['test/audit-db.test.ts']),
  // --- holes found and fixed on 2026-11-02 (THREATS.md A17, R7, A15, L10) ----
  code('decide: admins get nothing from grants, groups or ownership', ACCESS,
    "if (user.role === 'ADMIN') {", 'if (false) {', ['test/access.unit.test.ts']),
  code('sharing: administrators cannot be given document access', 'src/documents/sharing.service.ts',
    "if (target.role === 'ADMIN') throw new BadRequestException('Administrators cannot be given access to documents');", '',
    ['test/revocation-holes.test.ts']),
  code('sharing: a manager cannot share with a group they belong to', 'src/documents/sharing.service.ts',
    'if (decision.level < Level.OWNER && await tx.groupMember.findUnique(', 'if (false && await tx.groupMember.findUnique(',
    ['test/revocation-holes.test.ts']),
  code('revoke: report access the person still has through a group', 'src/documents/sharing.service.ts',
    'const stillHas = grant.userId ? await remainingLevel(tx, documentId, grant.userId) : null;', 'const stillHas = null;',
    ['test/revocation-holes.test.ts']),
  code('transfer: report access the former owner still has', 'src/documents/documents.service.ts',
    'const stillHas = await remainingLevel(tx, id, actor.userId);', 'const stillHas = null;',
    ['test/revocation-holes.test.ts']),
  code('groups: administrators cannot join a group', 'src/users/groups.controller.ts',
    "if (user.role === 'ADMIN') throw new BadRequestException('Administrators cannot join groups: they never get document access');", '',
    ['test/revocation-holes.test.ts']),
  code('users: role changes keep ownership and admin rules (drop grants, refuse owners)', 'src/users/users.service.ts',
    'const promotion = roleChanged\n', 'const promotion = false\n',
    ['test/revocation-holes.test.ts']),
  code('session: a refused ended session is audited', SESSION,
    'if (marked.count > 0) {', 'if (false) {', ['test/revocation-holes.test.ts']),
  code('session: ended sessions are refused (revoked mark checked)', SESSION,
    "session.revokedAt !== null ? (session.revokedReason ?? 'revoked')", "false ? 'revoked'",
    ['test/auth.test.ts', 'test/revocation-holes.test.ts']),
  code('search: a group grant counts only for members the sharer confirmed', 'src/documents/documents.service.ts',
    '{ AND: [{ group: { members: { some: { userId: me } } } }, { coveredMembers: { some: { userId: me } } }] }', '{ group: { members: { some: { userId: me } } } }',
    ['test/revocation-holes.test.ts', 'test/search-filter.test.ts']),
  code('search: admins see no documents', 'src/documents/documents.service.ts',
    "if (actor.role === 'ADMIN') return { id: { in: [] } };", '',
    ['test/search-filter.test.ts', 'test/revocation-holes.test.ts']),
  code('users: a changed access end date ends sessions', 'src/users/users.service.ts',
    'const ended = roleChanged || expiryChanged', 'const ended = roleChanged',
    ['test/revocation-holes.test.ts']),
  sql('database: break-glass start time and one-hour limit set by the database',
    'ALTER TABLE break_glass DISABLE TRIGGER break_glass_now', 'ALTER TABLE break_glass ENABLE TRIGGER break_glass_now',
    ['test/revocation-holes.test.ts']),
  sql('database: audit checkpoints must match a real event and move forward',
    'ALTER TABLE audit_checkpoints DISABLE TRIGGER audit_checkpoints_guard_insert', 'ALTER TABLE audit_checkpoints ENABLE TRIGGER audit_checkpoints_guard_insert',
    ['test/checkpoint-guard.test.ts']),
  sql('database: group membership rules trigger (no externals, no admins)',
    'ALTER TABLE group_members DISABLE TRIGGER group_members_guard', 'ALTER TABLE group_members ENABLE TRIGGER group_members_guard',
    ['test/rls.test.ts']),

  // --- invitations (THREATS.md S18) ------------------------------------------
  code('invite: an invitation link works once', 'src/auth/invite.service.ts',
    "if (row.used_at) return 'link_used';", '', ['test/invite.test.ts']),
  code('invite: only an account still waiting can accept', 'src/auth/invite.service.ts',
    "if (!u || u.status !== 'INVITED' || u.is_protected) return { refused: 'not_eligible', userId: row!.user_id };", '',
    ['test/invite.test.ts']),
  code('reset: an invitation link is not a reset link', 'src/auth/password-reset.service.ts',
    "if (row.purpose !== 'RESET') return { refused: 'wrong_link_type', userId: row.user_id };", '', ['test/invite.test.ts']),
  code('users: deactivating cancels outstanding links', 'src/users/users.service.ts',
    'const links = await tx.passwordResetToken.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: new Date() } });', 'const links = { count: 0 };',
    ['test/invite.test.ts']),
  code('users: reactivating a never-accepted invitation does not make it ACTIVE', 'src/users/users.service.ts',
    "const status = before.activatedAt ? 'ACTIVE' : 'INVITED';", "const status = 'ACTIVE';", ['test/invite.test.ts']),

  // --- access policies: approvals, time windows, networks (THREATS.md P1-P12) --
  code('policy: a share outside its time window or network gives nothing (app)', ACCESS,
    'if (why) { blocked ??= why; continue; }', '', ['test/access-policy.unit.test.ts', 'test/access-policy.test.ts']),
  code('policy: role rules apply on top of every share (app)', ACCESS,
    'if (role) {', 'if (false) {', ['test/access-policy.unit.test.ts', 'test/access-policy.test.ts']),
  code('policy: an exception lifts share conditions only until it ends (app)', ACCESS,
    'if (facts.overrideUntil && new Date(facts.overrideUntil) > now) return null;', 'if (facts.overrideUntil) return null;',
    ['test/access-policy.unit.test.ts']),
  code('policy: downloads need approval unless a usable share waives it (app)', ACCESS,
    'if (!g.downloadApproval) freeDownload = true;', 'freeDownload = true;', ['test/access-policy.unit.test.ts', 'test/access-policy.test.ts']),
  code('download: an approval is used before the bytes are read (app)', 'src/documents/documents.service.ts',
    'if (decision.approvalRequired) {', 'if (false) {', ['test/access-policy.test.ts']),
  code('approval: nobody decides their own request (app)', 'src/documents/download-approvals.service.ts',
    "if (req.requesterId === actor.userId) await refuse('self_approval', 'You cannot decide your own download request');", '',
    ['test/access-policy.test.ts']),
  code('sharing: only the owner changes conditions already on a share (app)', 'src/documents/sharing.service.ts',
    'if (hadConditions && policy && decision.level < Level.OWNER) throw', 'if (false) throw', ['test/access-policy.test.ts']),
  code('network: X-Forwarded-For believed only from configured proxies', 'src/bootstrap.ts',
    "app.set('trust proxy', env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean));", "app.set('trust proxy', true);",
    ['test/access-policy.test.ts']),
  sql('database: share conditions count in tv_doc_level (tv_grant_usable)',
    `ALTER FUNCTION tv_grant_usable(uuid, uuid, timestamptz) RENAME TO tv_grant_usable_off;
     CREATE FUNCTION tv_grant_usable(uuid, uuid, timestamptz) RETURNS boolean LANGUAGE sql AS 'SELECT true'`,
    `DROP FUNCTION tv_grant_usable(uuid, uuid, timestamptz);
     ALTER FUNCTION tv_grant_usable_off(uuid, uuid, timestamptz) RENAME TO tv_grant_usable`,
    ['test/access-policy-db.test.ts']),
  sql('database: blobs only to a transaction that used an approval (restrictive policy)',
    'DROP POLICY blobs_release ON document_blobs',
    'CREATE POLICY blobs_release ON document_blobs AS RESTRICTIVE FOR SELECT TO trustvault_app USING (tv_blob_release_ok(version_id))',
    ['test/access-policy-db.test.ts']),
  sql('database: nobody decides their own download request (CHECK)',
    'ALTER TABLE download_approvals DROP CONSTRAINT download_approvals_not_self',
    'ALTER TABLE download_approvals ADD CONSTRAINT download_approvals_not_self CHECK (decided_by_id IS NULL OR decided_by_id <> requester_id)',
    ['test/access-policy-db.test.ts']),
  sql('database: new download requests always start pending',
    'ALTER TABLE download_approvals DISABLE TRIGGER download_approvals_guard_insert', 'ALTER TABLE download_approvals ENABLE TRIGGER download_approvals_guard_insert',
    ['test/access-policy-db.test.ts']),
  sql('database: conditions on shares (time zone, approver, owner-only changes)',
    'ALTER TABLE grants DISABLE TRIGGER grants_access_policy_guard', 'ALTER TABLE grants ENABLE TRIGGER grants_access_policy_guard',
    ['test/access-policy-db.test.ts']),
  sql('database: exceptions only from the owner, at most 24 hours',
    'ALTER TABLE access_overrides DISABLE TRIGGER access_overrides_guard', 'ALTER TABLE access_overrides ENABLE TRIGGER access_overrides_guard',
    ['test/access-policy-db.test.ts']),
];

function loadEnv() {
  try { process.loadEnvFile(join(API, '.env')); } catch { /* CI */ }
}

async function runSql(statement) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
  await client.connect();
  try { await client.query(statement); } finally { await client.end(); }
}

function runTests(files) {
  const r = spawnSync('npx', ['vitest', 'run', ...files], { cwd: API, shell: process.platform === 'win32', encoding: 'utf8', env: process.env });
  // Strip colour codes first: vitest colours the "Tests N passed" line.
  const summary = (r.stdout + r.stderr).replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => /Tests\s+\d/.test(l))?.trim().replace(/\s*\|\s*/g, ', ').replace(/\s+/g, ' ') ?? '(no summary)';
  return { failed: r.status !== 0, summary };
}

const restore = new Map();
const restoreAll = () => { for (const [f, text] of restore) writeFileSync(f, text); restore.clear(); };
process.on('SIGINT', () => { restoreAll(); process.exit(130); });

async function main() {
  loadEnv();
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx > 0 ? Number(process.argv[onlyIdx + 1]) : null;

  if (process.argv.includes('--dry-run')) {
    let missing = 0;
    for (const [i, m] of MUTATIONS.entries()) {
      if (m.kind !== 'code') continue;
      const found = readFileSync(join(API, m.file), 'utf8').includes(m.find);
      if (!found) missing++;
      console.log(`#${i + 1} ${found ? 'ok     ' : 'MISSING'} ${m.name}`);
    }
    process.exit(missing ? 1 : 0);
  }

  console.log('baseline: running the full suite unmodified...');
  const baseline = runTests([]);
  if (baseline.failed) {
    console.error(`baseline is not green (${baseline.summary}); fix the tests first`);
    process.exit(2);
  }
  console.log(`baseline green: ${baseline.summary}\n`);

  const results = [];
  for (const [i, m] of MUTATIONS.entries()) {
    const n = i + 1;
    if (only && only !== n) continue;
    process.stdout.write(`#${String(n).padStart(2)} ${m.name} ... `);
    let applied = true;
    try {
      if (m.kind === 'code') {
        const file = join(API, m.file);
        const text = readFileSync(file, 'utf8');
        if (!text.includes(m.find)) applied = false;
        else {
          restore.set(file, text);
          writeFileSync(file, text.replace(m.find, m.replace));
        }
      } else {
        await runSql(m.apply);
      }
      const r = applied ? runTests(m.tests) : { failed: false, summary: 'mutation target not found in source' };
      const verdict = !applied ? 'NOT APPLIED' : r.failed ? 'CAUGHT' : 'SURVIVED';
      console.log(`${verdict} (${r.summary})`);
      results.push({ n, ...m, verdict, summary: r.summary });
    } finally {
      restoreAll();
      if (m.kind === 'sql') await runSql(m.revert);
    }
  }

  const caught = results.filter((r) => r.verdict === 'CAUGHT').length;
  const lines = [
    '# Mutation check report',
    '',
    `Generated by \`node tools/mutation-check.mjs\` on ${new Date().toISOString()}.`,
    '',
    'Each row removes or disables one authorisation rule, runs the tests that should notice, and expects them to fail.',
    '"CAUGHT" means at least one test failed with the rule gone. "SURVIVED" would mean nothing tests that rule.',
    '',
    `Baseline (no mutation): ${baseline.summary}`,
    '',
    `**${caught} of ${results.length} mutations caught.**`,
    '',
    '| # | Rule removed | Where | Tests run | Result |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.n} | ${r.name} | ${r.kind === 'code' ? `\`${r.file.replace('../../', '')}\`` : 'database'} | ${r.tests.map((t) => `\`${t.replace('test/', '')}\``).join(', ')} | **${r.verdict}** — ${r.summary} |`),
    '',
  ];
  writeFileSync(join(ROOT, 'docs/MUTATION_REPORT.md'), lines.join('\n'));
  console.log(`\n${caught}/${results.length} caught. Report: docs/MUTATION_REPORT.md`);
  process.exit(caught === results.length ? 0 : 1);
}

main().catch((err) => { restoreAll(); console.error(err); process.exit(2); });
