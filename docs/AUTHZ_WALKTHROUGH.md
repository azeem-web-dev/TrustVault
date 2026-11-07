# Authorisation walkthrough (for the interview)

Written to speak from. Line numbers are for commit `main` on 2026-11-08; if they drift, search for the quoted code. The decision function the README calls `decide()` is `evaluate()` plus `effectiveLevel()` in `apps/api/src/documents/access.ts`; the mutation check still names its rows "decide: …".

## 1. One download, end to end

`GET /api/documents/:id/download`, as Victor, for a document shared with him at Download (READ).

| # | Hop | Where | What happens |
|---|---|---|---|
| 1 | nginx | `infra/nginx/vault.conf:38` (`location /api/`) | TLS, HSTS, rate limit `tv_api` (429), `X-Forwarded-For` overwritten, `proxy_buffering off` so nothing is cached on disk. Proxies to the API on loopback. |
| 2 | Global guard registered | `apps/api/src/app.module.ts:128` (`APP_GUARD` → `SecurityGuard`) | Runs before every controller method. Deny by default: only `@Public()` routes skip it. |
| 3 | Guard step 1: Origin | `apps/api/src/auth/security.guard.ts:68` | State-changing methods from a foreign Origin are refused (403, audited). A GET passes. |
| 4 | Guard step 2: session | `security.guard.ts:85`, lookup at `:87` → `apps/api/src/auth/session.service.ts:68` `resolve()` | The `__Host-tv_session` cookie is a random token; its hash is looked up in `sessions` **in the database on every request** (no JWT). Deactivated, expired, password-changed or signed-out sessions resolve to nothing → 401. |
| 5 | Guard step 3: CSRF | `security.guard.ts:92`/`:93` | For writes, the `X-CSRF-Token` header must match the session's token (constant-time). Not needed for this GET. |
| 6 | Guard step 4: second factor | `security.guard.ts:100` | A session that still owes a second factor (every admin; anyone enrolled; roles in the MFA policy) reaches only the sign-in routes. |
| 7 | Guard step 5: role | `security.guard.ts:112`/`:113` | `@Roles(...)` metadata. The download route has none: any signed-in role may *ask*; the document decision comes next. |
| 8 | Guard step 6: step-up | `security.guard.ts:121` | Only for `@StepUp()` routes (risky admin actions). Not this one. |
| 9 | Controller | `apps/api/src/documents/documents.controller.ts:165–169` | Per-user download rate limit (300 per 10 min), `docId(id)` validates the UUID (a malformed id is a recorded 404), then `DocumentsService.download()`. |
| 10 | One transaction as the user | `apps/api/src/documents/documents.service.ts:266` → `apps/api/src/db/prisma.service.ts:44–49` `asUser()` | Opens a transaction and runs `set_config('app.user_id', <Victor>, true)` (and the client IP). Every query inside now runs under row-level security as Victor. |
| 11 | **The authorisation line** | `documents.service.ts:267`: `const decision = await this.access.require(tx, actor, id, 'download');` | Lock 1. Everything below happens only if this returns. |
| 12 | `require()` | `access.ts:244` | `tv_lock_access()` at `:253` takes a shared row lock on the grant/membership rows, so a revoke waits for this download or this download sees the revoke (R11). `tv_access_facts()` at `:255` loads raw facts (document, user, grants, group coverage, break-glass, session liveness). `evaluate()` at `:261`. A refusal is audited at `:267` and thrown as **404 "Document not found"** at `:279` (or 403 with a code for a policy refusal such as "outside the allowed hours"). |
| 13 | `effectiveLevel()` | `access.ts:149` | Pure function, deny by default, in this order: no document / no user → NONE (`:151`); user not ACTIVE or access ended → NONE (`:153–154`); ADMIN → NONE unless a live approved break-glass, which gives VIEW (`:159–161`); owner → OWNER (`:164`); trashed → NONE (`:165`); each grant: skip expired (`:173`), skip group grants for externals (`:174`), skip grants outside their time window/network (`:176`); externals capped at READ (`:181`). |
| 14 | `evaluate()` | `access.ts:187` | NONE → refuse (`:189`); trash rules (`:190`); a VIEW holder asking to download may use an owner-approved one-off download (`:202`); otherwise `level < REQUIRED_LEVEL[action]` → refuse (`:206`). `REQUIRED_LEVEL.download = READ` (`access.ts:33`). |
| 15 | Limits and approvals | `documents.service.ts:292`, `:299` | Hard per-day/per-session download limits (U9), then, if the share needs approval, consume one approved use. |
| 16 | Lock 2: row-level security | `apps/api/prisma/migrations/20261103600000_access_policies/migration.sql:210` `tv_doc_level()`; `20261104200000_view_download_request/migration.sql:75` `blobs_select`; `20261103600000_access_policies/migration.sql:319` `blobs_release` (RESTRICTIVE) | The version and blob reads at `documents.service.ts:305` only return rows if the **same rule written separately in SQL** gives Victor level ≥ READ (2) on that document, and, for an approval-gated share, only inside the transaction that used the approval. Without a row there is nothing to decrypt. |
| 17 | Audit row, before any byte | `documents.service.ts:316` | `document.download ALLOWED`, with the reason, a download id and a trace code. The database trigger `audit_events_download_live` (`20261103330100_view_levels_after_download_order/migration.sql:48`) refuses this row if the access lapsed since the check. If the row cannot be written, nothing is sent. |
| 18 | keyd ticket | `documents.service.ts:328` `issueUnwrapTicket()` → `tv_issue_unwrap_ticket()` (`20261104200000_view_download_request/migration.sql:114`) | The database (as the schema owner) re-checks `tv_doc_level` for the action, requires that fresh ALLOWED audit event, and MACs a single-use ticket for this person, version and event. Commit. |
| 19 | Decrypt | `documents.service.ts:345` `openFile()` → `apps/api/src/crypto/file-crypto.ts:42` → keyd `keyd/src/ticket.rs:126` `verify_mac`, `:203` `check_binding` | keyd (separate Rust process and Linux user, no network) unwraps the file key only for a valid, unused ticket bound to exactly this wrapped key and AAD, and writes its own signed ledger entry. AES-256-GCM then checks the ciphertext is bound to this document and version. |
| 20 | Stamp | `documents.service.ts:366` `stampDownload()` | PDFs and images get "who, when, trace code" drawn in. |
| 21 | Response | `documents.controller.ts:336–341` | `Content-Disposition: attachment` with a sanitised name, `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, `Cache-Control: no-store, private`. Completion of the transfer is recorded afterwards under the same download id. |

## 2. "What if that line were removed?"

### Remove `require(..., 'download')` (`documents.service.ts:267`)

What still blocks the request: **Lock 2.** The transaction still runs as Victor (`app.user_id`), so for someone without a grant the version and blob rows are invisible (`tv_doc_level` < 2) and the request fails with "Version not found"; the keyd ticket would also be refused by `tv_issue_unwrap_ticket`. A VIEW holder is still refused the bytes by `blobs_select` (needs READ).

What is lost: the refusal is no longer the uniform 404 from `require()` and it is not audited as a document refusal, and the policy checks that only live in TypeScript (hard limits, approvals) are skipped.

Which tests fail: mutation row **#8 "download: the authorisation line itself"**: CAUGHT, **2 tests fail in `documents.test.ts`** (docs/MUTATION_REPORT.md). The route matrix test "every document route returns 404 to a user with no grant, and each refusal is audited" is the one built for this. Row #7 (removing `require()`'s refusal for every route) fails 10 tests.

### Remove the row-level security (Lock 2)

What still blocks the request: **Lock 1.** `require()` is the first call on every document route, so every request is refused exactly as before; the API behaves identically.

Which tests fail: the database is tested **on its own**, without the API: mutation row **#33 "database: row-level security on documents"**: 6 tests fail in `rls.test.ts`; **#93** (blob rows need READ, so VIEW never gets bytes): `rls.test.ts`/`view-only.test.ts`; **#105** (blobs only to a transaction that used an approval): 3 tests in `access-policy-db.test.ts`; **#104** (share conditions inside `tv_doc_level`): 5 tests. That is the point of two locks: each is tested with the other one absent.

## 3. Five practice live changes

Do not apply these; they are rehearsals. For each: the lines to change, the tests that should then fail (because they assert today's rule), and how to run them. SQL changes go in a **new migration** (`apps/api/prisma/migrations/<timestamp>_<name>/migration.sql` with `CREATE OR REPLACE FUNCTION …` copying the latest body), never by editing an applied one. Run: `cd apps/api && npx prisma migrate deploy && npx vitest run test/<file>`, then `node tools/mutation-check.mjs` (or `--only N-M`).

### 3.1 Let MANAGE grant MANAGE

- TypeScript, `apps/api/src/documents/sharing.service.ts:111`:
  `if (input.level === 'MANAGE' && decision.level < Level.OWNER) throw …` → `decision.level < Level.MANAGE`. Also `:148` (changing a MANAGE grant) and `:207` (removing one), if managers may also change and remove MANAGE grants.
- SQL, `grants_guard()` (latest body: `20261103200100_view_only/migration.sql:121`), line 131:
  `IF NEW.level = 'MANAGE' AND granter_level < 5 THEN` → `< 4`.
- Expected to fail: `documents.test.ts` "MANAGE: can share READ/EDIT, cannot give MANAGE, cannot remove a MANAGE grant…", "a manager cannot sneak a MANAGE grant in by changing an existing grant"; `rls.test.ts` grant-rule cases; mutation row #9 would then "survive" and must be rewritten. Update the README levels table and THREATS.md A8.

### 3.2 VIEW can download PDFs only

- TypeScript, `access.ts`: keep `download: Level.READ` but in `evaluate()` before `:206` add: allow `download` at VIEW when the requested version is a PDF. The version is not in the facts today, so the cleaner change is in `documents.service.ts` after `:267`: call `require(…, 'view')` for VIEW holders and then refuse unless `version.mimeType === 'application/pdf'` (and keep stamping).
- SQL, three places that encode "download needs READ (2)": `blobs_select` (`20261104200000_view_download_request/migration.sql:75–79`, add `OR (tv_doc_level(...) >= 1 AND v.mime_type = 'application/pdf')`), the download branch of `audit_events_download_live` (`20261103330100_view_levels_after_download_order/migration.sql`), and the `'download'` level check in `tv_issue_unwrap_ticket` (`20261104200000_view_download_request/migration.sql:114`).
- Expected to fail: `access.unit.test.ts` "VIEW grant allows metadata and pages, never the original file", `view-only.test.ts` "a VIEW grantee can find, open and page through a document, but every route to the original is refused", "the database alone refuses the original to a VIEW grantee", `download-order.test.ts` "the database checks each ALLOWED row at the level its action needs"; mutation row #93. Update THREATS.md V1.

### 3.3 Break-glass lasts 30 minutes

- TypeScript, `apps/api/src/audit/audit-admin.service.ts:294`: `new Date(Date.now() + 60 * 60_000)` → `30 * 60_000`.
- SQL, `break_glass_now()` (`20261102220000_break_glass_cap/migration.sql:8–15`): `interval '61 minutes'` → `'31 minutes'` and `interval '1 hour'` → `'30 minutes'`; the table's check constraint (`expires_at <= created_at + 1 hour`, see the comment at line 4) needs `ALTER TABLE break_glass DROP CONSTRAINT …, ADD CONSTRAINT … CHECK (expires_at <= created_at + interval '30 minutes')`.
- Expected to fail: `documents.test.ts` "break-glass gives one hour of VIEW…", `approvals.test.ts` "break-glass: … one hour at most…", `revocation-holes.test.ts` break-glass limit cases. Update README Roles, WRITEUP.

### 3.4 EXTERNAL can only have VIEW

- TypeScript: `access.ts:181` `if (user.role === 'EXTERNAL') level = Math.min(level, Level.READ);` → `Level.VIEW`; `sharing.service.ts:125` allow only `'VIEW'` for externals (message "External people can only be given View only access").
- SQL: `grants_guard()` line 145 (`20261103200100_view_only/migration.sql`): `NEW.level NOT IN ('VIEW', 'READ')` → `NEW.level <> 'VIEW'`; `tv_doc_level()` (`20261103600000_access_policies/migration.sql:251`): `least(lvl, 2)` → `least(lvl, 1)`. Existing READ grants to externals: a data migration `UPDATE grants SET level = 'VIEW' WHERE user_id IN (SELECT id FROM users WHERE role = 'EXTERNAL') AND level = 'READ'` (audited by a note in the migration).
- Expected to fail: `access.unit.test.ts` "external users are capped at READ even if a grant says more", `documents.test.ts` "external people get READ only, always with an expiry…", `view-only.test.ts` "an external can be given VIEW or READ (with an expiry), nothing more"; the seed's Erin grant (READ) would now be refused by the trigger, so `seed.ts` and `apps/api/src/cli/demo-reset.ts` must change to VIEW.

### 3.5 A new "comment" action at EDIT

- TypeScript: add `comment: Level.EDIT,` to `REQUIRED_LEVEL` (`access.ts:29–46`); comments are writes, so leave it out of `READ_ONLY` (`:54`). New route in `documents.controller.ts`: `@Post(':id/comments')` → a service method that opens `asUser()`, calls `this.access.require(tx, actor, id, 'comment')` first, inserts, and records `document.comment` in the audit log.
- SQL: new table `document_comments (id, document_id, author_id, body, created_at)`, `ENABLE ROW LEVEL SECURITY`, `GRANT SELECT, INSERT` to `trustvault_app`, policies: `SELECT USING (tv_doc_level(document_id, tv_current_user()) >= 1)`, `INSERT WITH CHECK (author_id = tv_current_user() AND tv_doc_level(document_id, tv_current_user()) >= 3)`.
- Tests to add (none fail today, because nothing tests a route that does not exist): add `'comment'` to the `routes()` matrix in `documents.test.ts` so outsiders get 404; READ gets 404/403 and EDIT succeeds; an `rls.test.ts` case for the insert policy; two mutation rows (the TS level and the SQL policy).

## 4. Design questions, with my answers

**Why per-document grants and groups, but no folder inheritance?** The brief's first failure is "access to a folder to see one file, and they can now see forty". Inheritance makes the effective permission of a document depend on where it sits, so moving a file silently changes who can read it, and "who can see this?" needs a tree walk. Per-document grants make the answer one query. Groups give the convenience back without the surprise: a group share covers the members confirmed at the time; someone added later waits for the owner to confirm (R7). Folders only organise.

**How are files stored, and why are they unreachable without authorisation?** Each version is encrypted with its own random AES-256-GCM key, bound by AAD to its document and version, stored in Postgres. The key is wrapped by keyd, a separate Rust service running as its own Linux user with no network, holding the master key. To read a file you need: the blob row (row-level security as the user), a single-use ticket the database mints only after the access check and a committed audit row, and keyd's agreement. There is no file path, no object-store URL and no share link to guess. A database dump alone is ciphertext.

**What does "immediate" cost?** A database read on every request: the session lookup and the live grant/membership read in both locks. No JWTs, so no offline validation and no horizontal scaling without the database. Lock ordering: a download takes a shared lock on the access rows and a revoke an exclusive one, so they serialise; I had to prove there is no deadlock under a burst (`download-order.test.ts`). The upside: revoke, deactivation, role change and expiry all take effect on the next request.

**What stops the audit log being altered?** The app's database role can only INSERT. A trigger hash-chains every row; UPDATE, DELETE and TRUNCATE are refused, even for the table owner. keyd signs the chain head every minute with a key the database never sees; each checkpoint goes to Sigstore's public transparency log within seconds and to the `witness` branch on GitHub. A superuser can still disable triggers and rewrite rows, but every rewrite of published history is detected by the in-app verify, the offline verifier and the witness. The honest gap: the last one or two minutes before publication.

**What does the admin see, and what triggers an alert?** Admins see the audit log (filters, document titles, permission changes), integrity verification, users, groups, approvals and alerts, and **cannot open documents**. Alerts are persistent and must be reviewed with a note: repeated refusals, attempts after revocation, use of an ended session, sign-in after an admin-sent reset, bulk downloads or page views, unusual hours or networks, coverage of a large share of what someone can open, external sharing, break-glass, integrity failures, malware found.

**What did you choose not to build?** Anonymous share links (revocation would mean finding every copy), folder inheritance, end-to-end encryption (the server could no longer validate, search or audit), an external IdP or JWTs (tokens outlive revocation), OPA (a second language for the decision I most need to explain), Kubernetes/SIEM (out of proportion). Smaller and holding beats larger with a hole.

## 5. Twelve likely questions, short answers

1. **Where is the authorisation decision made when someone downloads a file?** `documents.service.ts:267`, `access.require(tx, actor, id, 'download')`, which runs the pure `evaluate()`/`effectiveLevel()` in `access.ts`; and independently in Postgres row-level security via `tv_doc_level()` when the blob row is read.
2. **What happens if that line is removed?** Row-level security still hides the version and blob, so no bytes leave; the refusal is no longer the uniform audited 404, and `documents.test.ts` fails (mutation #8, 2 tests).
3. **And if RLS is removed instead?** The API still refuses through `require()`; `rls.test.ts` fails (mutation #33, 6 tests), because the database lock is tested without the API.
4. **Why 404 and not 403?** So an outsider cannot learn a document exists. "Not yours" and "does not exist" are the same answer, timing included; the difference is only in the audit row's reason.
5. **How does revocation take effect immediately?** Revoke deletes the grant row; both locks read grants live on every request; sessions are database rows, not tokens; a download in flight holds a lock the revoke waits for, so the log order matches reality.
6. **Can an admin read a document?** No. The ADMIN role gives level NONE (`access.ts:159–161`), admins cannot be granted access or join groups (database triggers). Break-glass needs a written reason and a second admin's approval, gives one hour of watermarked pages only, is alerted and emailed to the owner.
7. **Can the AI give someone access?** There is no AI in the product: suggestions are a heuristic over the owner's earlier same-category shares. They only read; a grant needs the owner's own share call, and both the suggestion and the confirmed grant are audited. A test checks no grant row exists after asking.
8. **What stops a DB superuser rewriting history?** Nothing inside the database; detection outside it: keyd-signed checkpoints, Sigstore, the GitHub witness, and an offline verifier anyone can run. The last 1–2 minutes are the accepted gap.
9. **How do your tests prove they test something?** `tools/mutation-check.mjs` removes each authorisation rule, TypeScript and SQL, one at a time and requires a failing test; 249 of 249 were caught in CI on 2026-11-08 (run 42403412506); this session added rows for demo mode, invitation limits, folder and download-request RLS, file names, the generic 500 and suggestions.
10. **What does a judge using the shared admin account change for the next judge?** Protected accounts cannot be changed. `DEMO_MODE` refuses lock-out settings and stops outgoing mail; a reset every four hours restores shares, groups, policies and folders. Both are built and tested; switching them on in production is pending.
11. **Where did the AI get authorisation wrong?** Examples in PROMPTS.md: a grants policy that hid group grants from members; RLS that blocked every upload; a check order that leaked "you already own this" before "not found"; a sign-in race it said was closed and was not; this session, a seed that created group shares covering nobody.
12. **What is unfinished?** One server; backups copied off it by hand; the audit tail of 1–2 minutes; admin impersonation via reset detected not prevented; browser screenshots only reported; Android not tested on a device automatically; demo protection not switched on; the three large UI files not yet split.
