# THREATS.md

How I believe TrustVault could be broken, what I did about each, how I know it holds, and what I knowingly accepted. Statuses:

- **done**: defended, and the test named in the right-hand column fails if the defence is removed. `node tools/mutation-check.mjs` removes the main checks one by one to prove it; see [docs/MUTATION_REPORT.md](docs/MUTATION_REPORT.md).
- **accepted**: a known weakness I chose to leave, with the reason.
- **partial**: some defence, with the gap stated.

Test files live in `apps/api/test/`. "live" means checked by hand against https://vault.rayyanazeem.cloud.

## The model in one paragraph

Every document request passes **two independent locks**. Lock 1 is `decide()` in `apps/api/src/documents/access.ts`, a pure function over raw facts that denies by default. Lock 2 is Postgres **row-level security**, driven by `tv_doc_level()`, written separately in SQL. The API connects as a role that owns nothing, so RLS always applies, and it sets `app.user_id` per transaction. Grants and group membership are read live on every request; nothing is cached. The audit log is written by the database itself: hash-chained by a trigger, append-only by both privileges and triggers, signed every five minutes by a separate key service, and copied off the server by an outside witness that the server cannot write to.

---

## A. Reaching a document you were not given

| # | Threat | Defence | Status / proof |
|---|---|---|---|
| A1 | Change a document id in the URL or API body (IDOR) | `decide()` on every route that names a document, then RLS. Refusal = 404 + audit row | **done**: `documents.test.ts` "every document route returns 404 to a user with no grant" (13 routes × 4 kinds of outsider), `rls.test.ts`; live |
| A2 | Tell "exists" from "forbidden" by status code, message or timing of the response | Same 404 and message for missing, forbidden and malformed ids | **done**: "a document id that does not exist looks exactly like one you cannot see" |
| A3 | Search, result counts, categories or autocomplete reveal documents you cannot read | Search has its own access filter (`buildSearchWhere`) **and** RLS; counts and categories come from the filtered set | **done**: "search never returns, counts or hints…", `search-filter.test.ts` tests lock 1 alone (as table owner, no RLS) |
| A4 | Old versions still downloadable after access is removed | Version routes go through the same `decide()` and RLS on the parent document | **done**: "revoking a grant…", route list includes `versions/1/download` |
| A5 | Documents in the trash still reachable by people who had a grant | Non-owners get level 0 on a deleted document in both locks | **done**: `access.unit.test.ts` trash cases, "trashed documents disappear for everyone with a grant" |
| A6 | The "who has access" list reveals collaborators to readers | Needs MANAGE | **done**: READ test covers `/access` → 404 |
| A7 | Mass assignment: send `ownerId`, `role`, `level`, `grantedById` in a body | Strict schemas reject unknown fields; owner and granter always come from the session; RLS `WITH CHECK owner_id = current user`, `granted_by_id = current user` | **done**: "you cannot set yourself as owner…", "rejects unknown fields", `rls.test.ts` "nobody can write a grant in someone else's name" |
| A8 | Privilege escalation through grants (EDIT grants itself MANAGE, MANAGE grants MANAGE, change someone else's MANAGE) | App rules plus `grants_guard` trigger: nobody grants above their level; MANAGE is owner-only; you cannot change your own access | **done**: "MANAGE: … cannot give MANAGE", "a manager cannot sneak a MANAGE grant in…", "nobody can grant themselves more access", `rls.test.ts` guard cases |
| A9 | Administrator reads documents | ADMIN role is not access in either lock. Break-glass only: written reason, one hour, READ, alerted, visible to the owner | **done**: `access.unit.test.ts` admin cases, "break-glass gives one hour of READ…"; live: password-only admin gets 403 on documents |
| A10 | Grants to deactivated users, or to externals beyond READ / without expiry | App checks plus trigger; external grants capped at the account's own expiry | **done**: "external people get READ only…", `rls.test.ts` |
| A11 | External users gain access through a group | Externals cannot join groups (trigger), and both locks ignore group grants for externals anyway | **done**: unit case, `search-filter.test.ts`, "externals cannot be added to a group" |
| A12 | Bypass the app and read storage directly | No file storage outside Postgres; bytes are AES-256-GCM ciphertext; the DB listens on localhost only and TrustVault roles are rejected by `pg_hba` on every other database | **done**: "the database holds only ciphertext"; provisioning checks |
| A13 | Swap encrypted blobs between documents with database write access | Each blob is encrypted with additional data `document id, version id, version number`; a moved blob fails decryption and is reported | **done**: "a blob moved to another document fails its integrity check" |
| A14 | AI suggestion widens access on its own | The suggestion code only reads; a grant needs an explicit owner action; suggestion and decision are both audited (`source: suggestion_confirmed_by_owner`) | **done**: "suggests people… grants nothing, and audits the suggestion" |
| A15 | Ownership transfer leaves the old owner a silent permission | Old owner keeps nothing; the new owner must be an active OWNER (trigger enforces too) | **done**: "transfer: the new owner gets everything, the old owner keeps nothing" |
| A16 | Order of checks leaks information (e.g. "you already own this" before "not found") | Authorisation runs first in every handler | **done**: found by a test during the build (PROMPTS.md), now covered by the 13-route test |

## R. Taking access away

| # | Threat | Defence | Status / proof |
|---|---|---|---|
| R1 | Old session keeps working after deactivation, role change or password change | Admin actions delete sessions in the same transaction; **and** every request re-reads session and user (status, expiry, `password_changed_at`) as a backup | **done**: auth tests incl. "the session lookup re-checks the account…" (changes the account behind the API's back) |
| R2 | A permission cached somewhere (Redis, memory, browser) | No permission cache anywhere; `Cache-Control: no-store` on every API response and download | **done**: revocation tests pass on the very next request |
| R3 | Removing someone from a group does not take effect | Membership read live in both locks | **done**: "removing someone from a group removes their access through it at once" |
| R4 | A grant past its expiry keeps working | Expiry checked on every request in both locks | **done**: "a grant that has expired stops working", unit cases |
| R5 | Share links outliving revocation | **Not built on purpose**: there are no anonymous links. Outsiders get EXTERNAL accounts with an expiry | n/a (design decision, see docs/PLAN.md) |
| R6 | A download already streaming when access is revoked | **accepted**: it completes. A file already on someone's disk cannot be recalled; the audit log records that it was downloaded | accepted |

## L. The audit trail

| # | Threat | Defence | Status / proof |
|---|---|---|---|
| L1 | Edit or delete audit rows through the app | App role has INSERT and SELECT only; triggers refuse UPDATE/DELETE/TRUNCATE **even for the table owner**; the trigger, not the app, assigns `seq`, time and hashes | **done**: `audit-db.test.ts` |
| L2 | Someone with full database access rewrites history | Hash chain (`audit_verify()` finds the first altered row), unique `prev_hash` (no forks), Ed25519-signed checkpoints every minute (when there are new events) from keyd, which the database cannot forge | **done**: "audit_verify finds the exact row if history is rewritten", "verifies the chain and signed checkpoints" |
| L3 | Action succeeds but its audit row is lost | Audit insert in the same transaction as the action; downloads are audited and committed before the first byte is sent; retention purge and audit in one transaction | **done** by construction; download path covered in document tests |
| L4 | Refused attempts are not recorded | Every refusal writes a DENIED row with the real reason, outside the failing transaction | **done**: refusal tests read the rows back |
| L5 | Cutting off the newest events (tail truncation) | A checkpoint is signed every minute there are new events, and within about a minute more it is in Sigstore's public log (L8). A missing checkpointed event is reported by in-app verification, by the witness, and by `verify-audit.mjs --witness` / `--rekor`. Remaining: events from the last minute or two before a compromise (signed but not yet published) can still be cut off by someone with root | **done**; window about 1–2 minutes (was about 20) |
| L6 | Log injection: newlines or HTML in file names shown in the admin view | Values stored as data (JSON / text columns), rendered by React (escaped); never interpreted | **done** by construction |
| L7 | Exported evidence altered before reaching an auditor | `tools/verify-audit.mjs` re-verifies offline, optionally against a pinned public key | **done**: "exports a bundle the offline tool verifies — and the tool catches an edited event" |
| L8 | Root on the server rewrites the database **and** asks keyd to sign the forged head | **Two outside records.** (1) **Sigstore's public transparency log.** `trustvault-anchor.timer` runs `tools/anchor.mjs` every minute. It is a separate service with its own throwaway user, no database password, no key service access and no open port (the API itself still has no internet access at all): it reads the public checkpoint list on localhost and submits each new checkpoint to rekor.sigstore.dev as a signed `rekord` entry, and verifies Rekor's signed receipt (pinned Rekor key) for exactly that checkpoint before moving on. Nobody can remove or change a Rekor entry. (2) **GitHub witness.** Every 15 minutes a GitHub Actions workflow (`.github/workflows/witness.yml`), for which this server holds no credential, fetches the checkpoints from the public endpoint (`GET /api/witness/checkpoints`). It checks that every checkpoint it saw before is unchanged and the chain's current hash at the last one, verifies new signatures against the pinned key, and commits them to the protected `witness` branch. It also lists every Rekor entry signed with the audit key: each must match a checkpoint the server still reports, and a checkpoint unpublished for an hour fails the run. Any failure: nothing recorded, the workflow fails, GitHub emails the owner. A forger holding keyd's key can sign a new history, but cannot match what is already public; `verify-audit.mjs --rekor` rejects a full exported bundle that disagrees with any earlier public entry | **done**: `witness.test.ts` (a forgery re-signed with the real key; events rewritten behind untouched checkpoints; deleted, backdated and badly signed checkpoints; a key swap; a recomputed bundle), `anchor.test.ts` against a fake Rekor that signs its receipts (in-order publishing, log down, a receipt for another entry, a receipt not signed by the pinned key, lost state, key change; a checkpoint changed or deleted after publishing, even re-signed; unpublished for an hour; a recomputed full bundle); mutation check; live (first entry: Rekor log index 3633615638) |
| L9 | Concurrent writers fork or reorder the chain | Advisory lock until commit; trigger refuses REPEATABLE READ; unique `prev_hash` | **done**: "concurrent writers produce one unbroken chain" |

## S. Accounts and sessions

| # | Threat | Defence | Status / proof |
|---|---|---|---|
| S1 | Password guessing / credential stuffing | Argon2id (64 MiB, 3 passes); per-IP and per-account limits in Redis (fail closed if Redis is down); account lock after 5 failures, doubling to 24 h, atomic counter; nginx limit on `/auth/login` | **done**: lockout, parallel-guess and rate-limit tests |
| S2 | Account enumeration by message or timing | One message for every failure. Every failure path does the same work: one Argon2 verify (a dummy hash for unknown accounts) and one database statement (a wrong password's counter, lock and audit row are a single SQL statement). On top of that, every failed login is padded to at least 450 ms | **done, measured**: `npm run measure:timing` ([docs/LOGIN_TIMING.md](docs/LOGIN_TIMING.md)). The first measurement found a real leak (78% attacker accuracy; fixed, see PROMPTS.md). After the fix an attacker's best threshold scores at chance |
| S3 | Session theft through XSS | `__Host-` HttpOnly Secure SameSite=Strict cookie; nonce + `strict-dynamic` CSP on every page; uploads never rendered inline; CSRF token in memory only | **done**: cookie test; CSP checked live |
| S4 | CSRF | SameSite=Strict, Origin check, per-session CSRF token compared in constant time | **done**: CSRF and cross-origin tests (including a cross-site upload) |
| S5 | Session fixation | New random token at login and at every MFA step; the browser's old session is ended | **done**: "logging in again… replaces the old session", "the password-only session token no longer works" |
| S6 | Admin account takeover with a stolen password | Second factor required for every admin (TOTP or passkey); a password-only session reaches only sign-in routes | **done**: `admin-mfa.test.ts` |
| S7 | TOTP code replayed or guessed | Each code works once (atomic "newer step" update); 5 tries per 5 minutes | **done**: replay and rate-limit tests |
| S8 | Attacker with a password adds their own second factor | Enrolling another factor requires the existing one in this session | **done** by construction (`requireMfaIfEnrolled`) |
| S9 | Lockout used to deny service to a known user | **accepted** trade-off: capped at 24 h, admin can clear it; the alternative is unlimited guessing | accepted |
| S10 | Spoofed `X-Forwarded-For` to dodge IP limits or falsify the audit IP | nginx overwrites the header; Express trusts loopback only | **done**: live, a forged `1.2.3.4` was logged as the real IP |
| S11 | Lost phone locks an admin out | Another admin can reset a user's second factor (audited, sessions end). An admin cannot reset their own | **done** |
| S12 | Passkey phishing, cloning or replay | WebAuthn binds each assertion to our origin and RP id; user verification (PIN or biometric) required; each challenge works once and only in the session it was issued to; the signature counter must increase | **done**: `passkeys.test.ts` runs the whole ceremony with a software authenticator (real P-256 keys, real WebAuthn bytes): enrol, sign in, wrong origin, other key, unknown credential, replay, counter going backwards, challenge from another session, no user verification, wrong RP id. `test/e2e/passkey.e2e.ts` runs it in **real Chrome** through the real pages and API, with Chrome's virtual authenticator: an admin made to enrol, sign-in with the counter moving forward, a second device added from the Account page, and a device without the passkey staying at the second step; in CI on every push. Not yet tried with a physical phone or security key on the live site |

## U. Uploads and downloads

| # | Threat | Defence | Status / proof |
|---|---|---|---|
| U1 | Fake file type (extension or Content-Type spoofing) | Type from magic bytes only; the stored name gets the real extension | **done**: "accepts a real Word document and stores the detected type" |
| U2 | HTML/SVG/script uploaded and opened on our origin (stored XSS) | Markup refused; downloads always `attachment` + `CSP: sandbox` + `nosniff` | **done**: HTML/SVG cases, download header test |
| U3 | Active content: PDF JavaScript, macro Office files | Refused | **done**: PDF-JS and `vbaProject.bin` cases |
| U4 | Path traversal in file names or archive entries | File names are metadata only (sanitised); ZIP entries with `..`, `/` or `\` refused; nothing is unpacked | **done** |
| U5 | Oversized uploads, zip bombs | 25 MB cap enforced while streaming (413); nginx cap; archives never decompressed | **done**: size test |
| U6 | Malware in an allowed type | Every upload and new version is streamed to ClamAV (clamd, signatures kept current by freshclam) before it is encrypted and stored. Infected: 422 and a DENIED audit row naming the signature. Scanner down, slow, or any answer but an exact `OK`: 503, a FAILED audit row, nothing stored (fails closed). Files too large or deep to scan fully are reported as found and refused. Production refuses to start without the scanner. New versions are scanned only after the permission check, so outsiders cannot use the scanner. Active content is refused by type before scanning: macros, PDF JavaScript and launch actions, embedded files, executables, HTML/SVG, encrypted archives. **Nightly re-scan** (04:15 UTC): every stored version is decrypted and scanned again with that day's signatures, so malware that was unknown at upload time is found once ClamAV learns it. A version found infected is quarantined: downloads refused (403, audited), marked in the version list, a critical admin alert. The app can add a quarantine but not remove one. A run that loses the scanner stops, assumes nothing is clean, and alerts. Remaining: malware no scanner recognises yet stays undetected until one does; files are still never executed or previewed on the server | **done**: "uploads are scanned for malware..." (EICAR, an editor's new version, an outsider never reaching the scanner, scanner down / garbage / silent), `scanner.unit.test.ts`, `rescan.test.ts` (a file stored clean and found by a later signature, only that version blocked, no double quarantine, scanner down then resume, time-budget resume, a tampered blob reported, the app cannot release a quarantine); mutation check; live EICAR test |
| U7 | Upload flooding | 60 uploads / 10 min per user | **done** by construction |
| U8 | The malware scanner itself is attacked through a crafted file | clamd runs as its own user under Ubuntu's AppArmor profile, on a Unix socket only (no TCP), memory-capped; it never sees a path, only a stream | **done** by configuration (`install-clamav.sh`) |

## K. Keys and cryptography

| # | Threat | Defence | Status / proof |
|---|---|---|---|
| K1 | Encryption keys stolen together with the database | Data keys are stored only wrapped; the master key lives in keyd, a separate process and Linux user. The API never holds it | **done**: live, keyd refused root and every uid but the API's |
| K2 | A compromised API gets keyd to sign forged audit data | keyd signs only `tv-checkpoint-v1|…` messages | **done**: keyd unit test, live probe |
| K3 | Key material swapped to disk or in a core dump | keyd `mlockall`, non-dumpable, `LimitCORE=0` | **done**: `VmLck` checked live |
| K4 | Master key or database lost | Nightly encrypted backup (`trustvault-backup.timer`): database dump, master key and config in one archive, encrypted with `age` to a public key whose private half is not on the server; 14 days kept; restore tested ([docs/RESTORE.md](docs/RESTORE.md)). **Remaining, by the owner's choice:** the backups stay on this one server, so losing the machine loses them. Copying them off-site is one `scp` | **partial**: backup and restore tested on the server |

## I. Infrastructure

| # | Threat | Defence | Status / proof |
|---|---|---|---|
| I1 | A TrustVault compromise spreads to the other services on this shared server | Dedicated users; systemd sandbox (API `systemd-analyze` 1.1, keyd 0.5); `pg_hba` rejects TrustVault roles everywhere else; Redis ACL per key prefix with admin commands removed | **done**: checked on the server |
| I2 | Secrets committed to git | `.env` ignored; secrets only on the server; gitleaks in CI | **done** |
| I3 | Verbose errors leak internals | One exception filter; unexpected errors are a generic 500 with a request id | **done** |
| I4 | CORS misconfiguration | Same origin; CORS never enabled | **done** |
| I5 | Supply-chain install scripts run on the server | `npm ci --ignore-scripts`, then only the three approved packages rebuilt; keyd built by an unprivileged user | **done** |
| I6 | Full root compromise of the server | **accepted**: root can read process memory, including keyd's, and every file. It cannot alter audit history already published to Sigstore or recorded by the GitHub witness without being detected (L8), and it cannot decrypt older backups (they are encrypted to an offline key) | accepted |
| I7 | Demo credentials are published | **accepted**: required by the brief. Demo accounts can only reach demo documents | accepted |
| I8 | A visitor uses the published admin login to break the demo for the next visitor | Demo accounts are protected: cannot be deactivated, demoted, renamed, have their password or second factor changed | **done**: "protected demo accounts…" |
| I9 | The witness endpoint leaks information | It returns checkpoint numbers, hashes, signatures and times only (no names, actions or document ids) and is rate limited. It does reveal roughly how much activity there is (the event count) | **done**: "answers without signing in and reveals no event content"; activity volume accepted |
| I10 | The Sigstore publisher becomes a way in or out | It has no listening port, no database password, no key service socket, and cannot read the app's files (systemd `DynamicUser`, `InaccessiblePaths`). It reads only public data and sends only public data (checkpoint numbers, hashes and signatures, already public on the witness branch) to rekor.sigstore.dev. It checks every Rekor receipt against a pinned key, so a fake log cannot make it skip checkpoints | **done** by design (`infra/systemd/trustvault-anchor.service`) |

## Not built, on purpose

- **Anonymous share links.** Every outsider is a named EXTERNAL account with an expiry, so there is never a link that works for whoever holds it.
- **End-to-end encryption.** It would stop the server from validating uploads, searching and auditing. The threat it addresses (a fully compromised server) is accepted above (I6, L8).
- **Previews.** Rendering untrusted files server-side is a large attack surface; files are only ever downloaded.
- **Folder inheritance.** Folders organise and never grant. "Given a folder to see one file, can now see forty" is the first problem in the brief.
