# TrustVault

A document platform where the wrong person can never read the file, and you can prove who read it.

**Live:** https://vault.rayyanazeem.cloud

**Demo video (5 min):** `[DEMO VIDEO LINK: TO BE ADDED]`

## Demo accounts

| Role | Email | Password | What to try |
|---|---|---|---|
| Admin | `admin@demo.com` | `admin1234567` | Needs a second factor: add the secret below to an authenticator app (Google Authenticator, 1Password, Authy...) or generate a code with `oathtool --totp -b <secret>`. Audit log, alerts, verify integrity. Break-glass and clearing an owner's second factor need a second admin's approval (THREATS.md S19): ask here, approve as Ben. |
| Admin 2 | `admin2@demo.com` | `admin2345678` | The second administrator, with its own authenticator secret (below). Approve or reject Ada's requests on the Approvals page; then Ada uses the approval once (break-glass gives one hour of View only). Nobody approves their own request. |
| Owner | `olivia@demo.com` | `owner1234567` | Owns the four seeded documents, shared in different ways. Share, revoke, see history. |
| Owner | `oscar@demo.com` | `owner1234567` | Owns *Architecture review* (Engineering group can edit, Olivia can manage). |
| Viewer | `victor@demo.com` | `viewer123456` | Sees 3 documents (one direct, two through groups). Try to reach *Salary bands 2026*. |
| External | `erin@demo.com` | `external1234` | Sees only the NDA shared with her, read-only, until it expires. |

**Admin authenticator secret:** `NZVD2J3RUX6P7RSZ3FSGBT2ACTCWOPRZ`  
**Admin 2 authenticator secret:** `NIGQMN42LTYZ6MNDYSNHFFOBUVL5C3E6`

The demo accounts are published because the brief asks for them, so they are **protected**: nobody can deactivate, demote, rename them or change their password or second factor (THREATS.md I7, I8). Each code works once (replay-protected). If a code is refused, wait for the next one.

Demo accounts cannot reset their password and never receive email: their addresses belong to someone else.

## The ten requirements

Paths are relative to the repository root; tests are in `apps/api/test/`. CI runs every one of them on each push (`.github/workflows/ci.yml`).

| # | The brief says | Where it is implemented | How to see it in the demo | Test that proves it |
|---|---|---|---|---|
| 1 | "Authentication, with at least three roles: an administrator, a document owner, and a viewer" | `apps/api/src/auth/auth.service.ts` (sign-in), `session.service.ts` (database sessions), `security.guard.ts` (role check on every route); roles and levels are written down under [Roles](#roles) | Sign in as Ada (admin, with the authenticator secret), Olivia (owner), Victor (viewer), Erin (external) | `auth.test.ts`, `admin-mfa.test.ts` "an admin with only a password reaches nothing but the sign-in routes" |
| 2 | "Upload, organise, search and manage documents" | `apps/api/src/documents/documents.service.ts` (upload, versions, trash, restore, purge, transfer), `folders.controller.ts`; web `apps/web/src/app/page.tsx` and `apps/web/src/app/documents/[id]/page.tsx` | Olivia: upload, move to a folder, new version, trash and restore | `documents.test.ts` "trashed documents disappear…", "purge only works from the trash…", "transfer: the new owner gets everything…" |
| 3 | "Permissions per document, at least read and edit, granted to named people" | `apps/api/src/documents/sharing.service.ts` `grant()`; levels VIEW / READ / EDIT / MANAGE in `access.ts` | Olivia → a document → Access → share with Victor at Download or Edit | `documents.test.ts` "READ: can view and download; cannot edit…", "EDIT: can rename and upload a version; cannot share or trash" |
| 4 | "Owners can grant access and take it back" | `sharing.service.ts` `grant()` and `revoke()` | Olivia removes Victor; Victor's open tab fails on its next click | `documents.test.ts` "revoking a grant: the very next request is refused, and the attempt is audited" |
| 5 | "People who were not granted access cannot read, download, change or delete a document" | Lock 1: `apps/api/src/documents/access.ts` `require()` → `evaluate()`, called first by every document route. Lock 2: row-level security `tv_doc_level()` in `apps/api/prisma/migrations/20261101083248_documents_and_permissions/migration.sql` | Victor pastes the URL of *Salary bands 2026*: "does not exist, or you do not have access" | `documents.test.ts` "every document route returns 404 to a user with no grant, and each refusal is audited" (17 routes × 4 kinds of outsider); `rls.test.ts` (the database alone) |
| 6 | "An audit trail of uploads, downloads, changes, deletions and permission changes" | `apps/api/src/audit/audit.service.ts`; hash chain and the refusal of UPDATE/DELETE in `apps/api/prisma/migrations/20261101071557_identity_and_audit/migration.sql` | Olivia → document → History; Ada → Audit log | `documents.test.ts` "records upload, view, download, edit, grant, revoke, trash with the actor"; `audit-db.test.ts` |
| 7 | "Search by name, owner, category and date" | `documents.service.ts` `search()`; filters on the web documents page | Search box plus the owner, category and date filters | `documents.test.ts` "q matches the title…", "owner matches the owner by name or email", "category matches exactly…", "from/to bound the upload date", "filters combine" |
| 8 | "Validation of what is uploaded" | `apps/api/src/documents/content-check.ts` (type from the bytes, structure checks in a worker), `pdf-sanitize.ts`, `apps/api/src/scanning/` (ClamAV, fails closed) | Upload a renamed `.exe` or a PDF with JavaScript: refused, and a `DENIED` row appears in History / Audit | `documents.test.ts` upload section, `content-check.unit.test.ts`, `upload-sanitize.test.ts` |
| 9 | "An administrative view of document activity and permission changes" | `apps/api/src/audit/audit-admin.service.ts`; web `apps/web/src/app/admin/audit/page.tsx`, `admin/alerts/page.tsx` | Ada → Audit log → "Permission changes" filter → Verify integrity | `admin-mfa.test.ts` "lists document activity and permission changes, with document titles", "non-admins cannot read the audit log, alerts or export" |
| 10 | "Automated tests showing that one user cannot reach another user's documents" | `apps/api/test/documents.test.ts` (`describe('one user cannot reach another user’s documents')`), `rls.test.ts`, `search-filter.test.ts`, `tools/mutation-check.mjs` | `cd apps/api && npx vitest run test/documents.test.ts` | The suite itself: 901 tests pass in CI (1 skipped); 249 of 249 rules, removed one at a time, each fail a test ([MUTATION_REPORT.md](docs/MUTATION_REPORT.md)) |

## The three non-negotiables

**1. Only people who were granted a document reach it, by any route.**
Every route that names a document calls `AccessService.require()` (`apps/api/src/documents/access.ts`) before anything else; it is deny-by-default and answers 404 for "not yours" and "does not exist" alike. Independently, Postgres row-level security (`tv_doc_level()`) hides the document, version and file rows from the app's own database role unless the same rule passes in SQL. Admins get no document access at all.
Tests: `documents.test.ts` "every document route returns 404…", `rls.test.ts`, `search-filter.test.ts`, and the mutation check.

**2. Provable access, including refusals, in a log that cannot be quietly altered.**
Every upload, view, download, change, deletion, permission change and every refusal writes a row to `audit_events` (`apps/api/src/audit/audit.service.ts`). A trigger hash-chains each row; UPDATE, DELETE and TRUNCATE are refused even for the table owner. A separate key service signs a checkpoint every minute and each one is published to Sigstore's public log; a GitHub Action copies them to the [`witness` branch](https://github.com/azeem-web-dev/TrustVault/tree/witness). Honest limit: someone with root can still cut off the last minute or two of events before they are published (THREATS.md L5).
Tests: `audit-db.test.ts`, `refusal-audit.test.ts`, `witness.test.ts`, `anchor.test.ts`, `node tools/verify-audit.test.mjs`.

**3. Taking access away works immediately.**
Revoking deletes the grant row. Sessions are random tokens looked up in the database on every request (no JWTs), and both locks read grants and group membership live; nothing caches a permission. A download and a revoke take the same row lock, so they cannot interleave. Page images are sent `no-store`, and the Android app's offline file key is destroyed on revoke.
Tests: `documents.test.ts` "revoking a grant: the very next request is refused…", "removing someone from a group removes their access through it at once", `download-order.test.ts`, `view-only.test.ts` "after a revoke: pages refused on the next request, the offline key refused and destroyed".

## What I chose not to build, and why

No anonymous share links, no folder inheritance, no end-to-end encryption, no external identity provider or JWTs, no policy engine (OPA), no Kubernetes or SIEM. Each is explained in [docs/WRITEUP.md, "What I deliberately did not build"](docs/WRITEUP.md#what-i-deliberately-did-not-build). The short version: every one of them either breaks immediate revocation, recreates the "one folder, forty files" problem, or adds a second place where the authorisation decision lives.

## Known limitations

- **One server**, no database replication. Encrypted backups are made nightly on the server; copies on the owner's PC are pulled by hand (last pulled 2026-11-03), not on a schedule.
- **The audit log's newest minute or two** before a server compromise is signed but not yet public, so root could cut it off (THREATS.md L5).
- **The `witness` branch is scheduled every 15 minutes, but GitHub runs scheduled jobs late:** on 2026-11-07 it ran roughly every 4 to 7 hours. Sigstore publishing is separate and was seconds behind each checkpoint (checked 2026-11-07, see [docs/CLAIMS_CHECK.md](docs/CLAIMS_CHECK.md)).
- **Admin impersonation through a password reset** is detected (alert, email to the person, audit) but not prevented for viewers and externals (THREATS.md S15).
- **Screenshots of View-only pages** cannot be stopped in a browser: they are watermarked and likely attempts are reported to the owner. Android blocks them.
- **Shared demo accounts:** every judge uses the same logins. Protected accounts cannot be changed, but other shared state (shares, groups, policies) can be. `DEMO_MODE` and a scheduled demo reset are in the repository but not switched on in production yet ([docs/DEMO.md](docs/DEMO.md)).
- **Access suggestions are a heuristic, not AI:** they rank people you shared documents of the same category with. They never grant anything.
- **Android:** checked by hand on a phone; not in a store; no automated on-device test.
- The full list is in [docs/WRITEUP.md, "What is not finished"](docs/WRITEUP.md#what-is-not-finished).

## Roles

| Role | Can | Cannot |
|---|---|---|
| Admin | Manage users and groups. See the audit log and alerts, verify integrity, export evidence. Send a password reset link (never set a password). Break-glass: ask with a written reason of at least 20 characters; once a **second** admin approves, one hour of View only on one document (watermarked pages, no download), alerted, emailed to the owner and shown in that document's history. Clearing an owner's or admin's second factor also needs a second admin (Approvals page). | Open, download or upload documents (except viewing pages through approved break-glass). Set anyone's password. Approve their own request. Be given access to a document. Join a group. Change the protected demo accounts. |
| Owner | Upload documents. On their own documents: share (View only, Download, Edit or Manage), revoke, edit, upload new versions, move to folders, trash, restore, delete permanently, transfer ownership. | Be moved to another role while they own documents. |
| Viewer | Use what they are granted (levels below). | Upload new documents. Give MANAGE. |
| External | View only or Download, and only on grants with an expiry, until their account's end date. The share screens offer View only first. | Get access through a group. Anything above Download (READ). |

| Level (on one document) | Can | Cannot |
|---|---|---|
| **View only** (`VIEW`) | Find it in search, see its details and versions, read its pages inside TrustVault. Every page is drawn by the server with the viewer's email, the time and a trace code; on Android screenshots and recording are blocked while it is open. In the browser a screenshot cannot be blocked: likely capture keys (Print Screen, Win+Shift+S, Cmd+Shift+3/4/5, Ctrl+P) blank the page for a moment and are reported to the owner (history, alert, email) without telling the viewer | Download the file, by any route: the app and the database both refuse. Word, Excel and PowerPoint files have no preview, so View only shows a note to ask the owner |
| **Download** (`READ`) | Also download. PDFs and images are stamped with who downloaded, when and a trace code; the Android app keeps the file only encrypted, with a key it must fetch from the server on every open | Change anything |
| **Edit** (`EDIT`) | Also rename, describe and upload new versions | Share |
| **Manage** (`MANAGE`) | Also share View only, Download or Edit, revoke, see who has access and the history | Give Manage, trash, transfer |
| **Owner** | Everything, including Manage grants, trash, restore, delete and transfer | |

Anyone who can see a page can photograph it. View only keeps originals off devices, Android blocks screenshots, the web viewer reports likely screenshot attempts to the owner (deterrence, not prevention), and watermarks make leaks traceable ([THREATS.md](THREATS.md) V1 to V11).

Accounts are created by invitation. An admin enters an email, a role and, if needed, an access end date; the person gets an email with a link (it works once and expires after 72 hours) and chooses their own name and password. Until then the account is **Invited** and can do nothing. The admin never knows the password. Admins can resend or cancel an invitation from the Users screen (THREATS.md S18).

Grants are per document, to named people or to groups. A group share covers the people in the group when it is shared. Anyone added later waits until the owner (or a manager outside the group) confirms; `GET /documents/:id/access` shows them as pending.

## Run it locally

Needs Node 22+, PostgreSQL 16 and Redis 7 running on the machine.

```bash
git clone https://github.com/azeem-web-dev/TrustVault.git && cd TrustVault
npm ci --ignore-scripts && npm rebuild prisma @prisma/engines esbuild
# Database roles and a database, the same layout as production (row-level security needs it):
sudo -u postgres psql -v ON_ERROR_STOP=1 < infra/ci/setup-db.sql   # on stdin: the postgres user may not be able to read your home folder
#   creates database trustvault_test, owner role tv_dev_owner (password ci-owner), app role tv_dev_app (password ci-app)
cp apps/api/.env.example apps/api/.env
#   in apps/api/.env set:
#   DATABASE_URL=postgresql://tv_dev_app:ci-app@127.0.0.1:5432/trustvault_test
#   DATABASE_OWNER_URL=postgresql://tv_dev_owner:ci-owner@127.0.0.1:5432/trustvault_test
#   TEST_DATABASE_URL and TEST_DATABASE_OWNER_URL: the same two URLs
#   REDIS_URL=redis://127.0.0.1:6379        (a local Redis without ACLs)
#   LOCAL_MASTER_KEY=<output of: openssl rand -base64 32>
cd apps/api
npx prisma generate                        # the database client is generated, not committed
npx prisma migrate deploy                  # runs as DATABASE_OWNER_URL
npx tsx --env-file=.env prisma/seed.ts     # demo data with dev-only passwords
npm run dev                                # API on http://127.0.0.1:4100
cd ../web && npm run dev                   # web on http://localhost:3005 (PUBLIC_ORIGIN in .env must be http://localhost:3005)
```

On an Ubuntu server, `sudo bash infra/server/provision.sh` creates the roles with generated passwords instead (see Deploy). The tests use the same `.env`: `cd apps/api && npx vitest run`. What happened when this was followed from a fresh clone is in [docs/CLAIMS_CHECK.md](docs/CLAIMS_CHECK.md#clean-clone-run).

## Deploy (Ubuntu 24.04, from a clean machine)

```bash
sudo bash infra/server/provision.sh     # users, databases, roles, pg_hba, Redis ACL
sudo bash infra/server/install-app.sh   # env files, systemd units, nginx, TLS (certbot)
sudo bash infra/server/install-keyd.sh  # build and start the key service; generates the master key
sudo bash infra/server/install-clamav.sh          # malware scanner for uploads; checks it detects EICAR
sudo bash infra/server/install-backup.sh age1...  # nightly encrypted backup to an offline key (docs/RESTORE.md)
sudo bash infra/server/deploy.sh        # fetch, install, build, migrate, restart, health check
```

Email (optional) is set in `/etc/trustvault/mail.env` on the server (root:trustvault, 0640, read by the API service; never in git): `MAIL_TRANSPORT` (`off`, `smtp` or `memory` for tests), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `RESET_LINK_MINUTES`. With `smtp`, the API refuses to start unless host, user and password are set. `INVITE_LINK_HOURS` (default 72) sets how long an invitation link works. `DEVICE_TRUST_KEY` (32 random bytes, base64) signs the trusted-device cookie that lets a person past the sign-in throttles a stranger can trigger (THREATS.md S27); without it a random key is used and devices are forgotten on restart. `SIGNIN_LINK_MINUTES` (default 15) sets how long the emailed sign-in confirmation link works. The API unit allows no outbound internet; after setting `SMTP_HOST`, run `bash infra/server/mail-egress.sh` as root, which adds a drop-in allowing only that host's current addresses (re-run it if the provider's addresses change: deliveries then fail with `Connection timeout` in the API log).

Then seed with production passwords (`SEED_PASSWORD_*`, `SEED_ADMIN_TOTP_SECRET` in `/etc/trustvault/seed.passwords`); see `apps/api/prisma/seed.ts`. The seed connects as the schema owner (`DATABASE_OWNER_URL`, as for migrations): the app's own role may not create active or protected accounts (THREATS.md A23).

## Tests

```bash
cd apps/api && npx vitest run            # 902 tests (901 pass, 1 skipped) in 61 files against a real Postgres and Redis (CI run 42403412506, 2026-11-08)
cd apps/api && npm run test:e2e          # real Chrome: passkeys, and stored XSS / CSP / framing on the production build
cd apps/api && npm run measure:timing    # login timing: can response time reveal which emails exist?
node tools/mutation-check.mjs            # removes every authorisation rule listed in tools/mutation-check.mjs (249 of them; all 249 caught in CI on 2026-11-08), one at a time; every removal must fail a test
node tools/verify-audit.test.mjs         # the offline audit verifier against forged and cut bundles
cd keyd && cargo test --locked           # key service (tickets, ledger, rate limits)
cd apps/mobile && flutter test           # the Android app: session storage, wipe on sign-out and 401, local copies, transport policy
node tools/verify-audit.mjs bundle.json --key OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE= --witness checkpoints.jsonl --rekor   # verify an audit export: pinned key, witness, Sigstore
```

| Test file | Proves |
|---|---|
| `access.unit.test.ts` | `decide()` alone: every rule, deny by default |
| `rls.test.ts` | the database alone (no API code): RLS policies and guard triggers |
| `search-filter.test.ts` | the search access filter alone (run where RLS does not apply) |
| `view-only.test.ts` | View only: pages yes, original no (both locks), watermark and trace code in the audit row, stamped downloads, revoke stops pages and the Android key, externals, break-glass, bulk-viewing alert and rate limit |
| `capture-attempt.test.ts`, `capture-guard.unit.test.ts` | Screenshot attempts on view-only pages: reported silently to the owner (history, one alert and one email an hour), nothing for people without access, rate limit, the web key detection and its debounce |
| `documents.test.ts` | end to end: 17 document routes refused for 4 kinds of outsider, search leaks nothing, revocation is immediate, uploads validated and malware-scanned (fails closed), files encrypted, blob swaps detected, break-glass, suggestions |
| `auth.test.ts` | sessions, lockout, rate limits, CSRF, Origin, session death on deactivate / role / password change |
| `admin-mfa.test.ts` | second factor, replay, protected demo accounts, admin audit view, alerts, export verified by the offline tool |
| `audit-db.test.ts` | direct attacks on the audit table as the app role and as the table owner |
| `witness.test.ts` | the outside witness catches a rewritten history even when the forger holds the real signing key |
| `anchor.test.ts` | checkpoints reach the public log in order, only with a valid receipt; a checkpoint changed or removed after publishing is caught |
| `passkeys.test.ts` | the full passkey ceremony with a software authenticator (real keys and bytes), and every refusal |
| `e2e/passkey.e2e.ts` | the same in real Chrome (virtual authenticator) through the real Next.js pages and API |
| `rescan.test.ts` | a file stored clean and caught by a later signature is quarantined; downloads refused; the app cannot release it |
| `scanner.unit.test.ts` | only an exact "clean" from ClamAV passes; production refuses to start without it |
| `revocation-holes.test.ts` | admins never read through groups or grants; a group share reaches people added later only after the owner confirms; revoke and transfer say when a group still gives access; role changes, break-glass limits and ended sessions are enforced and recorded |
| `refusal-audit.test.ts` | refusals before the access check (bad body, bad version number, malformed id) and the guard's second-factor and foreign-Origin refusals are recorded, and no refusal is recorded twice |
| `download-order.test.ts` | a download and a revoke (or share change, group removal, role change, deactivation, ended session, expiry) never interleave: real requests paused on the real locks, the log always in decision order, downloads still parallel, no deadlock under a burst |
| `approvals.test.ts` | two admins for break-glass and for clearing an owner's or admin's second factor: one admin alone cannot, nobody approves their own request (API and direct SQL), an approval works once, for its own target, within 24 hours; rejected and expired requests recorded; owners emailed |
| `step-up.test.ts` | risky actions refused without a recent second factor, then allowed after `POST /auth/mfa/step-up` (code or passkey); replay and rate limit still apply |
| `email-otp.test.ts` | email codes as a second factor: turning on needs the emailed code; expired, reused, other-purpose and other-session codes refused; 5 tries per code, 3 sends per 10 minutes; sign-in with a code; turning off needs a fresh factor; a policy-covered role keeps its last factor; admins and demo accounts refused (API and database); no code in responses, audit, logs or Redis |
| `mfa-policy.test.ts` | adding a role to the MFA policy forces its open password-only sessions to enrol; ADMIN cannot be removed (API and database); admins only, with step-up |
| `devices.test.ts` | your own sessions only: list, sign out one, sign out all others; someone else's session is `404` |
| `passkeys-android.test.ts` | the Android app's `android:apk-key-hash` origin accepted only when configured; other signing keys refused |
| `totp.unit.test.ts` | RFC 6238 Appendix B vectors, clock drift of one step, the `otpauth://` URI Google Authenticator reads |
| `email.test.ts` | password reset links reveal nothing, work once, expire, are built from the configured site and end every session; admins send links and never see passwords; notices for sign-ins, password and second-factor changes, and shares; demo accounts never get mail |
| `identity-guards.test.ts` | the database on its own, as the app's real role: no self-promotion, no role or status change without an admin, never the last admin, no password or second factor set for someone else, groups only by admins, hashes and TOTP secrets unreadable; malformed `app.user_id` fails closed |
| `invite.test.ts` | accounts by invitation: no admin-chosen password, invited accounts can do nothing, links work once, expire, are built from the configured site and never work as reset links (or the reverse); resend and cancel; reactivating a never-accepted account keeps it invited |
| `checkpoint-guard.test.ts` | the database accepts an audit checkpoint only for a real event with the same hash, and only moving forward |
| `access-policy*.test.ts` | download approvals (never by the requester, once per use, cancelled by a revoke), time windows across daylight saving, network allowlists and spoofed X-Forwarded-For, role rules, exceptions: in decide() and in the database on its own |
| `keyd-tickets.test.ts`, `key-rotation.test.ts` | a file key is released only against a database ticket for that person, version and audit row; the ledger and its reconciliation catch a release without a record; rotation and verification |
| `insider-detect.test.ts` | persistent alerts and their review history, hard download limits and overrides, the download lifecycle |
| `auth-abuse.test.ts` | strangers cannot lock an account; credential stuffing and distributed guessing detected; sign-in links; trusted devices |
| `content-*.test.ts`, `pdf-sanitize.unit.test.ts`, `upload-sanitize.test.ts`, `web-security.test.ts`, `e2e/web-security.e2e.ts` | hostile Office files, ZIP tricks and polyglots refused in a worker; PDFs with active content rebuilt (text, pages and rotation kept; the copy passes the strict check; downloads, stamping and page views work), broken PDFs refused; one audit row per refused upload, per refusal class; CSV formulas; headers, CSP and stored XSS in real Chrome |
| `timezone.test.ts` | every connection runs in UTC, whatever the database default (a non-UTC default used to end every session) |
| `integration-attacks.test.ts` | the merged features against each other: View only vs approvals and the Android key, group View vs a direct share's approval, revoke vs approvals/keys/pages, windows on pages, break-glass vs downloads, limits vs approval uses |
| `tools/verify-audit.test.mjs` | the offline verifier (19 cases): pinned key, no checkpoints, recomputed forged chains, cut-off tails caught through Sigstore or the witness |

## What to read

| File | What it is |
|---|---|
| [docs/WRITEUP.md](docs/WRITEUP.md) | What I built, what I deliberately did not, the permission model in my own words, how I used AI and where it was wrong, what is unfinished |
| [THREATS.md](THREATS.md) | Every way I think it could be broken, the defence, the test that proves it, and what I accepted |
| [PROMPTS.md](PROMPTS.md) | AI usage, dated, with each mistake and the commit that fixed it |
| [docs/API.md](docs/API.md) | Every endpoint and who is allowed to call it |
| [docs/MUTATION_REPORT.md](docs/MUTATION_REPORT.md) | Each authorisation rule removed in turn, and the test that caught it |
| [docs/PLAN.md](docs/PLAN.md) | The design and the decisions behind it |
| [docs/DEMO.md](docs/DEMO.md) | The five-minute demo script |
| [docs/LOGIN_TIMING.md](docs/LOGIN_TIMING.md) | Measured: login response time does not reveal which emails have accounts |
| [docs/RESTORE.md](docs/RESTORE.md) | Backups and how to restore from one |
| [docs/ACCESS_POLICIES.md](docs/ACCESS_POLICIES.md) | Conditions on a share: download approval, working hours, networks; role rules; emergency exceptions |
| [docs/KEYS.md](docs/KEYS.md) | The key hierarchy; keyd releases a file key only against a ticket the database issues; its signed key-use ledger; rotation and recovery |
| [docs/ANDROID_SECURITY.md](docs/ANDROID_SECURITY.md) | The Android app's own security tests (unit, widget, static manifest check, on-device) and what they cover |
| [docs/SUPPLY_CHAIN.md](docs/SUPPLY_CHAIN.md) | Pinned actions, lockfiles, dependency audit, SBOMs, reproducible keyd, signed releases |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The components and trust boundaries in one place |
| [docs/VERIFY.md](docs/VERIFY.md) | How anyone can check an audit export without our code (format, and an independent Python verifier) |
| [docs/BACKUP_DR.md](docs/BACKUP_DR.md) | Backup, off-site copy, restore drill, recovery targets |
| [docs/INCIDENT.md](docs/INCIDENT.md), [docs/TABLETOP.md](docs/TABLETOP.md) | Incident response runbook and a tabletop exercise |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md), [docs/GOVERNANCE.md](docs/GOVERNANCE.md), [docs/PENTEST_SCOPE.md](docs/PENTEST_SCOPE.md), [docs/E2E_DESIGN.md](docs/E2E_DESIGN.md), [SECURITY.md](SECURITY.md) | Control mapping, who decides what, the scope for an outside test, a design for end-to-end encryption (not built), how to report a vulnerability |
| [apps/mobile/README.md](apps/mobile/README.md) | The Android app: same screens and rules, how it signs in, how to build the APK |
| [`witness` branch](https://github.com/azeem-web-dev/TrustVault/tree/witness) | Every signed audit checkpoint, recorded by GitHub outside the server's reach |
| [Sigstore public log](https://search.sigstore.dev/?logIndex=3633615638) | Every signed audit checkpoint, published within about a minute; nobody can remove an entry |

---

# Beyond the brief

Everything below goes further than the ten requirements. None of it is needed to check them.

## What it protects beyond the brief

- **View only** (a level below Read): the document's pages drawn by the server with the viewer's email, the time and a trace code; never the original file, in either lock. Downloads are stamped the same way. The Android app keeps files only encrypted, with a key the server releases on every open and destroys on revoke (THREATS.md V1-V10).
- **Access policies on a share**: downloads only with the owner's approval, working hours in a named time zone, network allowlists; role-wide rules set by admins; time-boxed emergency exceptions (P1-P15).
- **Two administrators** for break-glass (which shows pages only) and for clearing an owner's or admin's second factor; **step-up** (a fresh second factor) before risky actions; a per-role **MFA policy**; signed-in devices; Android passkeys and app lock (S19-S24).
- **The key service decides too**: keyd releases a file key only against a single-use ticket the database issues for that person, version and audit event, and keeps its own signed ledger, reconciled with the audit log every hour (K5-K14).
- **Insider detection and hard limits**: persistent, reviewable alerts (bulk downloads and page views, unusual hours or networks, coverage of what someone can open), download limits per day and per session, and a recorded download lifecycle (L15-L19, U9-U10).
- **Two-step verification for everyone**: authenticator app, passkeys, or an emailed code (not for admins: their mailbox must not be enough); turning a method on or off needs a code (S30).
- **Sign-in abuse**: nobody can lock someone else out; stuffing and distributed guessing are detected; new devices confirm by email under attack (S27-S29).
- **Hostile files**: PDFs and Office files checked structurally in a resource-limited worker; every PDF stored as a sanitized copy rebuilt without JavaScript, actions, attachments, multimedia and forms (the uploader is told what was removed; the copy must pass the full check again and is scanned again); CSV formulas neutralised on request; a strict production CSP with browser tests (C1-C11, W1-W8).
- **Refused uploads are evidence too**: every refused upload or new version (wrong type, too large, polyglot, macros, PDF that could not be made safe, malware, scanner down, rate limit, bad form) leaves a `DENIED`/`FAILED` audit row with the file name, size and SHA-256 of what was received (L22).

## Second factor

- **Google Authenticator in three steps** (Account page, website or app): install the app, scan the QR code (or tap "Open in authenticator app" on the phone, or copy the key shown in groups of four), type the 6-digit code. Codes are standard RFC 6238, tested against the RFC's own vectors, so any authenticator app works.
- **Who must use one:** every admin, always. An admin can add owners, viewers or externals under Administration → Settings; it applies from everyone's next click.
- **Step-up:** risky actions (role changes, deactivating, resets, break-glass, the policy itself, transferring or permanently deleting a document, removing a factor, signing out devices) ask for a fresh code or passkey if the last one was more than 5 minutes ago (THREATS.md S20).
- **Signed-in devices:** Account shows where you are signed in; sign out one device or all others (S23).
- **Android app:** passkeys through Android's Credential Manager, the same passkeys as the website (S22), and a face / fingerprint / PIN lock when the app is opened or comes back after 30 seconds (S24).

## How it works

```
Browser ──HTTPS──► nginx (TLS, HSTS, rate limits, X-Forwarded-For overwritten)
                    ├── /api/* ──► NestJS API (user trustvault, systemd sandbox, loopback only)
                    │               ├─ SecurityGuard: Origin → session → CSRF → 2nd factor → role → step-up
                    │               ├─ decide()  ← LOCK 1: every document route, deny by default
                    │               ├─ prisma.asUser(): sets app.user_id for the transaction
                    │               ├─ uploads ──unix socket──► clamd (ClamAV; no clean answer, no upload)
                    │               └─ keyd client ──unix socket──► tvkeyd (Rust, user tvkeyd, no network)
                    │                                               master key · wraps file keys · signs checkpoints
                    └── /* ─────► Next.js web (user trustvault, sandboxed)

PostgreSQL 16 (API connects as a role that owns nothing)
  ├─ row-level security on every document table  ← LOCK 2: tv_doc_level(), written separately in SQL
  ├─ triggers: grant rules, owner-only changes, externals never in groups
  ├─ files: AES-256-GCM ciphertext, one random key per version, bound to its row
  └─ audit_events: hash chain assigned by a trigger; UPDATE/DELETE/TRUNCATE refused even for the owner
Redis (localhost, ACL-restricted): rate limits, BullMQ jobs (checkpoints every minute, retention, verification,
  nightly re-scan of every stored file with the latest malware signatures; infected versions are quarantined)
Nightly: encrypted backup (database + master key + config, age-encrypted to an offline key)

trustvault-anchor (every minute; own throwaway user, no DB password, no keyd, no open port)
  └─ reads the public checkpoint list on localhost ──HTTPS──► rekor.sigstore.dev (Sigstore transparency log)
     each new checkpoint becomes a permanent public entry; Rekor's signed receipt is checked before moving on

GitHub Actions, scheduled every 15 min (GitHub often runs it hours late) ──HTTPS──► GET /api/witness/checkpoints (signed heads only)
  └─ checks nothing it saw before changed, commits new heads to the `witness` branch
     (the server has no credential for it, so root on the server cannot rewrite what was witnessed)
  └─ checks every Sigstore entry signed with the audit key still matches the server
```
