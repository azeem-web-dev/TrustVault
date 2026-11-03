# TrustVault

A document platform where the wrong person can never read the file, and you can prove who read it.

**Live:** https://vault.rayyanazeem.cloud

## Demo accounts

| Role | Email | Password | What to try |
|---|---|---|---|
| Admin | `admin@demo.com` | `admin1234567` | Needs a second factor: add the secret below to an authenticator app (Google Authenticator, 1Password, Authy...) or generate a code with `oathtool --totp -b <secret>`. Audit log, alerts, verify integrity. Break-glass and clearing an owner's second factor need a second admin's approval (THREATS.md S19): ask here, approve as Ben. |
| Admin 2 | `admin2@demo.com` | `admin2345678` | The second administrator, with its own authenticator secret (below). Approve or reject Ada's requests on the Approvals page; then Ada uses the approval once (break-glass gives one hour of View only). Nobody approves their own request. |
| Owner | `olivia@demo.com` | `owner1234567` | Owns five documents shared in different ways. Share, revoke, see history. |
| Owner | `oscar@demo.com` | `owner1234567` | Owns *Architecture review* (Engineering group can edit, Olivia can manage). |
| Viewer | `victor@demo.com` | `viewer123456` | Sees 3 documents (one direct, two through groups). Try to reach *Salary bands 2026*. |
| External | `erin@demo.com` | `external1234` | Sees only the NDA shared with her, read-only, until it expires. |

**Admin authenticator secret:** `NZVD2J3RUX6P7RSZ3FSGBT2ACTCWOPRZ`  
**Admin 2 authenticator secret:** `NIGQMN42LTYZ6MNDYSNHFFOBUVL5C3E6`

The demo accounts are published because the brief asks for them, so they are **protected**: nobody can deactivate, demote, rename them or change their password or second factor (THREATS.md I7, I8). Each code works once (replay-protected). If a code is refused, wait for the next one.

Demo accounts cannot reset their password and never receive email: their addresses belong to someone else.

## Second factor

- **Google Authenticator in three steps** (Account page, website or app): install the app, scan the QR code (or tap "Open in authenticator app" on the phone, or copy the key shown in groups of four), type the 6-digit code. Codes are standard RFC 6238, tested against the RFC's own vectors, so any authenticator app works.
- **Who must use one:** every admin, always. An admin can add owners, viewers or externals under Administration → Settings; it applies from everyone's next click.
- **Step-up:** risky actions (role changes, deactivating, resets, break-glass, the policy itself, transferring or permanently deleting a document, removing a factor, signing out devices) ask for a fresh code or passkey if the last one was more than 5 minutes ago (THREATS.md S20).
- **Signed-in devices:** Account shows where you are signed in; sign out one device or all others (S23).
- **Android app:** passkeys through Android's Credential Manager, the same passkeys as the website (S22), and a face / fingerprint / PIN lock when the app is opened or comes back after 30 seconds (S24).

## Roles

| Role | Can | Cannot |
|---|---|---|
| Admin | Manage users and groups. See the audit log and alerts, verify integrity, export evidence. Send a password reset link (never set a password). Break-glass: ask with a written reason of at least 20 characters; once a **second** admin approves, one hour of View only on one document (watermarked pages, no download), alerted, emailed to the owner and shown in that document's history. Clearing an owner's or admin's second factor also needs a second admin (Approvals page). | Open, download or upload documents (except viewing pages through approved break-glass). Set anyone's password. Approve their own request. Be given access to a document. Join a group. Change the protected demo accounts. |
| Owner | Upload documents. On their own documents: share (View only, Download, Edit or Manage), revoke, edit, upload new versions, move to folders, trash, restore, delete permanently, transfer ownership. | Be moved to another role while they own documents. |
| Viewer | Use what they are granted (levels below). | Upload new documents. Give MANAGE. |
| External | View only or Download, and only on grants with an expiry, until their account's end date. The share screens offer View only first. | Get access through a group. Anything above Download (READ). |

| Level (on one document) | Can | Cannot |
|---|---|---|
| **View only** (`VIEW`) | Find it in search, see its details and versions, read its pages inside TrustVault. Every page is drawn by the server with the viewer's email, the time and a trace code; on Android screenshots and recording are blocked while it is open | Download the file, by any route: the app and the database both refuse. Word, Excel and PowerPoint files have no preview, so View only shows a note to ask the owner |
| **Download** (`READ`) | Also download. PDFs and images are stamped with who downloaded, when and a trace code; the Android app keeps the file only encrypted, with a key it must fetch from the server on every open | Change anything |
| **Edit** (`EDIT`) | Also rename, describe and upload new versions | Share |
| **Manage** (`MANAGE`) | Also share View only, Download or Edit, revoke, see who has access and the history | Give Manage, trash, transfer |
| **Owner** | Everything, including Manage grants, trash, restore, delete and transfer | |

Anyone who can see a page can photograph it. View only keeps originals off devices, Android blocks screenshots, and watermarks make leaks traceable ([THREATS.md](THREATS.md) V1 to V10).

Accounts are created by invitation. An admin enters an email, a role and, if needed, an access end date; the person gets an email with a link (it works once and expires after 72 hours) and chooses their own name and password. Until then the account is **Invited** and can do nothing. The admin never knows the password. Admins can resend or cancel an invitation from the Users screen (THREATS.md S18).

Grants are per document, to named people or to groups. A group share covers the people in the group when it is shared. Anyone added later waits until the owner (or a manager outside the group) confirms; `GET /documents/:id/access` shows them as pending.

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
| [apps/mobile/README.md](apps/mobile/README.md) | The Android app: same screens and rules, how it signs in, how to build the APK |
| [`witness` branch](https://github.com/azeem-web-dev/TrustVault/tree/witness) | Every signed audit checkpoint, recorded by GitHub outside the server's reach |
| [Sigstore public log](https://search.sigstore.dev/?logIndex=3633615638) | Every signed audit checkpoint, published within about a minute; nobody can remove an entry |

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

GitHub Actions, every 15 min ──HTTPS──► GET /api/witness/checkpoints (signed heads only)
  └─ checks nothing it saw before changed, commits new heads to the `witness` branch
     (the server has no credential for it, so root on the server cannot rewrite what was witnessed)
  └─ checks every Sigstore entry signed with the audit key still matches the server
```

## Tests

```bash
cd apps/api && npx vitest run            # over 230 tests against a real Postgres and Redis
cd apps/api && npm run test:e2e          # passkeys in real Chrome through the real pages (needs Chrome)
cd apps/api && npm run measure:timing    # login timing: can response time reveal which emails exist?
node tools/mutation-check.mjs            # removes every authorisation rule listed in tools/mutation-check.mjs (59 of them), one at a time; every removal must fail a test
node tools/verify-audit.test.mjs         # the offline audit verifier against forged and cut bundles
cd keyd && cargo test                    # key service
node tools/verify-audit.mjs bundle.json --key OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE= --witness checkpoints.jsonl --rekor   # verify an audit export: pinned key, witness, Sigstore
```

| Test file | Proves |
|---|---|
| `access.unit.test.ts` | `decide()` alone: every rule, deny by default |
| `rls.test.ts` | the database alone (no API code): RLS policies and guard triggers |
| `search-filter.test.ts` | the search access filter alone (run where RLS does not apply) |
| `view-only.test.ts` | View only: pages yes, original no (both locks), watermark and trace code in the audit row, stamped downloads, revoke stops pages and the Android key, externals, break-glass, bulk-viewing alert and rate limit |
| `documents.test.ts` | end to end: 13 document routes refused for 4 kinds of outsider, search leaks nothing, revocation is immediate, uploads validated and malware-scanned (fails closed), files encrypted, blob swaps detected, break-glass, suggestions |
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
| `mfa-policy.test.ts` | adding a role to the MFA policy forces its open password-only sessions to enrol; ADMIN cannot be removed (API and database); admins only, with step-up |
| `devices.test.ts` | your own sessions only: list, sign out one, sign out all others; someone else's session is `404` |
| `passkeys-android.test.ts` | the Android app's `android:apk-key-hash` origin accepted only when configured; other signing keys refused |
| `totp.unit.test.ts` | RFC 6238 Appendix B vectors, clock drift of one step, the `otpauth://` URI Google Authenticator reads |
| `email.test.ts` | password reset links reveal nothing, work once, expire, are built from the configured site and end every session; admins send links and never see passwords; notices for sign-ins, password and second-factor changes, and shares; demo accounts never get mail |
| `identity-guards.test.ts` | the database on its own, as the app's real role: no self-promotion, no role or status change without an admin, never the last admin, no password or second factor set for someone else, groups only by admins, hashes and TOTP secrets unreadable; malformed `app.user_id` fails closed |
| `invite.test.ts` | accounts by invitation: no admin-chosen password, invited accounts can do nothing, links work once, expire, are built from the configured site and never work as reset links (or the reverse); resend and cancel; reactivating a never-accepted account keeps it invited |
| `checkpoint-guard.test.ts` | the database accepts an audit checkpoint only for a real event with the same hash, and only moving forward |
| `tools/verify-audit.test.mjs` | the offline verifier (19 cases): pinned key, no checkpoints, recomputed forged chains, cut-off tails caught through Sigstore or the witness |

## Run it locally

Needs Node 22+, PostgreSQL 16 and Redis 7.

```bash
git clone https://github.com/azeem-web-dev/TrustVault.git && cd TrustVault
npm ci --ignore-scripts && npm rebuild prisma @prisma/engines esbuild
sudo bash infra/server/provision.sh        # or create the roles in infra/ci/setup-db.sql by hand
cp apps/api/.env.example apps/api/.env     # fill in URLs; LOCAL_MASTER_KEY=$(openssl rand -base64 32)
cd apps/api
npx prisma migrate deploy                  # runs as DATABASE_OWNER_URL
npx tsx --env-file=.env prisma/seed.ts     # demo data with dev-only passwords
npm run dev                                # API on http://127.0.0.1:4100
cd ../web && npm run dev                   # web on http://localhost:3005 (set PUBLIC_ORIGIN to match)
```

## Deploy (Ubuntu 24.04, from a clean machine)

```bash
sudo bash infra/server/provision.sh     # users, databases, roles, pg_hba, Redis ACL
sudo bash infra/server/install-app.sh   # env files, systemd units, nginx, TLS (certbot)
sudo bash infra/server/install-keyd.sh  # build and start the key service; generates the master key
sudo bash infra/server/install-clamav.sh          # malware scanner for uploads; checks it detects EICAR
sudo bash infra/server/install-backup.sh age1...  # nightly encrypted backup to an offline key (docs/RESTORE.md)
sudo bash infra/server/deploy.sh        # fetch, install, build, migrate, restart, health check
```

Email (optional) is set in `/etc/trustvault/mail.env` on the server (root:trustvault, 0640, read by the API service; never in git): `MAIL_TRANSPORT` (`off`, `smtp` or `memory` for tests), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `RESET_LINK_MINUTES`. With `smtp`, the API refuses to start unless host, user and password are set. `INVITE_LINK_HOURS` (default 72) sets how long an invitation link works.

Then seed with production passwords (`SEED_PASSWORD_*`, `SEED_ADMIN_TOTP_SECRET` in `/etc/trustvault/seed.passwords`); see `apps/api/prisma/seed.ts`. The seed connects as the schema owner (`DATABASE_OWNER_URL`, as for migrations): the app's own role may not create active or protected accounts (THREATS.md A23).
