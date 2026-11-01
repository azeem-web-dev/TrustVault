# THREATS.md

Ways I believe TrustVault could be broken, what I did about each, and what I accepted. Status: **planned** → **done** (with the test that proves it) → **accepted** (with the reason).

This list is started on day one from the design and grows as I build and attack the deployed system.

## Access to documents

| # | Threat | Plan | Status |
|---|---|---|---|
| A1 | Change a document ID in the URL/API (IDOR) | Every route calls `decide()`; random UUIDs; RLS as second layer | planned |
| A2 | Guess or enumerate IDs; tell "exists" from "forbidden" | UUIDs; `404` for both; denial logged | planned |
| A3 | Search, counts or autocomplete reveal titles of documents I can't read | Permission filter inside the search SQL; counts computed after filtering | planned |
| A4 | Old versions reachable after revoke | Version routes call `decide()` on the parent document | planned |
| A5 | Trash / deleted documents still downloadable | Deleted documents give no access except owner restore | planned |
| A6 | Access list ("who can see this") readable by viewers | Requires MANAGE | planned |
| A7 | Mass assignment: send `ownerId`, `role`, `level` in a body | Strict Zod schemas reject unknown keys; server sets owner from session | **done** (auth) — `rejects unknown fields (mass assignment)` |
| A8 | Privilege escalation through grants (EDIT grants self MANAGE, MANAGE grants MANAGE) | "Cannot grant above own level" rule, tested | planned |
| A9 | Admin reads document contents | Admin role ≠ document access; break-glass audited and alerted | planned |
| A10 | Grant to a deactivated user or external user without expiry | Rejected at grant time and ignored at decide time | planned |
| A11 | Bypass the app and hit storage directly | No public storage; encrypted bytes only in Postgres; DB not exposed | planned |
| A12 | AI suggestion widens access by itself | AI code returns suggestions only; owner confirms; both audited | planned |

## Revocation

| # | Threat | Plan | Status |
|---|---|---|---|
| R1 | Old session still works after deactivation, role change or password change | Sessions deleted in the same transaction; every request re-reads session + user; `password_changed_at` invalidates older sessions | **done** — `deactivating a user ends their live session…`, `changing a user role…`, `changing your password ends every session…` |
| R2 | Permission cached somewhere (Redis, memory, browser) | No permission cache; `Cache-Control: no-store` | planned |
| R3 | Share link keeps working after revoke | Links stored hashed, checked on every use, expiry required | planned |
| R4 | Group removal not immediate | Membership read live | planned |
| R5 | Download in progress at revoke time | **Accepted**: completes; already-downloaded copies cannot be recalled | accepted |

## Audit trail

| # | Threat | Plan | Status |
|---|---|---|---|
| L1 | Edit or delete audit rows through the app | App DB role has INSERT/SELECT only; triggers block UPDATE/DELETE/TRUNCATE even for the owner; trigger assigns seq/time/hash | **done** — `test/audit-db.test.ts` |
| L2 | DB superuser rewrites history | Hash chain + Ed25519 checkpoints signed by keyd + daily off-server export of the head | planned |
| L3 | Action succeeds but audit write fails | Same transaction; audit failure aborts the action | **done** for user/session changes; documents next |
| L4 | Refused attempts not recorded | Denials written as audit rows with reason, outside the failing transaction | **done** for login, CSRF, role — `records refused logins…`, `…attempt is audited` |
| L5 | Log injection (newlines, HTML in filenames shown in admin view) | Structured storage, escaped rendering | planned |
| L6 | Cutting off the newest audit rows (tail truncation) | Checkpoints + off-server head export detect it | planned |

## Authentication and sessions

| # | Threat | Plan | Status |
|---|---|---|---|
| S1 | Password brute force / credential stuffing | Argon2id (64 MiB, t=3); Redis limits per IP (20/15 min) and account (10/15 min), fail closed; lock after 5 failures doubling to 24 h with an atomic counter; nginx 10/min on login | **done** — `locks the account…`, `counts parallel wrong guesses…`, `rate-limits one IP…` |
| S2 | Account enumeration via login messages or timing | One message for every failure; unknown accounts verify against a dummy Argon2 hash | **done** (message) — `gives the same answer…`; timing equalised by design, not yet measured |
| S3 | Session theft via XSS | `__Host-` HttpOnly cookie; nonce + strict-dynamic CSP on every page; CSRF token in memory only | **done** — `sets a __Host- cookie…`; CSP checked live |
| S4 | CSRF | `SameSite=Strict`; Origin must match; per-session CSRF token, constant-time compare | **done** — `logout needs the CSRF token…`, `a CSRF token from another session does not work`, `refuses a cross-origin login attempt` |
| S5 | Session fixation | Fresh random token on every login; the browser's previous session is ended; role change ends sessions | **done** — `logging in again from the same browser replaces the old session` |
| S6 | Admin account takeover | Admin requires passkey or TOTP | planned |
| S7 | Attacker locks a known user out with wrong passwords (lockout as denial of service) | **Accepted trade-off**: lockout is capped (doubling up to 24 h) and an admin can clear it; the alternative is unlimited guessing | accepted |
| S8 | Spoofed `X-Forwarded-For` to dodge IP limits or falsify the audit IP | nginx overwrites the header; Express trusts loopback only | **done** — checked live: a forged `1.2.3.4` was logged as the real IP |

## Uploads and files

| # | Threat | Plan | Status |
|---|---|---|---|
| U1 | Fake file type (extension/MIME spoofing) | Magic-byte detection against an allowlist | planned |
| U2 | Uploaded HTML/SVG runs script on our origin | Always `attachment`, `nosniff`, strict CSP, never rendered inline | planned |
| U3 | Path traversal in filenames | Filenames are metadata only; storage key is a UUID | planned |
| U4 | Huge uploads / zip bombs exhaust the server | Size cap at nginx and app; archives not unpacked | planned |
| U5 | Malware uploaded and shared | **Accepted for now**: no AV scanner on this server; files are only ever downloaded, never executed or previewed server-side | accepted |

## Infrastructure

| # | Threat | Plan | Status |
|---|---|---|---|
| I1 | A TrustVault compromise spreads to other services on the shared server | Dedicated user; systemd sandbox (`systemd-analyze security` = 1.1); pg_hba rejects TrustVault roles on every other database; Redis ACL per key prefix | **done** — checked on the server |
| I2 | Encryption keys stolen together with the database | Keys live in keyd (separate user, Unix socket); DB holds only wrapped data keys | planned |
| I3 | Secrets committed to git | `.env` ignored, secrets only on the server, gitleaks in CI | planned |
| I4 | Verbose errors leak internals | One exception filter; unexpected errors become a generic 500 + request id | **done** — `malformed JSON gives a clean 400…` |
| I5 | CORS misconfiguration | Same origin (nginx routes /api); CORS never enabled; Origin checked on writes | **done** |
| I6 | Full server compromise (root) | **Accepted**: root could read keyd memory. Off-server audit export still proves what happened up to that point | accepted |
| I7 | Seed credentials published in README | **Accepted**: required by the brief for judging; seed accounts can only reach seed documents | accepted |
| I8 | Anyone with the published demo admin password can deactivate the other demo accounts or create users, breaking the demo for the next visitor | Planned: demo accounts flagged as protected (cannot be deactivated, demoted or have their password reset through the API) and a nightly demo reset | planned |
| I9 | A compromised dependency's npm install script runs on the server | `npm ci --ignore-scripts`, then rebuild only the three approved packages | **done** |
