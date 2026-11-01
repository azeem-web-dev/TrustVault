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
    "user.status !== 'ACTIVE' ||", '', ['test/auth.test.ts']),
  code('session: password change invalidates older sessions', SESSION,
    'session.createdAt.getTime() < user.passwordChangedAt.getTime();', 'false;', ['test/auth.test.ts']),
  code('mfa: a TOTP code works only once', 'src/auth/mfa.service.ts',
    'AND (totp_last_step IS NULL OR totp_last_step < ${step})', '', ['test/admin-mfa.test.ts']),
  code('uploads: PDFs with JavaScript refused', 'src/documents/content-check.ts',
    'if (/\\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\\b/.test(text)) {', 'if (false) {', ['test/documents.test.ts']),
  code('users: protected demo accounts cannot be changed', 'src/users/users.service.ts',
    "if (u.isProtected) throw new ForbiddenException('This is a protected demo account and cannot be changed');", '',
    ['test/admin-mfa.test.ts']),

  // --- the database's own locks ---------------------------------------------
  sql('database: row-level security on documents',
    'ALTER TABLE documents DISABLE ROW LEVEL SECURITY', 'ALTER TABLE documents ENABLE ROW LEVEL SECURITY', ['test/rls.test.ts']),
  sql('database: grant rules trigger (no MANAGE from managers, external limits)',
    'ALTER TABLE grants DISABLE TRIGGER grants_guard', 'ALTER TABLE grants ENABLE TRIGGER grants_guard', ['test/rls.test.ts']),
  sql('database: audit log append-only trigger',
    'ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete', 'ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete',
    ['test/audit-db.test.ts']),
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
  const summary = (r.stdout + r.stderr).split('\n').find((l) => /Tests\s+\d/.test(l))?.trim().replace(/\s*\|\s*/g, ', ').replace(/\s+/g, ' ') ?? '(no summary)';
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
    ...results.map((r) => `| ${r.n} | ${r.name} | ${r.kind === 'code' ? `\`${r.file}\`` : 'database'} | ${r.tests.map((t) => `\`${t.replace('test/', '')}\``).join(', ')} | **${r.verdict}** — ${r.summary} |`),
    '',
  ];
  writeFileSync(join(ROOT, 'docs/MUTATION_REPORT.md'), lines.join('\n'));
  console.log(`\n${caught}/${results.length} caught. Report: docs/MUTATION_REPORT.md`);
  process.exit(caught === results.length ? 0 : 1);
}

main().catch((err) => { restoreAll(); console.error(err); process.exit(2); });
