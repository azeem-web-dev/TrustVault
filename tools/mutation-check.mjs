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

  // --- downloads and revokes in one order (THREATS.md R11) -------------------
  code('order: every document request takes its locks before deciding', ACCESS,
    'await tx.$executeRaw`SELECT tv_lock_access(${actor.userId}::uuid, ${documentId}::uuid, ${!READ_ONLY.has(action)})`;', '',
    ['test/download-order.test.ts']),
  code('order: reads share the document lock (downloads run in parallel)', ACCESS,
    '${!READ_ONLY.has(action)})`;', '${true})`;', ['test/download-order.test.ts']),
  code('order: a session ended while the request waited is refused', ACCESS,
    "if (decision.allowed && !state!.session_live) decision", "if (false) decision", ['test/download-order.test.ts']),
  sql('database: an ALLOWED download row is refused once access has lapsed',
    'ALTER TABLE audit_events DISABLE TRIGGER audit_events_download_live', 'ALTER TABLE audit_events ENABLE TRIGGER audit_events_download_live',
    ['test/download-order.test.ts']),
  sql('database: grant writes take the document lock',
    'ALTER TABLE grants DISABLE TRIGGER grants_0_lock', 'ALTER TABLE grants ENABLE TRIGGER grants_0_lock', ['test/download-order.test.ts']),
  sql('database: membership and account writes take the person lock',
    'ALTER TABLE group_members DISABLE TRIGGER group_members_0_lock; ALTER TABLE users DISABLE TRIGGER users_0_lock',
    'ALTER TABLE group_members ENABLE TRIGGER group_members_0_lock; ALTER TABLE users ENABLE TRIGGER users_0_lock', ['test/download-order.test.ts']),

  // --- two administrators (THREATS.md S15, S19) -------------------------------
  code('approvals: an owner or admin second factor needs an approval', 'src/users/users.service.ts',
    'if (needsTwo && !approvalId) {', 'if (false) {', ['test/approvals.test.ts']),
  code('approvals: nobody answers their own request (API)', 'src/users/approvals.service.ts',
    'if (row.requested_by === actor.userId) return { updated: null, refused:', 'if (false) return { updated: null, refused:', ['test/approvals.test.ts']),
  code('approvals: an approval is used once (API)', 'src/users/approvals.service.ts',
    ": row.consumed_at ? 'already_used'", ": false ? 'already_used'", ['test/approvals.test.ts']),
  code('approvals: with one admin, asking is refused', 'src/users/approvals.service.ts',
    'if (others.length === 0) {', 'if (false) {', ['test/approvals.test.ts']),
  code('approvals: the owner is emailed when break-glass is approved', 'src/users/approvals.service.ts',
    'this.notify.breakGlassApproved(', 'void (', ['test/approvals.test.ts']),
  sql('database: approvals change one step at a time, by the right admin',
    'ALTER TABLE admin_approvals DISABLE TRIGGER admin_approvals_guard_update', 'ALTER TABLE admin_approvals ENABLE TRIGGER admin_approvals_guard_update',
    ['test/approvals.test.ts']),
  sql('database: break-glass needs an approval used in the same transaction',
    'ALTER TABLE break_glass DISABLE TRIGGER break_glass_needs_approval', 'ALTER TABLE break_glass ENABLE TRIGGER break_glass_needs_approval',
    ['test/approvals.test.ts']),

  // --- the database protects identities on its own (THREATS.md A23-A26) -------
  sql('database: account changes need an admin, the person or a link (users guard)',
    'ALTER TABLE users DISABLE TRIGGER users_guard_update', 'ALTER TABLE users ENABLE TRIGGER users_guard_update', ['test/identity-guards.test.ts']),
  sql('database: new accounts only from an admin, as invitations',
    'ALTER TABLE users DISABLE TRIGGER users_guard_insert', 'ALTER TABLE users ENABLE TRIGGER users_guard_insert', ['test/identity-guards.test.ts']),
  sql('database: passkeys added only by their owner, removed under the second-factor rules',
    'ALTER TABLE passkeys DISABLE TRIGGER passkeys_guard', 'ALTER TABLE passkeys ENABLE TRIGGER passkeys_guard', ['test/identity-guards.test.ts']),
  sql('database: groups and members changed only by an admin',
    'ALTER TABLE groups DISABLE TRIGGER groups_admin_only; ALTER TABLE group_members DISABLE TRIGGER group_members_admin_only',
    'ALTER TABLE groups ENABLE TRIGGER groups_admin_only; ALTER TABLE group_members ENABLE TRIGGER group_members_admin_only', ['test/identity-guards.test.ts']),
  sql('database: a used reset or invitation link stays used',
    'ALTER TABLE password_reset_tokens DISABLE TRIGGER password_reset_tokens_guard', 'ALTER TABLE password_reset_tokens ENABLE TRIGGER password_reset_tokens_guard',
    ['test/identity-guards.test.ts']),
  sql('database: the app role cannot read password hashes or TOTP secrets',
    'GRANT SELECT ON users TO trustvault_app',
    'REVOKE SELECT ON users FROM trustvault_app; GRANT SELECT ("id", "email", "display_name", "role", "status", "password_changed_at", "failed_login_count", "locked_until", "access_expires_at", "created_at", "updated_at", "created_by_id", "deactivated_at", "activated_at", "is_protected", "totp_enabled_at", "totp_last_step") ON users TO trustvault_app', ['test/identity-guards.test.ts']),
  // --- step-up, MFA policy, signed-in devices (THREATS.md S20, S21, S23) -----
  code('guard: risky actions need a recent second factor (step-up)', GUARD,
    'if (Date.now() - verifiedAt > this.env.STEP_UP_MINUTES * 60_000) {', 'if (false) {', ['test/step-up.test.ts']),
  code('users: deactivating someone is a step-up route', 'src/users/users.controller.ts',
    "@Post(':id/deactivate')\n  @HttpCode(200)\n  @StepUp()", "@Post(':id/deactivate')\n  @HttpCode(200)", ['test/step-up.test.ts']),
  code('mfa: a step-up code works only once', 'src/auth/mfa.service.ts',
    'AND (totp_last_step IS NULL OR totp_last_step < ${step})', '', ['test/step-up.test.ts']),
  code('session: the MFA policy applies to live sessions', SESSION,
    'mfaRequired: MfaPolicyService.isRequired(user.role, mfaEnrolled, requiredRoles),', "mfaRequired: MfaPolicyService.isRequired(user.role, mfaEnrolled, ['ADMIN']),",
    ['test/mfa-policy.test.ts']),
  code('policy: ADMIN can never be taken out of the MFA policy', 'src/auth/mfa-policy.service.ts',
    "if (!roles.includes('ADMIN')) throw new BadRequestException('Administrators always need a second factor');", '', ['test/mfa-policy.test.ts']),
  code('mfa: a role the policy covers keeps its last factor', 'src/auth/mfa.service.ts',
    'if (MfaPolicyService.isRequired(actor.role, false, await this.policy.requiredRoles(tx))) {', "if (actor.role === 'ADMIN') {", ['test/mfa-policy.test.ts']),
  code('devices: you can only sign out your own sessions', 'src/auth/sessions.controller.ts',
    'where: { id, userId: actor.userId, revokedAt: null }', 'where: { id, revokedAt: null }', ['test/devices.test.ts']),
  sql('database: ADMIN always in the MFA policy (check constraint)',
    'ALTER TABLE app_settings DROP CONSTRAINT app_settings_admin_needs_mfa',
    "ALTER TABLE app_settings ADD CONSTRAINT app_settings_admin_needs_mfa CHECK ('ADMIN' = ANY (mfa_required_roles))", ['test/mfa-policy.test.ts']),
  sql('database: instance settings changed only in an admin transaction',
    'ALTER TABLE app_settings DISABLE TRIGGER app_settings_admin_only', 'ALTER TABLE app_settings ENABLE TRIGGER app_settings_admin_only', ['test/mfa-policy.test.ts']),
  // --- view-only and leak tracing (THREATS.md V1-V9) ------------------------
  code('decide: downloading the original needs READ, not VIEW', ACCESS,
    'download: Level.READ,      // the original bytes: never VIEW (THREATS.md V1)', 'download: Level.VIEW,',
    ['test/access.unit.test.ts', 'test/view-only.test.ts']),
  code('decide: the Android key needs READ, not VIEW', ACCESS,
    'offline_key: Level.READ,   // key for', 'offline_key: Level.VIEW, // key for',
    ['test/access.unit.test.ts', 'test/view-only.test.ts']),
  code('decide: break-glass gives VIEW, never READ', ACCESS,
    "return { level: Level.VIEW, reason: 'break_glass' };", "return { level: Level.READ, reason: 'break_glass' };",
    ['test/access.unit.test.ts', 'test/view-only.test.ts']),
  code('pages: the access check before a file is decrypted for drawing', 'src/documents/viewing.service.ts',
    "await this.access.require(tx, actor, id, 'view_pages');\n      return this.loadSource(tx, id);", 'return this.loadSource(tx, id);',
    ['test/documents.test.ts']),
  code('pages: the trace code is in the page view audit row', 'src/documents/viewing.service.ts',
    'details: { page: n, pages: total, versionNo: src.versionNo, trace, at: at.toISOString() },', 'details: { page: n, pages: total, versionNo: src.versionNo, at: at.toISOString() },',
    ['test/view-only.test.ts']),
  code('downloads: the copy is stamped with who, when and the trace code', 'src/documents/documents.service.ts',
    'stamped = await stampDownload(plaintext, found.mimeType, { email: actor.email, at, trace });', 'stamped = null;',
    ['test/view-only.test.ts']),
  code('alerts: many pages in ten minutes', 'src/audit/audit-admin.service.ts',
    'AND (w.pages > ${this.env.PAGE_VIEW_ALERT_PAGES} OR w.documents > ${this.env.PAGE_VIEW_ALERT_DOCUMENTS})', 'AND false',
    ['test/view-only.test.ts']),
  sql('database: a VIEW grantee cannot read the original bytes (blob rows need READ)',
    `DROP POLICY blobs_select ON document_blobs; CREATE POLICY blobs_select ON document_blobs FOR SELECT TO trustvault_app USING (EXISTS (SELECT 1 FROM document_versions v WHERE v.id = version_id AND tv_doc_level(v.document_id, tv_current_user()) >= 1))`,
    `DROP POLICY blobs_select ON document_blobs; CREATE POLICY blobs_select ON document_blobs FOR SELECT TO trustvault_app USING (EXISTS (SELECT 1 FROM document_versions v WHERE v.id = version_id AND tv_doc_level(v.document_id, tv_current_user()) >= 2))`,
    ['test/rls.test.ts', 'test/view-only.test.ts']),
  sql('database: Android keys are destroyed when access drops below READ',
    'ALTER TABLE grants DISABLE TRIGGER offline_keys_forget', 'ALTER TABLE grants ENABLE TRIGGER offline_keys_forget',
    ['test/rls.test.ts', 'test/view-only.test.ts']),
  sql('database: an ALLOWED download row needs READ live, not just VIEW',
    `CREATE OR REPLACE FUNCTION audit_download_still_allowed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ BEGIN IF tv_doc_level(NEW.document_id, NEW.actor_id) < 1 THEN RAISE EXCEPTION 'download refused: access ended during the request' USING ERRCODE = 'insufficient_privilege'; END IF; RETURN NEW; END $$`,
    `CREATE OR REPLACE FUNCTION audit_download_still_allowed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ DECLARE needed int := CASE NEW.action WHEN 'document.page_view' THEN 1 ELSE 2 END; BEGIN IF tv_doc_level(NEW.document_id, NEW.actor_id) < needed THEN RAISE EXCEPTION 'download refused: access ended during the request' USING ERRCODE = 'insufficient_privilege'; END IF; RETURN NEW; END $$`,
    ['test/download-order.test.ts']),
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
