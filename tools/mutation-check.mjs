#!/usr/bin/env node
// Mutation check for the authorisation code.
//
// The judges will "take one authorisation check out of your code and run
// your tests". This script does exactly that, for every check we can name:
// it removes or disables one rule, runs the relevant tests, and expects them
// to FAIL. A mutation that leaves the tests green is a check nothing tests.
//
//   node tools/mutation-check.mjs            (from the repo root; needs the test DB)
//   node tools/mutation-check.mjs --only 7   (one mutation; --only 56-69 for a range)
//   node tools/mutation-check.mjs --shard 3/8 (every 8th row from row 3; CI runs 8 in parallel)
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
const CONTENT = 'src/documents/content-check.ts';
const PDFI = 'src/documents/pdf-inspect.ts';
const ZIPI = 'src/documents/zip-inspect.ts';
const WEB_PROXY = '../web/src/proxy.ts';

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
  code('uploads: raw /JavaScript pass of the strict PDF check (what a sanitized PDF must pass)', 'src/documents/content-check.ts',
    'if (ACTIVE_RAW.test(text)) {', 'if (false) {', ['test/content-check.unit.test.ts', 'test/pdf-sanitize.unit.test.ts']),
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
  // documents_update RLS is USING tv_doc_level >= 3 with CHECK true, so the
  // owner-only columns (owner_id, status, folder_id) are guarded by this
  // trigger, not by the RLS CHECK. Without it an EDIT holder could seize
  // ownership or untrash a document by direct SQL (THREATS.md A1/A20).
  sql('database: only the owner changes owner, status or folder (documents guard)',
    'ALTER TABLE documents DISABLE TRIGGER documents_guard_update', 'ALTER TABLE documents ENABLE TRIGGER documents_guard_update',
    ['test/hunt/probe.test.ts']),
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
    'REVOKE SELECT ON users FROM trustvault_app; GRANT SELECT ("id", "email", "display_name", "role", "status", "password_changed_at", "failed_login_count", "locked_until", "access_expires_at", "created_at", "updated_at", "created_by_id", "deactivated_at", "activated_at", "is_protected", "totp_enabled_at", "totp_last_step", "email_otp_enabled_at") ON users TO trustvault_app', ['test/identity-guards.test.ts']),
  // --- step-up, MFA policy, signed-in devices (THREATS.md S20, S21, S23) -----
  code('guard: risky actions need a recent second factor (step-up)', GUARD,
    'if (Date.now() - verifiedAt > this.env.STEP_UP_MINUTES * 60_000) {', 'if (false) {', ['test/step-up.test.ts']),
  code('users: deactivating someone is a step-up route', 'src/users/users.controller.ts',
    "@Post(':id/deactivate')\n  @HttpCode(200)\n  @StepUp()", "@Post(':id/deactivate')\n  @HttpCode(200)", ['test/step-up.test.ts']),
  code('users: changing an access window is a step-up route', 'src/users/users.controller.ts',
    "'role' in req.body || 'accessExpiresAt' in req.body", "'role' in req.body", ['test/step-up.test.ts']),
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
    "const decision = await this.access.require(tx, actor, id, 'view_pages');\n      const row = await this.loadSource(tx, id);", "const decision = { reason: 'grant' };\n      const row = await this.loadSource(tx, id);",
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
    `DROP POLICY blobs_select ON document_blobs; CREATE POLICY blobs_select ON document_blobs FOR SELECT TO trustvault_app USING (EXISTS (SELECT 1 FROM document_versions v WHERE v.id = version_id AND (tv_doc_level(v.document_id, tv_current_user()) >= 2 OR (tv_doc_level(v.document_id, tv_current_user()) >= 1 AND tv_download_approval_in_tx(version_id, tv_current_user())))))`,
    ['test/rls.test.ts', 'test/view-only.test.ts']),
  sql('database: Android keys are destroyed when access drops below READ',
    'ALTER TABLE grants DISABLE TRIGGER offline_keys_forget', 'ALTER TABLE grants ENABLE TRIGGER offline_keys_forget',
    ['test/rls.test.ts', 'test/view-only.test.ts']),
  sql('database: an ALLOWED download row needs READ live, not just VIEW',
    `CREATE OR REPLACE FUNCTION audit_download_still_allowed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ BEGIN IF tv_doc_level(NEW.document_id, NEW.actor_id) < 1 THEN RAISE EXCEPTION 'download refused: access ended during the request' USING ERRCODE = 'insufficient_privilege'; END IF; RETURN NEW; END $$`,
    `CREATE OR REPLACE FUNCTION audit_download_still_allowed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ DECLARE needed int := CASE NEW.action WHEN 'document.page_view' THEN 1 ELSE 2 END; BEGIN IF tv_doc_level(NEW.document_id, NEW.actor_id) < needed THEN IF NEW.action = 'document.download' AND NEW.actor_id IS NOT NULL AND tv_doc_level(NEW.document_id, NEW.actor_id) >= 1 AND tv_download_approval_in_tx((SELECT v.id FROM document_versions v WHERE v.document_id = NEW.document_id AND v.version_no = (NEW.details ->> 'versionNo')::int), NEW.actor_id) THEN RETURN NEW; END IF; RAISE EXCEPTION 'download refused: access ended during the request' USING ERRCODE = 'insufficient_privilege'; END IF; RETURN NEW; END $$`,
    ['test/download-order.test.ts']),
  // --- access policies: approvals, time windows, networks (THREATS.md P1-P12) --
  code('policy: a share outside its time window or network gives nothing (app)', ACCESS,
    'if (why) { blocked ??= why; continue; }', '', ['test/access-policy.unit.test.ts', 'test/access-policy.test.ts']),
  code('policy: role rules apply on top of every share (app)', ACCESS,
    'if (role) {', 'if (false) {', ['test/access-policy.unit.test.ts', 'test/access-policy.test.ts']),
  code('policy: an exception lifts share conditions only until it ends (app)', ACCESS,
    'if (facts.overrideUntil && new Date(facts.overrideUntil) > now) return null;', 'if (facts.overrideUntil) return null;',
    ['test/access-policy.unit.test.ts']),
  code('policy: downloads need approval unless a usable share waives it (app)', ACCESS,
    'if (!g.downloadApproval && GRANT_LEVEL[g.level] >= Level.READ) freeDownload = true;', 'freeDownload = true;', ['test/access-policy.unit.test.ts', 'test/access-policy.test.ts']),
  code('download: an approval is used before the bytes are read (app)', 'src/documents/documents.service.ts',
    'if (decision.approvalRequired && version.uploadedById !== actor.userId) {', 'if (false) {', ['test/access-policy.test.ts']),
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

  // --- a VIEW holder downloads one file by owner approval (THREATS.md V1) -----
  // download allowed for a VIEW holder ONLY with a usable approval — caught in
  // the app (decide()) and in the database (consume floor, ticket mint and the
  // ALLOWED-download backstop).
  code('view-download: a VIEW holder with a usable approval may download (app)', ACCESS,
    "&& facts.user?.role !== 'ADMIN' && facts.download?.usableAny) {",
    "&& facts.user?.role !== 'ADMIN' && false && facts.download?.usableAny) {",
    ['test/view-download.test.ts']),
  code('view-download: a VIEW holder may ask for download permission (app)', 'src/documents/download-approvals.service.ts',
    'const needsApproval = decision.level === Level.VIEW\n        || (decision.level >= Level.READ && decision.approvalRequired === true);',
    'const needsApproval = (decision.level >= Level.READ && decision.approvalRequired === true);',
    ['test/view-download.test.ts']),
  sql('database: a VIEW holder spends an approval, with only a live grant (consume floor is VIEW)',
    `CREATE OR REPLACE FUNCTION tv_consume_download(p_request uuid, p_version uuid) RETURNS int
     LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $MUT$
     DECLARE me uuid := tv_current_user(); a download_approvals%ROWTYPE;
     BEGIN
       SELECT * INTO a FROM download_approvals WHERE id = p_request AND requester_id = me AND version_id = p_version FOR UPDATE;
       IF NOT FOUND OR a.status <> 'APPROVED' OR a.valid_until <= clock_timestamp() OR a.uses >= a.max_uses
          OR tv_doc_level(a.document_id, me) < 2 THEN RETURN NULL; END IF;
       UPDATE download_approvals SET uses = uses + 1,
              status = CASE WHEN uses + 1 >= max_uses THEN 'USED'::"DownloadApprovalStatus" ELSE status END,
              last_use_tx = txid_current() WHERE id = p_request;
       RETURN a.uses + 1;
     END $MUT$`,
    `CREATE OR REPLACE FUNCTION tv_consume_download(p_request uuid, p_version uuid) RETURNS int
     LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $MUT$
     DECLARE me uuid := tv_current_user(); a download_approvals%ROWTYPE;
     BEGIN
       SELECT * INTO a FROM download_approvals WHERE id = p_request AND requester_id = me AND version_id = p_version FOR UPDATE;
       IF NOT FOUND OR a.status <> 'APPROVED' OR a.valid_until <= clock_timestamp() OR a.uses >= a.max_uses
          OR tv_doc_level(a.document_id, me) < 1
          OR EXISTS (SELECT 1 FROM users u WHERE u.id = me AND u.role = 'ADMIN') THEN RETURN NULL; END IF;
       UPDATE download_approvals SET uses = uses + 1,
              status = CASE WHEN uses + 1 >= max_uses THEN 'USED'::"DownloadApprovalStatus" ELSE status END,
              last_use_tx = txid_current() WHERE id = p_request;
       RETURN a.uses + 1;
     END $MUT$`,
    ['test/view-download-db.test.ts']),
  sql('database: a below-READ download ticket and audit row need a consumed approval (in-tx check)',
    `CREATE OR REPLACE FUNCTION tv_download_approval_in_tx(p_version uuid, p_user uuid) RETURNS boolean
     LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS 'SELECT false'`,
    `CREATE OR REPLACE FUNCTION tv_download_approval_in_tx(p_version uuid, p_user uuid) RETURNS boolean
     LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $MUT$
       SELECT EXISTS (SELECT 1 FROM download_approvals a
         WHERE a.version_id = p_version AND a.requester_id = p_user
           AND a.status IN ('APPROVED', 'USED') AND a.valid_until > clock_timestamp()
           AND a.last_use_tx IS NOT NULL AND a.last_use_tx = txid_current_if_assigned()) $MUT$`,
    ['test/view-download.test.ts', 'test/view-download-db.test.ts']),
  sql('database: a VIEW holder may open a download request (insert policy floor is VIEW)',
    `DROP POLICY approvals_insert ON download_approvals;
     CREATE POLICY approvals_insert ON download_approvals FOR INSERT TO trustvault_app
       WITH CHECK (requester_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 2)`,
    `DROP POLICY approvals_insert ON download_approvals;
     CREATE POLICY approvals_insert ON download_approvals FOR INSERT TO trustvault_app
       WITH CHECK (requester_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 1
                   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = tv_current_user() AND u.role = 'ADMIN'))`,
    ['test/view-download-db.test.ts']),
  // --- keyd authorises decryption itself; key-use ledger (THREATS.md K1-K8) --
  code('keys: a document key needs a ticket', 'src/crypto/key-provider.ts',
    "if (ticket === undefined) this.refuse(bare, 'ticket required');", '', ['test/keyd-tickets.test.ts']),
  code('keys: the ticket MAC must verify', 'src/crypto/key-ledger.ts',
    "if (!timingSafeEqual(want, Buffer.from(mac, 'hex'))) throw new TicketError('bad ticket mac');", '', ['test/keyd-tickets.test.ts', 'test/key-ledger.unit.test.ts']),
  code('keys: a ticket opens only its own document version', 'src/crypto/key-ledger.ts',
    'if (!ownAad || sha256hex(aad) !== t.aadSha256) {', 'if (false) {', ['test/keyd-tickets.test.ts']),
  code('keys: a ticket opens only its own wrapped key', 'src/crypto/key-ledger.ts',
    "if (sha256hex(wrapped) !== t.wkSha256) throw new TicketError('ticket is for another wrapped key');", '', ['test/keyd-tickets.test.ts']),
  code('keys: an expired ticket is refused', 'src/crypto/key-ledger.ts',
    "if (nowSec >= t.exp) throw new TicketError('ticket expired');", '', ['test/keyd-tickets.test.ts']),
  code('keys: a ticket works once', 'src/crypto/key-provider.ts',
    "if (this.seen.has(t.tid)) this.refuse(entry, 'ticket already used');", '', ['test/keyd-tickets.test.ts']),
  code('keys: per-user unwrap rate limit', 'src/crypto/key-provider.ts',
    "if (!allowed) this.refuse(entry, 'rate limited');", "if (!allowed && false) this.refuse(entry, 'rate limited');", ['test/keyd-tickets.test.ts']),
  code('reconcile: key release without a matching audit event', 'src/keys/key-ledger.service.ts',
    'for (const r of noAudit) findings.push(', 'for (const r of noAudit.slice(0, 0)) findings.push(', ['test/keyd-tickets.test.ts']),
  code('reconcile: key release on a ticket the database never issued', 'src/keys/key-ledger.service.ts',
    'for (const r of noTicket) findings.push(', 'for (const r of noTicket.slice(0, 0)) findings.push(', ['test/keyd-tickets.test.ts']),
  code('reconcile: ALLOWED download without a ticket', 'src/keys/key-ledger.service.ts',
    'if (!r.has_ticket) findings.push(', 'if (false) findings.push(', ['test/keyd-tickets.test.ts']),
  code('reconcile: mirrored ledger entries are re-verified', 'src/keys/key-ledger.service.ts',
    'const bad = verifyLedgerRun(seq, hash, page);', 'const bad = null;', ['test/keyd-tickets.test.ts']),
  code('rotation: a row is replaced only if unchanged (compare-and-swap)', 'src/keys/rotation.ts',
    "'UPDATE document_blobs SET wrapped_key = $1, key_id = $2 WHERE version_id = $3 AND key_id = $4 AND wrapped_key = $5',",
    "'UPDATE document_blobs SET wrapped_key = $1, key_id = $2 WHERE version_id = $3 AND $4::text IS NOT NULL AND $5::bytea IS NOT NULL',",
    ['test/key-rotation.test.ts']),
  code('pages: decryption for drawing needs a database ticket', 'src/documents/viewing.service.ts',
    "const ticket = await issueUnwrapTicket(tx, row.version_id, 'view_page', event.id);", "const ticket = 'tv-unwrap-ticket-v1|made-up';",
    ['test/view-only.test.ts']),
  sql('database: the application role cannot read the ticket key',
    'GRANT SELECT ON keyd_ticket_keys TO trustvault_app', 'REVOKE SELECT ON keyd_ticket_keys FROM trustvault_app', ['test/keyd-tickets.test.ts']),
  sql('database: the ledger mirror only accepts rows that extend the chain',
    'ALTER TABLE keyd_ledger_entries DISABLE TRIGGER keyd_ledger_entries_extend', 'ALTER TABLE keyd_ledger_entries ENABLE TRIGGER keyd_ledger_entries_extend', ['test/keyd-tickets.test.ts']),
  // --- insider-extraction detection and enforcement (THREATS.md L15-L19, U9-U10, S25-S26) ---
  code('downloads: hard download limits are enforced before release', 'src/documents/documents.service.ts',
    'await this.limits.enforce(tx, actor, id, version.versionNo);', '', ['test/insider-detect.test.ts']),
  code('limits: the per-person daily limit', 'src/risk/download-limits.service.ts',
    "if (usedDay >= limits.daily) return { allowed: false, reason: 'download_limit_daily', usedDay, usedSession, limits };", '',
    ['test/insider-rules.unit.test.ts', 'test/insider-detect.test.ts']),
  code('limits: the per-session limit', 'src/risk/download-limits.service.ts',
    "if (usedSession >= limits.session) return { allowed: false, reason: 'download_limit_session', usedDay, usedSession, limits };", '',
    ['test/insider-rules.unit.test.ts', 'test/insider-detect.test.ts']),
  code('limits: check and count are atomic per person (no parallel slip-through)', 'src/risk/download-limits.service.ts',
    "await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('tv-download-quota:' || ${actor.userId}, 0))`;", '',
    ['test/insider-detect.test.ts']),
  code('limits: an expired or revoked override is ignored', 'src/risk/download-limits.service.ts',
    'WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > now()', 'WHERE user_id = ${userId}::uuid',
    ['test/insider-detect.test.ts']),
  code('limits: nobody raises their own limit', 'src/risk/download-limits.service.ts',
    "if (input.userId === actor.userId) throw new BadRequestException('You cannot raise your own download limit');", '',
    ['test/insider-detect.test.ts']),
  code('rules: the day window catches slow extraction', 'src/risk/rules.ts',
    'if (r.day >= s.day_alert) {', 'if (false) {', ['test/insider-rules.unit.test.ts', 'test/insider-detect.test.ts']),
  code('rules: the week window catches slow extraction', 'src/risk/rules.ts',
    'if (r.week >= s.week_alert) {', 'if (false) {', ['test/insider-rules.unit.test.ts', 'test/insider-detect.test.ts']),
  code('settings: thresholds are bounded', 'src/risk/risk-settings.service.ts',
    'if (v < spec.min || v > spec.max) throw new BadRequestException(`${k} must be between ${spec.min} and ${spec.max}`);', '',
    ['test/insider-rules.unit.test.ts', 'test/insider-detect.test.ts']),
  code('alerts: nobody resolves an alert about themselves', 'src/risk/alert-store.service.ts',
    "if (cur.subject_user_id === actor.userId && (action === 'resolve' || action === 'assign')) {", 'if (false) {',
    ['test/insider-detect.test.ts']),
  code('alerts: severity-first ordering', 'src/risk/alert-store.service.ts',
    "const order = f.sort === 'severity' ? Prisma.sql`a.severity_rank DESC, a.created_at DESC, a.id DESC` : Prisma.sql`a.created_at DESC, a.id DESC`;",
    'const order = Prisma.sql`a.created_at DESC, a.id DESC`;', ['test/insider-detect.test.ts']),
  code('alerts: flood of alerts about one account is itself alerted', 'src/risk/alert-generator.service.ts',
    'GROUP BY subject_user_id HAVING count(*) >= ${s.flood_per_subject}`;', 'GROUP BY subject_user_id HAVING false`;',
    ['test/insider-detect.test.ts']),
  code('alerts: the watermark moves only with a successful run', 'src/risk/alert-generator.service.ts',
    "await tx.$executeRaw`UPDATE alert_generator_state SET last_seq = ${last}, last_run_at = now(), last_ok_at = now(), last_error = NULL WHERE id = 1`;",
    "await this.prisma.$executeRaw`UPDATE alert_generator_state SET last_seq = ${last}, last_run_at = now(), last_ok_at = now(), last_error = NULL WHERE id = 1`;",
    ['test/insider-detect.test.ts']),
  sql('database: alerts are append-only',
    'ALTER TABLE security_alerts DISABLE TRIGGER security_alerts_no_update_delete', 'ALTER TABLE security_alerts ENABLE TRIGGER security_alerts_no_update_delete',
    ['test/insider-detect.test.ts']),
  sql('database: alert status changes only through its history',
    'ALTER TABLE security_alert_status DISABLE TRIGGER security_alert_status_guard', 'ALTER TABLE security_alert_status ENABLE TRIGGER security_alert_status_guard',
    ['test/insider-detect.test.ts']),
  sql('database: alert review steps checked by the database',
    'ALTER TABLE security_alert_events DISABLE TRIGGER security_alert_events_before_insert', 'ALTER TABLE security_alert_events ENABLE TRIGGER security_alert_events_before_insert',
    ['test/insider-detect.test.ts']),
  sql('database: override length and revoke-only changes',
    'ALTER TABLE download_limit_overrides DISABLE TRIGGER download_limit_overrides_guard', 'ALTER TABLE download_limit_overrides ENABLE TRIGGER download_limit_overrides_guard',
    ['test/insider-detect.test.ts']),
  // --- integration: rules added when the branches were merged ---------------
  sql('database: detection thresholds and limit exceptions only in an admin transaction',
    'ALTER TABLE risk_settings DISABLE TRIGGER risk_settings_admin_only; ALTER TABLE download_limit_overrides DISABLE TRIGGER download_limit_overrides_admin_only',
    'ALTER TABLE risk_settings ENABLE TRIGGER risk_settings_admin_only; ALTER TABLE download_limit_overrides ENABLE TRIGGER download_limit_overrides_admin_only',
    ['test/insider-detect.test.ts']),
  code('insider: view-only page views feed the persistent alert queue', 'src/risk/alert-generator.service.ts',
    "WHERE f.kind = 'page_view' AND f.occurred_at > ${now}::timestamptz - interval '10 minutes'", "WHERE false AND f.occurred_at > ${now}::timestamptz - interval '10 minutes'",
    ['test/view-only.test.ts']),
  code('database: every connection runs in UTC (non-UTC server default)', 'src/db/prisma.service.ts',
    'max: 10, options: UTC_SESSION })', 'max: 10 })', ['test/timezone.test.ts']),
  // --- authentication abuse (THREATS.md S1, S2, S7, S9, S27) ----------------
  code('login: per-(account, client) backoff', 'src/auth/login-throttle.service.ts',
    'const locked = await this.redis.pairGate(pairKey, LIMITS.pair);', 'const locked = 0;', ['test/auth-abuse.test.ts']),
  code('login: per-IP limit', 'src/auth/login-throttle.service.ts',
    "if (ipHits.count > LIMITS.ip.max) return await this.refuse(email, 'rate_limited_ip', ipHits.retryAfterSeconds);", '', ['test/auth-abuse.test.ts']),
  code('login: an IP caught stuffing is refused', 'src/auth/login-throttle.service.ts',
    "if (blockTtl > 0) return await this.refuse(email, 'rate_limited_stuffing_ip', blockTtl);", '', ['test/auth-abuse.test.ts']),
  code('login: a flagged network gets the lower limit', 'src/auth/login-throttle.service.ts',
    'const netMax = netFlagged ? LIMITS.network.flaggedMax : LIMITS.network.max;', 'const netMax = LIMITS.network.max;', ['test/auth-abuse.test.ts']),
  code('login: under attack, the password alone from an untrusted device gives no session', 'src/auth/auth.service.ts',
    'if (gate.stepUp) {', 'if (false) {', ['test/auth-abuse.test.ts']),
  code('login: a trusted device budget runs out', 'src/auth/login-throttle.service.ts',
    'if (used.count <= LIMITS.device.max) return', 'if (true) return', ['test/auth-abuse.test.ts']),
  code('device trust: the cookie must be for this account', 'src/auth/device-trust.service.ts',
    'd.userId === user.id &&', '', ['test/auth-abuse.test.ts']),
  code('device trust: a password change ends it', 'src/auth/device-trust.service.ts',
    '&& d.issuedAt >= user.passwordChangedAt.getTime()', '', ['test/auth-abuse.test.ts']),
  code('device trust: the signature is checked', 'src/auth/device-trust.service.ts',
    'if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;', '', ['test/auth-abuse.test.ts']),
  code('device trust: only after the second factor (MFA sign-in)', 'src/auth/auth.controller.ts',
    '    if (!mfa.required) {\n      this.devices.setCookie(res, user.id);', '    {\n      this.devices.setCookie(res, user.id);', ['test/auth-abuse.test.ts']),
  code('sign-in link: works once', 'src/auth/signin-link.service.ts',
    "if (row.used_at) return { userId: row.user_id, refused: 'link_used' };", '', ['test/auth-abuse.test.ts']),
  code('sign-in link: a password change voids it', 'src/auth/signin-link.service.ts',
    "if (u.password_changed_at.getTime() > row.created_at.getTime()) return { userId: row.user_id, refused: 'password_changed' };", '', ['test/auth-abuse.test.ts']),
  code('sign-in link: only sign-in links', 'src/auth/signin-link.service.ts',
    "if (row.purpose !== 'SIGNIN') return { userId: row.user_id, refused: 'wrong_link_type' };", '', ['test/auth-abuse.test.ts']),
  code('mfa: per-account cap on second-factor tries', 'src/auth/mfa.service.ts',
    'await this.limits.hit(`mfa:${actor.userId}`, 10, 900, message);', '', ['test/auth-abuse.test.ts']),
  code('password change: limited tries at the current password', 'src/auth/auth.service.ts',
    "await this.limits.hit(`pwchange:${actor.userId}`, 5, 900, 'Too many attempts. Try again later.');", '', ['test/auth-abuse.test.ts']),
  code('reset: per-IP limit on using links', 'src/auth/password-reset.service.ts',
    "await this.limits.hit(`reset-use:ip:${currentContext()?.ip ?? 'unknown'}`, 20, 900, 'Too many attempts. Try again in a few minutes.');", '', ['test/auth-abuse.test.ts']),
  code('forgot: padded to the failure floor (timing)', 'src/auth/password-reset.service.ts',
    'for (let wait = until - performance.now(); wait > 0; wait = until - performance.now()) await sleep(Math.ceil(wait));', '', ['test/timing.test.ts']),
  code('login: failures padded to the floor (timing)', 'src/auth/auth.service.ts',
    'if (err instanceof UnauthorizedException) await pad();', '', ['test/timing.test.ts']),
  // --- upload content checks (THREATS.md C1-C8) ------------------------------
  code('uploads: PDF names written with #xx escapes are decoded and checked', CONTENT,
    'if (ACTIVE_RAW_ESCAPED.test(unescapePdfNames(text))) {', 'if (false) {', ['test/content-check.unit.test.ts']),
  code('uploads: strict PDF check parses the structure (active content inside compressed object streams)', CONTENT,
    'await inspectPdf(buf, text);', '', ['test/content-check.unit.test.ts', 'test/content-upload.test.ts']),
  code('uploads: nothing may follow %%EOF in a PDF (truncation, appended files)', CONTENT,
    "if (eof < 0 || buf.length - eof > 1024 || !/^[\\0\\t\\n\\f\\r ]*$/.test(text.slice(eof + 5))) {", 'if (false) {', ['test/content-check.unit.test.ts']),
  code('uploads: files that are also ZIPs (polyglots) refused', CONTENT,
    "if (kind !== 'zip' && looksLikeZip(buf))", 'if (false)', ['test/content-check.unit.test.ts']),
  code('uploads: files that are also PDFs (polyglots) refused', CONTENT,
    "if (kind !== 'pdf' && PDF_MAGIC_NEAR_START(buf))", 'if (false)', ['test/content-check.unit.test.ts']),
  code('uploads: PNG must end at IEND', CONTENT,
    '  if (p !== buf.length) bad();', '', ['test/content-check.unit.test.ts']),
  code('uploads: markup inside images refused', CONTENT,
    "if (MARKUP.test(buf.toString('latin1')))", 'if (false)', ['test/content-check.unit.test.ts']),
  code('pdf: actions refused by type (Launch, GoToR, SubmitForm...)', PDFI,
    "if (key === 'S' && BAD_ACTIONS.has(nameOf(v) ?? '')) refuse(nameOf(v)!, sink);", '', ['test/content-check.unit.test.ts']),
  code('pdf: JavaScript / XFA / embedded-file keys refused', PDFI,
    '    if (BAD_KEYS.has(key)) refuse(key, sink);', '', ['test/content-check.unit.test.ts']),
  code('pdf: FileAttachment / RichMedia annotations refused', PDFI,
    "if (key === 'Subtype' && BAD_SUBTYPES.has(nameOf(v) ?? '')) refuse(nameOf(v)!, sink);", '', ['test/content-check.unit.test.ts']),
  code('pdf: links only to web or mail addresses', PDFI,
    'if (uri !== undefined && !SAFE_URI.test(uri.trim()))', 'if (false)', ['test/content-check.unit.test.ts']),
  code('pdf: lower-case #xx escapes decoded', PDFI,
    'const decodeName = (n: PDFName): string => n.decodeText().replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));',
    'const decodeName = (n: PDFName): string => n.decodeText();', ['test/content-check.unit.test.ts']),
  code('pdf: objects hidden inside stream data refused', PDFI,
    'if (rawObjectHeaders(latin1) !== topLevel) {', 'if (false) {', ['test/content-check.unit.test.ts']),
  code('pdf: decompressed stream size capped (stream zip bomb)', PDFI,
    'if (requested > PDF_LIMITS.maxStreamBytes) overLimit(', 'if (false) overLimit(', ['test/content-check.unit.test.ts']),
  code('pdf: object count capped', PDFI,
    'if (collected.length > PDF_LIMITS.maxObjects) overLimit(', 'if (false) overLimit(', ['test/content-check.unit.test.ts']),
  code('pdf: encrypted PDFs refused', PDFI,
    'if (context.trailerInfo.Encrypt) throw', 'if (false) throw', ['test/content-check.unit.test.ts']),
  code('zip: local header must match the central directory', ZIPI,
    'if (!buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).equals(nameBytes)) bad(', 'if (false) bad(', ['test/content-check.unit.test.ts']),
  code('zip: duplicate entry names refused', ZIPI,
    "if (seen.has(key)) bad('duplicate entry name');", '', ['test/content-check.unit.test.ts']),
  code('zip: entries must tile the archive (no overlap, no gaps)', ZIPI,
    'if (e.localOffset !== cursor) bad(', 'if (false) bad(', ['test/content-check.unit.test.ts']),
  code('zip: nothing after the end of the archive', ZIPI,
    "if (eocd + 22 + commentLen !== buf.length) bad('data after the end of the archive');", '', ['test/content-check.unit.test.ts']),
  code('zip: entry count limit', ZIPI,
    "if (entries > ZIP_LIMITS.maxEntries) bad('too many entries');", '', ['test/content-check.unit.test.ts']),
  code('zip: compression ratio limit', ZIPI,
    'if (size > 1024 * 1024 && size / Math.max(compSize, 1) > ZIP_LIMITS.maxRatio) bad(', 'if (false) bad(', ['test/content-check.unit.test.ts']),
  code('zip: encrypted entries refused', ZIPI,
    "if (flags & 0x0041) bad('encrypted entry');", '', ['test/content-check.unit.test.ts']),
  code('office: external relationships (remote templates, linked files)', ZIPI,
    'if (!ALLOWED_EXTERNAL.test(type)) {', 'if (false) {', ['test/content-check.unit.test.ts']),
  code('office: external hyperlinks only to web or mail', ZIPI,
    "if (!SAFE_LINK.test((a.Target ?? '').trim())) {", 'if (false) {', ['test/content-check.unit.test.ts']),
  code('office: OLE objects in embeddings refused', ZIPI,
    'if (!EMBEDDED_OFFICE.test(e.name)) throw new ZipRejected(', 'continue; if (false) throw new ZipRejected(', ['test/content-check.unit.test.ts']),
  code('office: embedded Office files checked recursively', ZIPI,
    '    inspectOoxml(inner, depth + 1, budget);', '', ['test/content-check.unit.test.ts']),
  code('office: ActiveX refused', ZIPI,
    "if (names.some((n) => /(^|\\/)activeX\\//i.test(n))) throw", 'if (false) throw', ['test/content-check.unit.test.ts']),
  code('office: DDE fields refused', ZIPI,
    'if (/\\bDDE(AUTO)?\\b/i.test(compact) ||', 'if (false &&', ['test/content-check.unit.test.ts']),
  code('office: DDE formulas refused', ZIPI,
    "if (/[A-Za-z0-9_.$-]+\\s*\\|\\s*['\"]?[^!]*['\"]?\\s*!/.test(f))", 'if (false)', ['test/content-check.unit.test.ts']),
  code('office: external workbook links refused', ZIPI,
    "if (names.some((n) => /^xl\\/externalLinks\\//i.test(n))) throw", 'if (false) throw', ['test/content-check.unit.test.ts']),
  code('office: macro content types refused', ZIPI,
    "if (MACRO_TYPE.test(texts.get(ct!.name) ?? '')) throw", 'if (false) throw', ['test/content-check.unit.test.ts']),
  code('inspector: per-file deadline', 'src/documents/content-inspector.ts',
    '}, INSPECTOR_LIMITS.timeoutMs);', '}, 2 ** 31 - 1);', ['test/content-check.unit.test.ts']),
  code('inspector: worker heap limit', 'src/documents/content-inspector.ts',
    'resourceLimits: { maxOldGenerationSizeMb: INSPECTOR_LIMITS.heapMb,', 'resourceLimits: { maxOldGenerationSizeMb: 4096,', ['test/content-check.unit.test.ts']),
  code('downloads: the formulas-disabled CSV copy neutralises cells', 'src/documents/documents.controller.ts',
    'const safe = neutralizeCsv(stored.data);', 'const safe = { data: stored.data, changed: 0 };', ['test/content-upload.test.ts']),
  code('csv: cells starting = + - @ tab CR are dangerous', 'src/common/csv.ts',
    'export const isDangerousCell = (v: string): boolean => TRIGGER.test(v) && !NUMBER.test(v);', 'export const isDangerousCell = (v: string): boolean => false && TRIGGER.test(v) && !NUMBER.test(v);',
    ['test/csv.unit.test.ts']),

  // --- web security (THREATS.md W1-W8) ----------------------------------------
  code('errors: an unknown route does not echo the path', 'src/common/errors.filter.ts',
    "if (exception instanceof NotFoundException && /^Cannot [A-Z]+ /.test(String(payload.message))) payload.message = 'Not found';", '',
    ['test/web-security.test.ts']),
  code('errors: unknown field names are not echoed', 'src/common/zod.pipe.ts',
    "message: i.code === 'unrecognized_keys' ? 'Unrecognized field' : i.message", 'message: i.message', ['test/web-security.test.ts']),
  code('api: no-store on every response', 'src/bootstrap.ts',
    "res.setHeader('Cache-Control', 'no-store');", '', ['test/web-security.test.ts']),
  code('api: HSTS', 'src/bootstrap.ts',
    'hsts: { maxAge: 63072000, includeSubDomains: true, preload: false },', 'hsts: false,', ['test/web-security.test.ts']),
  code('web: no inline styles allowed in production CSP', WEB_PROXY,
    "dev ? `style-src 'self' 'unsafe-inline'` : `style-src 'self' 'nonce-${nonce}'`,", "`style-src 'self' 'unsafe-inline'`,", ['test/web-headers.unit.test.ts']),
  code('web: frame-ancestors none', WEB_PROXY,
    "    `frame-ancestors 'none'`,\n", '', ['test/web-headers.unit.test.ts']),
  code('web: X-Frame-Options DENY', WEB_PROXY,
    "response.headers.set('X-Frame-Options', 'DENY');", '', ['test/web-headers.unit.test.ts']),
  code('web: pages are not cached', WEB_PROXY,
    "response.headers.set('Cache-Control', 'no-store');", '', ['test/web-headers.unit.test.ts']),
  // --- screen-capture reports (THREATS.md V11) ------------------------------
  code('capture reports: the access check before anything is recorded', 'src/documents/capture-report.service.ts',
    "const decision = await this.access.require(tx, actor, id, 'capture_attempt');", "const decision = { reason: 'grant' };",
    ['test/capture-attempt.test.ts']),
  code('capture reports: the owner is not alerted or mailed about their own document', 'src/documents/capture-report.service.ts',
    'if (found.ownerId === actor.userId) return;', '', ['test/capture-attempt.test.ts']),
  code('capture reports: one alert and one email per viewer and document per hour', 'src/documents/capture-report.service.ts',
    'if (row) return row.id;', '', ['test/capture-attempt.test.ts']),
  code('capture reports: rate limited per person', 'src/documents/documents.controller.ts',
    "await this.limits.hit(`capture:${actor.userId}`, CAPTURE_REPORT_LIMIT, 600, 'Too many requests. Try again later.');", '', ['test/capture-attempt.test.ts']),
  code('web: Print Screen is detected as a capture attempt', '../web/src/lib/capture-guard.ts',
    "if (e.key === 'PrintScreen' || e.code === 'PrintScreen') return 'printscreen';", '', ['test/capture-guard.unit.test.ts']),
  // --- PDF sanitization (THREATS.md C9-C11) and refused-upload audit rows (L22) ---
  code('pdf sanitize: the rebuilt copy gets the full strict check (re-inspection guard)', CONTENT,
    '    await strictPdfCheck(out);\n', '', ['test/pdf-sanitize.unit.test.ts', 'test/upload-sanitize.test.ts']),
  code('pdf sanitize: the upload is still inspected structurally (hidden objects, encryption refused, not rebuilt)', CONTENT,
    'await inspectPdf(buf, text, removed);', '', ['test/pdf-sanitize.unit.test.ts']),
  code('pdf sanitize: only the rebuilt copy is stored, never the upload', CONTENT,
    'sanitized: { data: out, removed', 'sanitized: { data: buf, removed', ['test/pdf-sanitize.unit.test.ts', 'test/content-check.unit.test.ts']),
  code('pdf sanitize: pages cleaned before copying (AA, attachment/media annotations, unsafe links)', 'src/documents/pdf-sanitize.ts',
    '  for (const page of src.getPages()) cleanPage(src, page.node, removed);', '', ['test/pdf-sanitize.unit.test.ts']),
  code('pdf sanitize: scrub of the rebuilt document (action chains, stray keys)', 'src/documents/pdf-sanitize.ts',
    '  scrub(out);\n', '', ['test/pdf-sanitize.unit.test.ts']),
  code('pdf sanitize: the rebuilt PDF is malware-scanned too', 'src/documents/documents.service.ts',
    ", { buffer: f.buffer, which: 'sanitized' }]", ']', ['test/upload-sanitize.test.ts']),
  code('refused uploads: content-check refusals audited with their reason', 'src/documents/documents.service.ts',
    'await this.recordUploadRefusal({ action, reason: err.code, message: err.message, file, documentId });', '',
    ['test/upload-sanitize.test.ts', 'test/content-upload.test.ts']),
  code('refused uploads: refusals before the service (size, form, rate limit) audited', 'src/documents/documents.controller.ts',
    '@UseInterceptors(UploadRefusalInterceptor, upload)', '@UseInterceptors(upload)', ['test/upload-sanitize.test.ts']),
  code('refused uploads: new version checks permission before the file', 'src/documents/documents.service.ts',
    "await this.prisma.asUser(actor.userId, (tx) => this.access.require(tx, actor, id, 'upload_version'));", '', ['test/upload-sanitize.test.ts']),
  // --- email codes as a second factor (THREATS.md S30) ---
  code('email codes: a code works once', 'src/auth/email-code.service.ts',
    "return (await this.redis.client.del(key)) === 1 ? 'ok' : 'code_used';", "return 'ok';", ['test/email-otp.test.ts']),
  code('email codes: five wrong tries end the code', 'src/auth/email-code.service.ts',
    'export const EMAIL_CODE_MAX_TRIES = 5;', 'export const EMAIL_CODE_MAX_TRIES = 1000;', ['test/email-otp.test.ts']),
  code('email codes: sign-in takes only sign-in codes (purpose binding)', 'src/auth/mfa.service.ts',
    "await this.checkEmailCode(actor, 'signin', code, 'mfa.email_verify');", "await this.checkEmailCode(actor, 'stepup', code, 'mfa.email_verify');", ['test/email-otp.test.ts']),
  code('email codes: turning on needs the emailed code', 'src/auth/mfa.service.ts',
    "await this.checkEmailCode(actor, 'enable', code, 'mfa.email_enable');", '', ['test/email-otp.test.ts']),
  code('email codes: sends limited per account', 'src/auth/mfa.service.ts',
    'await this.limits.hit(`emailcode:${actor.userId}`, EMAIL_SENDS_PER_ACCOUNT, EMAIL_SEND_WINDOW, message);', '', ['test/email-otp.test.ts']),
  code('email codes: not offered to administrators', 'src/auth/mfa.service.ts',
    "if (u.role === 'ADMIN') return refuse('admin_not_allowed', new ForbiddenException({ message: this.emailUnavailable(u)!, code: 'email_codes_not_for_admins' }));", '', ['test/email-otp.test.ts']),
  code('email codes: turning off is a step-up route', 'src/auth/mfa.controller.ts',
    "@Delete('email')\n  @HttpCode(204)\n  @StepUp()", "@Delete('email')\n  @HttpCode(204)", ['test/email-otp.test.ts']),
  code('email codes: a policy-covered role keeps its last factor', 'src/auth/mfa.service.ts',
    'if (!user.totpEnabledAt && user.passkeys.length === 0) await this.refuseLastFactor(actor, tx);', '', ['test/email-otp.test.ts']),
  sql('database: never an administrator\'s email codes (check constraint)',
    'ALTER TABLE users DROP CONSTRAINT users_email_otp_not_admin',
    "ALTER TABLE users ADD CONSTRAINT users_email_otp_not_admin CHECK (email_otp_enabled_at IS NULL OR role <> 'ADMIN')", ['test/email-otp.test.ts']),
  sql('database: email codes turned on only by their owner',
    'ALTER TABLE users DISABLE TRIGGER users_guard_update_email_otp', 'ALTER TABLE users ENABLE TRIGGER users_guard_update_email_otp', ['test/email-otp.test.ts']),
  // --- shared public demo (THREATS.md I15) and invitation limits ---
  code('demo mode: MFA policy for non-admin roles refused', 'src/auth/mfa-policy.service.ts',
    "if (this.env.DEMO_MODE && to.some((r) => r !== 'ADMIN')) {", 'if (false) {', ['test/demo-mode.test.ts']),
  code('demo mode: role-wide time and network rules refused', 'src/documents/access-policy.service.ts',
    '    if (this.env.DEMO_MODE) {\n      await this.audit.record({ action: \'policy.role_set\'', '    if (false) {\n      await this.audit.record({ action: \'policy.role_set\'', ['test/demo-mode.test.ts']),
  code('demo mode: invitations recorded, not sent', 'src/auth/invite.service.ts',
    '    if (this.env.DEMO_MODE) {', '    if (false) {', ['test/demo-mode.test.ts']),
  code('demo mode: reset links recorded, not sent (admin-sent)', 'src/auth/password-reset.service.ts',
    'const sent = !this.env.DEMO_MODE && this.mail.canReach(user);', 'const sent = this.mail.canReach(user);', ['test/demo-mode.test.ts']),
  code('demo mode: reset links recorded, not sent (self-service)', 'src/auth/password-reset.service.ts',
    "this.env.DEMO_MODE ? 'demo_mode' : !this.mail.canReach(user) ? 'mail_off' : 'sent';", "!this.mail.canReach(user) ? 'mail_off' : 'sent';", ['test/demo-mode.test.ts']),
  code('demo mode: sign-in links never made', 'src/auth/signin-link.service.ts',
    "if (this.env.DEMO_MODE) return 'stepup_link_demo_mode';", '', ['test/demo-mode.test.ts']),
  code('invitations: limit per admin', 'src/auth/invite.service.ts',
    'await this.limits.hit(`invite:send:admin:${actor.userId}`', 'void (`invite:send:admin:${actor.userId}`', ['test/demo-mode.test.ts']),
  code('invitations: global limit', 'src/auth/invite.service.ts',
    "await this.limits.hit('invite:send:all'", "void ('invite:send:all'", ['test/demo-mode.test.ts']),
  code('invitations: counted before the account is created', 'src/users/users.controller.ts',
    '    await this.invites.checkSendLimit(actor);\n    const user = await this.users.create(actor, body);', '    const user = await this.users.create(actor, body);', ['test/demo-mode.test.ts']),
  // --- IDOR on resources that are not documents (THREATS.md A27) ---
  sql('database: row-level security on folders',
    'ALTER TABLE folders DISABLE ROW LEVEL SECURITY', 'ALTER TABLE folders ENABLE ROW LEVEL SECURITY', ['test/idor-resources.test.ts']),
  sql('database: row-level security on download requests',
    'ALTER TABLE download_approvals DISABLE ROW LEVEL SECURITY', 'ALTER TABLE download_approvals ENABLE ROW LEVEL SECURITY', ['test/idor-resources.test.ts']),
  // --- probes: file names, server errors (THREATS.md U11, I3) ---
  code('file names: bidirectional and zero-width characters removed', 'src/documents/content-check.ts',
    String.raw`.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')`, '', ['test/probes.test.ts']),
  code('errors: an unexpected error answers a generic 500', 'src/common/errors.filter.ts',
    "res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: 'Internal error', requestId });", "res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: String(exception), stack: (exception as Error).stack, requestId });", ['test/probes.test.ts']),
  // --- access suggestions never widen access (THREATS.md A14) ---
  code('suggestions: asking for suggestions never creates a grant', 'src/documents/sharing.service.ts',
    '      return { suggestions };', "      for (const s of suggestions) if (s.type === 'user') await tx.grant.create({ data: { documentId, userId: s.id, level: 'READ', grantedById: actor.userId } }); return { suggestions };",
    ['test/documents.test.ts']),
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
  const lines = (r.stdout + r.stderr).replace(/\u001b\[[0-9;]*m/g, '').split('\n');
  const summary = lines.find((l) => /Tests\s+\d/.test(l))?.trim().replace(/\s*\|\s*/g, ', ').replace(/\s+/g, ' ') ?? '(no summary)';
  // Which tests failed, and the first lines of why (shown when the baseline is not green).
  const failures = lines.filter((l) => /^\s*(FAIL|AssertionError|Error:)/.test(l)).slice(0, 20).map((l) => l.trim());
  return { failed: r.status !== 0, summary, failures };
}

const restore = new Map();
const restoreAll = () => { for (const [f, text] of restore) writeFileSync(f, text); restore.clear(); };
process.on('SIGINT', () => { restoreAll(); process.exit(130); });

async function main() {
  loadEnv();
  const onlyIdx = process.argv.indexOf('--only');
  const [lo, hi = lo] = onlyIdx > 0 ? String(process.argv[onlyIdx + 1]).split('-').map(Number) : [];
  const only = lo ? { lo, hi } : null;
  // --shard K/N: run every Nth row starting at K (CI runs N of these in parallel).
  const shardIdx = process.argv.indexOf('--shard');
  const [sk, sn] = shardIdx > 0 ? String(process.argv[shardIdx + 1]).split('/').map(Number) : [];
  const shard = sn ? { k: sk, n: sn } : null;
  if (shard && !(shard.k >= 1 && shard.k <= shard.n)) { console.error('--shard K/N needs 1 <= K <= N'); process.exit(2); }
  const selected = (n) => (!only || (n >= only.lo && n <= only.hi)) && (!shard || (n - 1) % shard.n === shard.k - 1);

  // --from-logs DIR --source TEXT --baseline TEXT: write docs/MUTATION_REPORT.md
  // from the logs of the CI shards (each line "#N name ... VERDICT (summary)"),
  // for when the suite cannot run locally. Every row must appear in the logs.
  const logsIdx = process.argv.indexOf('--from-logs');
  if (logsIdx > 0) {
    const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : 'not given'; };
    const { readdirSync } = await import('node:fs');
    const dir = process.argv[logsIdx + 1];
    const seen = new Map();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.log'))) {
      for (const raw of readFileSync(join(dir, f), 'utf8').split('\n')) {
        const m = /#\s*(\d+) (.*) \.\.\. (CAUGHT|SURVIVED|NOT APPLIED) \((.*)\)\s*$/.exec(raw);
        if (m) seen.set(Number(m[1]), { name: m[2], verdict: m[3], summary: m[4] });
      }
    }
    const results = MUTATIONS.map((m, i) => {
      const s = seen.get(i + 1);
      if (!s || s.name !== m.name) { console.error(`row #${i + 1} (${m.name}) is not in the logs`); process.exit(2); }
      return { n: i + 1, ...m, verdict: s.verdict, summary: s.summary };
    });
    const caught = results.filter((r) => r.verdict === 'CAUGHT').length;
    writeFileSync(join(ROOT, 'docs/MUTATION_REPORT.md'), [
      '# Mutation check report',
      '',
      `Assembled by \`node tools/mutation-check.mjs --from-logs\` on ${new Date().toISOString()} from the logs of ${arg('--source')}.`,
      '',
      'Each row removes or disables one authorisation rule, runs the tests that should notice, and expects them to fail.',
      '"CAUGHT" means at least one test failed with the rule gone. "SURVIVED" would mean nothing tests that rule.',
      '',
      `Baseline (no mutation, full suite in the same CI run): ${arg('--baseline')}`,
      '',
      `**${caught} of ${results.length} mutations caught.**`,
      '',
      '| # | Rule removed | Where | Tests run | Result |',
      '|---|---|---|---|---|',
      ...results.map((r) => `| ${r.n} | ${r.name} | ${r.kind === 'code' ? `\`${r.file.replace('../../', '')}\`` : 'database'} | ${r.tests.map((t) => `\`${t.replace('test/', '')}\``).join(', ')} | **${r.verdict}** — ${r.summary} |`),
      '',
    ].join('\n'));
    console.log(`${caught}/${results.length} caught. Report: docs/MUTATION_REPORT.md`);
    process.exit(caught === results.length ? 0 : 1);
  }

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

  // A shard's baseline is the test files its rows use (the full suite runs in the main API job).
  const baselineFiles = shard ? [...new Set(MUTATIONS.flatMap((m, i) => (selected(i + 1) ? m.tests : [])))] : [];
  console.log(shard ? `baseline: shard ${shard.k}/${shard.n}, ${baselineFiles.length} test files unmodified...` : 'baseline: running the full suite unmodified...');
  const baseline = runTests(baselineFiles);
  if (baseline.failed) {
    console.error(`baseline is not green (${baseline.summary}); fix the tests first`);
    for (const l of baseline.failures) console.error(`  ${l}`);
    process.exit(2);
  }
  console.log(`baseline green: ${baseline.summary}\n`);

  const results = [];
  for (const [i, m] of MUTATIONS.entries()) {
    const n = i + 1;
    if (!selected(n)) continue;
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
  // A shard does not rewrite the committed report; it names what was not caught.
  if (!shard) writeFileSync(join(ROOT, 'docs/MUTATION_REPORT.md'), lines.join('\n'));
  for (const r of results.filter((x) => x.verdict !== 'CAUGHT')) console.log(`NOT CAUGHT: #${r.n} ${r.name} (${r.verdict})`);
  console.log(`\n${caught}/${results.length} caught.${shard ? '' : ' Report: docs/MUTATION_REPORT.md'}`);
  process.exit(caught === results.length ? 0 : 1);
}

main().catch((err) => { restoreAll(); console.error(err); process.exit(2); });
