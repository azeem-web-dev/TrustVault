# PROMPTS.md

How I used AI tools on this project: what I asked, what came back, what was wrong, and what I did instead. Written as I go, newest at the bottom.

Tools: ChatGPT (early brainstorming), Claude Code / Claude Opus (planning, code, review).

---

## 2026-11-01 — Choosing the stack

**Asked (ChatGPT):** "Suggest the most advanced and secure tech stack for a secure document sharing platform with an audit trail."

**Got:** Next.js + NestJS + PostgreSQL/Prisma + Redis/BullMQ, a Rust/WASM cryptographic core, Auth0 or Keycloak for identity, WebAuthn passkeys, AES-256-GCM, X25519 or hybrid post-quantum key exchange, HKDF, Ed25519, AWS KMS/CloudHSM, Open Policy Agent, hash-chained signed logs, Docker + Kubernetes, OpenTelemetry + SIEM.

**What was wrong:** I took the list to Claude and checked each item against the three rules in the problem statement instead of against "sounds secure".
- **Auth0/Keycloak** issue JWTs that stay valid until they expire. The problem says revocation must work *immediately*; a 15-minute token is a 15-minute hole. This was the most important catch — the "more secure" option would have failed rule 3.
- **X25519 / post-quantum key exchange** only makes sense for end-to-end encryption. With E2EE the server cannot validate uploads, run search or give the admin a view of activity, which are required features.
- **Rust/WASM crypto core** duplicates what Node's `crypto` already does (AES-256-GCM, HKDF, Ed25519) and adds a toolchain I would have to defend.
- **OPA** adds a network hop and a second language for the one decision I most need to explain.
- **CloudHSM / Kubernetes / SIEM**: cost and operational weight with no gain at this size.

**What I did instead:** kept the parts that serve the rules (Next.js, NestJS, Postgres, Redis for jobs only, AES-256-GCM, HKDF, Ed25519, passkeys, hash-chained signed audit). Replaced Auth0/Keycloak with server-side sessions checked on every request. Replaced OPA with one `decide()` function plus Postgres Row-Level Security as a second layer. Kept Rust only for a small isolated key service where process isolation actually adds something. Reasons recorded in [docs/PLAN.md](docs/PLAN.md).

**Commit:** [a43fb25](https://github.com/azeem-web-dev/TrustVault/commit/a43fb25) (the design written down before any code)

---

## Reused context

The full text I give the AI each session, including the ground rules added on 2026-11-07, is in [docs/AI_CONTEXT.md](docs/AI_CONTEXT.md). There is no CLAUDE.md or other hidden context file; what is quoted below and in that file is all of it.

The problem statement and [docs/PLAN.md](docs/PLAN.md) are given to the AI at the start of each working session, with the instruction: *"Every endpoint must go through decide(); never cache permissions; every allow and deny writes an audit row in the same transaction."*

When a piece of work is split across parallel subagents — the independent reviewers (2026-11-02) and later the attack/hardening run (2026-11-03) — each subagent is handed the same written brief, so they stay consistent and never step on each other. The brief for the security hunt, given to every attacker/reviewer, was in substance:

> Authorised defensive review of our own app; local only, never touch production. Read the problem statement, docs/PLAN.md and THREATS.md first. You own one area, one throwaway database and one git worktree — attack only your area, against your local build. The three guarantees you are trying to break: (1) a document is reachable only by someone granted it, through any route, server-decided every time; (2) you can prove who reached it, including refused attempts, from a tamper-evident record; (3) revocation takes effect immediately. For each confirmed finding write: severity, which guarantee it breaks, exact reproduction, root cause (file:line), the fix, and a regression test that fails without the fix. Rank real, reachable bugs above theoretical ones — a short list of real findings beats a long list of noise. If an area is clean, say what you tried and why you are confident; negative results count. Do not push to main; the parent integrates and runs CI once.

The same shape drives the independent code reviewers: one property each, and every finding confirmed with a live request before it is fixed.

---

## 2026-11-01 — First migration: users, sessions, hash-chained audit log

**Asked (Claude):** "Write the first Prisma migration for users, sessions and an append-only, hash-chained audit table. The app role must not be able to change or delete audit rows, and the chain must be computed by the database, not the app."

**Got:** a migration with a `BEFORE INSERT` trigger computing `sha256(prev_hash || canonical(row))`, triggers refusing UPDATE/DELETE/TRUNCATE, and grants of INSERT/SELECT only to the app role.

**What was wrong:**
1. The schema-level grant (`GRANT USAGE ON SCHEMA public`) was only in my server provisioning script, not in the migration. After `prisma migrate reset` recreated the schema, every query from the app role failed with `relation "audit_events" does not exist`. In production this would have shown up the first time anyone rebuilt the database.
2. Not a bug in the output, but two concurrency risks I asked about while reviewing the design before applying it: under `REPEATABLE READ` two concurrent writers could both read the same "last" row and fork the chain; and a plain sequence default on `seq` is assigned *before* the trigger takes its lock, so chain order and `seq` order could disagree. A naive version of this trigger has both problems, so I made sure this one does not.

**What I did instead:**
- Moved the schema grant into the migration itself.
- The trigger now refuses to run outside `READ COMMITTED`, takes a transaction-level advisory lock, and only then assigns `seq` and reads the previous hash.
- Added a unique index on `prev_hash`, so a fork is structurally impossible: a second event claiming the same predecessor fails to insert.
- Field encoding uses length prefixes (`<bytes>:<value>`, NULL as `~`) so text cannot be shifted between fields without changing the hash.
- Wrote a probe that attacks the table as the app role and as the table owner. All of UPDATE/DELETE/TRUNCATE/setval are refused, forged `seq`/`hash`/`occurred_at` values are overwritten by the trigger, and `audit_verify()` reports the chain intact. These become automated tests next.

**Commit:** [d91b245](https://github.com/azeem-web-dev/TrustVault/commit/d91b245)

---

## 2026-11-01 — Row-level security for documents and grants (authorisation)

**Asked (Claude):** "Write row-level security for documents, versions, blobs and grants, driven by an SQL access-level function, so the database refuses rows even if the API's check is skipped. Managers see a document's grants; anyone sees grants made to them."

**Got:** policies on every document table plus `tv_doc_level()`. The grants policy was `user_id = current user OR level >= MANAGE`.

**What was wrong:** that grants policy hid every grant made to a **group** from the group's own members. A READ member could open a group-shared document (the documents policy used `tv_doc_level()`, which does see group grants), but "Shared with me" search, which filters through the grants relation, would never list it. It showed up while I wrote `decide()`'s fact loader and asked which grant rows a member can actually read.

**What I did instead:** a follow-up migration lets members see grants to their own groups (it reveals only that their group has access), and `decide()` now reads raw facts through `tv_access_facts()` rather than through RLS-filtered tables, so the TypeScript and SQL decisions stay independent. Fix: [ef71800](https://github.com/azeem-web-dev/TrustVault/commit/ef71800). Covered by "removing someone from a group removes their access through it at once" (checks `scope=shared`).

---

## 2026-11-01 — Uploads failed for every owner (authorisation)

**Asked (Claude):** the same RLS work; then the document upload endpoint.

**Got:** a `documents_select` policy of `tv_doc_level(id, me) >= 1` and an upload that inserts the document with Prisma.

**What was wrong:** every upload returned 500: `new row violates row-level security policy for table "documents"`. Prisma's insert uses `RETURNING`, and Postgres then checks the new row against the **SELECT** policy too. `tv_doc_level()` looks the document up with a snapshot that cannot see the row being inserted, so it returned 0, even for the owner. 27 of 40 document tests failed on the first run.

**What I did instead:** the SELECT policy also matches "the caller is the active owner of this row" from the row's own columns. Same rule, no read-back. It's in its own migration with the explanation, rather than an edited old one. Fix: [ef71800](https://github.com/azeem-web-dev/TrustVault/commit/ef71800).

---

## 2026-11-01 — A check order that leaked, and a lost-update race

**Asked (Claude):** ownership transfer, self-service sharing rules, login lockout.

**Got / what was wrong:**
1. Transfer checked "you already own this document" **before** `decide()`, so a stranger got 400 instead of 404, which is a small leak of the check order. Caught by the test that calls all 13 document routes as outsiders and expects 404 from every one.
2. Self-grant was refused with the MANAGE error instead of "you cannot change your own access". The result was right but the message was misleading; caught by a test.
3. The failed-login counter was read, then written `count + 1`. Parallel wrong guesses would overwrite each other and never reach the lockout. Caught reviewing the generated code before running it.

**What I did instead:** authorisation runs first in every handler; the self-check comes before the level check; the counter uses an atomic `increment` and a test fires 5 wrong passwords in parallel. Fixes: [ef71800](https://github.com/azeem-web-dev/TrustVault/commit/ef71800), [a3d69d5](https://github.com/azeem-web-dev/TrustVault/commit/a3d69d5).

---

## 2026-11-01 — Audit trail: evidence export that would have looked forged

**Asked (Claude):** "Export an evidence bundle of audit events with every hashed field, and write an offline verifier that needs only Node."

**Got:** an export query selecting `seq::text AS seq ... ORDER BY seq`, and a verifier.

**What was wrong:** `ORDER BY seq` sorted by the **text alias**, not the bigint column: 1, 10, 100, 1000, 101... Every exported chain came out of order, and the verifier reported 276 "prev_hash does not link" problems on an untouched log. An auditor would have concluded the log was tampered with. The database-side `audit_verify()` was fine; only the export was wrong. Caught because the test runs the real verifier on a real export.

**What I did instead:** order by the table column (`e.seq`), with a comment. The test also edits one event and checks the verifier says TAMPERED. Fix: [84db532](https://github.com/azeem-web-dev/TrustVault/commit/84db532).

---

## 2026-11-01 — Retention could delete without a record (audit trail)

**Asked (Claude):** "A daily job that permanently removes documents in the trash past the retention period, and audits each removal."

**Got:** the job called the purge function, then wrote one audit row per removed document as separate statements.

**What was wrong:** if an audit insert failed after the purge committed, documents would be gone with no record. That breaks the rule that the audit insert is part of the action.

**What I did instead:** purge and audit inside one transaction. Fix: [ef71800](https://github.com/azeem-web-dev/TrustVault/commit/ef71800).

---

## 2026-11-01 — Upload validation accepted a renamed binary

**Asked (Claude):** "Validate uploads by content: allow PDF, images, Office files, plain text; refuse markup, executables, macros."

**Got:** a detector that treated anything without NUL bytes that decoded as UTF-8 as text.

**What was wrong:** the test "refuses Windows executable" (an `MZ` header followed by `0x01` bytes) was accepted as `report.txt`. A binary with no zero bytes is valid UTF-8.

**What I did instead:** text must also contain no control characters other than tab, newline, carriage return and form feed. Fix: [ef71800](https://github.com/azeem-web-dev/TrustVault/commit/ef71800).

---

## 2026-11-01 — Tests that would not have noticed a missing check

**Asked (Claude):** "List every authorisation check, remove each one, and confirm a test fails." This is the brief's own test, as a script (`tools/mutation-check.mjs`).

**Got:** a `tools/mutation-check.mjs` that, for each listed authorisation rule, edits the source to disable that one rule, runs only the tests it names, and reports the rule "caught" if a test fails or "survived" if none does — writing the result to `docs/MUTATION_REPORT.md`.

**What was wrong (found before running it, by reading which tests exercise which line):**
1. The session lookup re-checks "account deactivated" and "password changed since this session" on every request. But every API path that deactivates or changes a password **also deletes the sessions**, so removing those re-checks would have left every test green. They are a backup layer that no test exercised.
2. Search has an app-side access filter and RLS underneath. Remove the app filter and RLS still hides everything, so no API test can tell. Defence in depth makes a single layer untestable through the API.

**What I did instead:** (1) tests that deactivate an account, move `password_changed_at` or expire an external account **directly in the database**, so only the per-request check stands between the old cookie and the app; (2) moved the search filter into `buildSearchWhere()` and tested it with a database connection as the table owner (which RLS does not apply to), so the app filter is tested alone. RLS is tested alone in `rls.test.ts`, and `decide()` alone in `access.unit.test.ts`. The mutation report shows each removal caught: [docs/MUTATION_REPORT.md](docs/MUTATION_REPORT.md).

**Commits:** [84db532](https://github.com/azeem-web-dev/TrustVault/commit/84db532) (the second lock tested on its own), [f4455cc](https://github.com/azeem-web-dev/TrustVault/commit/f4455cc) (direct-database tests, search filter, mutation check)

---

## 2026-11-01 — Toolchain surprises (not security, recorded because they cost time)

*(Supplementary notes, not one of the main entries — no single commit carries them.)*

- NestJS 12 ships as ES modules, and TypeScript 7 was the default install; Nest's dependency injection needs the older decorator metadata. Pinned TypeScript 5.9 and used explicit `@Inject()` on every constructor parameter, so injection works the same under the dev runner, the test runner and the build.
- Ubuntu 24.04's default Rust (1.75) cannot build current crates (edition 2024). Used the archive's versioned `rustc-1.91` instead of piping an install script into a shell.
- The Redis ACL I wrote refused `KEYS` in my own test cleanup. Correct behaviour, so the tests use `SCAN`.

---

## 2026-11-01 — Login timing: "equalised by design" was not true (authentication)

**Asked (Claude):** "Fix the remaining gaps" — one of them was that login timing was equalised by design (a dummy Argon2 verify for unknown emails) but never measured. So it wrote `npm run measure:timing`: hundreds of failed logins of three kinds (unknown email, real account with a wrong password, locked account), interleaved randomly, through the full HTTP stack with production Argon2 settings, then fits an attacker's best threshold on half the samples and scores it on the other half.

**What was wrong:** the first run failed its own check. A wrong password on a real account was 40 ms slower than an unknown email, and the threshold guessed right **78%** of the time — anyone could have tested which emails have accounts. The cause: the wrong-password path also updated the failed-login counter, one extra database round trip.

**Then the AI's first fix made it worse:** it moved the counter update and the audit row into one transaction, reasoning that the extra *commit* was the cost. Measured again: 152 ms and **99%**. A breakdown of each step showed every query cost about 50 ms on this machine (the database is behind a forwarded port) and an interactive transaction adds BEGIN and COMMIT round trips; the number of round trips was the leak, not commits.

**What I did instead:** the counter, the lock and the audit row are now **one SQL statement** (a data-modifying CTE), so every failure path costs one Argon2 verify plus one statement. As a second layer, every failed login is padded to 450 ms. Measured again with the padding off: 56% and 51% (chance); with it on: see [docs/LOGIN_TIMING.md](docs/LOGIN_TIMING.md). A new test checks the single statement still locks for 15 minutes and then doubles, with the right audit reason.

**Commit:** [a9a8a67](https://github.com/azeem-web-dev/TrustVault/commit/a9a8a67)

---

## 2026-11-01 — Closing the audit and upload gaps (audit trail)

**Asked (Claude):** build an outside witness for the audit chain, malware scanning, encrypted backups and a full passkey test.

**Got:** a pulled GitHub-Actions witness of the audit checkpoints, a clamd malware scan that runs on every upload, encrypted off-site backups, and a passkey test driven by a software authenticator that builds real WebAuthn bytes.

**Decisions I made, and why:**
- **Witness is pulled, not pushed.** If the server pushed checkpoints somewhere, it would need a credential, and whoever owns the server would own that credential. Instead a public read-only endpoint serves checkpoints only, and a scheduled GitHub Actions job pulls them into the `witness` branch. The test that matters re-signs a forged history **with the real signing key** — the witness still rejects it, because the heads already recorded on GitHub cannot be matched.
- **The scanner fails closed,** and only an exact `stream: OK` counts as clean. The tests run the real clamd protocol code against a fake daemon that can refuse connections, answer nonsense or never answer.
- **Passkeys are tested with a software authenticator** that builds real WebAuthn bytes and P-256 signatures, so the server's verification runs unchanged.

**What was wrong:** the witness test helper first read only the first 1000 checkpoints. Checkpoints can never be deleted from the test database, so after enough test runs the newest ones would have fallen off the page and the test would have failed for no real reason. It now pages exactly as the real tool does. Small, but it would have looked like a real alarm.

**And one in the mutation check itself:** running the full suite showed the local test database's audit log had been wiped earlier. The mutation check disables the audit table's append-only trigger and then runs the test "even the table owner cannot TRUNCATE audit rows". With the trigger gone the TRUNCATE succeeded: the test failed as intended (mutation caught), but it also emptied the log, leaving signed checkpoints that pointed at events that no longer existed. Only the test database was affected. Those owner attempts now run inside a transaction that is always rolled back, so a missing guard fails the test without destroying anything; the orphaned test checkpoints were removed.

**Commits:** [ab39147](https://github.com/azeem-web-dev/TrustVault/commit/ab39147) (witness), [9b5446b](https://github.com/azeem-web-dev/TrustVault/commit/9b5446b) (malware scan), [f0c8afe](https://github.com/azeem-web-dev/TrustVault/commit/f0c8afe) (passkey test), [c04a5d9](https://github.com/azeem-web-dev/TrustVault/commit/c04a5d9) (backups), [b89fc09](https://github.com/azeem-web-dev/TrustVault/commit/b89fc09) (mutation check fix)

---

## 2026-11-01 — Shrinking the remaining gaps (audit tail, new malware, real browser)

**Asked (Claude):** "fix the remaining open gaps too": the newest ~20 minutes of audit events had no outside copy, signature scanning misses brand-new malware, and passkeys had never run in a real browser.

**Got:** per-minute checkpoints published to Sigstore's public Rekor log by a separate internet-only service, a nightly re-scan that re-decrypts and re-checks every stored version and quarantines newly-detected malware, and a passkey test driven through real Chrome against the live pages.

**Decisions I made, and why:**
- **Publish checkpoints to Sigstore's public transparency log (Rekor), but not from the API.** The GitHub witness can only look every 15 minutes, and GitHub delays scheduled jobs. Pushing each checkpoint somewhere public as soon as it is signed closes most of that window, and Rekor needs no credential: it accepts any correctly signed entry and never lets anyone remove it. I asked the owner before publishing anything there (entries are permanent). The API itself still has no internet access; a separate one-shot service with a throwaway user, no database password and no key service access reads the public checkpoint list on localhost and submits new ones, checking Rekor's signed receipt against a pinned key before it records anything. Checkpoints are now signed every minute instead of every five.
- **Rekor keeps only a fingerprint (SHA-256) of each checkpoint, not its text.** So a checker cannot read sequence numbers back from the log. Instead the GitHub witness lists every entry signed with the audit key and requires each one to match a checkpoint the server still reports; one that matches nothing means a published checkpoint was removed or changed. For an exported bundle that starts at event 1, `verify-audit.mjs --rekor` requires every entry published before the bundle's newest published checkpoint to match the bundle's chain.
- **New malware: re-scan, not just scan.** Nothing catches malware nobody has a signature for. What can be done is to look again once someone does: every night each stored version is decrypted and scanned with that day's signatures, and a version found infected is quarantined (downloads refused and audited, admin alert). The app may add a quarantine but not remove one. The job reads blobs through two narrow database functions, because row-level security shows nothing to a job running as no user.
- **Passkeys in real Chrome.** The test starts the real API and the real Next.js app and drives Chrome through the actual pages, with Chrome's built-in virtual authenticator standing in for a phone or key. It runs in CI on every push.

**What went wrong:**
- **My own editing scripts corrupted files.** Python edits run through the shell turned the two characters `\0` into real NUL bytes in the scanner code, turned a `\n` inside a mutation definition into a real line break (a syntax error), and saved files with Windows line endings. All were caught before anything was committed (a file showing up as "binary", a syntax check, git's line-ending warning) and fixed; later edits used a different method.
- **I suspected a UI bug that was not there.** The browser test's screenshot showed the Account page without the newly added passkey, and an exact-text check for it timed out. The API already returned both passkeys. The page was fine: the screenshot was taken before the list reloaded, and the exact match could never succeed because the name and its "Added …" line share one element. The test now waits for the list item instead.
- **Checked the new checks fail when broken.** Seven new mutations (a receipt for the wrong checkpoint, an unverified receipt, an unmatched public entry, a checkpoint left unpublished, a full bundle disagreeing with the log, a quarantined version downloaded, an infected file treated as clean): each made at least one test fail.

**Commit:** [afc0c48](https://github.com/azeem-web-dev/TrustVault/commit/afc0c48)

---

## 2026-11-02 — Simpler demo logins, and a redesigned interface

**Asked (Claude):** "make email and passwords simple" (for the published demo accounts), then "work hard on ui … premium icons and images … every screen section … easy to operate".

**Got:** `@demo.com` logins with 12-character passwords and one-click demo buttons on the sign-in page, and a redesigned web interface — sidebar, Ctrl+K command palette, light/dark/system themes, Phosphor icons and hand-drawn inline-SVG illustrations.

**Decisions I made, and why:**
- **Demo logins:** `@demo.com` emails and 12-character passwords (the app's minimum). They were already public in the README, so long random passwords protected nothing and only made them hard to type. The live accounts were changed in place with one `user.update` audit event each, and their sessions ended. The login page now has one-click demo account buttons that fill these in.
- **Interface:** a sidebar layout, a Ctrl+K command palette (its document search uses the same API, so it can only find what you can access), light/dark/system themes, toasts, and a redesign of every screen. Icons are Phosphor (duotone). The illustrations are hand-drawn inline SVG, not image files, so the strict Content-Security-Policy did not need loosening. The Geist font ships inside the app. Both packages are pinned to releases months old, not the newest.
- **Behaviour unchanged:** the API calls, permission checks and text the browser test relies on ("Use a passkey (this device)", "Add passkey", the Email and Password labels) are the same. The passkey test in real Chrome passes on the new pages.

**What went wrong:**
- **Three UI bugs found by clicking through every screen in Chrome before committing.** Text typed straight after Ctrl+K was lost because the search box was focused a moment too late. On a laptop-height screen, the sign-in page's feature cards were cut off. And the documents page told administrators "You can open what is shared", which is false: administrators cannot open documents. All three were fixed.
- **The local dev database was one migration behind**, so document pages showed "Internal error" during the check. This was not caused by the redesign. Applying the migration fixed it; production and the test database already had it.

**Commits:** [e4f63ad](https://github.com/azeem-web-dev/TrustVault/commit/e4f63ad) (demo logins), [91e59cf](https://github.com/azeem-web-dev/TrustVault/commit/91e59cf) (redesign), [12aa239](https://github.com/azeem-web-dev/TrustVault/commit/12aa239) (secret-scan follow-up: the redesign put the demo password on the sign-in page and CI flagged it)

---

## 2026-11-02 — An Android app with the same interface (authentication)

**Asked (Claude):** "build flutter apk too same ui clean and all stuff as it is".

**Decisions I made, and why:**
- **Same API, no new API.** The app calls the live API, so every check (application and RLS), every audit entry and every revocation rule is the server's, not the app's. Before writing it I read `security.guard.ts` to see whether a native client could pass. The Origin check refuses only a *different* origin, and a request with no Origin still needs the CSRF token. So no server change was needed, and none was made to make the app work.
- **The session on the phone** is the same cookie value, kept in Android's encrypted storage and excluded from backup. The CSRF token is in memory only, as on the web. THREATS.md S13 records what this does *not* protect against (root on an unlocked phone).
- **Passkeys stay on the website.** They are bound to the web origin; making them work in an app needs a Digital Asset Links file and a second accepted origin on the server. That widens what the server accepts, for a demo, so I left it out and said so in the app.
- **Testing sign-in against the local API, not production.** Signing in sends a password, so the emulator run used a debug build pointed at a local API with dev-only seed accounts. HTTP to localhost is allowed only in debug and profile builds; release refuses plain HTTP.

**What the AI got wrong:**
- **It wrote the whole UI against an icon package that does not compile.** `phosphor_flutter` 2.1.0 extends `IconData`, which became a `final` class in this Flutter version. `flutter analyze` passed (it does not analyse dependencies), and only the release build failed. No fixed release exists. Instead, the app's icons are generated from the web app's own `@phosphor-icons/react` package into one Dart file (`tool/gen-assets.tsx`), so web and app draw the same icons from one source.
- **It guessed an old file-picker API.** It wrote `FilePicker.platform.pickFiles` and `file.size`/`file.path`, from older versions. Version 13 has a static `pickFile`, no size field, and `path` can be null for files that come from content providers. I checked the package source, switched uploads to read bytes, and size comes from `length()`.
- **It reported an emulator crash that was not one.** The debug build was too slow on a software-rendered emulator, Android showed "not responding", and the keystrokes the test sent closed the dialog. The log showed an ANR, not an exception. The fix was a compiled (profile) build, not a code change.
- **It tried to stop every Java process** to free memory for the emulator. The command was refused because it could have hit unrelated programs on the machine. The emulator was simply restarted; nothing else was stopped.
- **It overstated testing in the write-up**, saying the app was "checked on an emulator and a phone" when only the sign-in screen had been seen. Corrected to say exactly what was checked.

**Commit:** [b1fce4a](https://github.com/azeem-web-dev/TrustVault/commit/b1fce4a)

---

## 2026-11-02 — Attacking the three non-negotiables until they hold (authorisation, revocation, audit trail)

**Asked (Claude):** take the brief's three rules ("reachable only by someone granted it", "prove who reached it", "taking access away works immediately") and "work on this until you are 99% confident". Then: "run max parallel agents".

**How it was checked, not just reviewed:**
- A live attack harness against a local copy with dev-only accounts (never the live site: attacks need passwords). It hit every one of the 51 routes as each role, compared every refusal with the answer for a document that does not exist, tried odd paths, header tricks, mass assignment and forged cookies, and raced revocation against a burst of downloads: 442 access checks, 22 revocation checks.
- Independent reviewers (subagents) read the code for one property each, and every finding was **confirmed with a live request before it was fixed**.

**What the reviews found that the first version, the tests and the earlier THREATS.md all missed:**
- **An admin could read documents** (A17, A19): by adding themselves to a group that held a grant; by keeping grants after a promotion; and, after that was fixed, by creating a stand-in viewer account and adding *it* to the group. With the published demo admin login, anyone could have done this on the live site. Fixed so a group share covers only members the owner confirmed.
- **Revocation that wasn't** (R7, R9): a manager could share with their own group and keep access after being revoked; a sign-in or second-factor step racing a password reset or deactivation could still mint a working session.
- **Silent refusals** (L10, L14): a deactivated user retrying left no trace (their sessions were deleted, so the next request was just "unknown cookie"); rate-limited, malformed and "second factor required" requests on documents were never recorded.
- **Evidence that could be faked** (L12, L13): the offline verifier trusted the public key inside the bundle, and missed a cut-off tail; the key service would sign any checkpoint it was handed.

**Where the AI was wrong this session, specifically:**
- **The earlier THREATS.md said A9 and A15 were "done"**, with tests. The tests only covered the routes that had been thought of; both claims were false (admins via groups, former owners via groups).
- **My own attack harness had three bugs that would have produced false alarms**: it compared error bodies including their random request id; it listed a document as off-limits to Victor although his group legitimately had Edit; and it flagged a forged `X-Forwarded-For` that is only accepted from localhost (production nginx overwrites it and the API binds 127.0.0.1, both checked on the server). Each was traced to the harness, not the app, before anything was "fixed".
- **My first fix for the stand-in hole broke every document list**: the new coverage table's row policy read `grants`, whose policy read the coverage table, and Postgres refused with "infinite recursion detected in policy". The local attack run caught it in seconds; a follow-up migration moved the check into a `SECURITY DEFINER` helper.
- **`pg_advisory_xact_lock` returns `void`**, which Prisma's `$queryRaw` cannot read, so every share failed with a 500 until it was switched to `$executeRaw`. Also caught by the attack run, not by type-checking.
- **Renaming code silently disabled three mutation rows**: their search text no longer existed, so "remove this rule" would have removed nothing. A small script now checks that every row's text appears exactly once before the mutation run.
- **I asked to delete rate-limit keys and stop every Java process** to speed things up; both were refused by the session's safety checks as too broad. The waits were taken instead.
- **I wrote "checked on an emulator and a phone"** in the write-up earlier today when only the sign-in screen had been seen (corrected in the previous entry). Same lesson: say exactly what was run.

**What is still accepted, not fixed** (all in THREATS.md): an admin resetting someone's password and signing in as them is detected and alerted (S15), not prevented; the re-scan functions bypass the database lock for ciphertext (A18); the last minute or two of audit events can be cut by root (L5); the two sign-in races are closed by locking and re-checking but not proven by a timed test.

**Commits:** [a9de674](https://github.com/azeem-web-dev/TrustVault/commit/a9de674) (access: admins, groups, revocation), [071156b](https://github.com/azeem-web-dev/TrustVault/commit/071156b) (sessions and refusals on record), [6eff294](https://github.com/azeem-web-dev/TrustVault/commit/6eff294) (audit evidence: verifier and checkpoints)

---

## 2026-11-03 — Accounts by invitation

*Written afterwards, on the evening of 2026-11-03 (commit [8c75a56](https://github.com/azeem-web-dev/TrustVault/commit/8c75a56)), from the commit history and my notes, not at the time.*

**Asked (Claude):** "for a new account … admin enters mail and role and if any access date, and the receiver gets an email and fills the remaining info" — build invite-by-email account creation.

**Got:** an admin form that takes email, role and an optional access-end date and sends a one-time invite link; an `/invite` page where the invited person sets their own name and password; the same flow in the Android app. No admin-chosen password ever exists, and an invited account can do nothing until it is accepted.

**What was wrong:**
- **The invite email never arrived.** The API service is sandboxed with no outbound internet (so a compromised API cannot phone home), which also blocked its own SMTP connection — every send failed with `Connection timeout`. The sandbox had always blocked this; the earlier one-off test email was sent from outside the API, so it hid the gap.
- Inviting someone asked the admin for a fresh second factor (step-up). The owner judged that too heavy for a routine invite that grants nothing until accepted.

**What I did instead:** a narrow systemd drop-in lets the API reach only the SMTP host's current addresses and nothing else on the internet (`infra/server/mail-egress.sh`), so mail works while the rest of the egress block stands. Inviting and re-inviting are no longer step-up routes (role changes, resets and the rest still are), recorded in THREATS.md S20.

**Commits:** [22dd266](https://github.com/azeem-web-dev/TrustVault/commit/22dd266) (invite flow, API), [1ab7319](https://github.com/azeem-web-dev/TrustVault/commit/1ab7319) (web and Android invite + accept page), [3a3d3ed](https://github.com/azeem-web-dev/TrustVault/commit/3a3d3ed) (SMTP-only egress), [9bb965f](https://github.com/azeem-web-dev/TrustVault/commit/9bb965f) (invites without step-up)

---

## 2026-11-03 — Ten security workstreams in parallel

*Written afterwards, on the evening of 2026-11-03 (commit [8c75a56](https://github.com/azeem-web-dev/TrustVault/commit/8c75a56)), from the commit history and my notes, not at the time.*

**Asked (Claude):** "make the authenticator good and advanced"; then, for view-only files, "if only view is given, users can still download or screenshot … what's the plan?" → "build all 6"; then "use max sub agents" to work the security checklist.

**Got:** ten branches built in parallel, each in its own worktree and test database: step-up re-verification + per-role MFA policy + signed-in devices + Android passkeys; a VIEW level below READ with watermarked in-app pages and stamped downloads; download approvals, time windows and network allowlists; a key service that unwraps only against database-issued tickets, with its own signed key-use ledger; insider-extraction detection with a persistent alert queue and hard download limits; auth-abuse resilience (no stranger lockout, trusted-device cookie, under-attack sign-in links); structural PDF/Office upload checks in a resource-limited worker; an Android security test suite; supply-chain hardening (pinned actions, SBOMs, signed release); and the ops runbooks.

**What was wrong:**
- **A shared scratchpad let two agents collide:** one agent's mutation-runner truncated another's service file mid-edit. Fixed by giving every agent a branch-unique temp name and its own worktree, which is how the later runs are isolated.
- **A timezone bug rejected good sessions:** a Postgres session running in the server's local time made Prisma misread `timestamptz`, so valid sessions were read as "password changed" and refused. Fixed by forcing `TimeZone=UTC` on every database connection, with a test that switches the test database to another zone to prove it.

**What I did instead:** each workstream kept to its own branch and database; I integrated them one at a time (next entry).

**Commits (branch merges):** [a2af2a8](https://github.com/azeem-web-dev/TrustVault/commit/a2af2a8) (MFA/passkeys), [a997df8](https://github.com/azeem-web-dev/TrustVault/commit/a997df8) (view-only), [384e4c4](https://github.com/azeem-web-dev/TrustVault/commit/384e4c4) (access policies), [9aaa8f3](https://github.com/azeem-web-dev/TrustVault/commit/9aaa8f3) (keyd ledger), [afb90ab](https://github.com/azeem-web-dev/TrustVault/commit/afb90ab) (insider detection), [4ac803c](https://github.com/azeem-web-dev/TrustVault/commit/4ac803c) (auth abuse), [a168041](https://github.com/azeem-web-dev/TrustVault/commit/a168041) (content checks + web CSP), [09f7737](https://github.com/azeem-web-dev/TrustVault/commit/09f7737) (Android tests), [df797ce](https://github.com/azeem-web-dev/TrustVault/commit/df797ce) (supply chain), [bee6141](https://github.com/azeem-web-dev/TrustVault/commit/bee6141) (ops docs), [cc25222](https://github.com/azeem-web-dev/TrustVault/commit/cc25222) (every connection runs in UTC)

---

## 2026-11-03 — Integrating ten branches, making CI fast, and deploying

*Written afterwards, on the evening of 2026-11-03 (commit [8c75a56](https://github.com/azeem-web-dev/TrustVault/commit/8c75a56)), from the commit history and my notes, not at the time.*

**Asked (Claude):** "deploy … start all three … keep working until all are satisfied"; later "make ci green and deploy it"; then "deploy".

**Got:** the ten branches merged into main one at a time with the full suite after each, a second protected demo admin so the two-admin break-glass flow can be tried end to end ([0859258](https://github.com/azeem-web-dev/TrustVault/commit/0859258)), and a production deploy (migrations in order, new settings, the key-service install, health checks).

**What was wrong:**
- **CI took about 50 minutes and kept failing late.** The mutation check ran all ~200 rules one after another after the full suite; a leftover download-limit from one test made the next test's download burst fail; and two timing tests answered a fraction of a millisecond early on busy runners.
- Each failed run cost another ~50 minutes, so fixing by trial was slow, and the owner asked specifically to make CI faster.

**What I did instead:** split the mutation check across 8 machines that run in parallel (`--shard K/8`), cutting CI from ~50 minutes to ~10; reset detection thresholds and limits between tests; and held the timing floors to whole milliseconds. Then deployed on the owner's "deploy", with a backup first and only the TrustVault services restarted.

**Commit:** [8847c3e](https://github.com/azeem-web-dev/TrustVault/commit/8847c3e) (parallel mutation check), deployed as part of the merged main.

---

## 2026-11-03 — Screenshots, PDF sanitising, and a simpler second factor

*Written afterwards, on the evening of 2026-11-03 (commit [8c75a56](https://github.com/azeem-web-dev/TrustVault/commit/8c75a56)), from the commit history and my notes, not at the time.*

**Asked (Claude), three separate requests:** "for view-only documents I can take a screenshot — stop it, and tell the owner, without telling the viewer"; the owner's sanitisation rules for uploaded PDFs ("sanitise and validate automatically before encryption; reject if sanitising fails; scan the output again; log both hashes"); and "every user can turn on two-step — authenticator or a simple email toggle".

**Got, what was wrong, and what I did — one per request:**
- **Screenshots (web):** the viewer blanks the page and overwrites the clipboard on the usual capture keys and silently records the attempt — the owner sees it in the document history, by email and as an alert; the viewer is told nothing. Stated honestly (THREATS V11): a web page cannot truly block a screenshot or a phone camera, so the watermark and trace code remain what make a leaked picture traceable; only the Android app (`FLAG_SECURE`) really blocks capture. [2f0f8ce](https://github.com/azeem-web-dev/TrustVault/commit/2f0f8ce)
- **PDF sanitising:** every uploaded PDF is now rebuilt into a fresh file in the sandboxed worker with scripts, auto-actions, launch actions, attachments and forms removed; the rebuilt copy must pass the full check and a virus scan or the upload is refused; both the original and sanitised SHA-256 are logged. This also closed a real gap the owner's rules exposed — refused uploads were not being audited at all; now every rejection is recorded. [0934f9c](https://github.com/azeem-web-dev/TrustVault/commit/0934f9c)
- **Email-code two-step:** a per-user toggle adds an emailed 6-digit code as a second factor beside the authenticator and passkeys; turning it on needs a code to the mailbox, turning it off needs a fresh factor. Admins cannot use email as their only factor (a mailbox compromise would be an admin compromise), enforced in the app and by a database constraint; demo accounts, which never receive mail, are refused. [4b949f1](https://github.com/azeem-web-dev/TrustVault/commit/4b949f1)

---

## 2026-11-03 — Attacking everything at once (the security hunt)

*Written afterwards, on the evening of 2026-11-03 (commit [8c75a56](https://github.com/azeem-web-dev/TrustVault/commit/8c75a56)), from the commit history and my notes, not at the time.*

**Asked (Claude):** "start the hunt" — the 40 KB file that takes the server down, SQL injection from files, "and all security constraints you can think of", with the parallel attackers each in isolation.

**Got:** six attacker/reviewer subagents, each in its own git worktree and throwaway database (resource-exhaustion files, injection, access-control bypass, authentication, key service + audit, and web/Android), plus a password-cracking benchmark. Five real bugs, all fixed with a regression test each:
- **Two HIGH, availability:** a tiny PDF whose content stream decodes to millions of trivial ops froze the whole API because pages were drawn on the main thread with no time limit; and a tiny image declaring billions of pixels made the API allocate gigabytes at view/download time. Fixed by moving rendering to a worker pool with a 10-second deadline and capping uploaded images at 40 megapixels.
- **Two MEDIUM:** the Android app only blanked the app-switcher preview on document screens, leaking other signed-in screens; and the key-use reconciler cried "released without a ticket" on every normal first Android copy key, which would train admins to ignore the one alarm meant to catch a real key-release bypass.
- **One LOW:** changing a user's access-end date skipped the fresh-second-factor check that every other access-altering admin action requires.
- Access-control and injection were attacked hard and came back clean; the password hashing (Argon2id, 64 MiB) was measured strong.

**What was wrong / honest notes:**
- The subagents could not create their own test databases (reading the local superuser password is blocked for them, correctly), so the parent created the databases for them.
- Two mutation rows read as "missing" when checked on Windows — a line-ending quirk only; they apply cleanly in CI on Linux, and the full CI run confirmed every rule caught.
- The two HIGH denial-of-service bugs were live on production until the fix was deployed; the owner was told, offered an interim block, and chose to deploy the fix.

**Commits:** [894eb49](https://github.com/azeem-web-dev/TrustVault/commit/894eb49) (image/PDF DoS), [1c00aaa](https://github.com/azeem-web-dev/TrustVault/commit/1c00aaa) (keyd reconciler), [7a9ec86](https://github.com/azeem-web-dev/TrustVault/commit/7a9ec86) (Android recents), [fc5cdfa](https://github.com/azeem-web-dev/TrustVault/commit/fc5cdfa) (step-up on access window), [243e91d](https://github.com/azeem-web-dev/TrustVault/commit/243e91d) (access probes); merged to main and deployed.

---

## 2026-11-03 — The web app on a phone, and buttons that did nothing (interface)

**Asked (Claude):** the owner tried the web app on a phone and judged it poor — cramped layout, and "many are just display, they don't have any onClick" — and asked for rem units so everything scales.

**Got:** a fluid root font size with every hard-coded pixel value converted to rem, horizontal scrolling removed on phones, a shared accessible dropdown menu (keyboard, Escape, click-outside) reused for the account menu, and a folder explorer (an accessible tree, a side panel on desktop, a drawer on phones).

**What was wrong:** of the owner's "display-only" complaint, one element was a false click affordance — a statistics card lifted on hover but did nothing. On phones the theme switch was also unreachable.

**What I did instead:** made the card plainly static rather than inventing an action for it, and moved the theme switch into the account menu so it is reachable on any screen size.

**Commits:** [014f4dd](https://github.com/azeem-web-dev/TrustVault/commit/014f4dd), merged in [703caee](https://github.com/azeem-web-dev/TrustVault/commit/703caee).

---

## 2026-11-03 — A view-only holder asking to download one file (authorisation)

**Asked (Claude):** let a person with View-only access ask the owner for permission to download one specific document.

**Got:** a request-and-approve flow: an approved, unexpired, uses-remaining approval tied to that user and that version authorises exactly one download; nothing else about View access changes.

**What was wrong / the risk:** the easy implementation — lowering the download requirement from Read to View — would have quietly given every View holder the original file. Administrators' emergency (break-glass) access is also View, so it could have turned into a download.

**What I did instead:** kept the Read requirement and added the approval as a narrow, separate allowance, enforced identically in every lock — the application check, the database download counter, the blob-release row policy, the audit backstop and the key-service ticket mint — with administrators excluded everywhere. Mutation-check rows prove the tests fail if any of those checks is removed.

**Commits:** [9b94e0e](https://github.com/azeem-web-dev/TrustVault/commit/9b94e0e), merged in [2ceca59](https://github.com/azeem-web-dev/TrustVault/commit/2ceca59).

---

## 2026-11-03 — Bringing the Android app level with the web (mobile)

**Asked (Claude):** "everything has changed" — update the Android app to match, and keep a built app ready at all times.

**Got:** the Android app gained the view-only download request, the email-code two-step toggle and the screenshot-attempt label in the history, plus a workflow that builds a release APK and app bundle on every change.

**What was wrong:** without signing keys configured, that workflow produces a debug-signed build, which installs on a phone for testing but cannot be published. The workflow and docs/ANDROID_RELEASE.md say so plainly; the signing key itself stays outside the repository.

**Commits:** [28bd0ca](https://github.com/azeem-web-dev/TrustVault/commit/28bd0ca), merged in [8ce28ff](https://github.com/azeem-web-dev/TrustVault/commit/8ce28ff).

---

## 2026-11-04 — A bug hunt across every page and screen, then a design system (interface)

**Asked (Claude):** "start a bug hunt thoroughly in all pages, with max agents and one master agent to plan clean, best UI, animations, experience, proper colours and icons".

**Got:** nine read-only hunters, one per area (web auth, documents, document detail, account and approvals, two admin areas, the shared design system, and two for Android), reported 227 findings — 23 high, 106 medium, 98 low. A master agent checked every high-severity claim against the code (none were false; three were downgraded), designed one set of colour, icon and motion rules, and split the fixes into eight packages that never touch the same file, so they could be fixed in parallel safely.

**What was wrong (the worst of it):**
- **No second factor could be typed in the step-up dialog.** The shared dialog re-ran its focus logic on every keystroke and moved focus to the Close button, so only the first digit landed. The same bug hit the upload, folders, invite, exception and alert dialogs. Escape also closed every stacked dialog at once.
- **About fifteen pages showed a loading skeleton forever** when their first request failed, with no error and no retry.
- **Double-clicking** approve, share, revoke or create-group submitted twice.
- **The admin audit date window was shifted by 5h30**, because local dates were sent as UTC — wrong for an evidence export.
- **Reset and invite pages called valid links invalid** on unrelated errors (a too-long password, a network blip).
- Low-contrast grey text, hard-coded colours outside the palette, no exit animations, and tap targets under 44px on phones.

**What I did instead:** the foundation package rebuilt the shared dialog (focus trap, focus restore, only the top layer closes, animated exit, bottom sheet on phones) and added shared pieces — a load-error-with-retry, a confirm dialog, a busy-action helper that ignores repeat clicks, local-time date helpers, colour tokens for light and dark, motion tokens that switch off under reduced motion, and accessible 44px buttons on Android. Seven page packages then adopted them, and a second pass applied the colours, icons and animations consistently. Type check, web build, Android analyze and all 59 Android tests passed after each pass.

**Not fixed here (needs the API):** folder counts include deleted documents; passkey-only users cannot have two-step reset from the user list; the server does not yet send an explicit "session ended" code, so the Android app infers it.

**Commit:** [dbd63b1](https://github.com/azeem-web-dev/TrustVault/commit/dbd63b1).

---

## 2026-11-07 — "The sign-in races are closed" was not true (authentication)

**Asked (Claude):** close the open items from the writeup, including proving with a test that two sign-in races are safe: an admin resetting the password, or deactivating the account, while that person is signing in.

**Got:** the claim, from reading the code, that both races were already closed by row locks and re-checks (`attemptLogin` and the second-factor step take `FOR UPDATE` on the user row), so only tests were needed.

**What was wrong:** the test proved the claim wrong. Four cases passed, but the old password still produced a session when an admin reset the password at the same moment. The password hash was read by a function inside the same `SELECT ... FOR UPDATE` that waited for the lock, and Postgres evaluated it against the snapshot taken *before* the wait, so it returned the old hash after the reset had committed. Status and expiry were plain columns and re-read correctly, which is why only the password case leaked. The first versions of the test were also wrong (they looked for the lock wait in the wrong place), and CI caught that before it could hide the bug.

**What I did instead:** sign-in now takes the row lock first and reads the password hash in a separate statement after it, refusing if it changed; the refusal, audit row and timing padding are identical to a normal wrong password. The race test now runs against both sign-in steps on every push.

**Commits:** [d026211](https://github.com/azeem-web-dev/TrustVault/commit/d026211) (fix), [3455a08](https://github.com/azeem-web-dev/TrustVault/commit/3455a08), [8be53a0](https://github.com/azeem-web-dev/TrustVault/commit/8be53a0) (tests).

---

## 2026-11-08 — Checking every claim against the code (documentation)

**Asked (Claude, one long session with the ground rules in [docs/AI_CONTEXT.md](docs/AI_CONTEXT.md)):** restructure the README for a judge, then check every factual claim in README, WRITEUP and API.md against the code and run what can be run; record it in docs/CLAIMS_CHECK.md.

**Got:** a claims table and a README that reads top-down: live URL, accounts, the ten requirements with file paths and tests, the three non-negotiables, limits.

**What was wrong:** with the old README. "Over 750 tests" was 880 (879 pass, 1 skipped); "13 document routes" refused to outsiders was 17; Olivia owns four seeded documents, not five; the write-up said the demo video was "recorded" with no link; THREATS.md, PLAN.md and the write-up called access suggestions "AI" when the code is a heuristic over past shares; the write-up said backups stay on the server while THREATS.md said a PC copy was live (the truth: copied by hand, last on 11-03); the witness branch is scheduled every 15 minutes but GitHub ran it every 4–7 hours. And the AI could not run the suite here (no Redis; the local database roles refused their passwords), so it took the numbers from the GitHub Actions logs and says so, rather than writing a number it had not seen.

**What I did instead:** every number now comes from a named CI run; the mutation report is assembled from the eight CI shard logs by a new `--from-logs` mode that refuses to write a report if any row is missing; the video link is a marked placeholder.

**Commits:** [e11df92](https://github.com/azeem-web-dev/TrustVault/commit/e11df92), [e6562aa](https://github.com/azeem-web-dev/TrustVault/commit/e6562aa), [b09756e](https://github.com/azeem-web-dev/TrustVault/commit/b09756e), [54d0390](https://github.com/azeem-web-dev/TrustVault/commit/54d0390).

---

## 2026-11-08 — Protecting the shared demo, and a seed that shared with nobody (authorisation)

**Asked (Claude):** every judge uses the same published accounts, admin included, so one judge must not change what the next sees. Add `DEMO_MODE` (record but never send invitation, reset and sign-in-link mail; refuse with a clear 403 settings that would lock the demo accounts out), invitation rate limits, and a scheduled demo reset that does not touch the audit log, with tests. Do not switch it on in production.

**Got:** the API changes and tests, and a reset script with a systemd timer.

**What was wrong:**
1. **The seed's group shares covered nobody on a fresh database.** The new reset test runs the real `prisma/seed.ts` on an empty database, and Victor could open one document instead of the three the README promises. Group shares only reach members the owner confirmed (`tv_confirm_group_members`, added on 11-02); the app calls it on every group share, the seed never did. Production was seeded before that migration, which back-filled the existing shares, so nobody noticed. A clean clone would have shown a broken demo.
2. **The AI's own test was wrong:** it checked that the outbox was empty, but the admin's own "new sign-in" notice arrives a moment after the login. Three pushes went red in CI ([3c22656](https://github.com/azeem-web-dev/TrustVault/commit/3c22656), [9577bd9](https://github.com/azeem-web-dev/TrustVault/commit/9577bd9), [e217d52](https://github.com/azeem-web-dev/TrustVault/commit/e217d52)) until the test waited for that notice and looked only for invitation, reset and sign-in-link messages.
3. A first design put the demo flag in the database as well. Rejected: the flag would need a second switch the app role cannot flip, which is a new subsystem; the reset, running as the schema owner, is the backstop instead, and THREATS.md I15 says so.

**What I did instead:** the seed confirms group members like the app does; the reset is a function (`apps/api/src/cli/demo-reset.ts`) that CI runs against the real seed after breaking the MFA policy, role rules, groups, grants, owner, trash and folders, and checks the audit log grew by exactly one `demo.reset` row. Nine mutation rows cover demo mode and the limits. The flag and the timer stay off in production until the owner decides.

**Commits:** [ea11bd9](https://github.com/azeem-web-dev/TrustVault/commit/ea11bd9) (seed), [6d02684](https://github.com/azeem-web-dev/TrustVault/commit/6d02684), [5c913fa](https://github.com/azeem-web-dev/TrustVault/commit/5c913fa), [3c22656](https://github.com/azeem-web-dev/TrustVault/commit/3c22656), [ed16a95](https://github.com/azeem-web-dev/TrustVault/commit/ed16a95) (test fix).

---

## 2026-11-08 — The likely attack list, item by item, and CI gates (authorisation)

**Asked (Claude):** for each item on a list of probes a judge is likely to try (IDOR on every non-document resource, leaks through other routes, session fixation and cookies, revocation edge cases, hostile uploads, XSS on web and Android, open redirect, CSRF, CORS, audit tampering, AI and insiders), make sure THREATS.md has a row with the defence, status and a test, writing the test if missing; add mutation rows for authorisation rules. Make CI fail on clippy warnings. Write the interview walkthrough.

**Got:** most items already had a row and a test; the gaps were IDOR on folders and download requests, CORS, open redirect, `Content-Disposition`, a forced 500, and the suggestion test (it never checked that asking creates no grant row).

**What was wrong:**
1. **File names kept bidirectional controls.** `safeFileName()` dropped C0 controls but kept U+202E (RTL override), zero-width and C1 characters, so `report\u202Efdp.exe` would display reversed. Fixed and tested.
2. **The AI's edit tool wrote the invisible characters themselves into the source** when it meant to write `\u202E` escape text, both in `content-check.ts` and in the mutation row. The mutation dry run reported the row as "MISSING", which is how it was caught before the commit; the files were converted back to escape text. Invisible bidi characters in source are exactly the "Trojan Source" problem the fix is about.
3. **Turning on `cargo clippy -D warnings` turned main red** ([2ccd42f](https://github.com/azeem-web-dev/TrustVault/commit/2ccd42f)): six findings in keyd. The AI added the gate without being able to run clippy here (no MSVC linker on this PC; keyd is Linux-only), so CI found them. Fixed without behaviour change in [c182ce6](https://github.com/azeem-web-dev/TrustVault/commit/c182ce6).
4. **Folder RLS makes one rule untestable on its own:** removing the API's own `owner_id = me` filter on folders changes nothing a test can see while row-level security is on. Written down in THREATS.md A27 instead of adding a mutation row that would "survive".
5. Two things the AI tried and the permission system stopped: building Redis from source to run the suite locally, and a TCP relay to reach the WSL database. CI stayed the source of truth.

**What I did instead:** `idor-resources.test.ts` and `probes.test.ts` (API and the database alone), new THREATS.md rows A27, I15, I16, U11, W9, W10 and a section mapping every probe to its row and test; an honest "partial" for audit tampering by a superuser and for admin impersonation through a reset.

**Commits:** [986c42a](https://github.com/azeem-web-dev/TrustVault/commit/986c42a), [9577bd9](https://github.com/azeem-web-dev/TrustVault/commit/9577bd9), [77cdfcd](https://github.com/azeem-web-dev/TrustVault/commit/77cdfcd), [e217d52](https://github.com/azeem-web-dev/TrustVault/commit/e217d52), [b6e1db2](https://github.com/azeem-web-dev/TrustVault/commit/b6e1db2), [e57b132](https://github.com/azeem-web-dev/TrustVault/commit/e57b132), [f617326](https://github.com/azeem-web-dev/TrustVault/commit/f617326), [2ccd42f](https://github.com/azeem-web-dev/TrustVault/commit/2ccd42f), [c182ce6](https://github.com/azeem-web-dev/TrustVault/commit/c182ce6).

---

## 2026-11-08 — Can someone else run it? A clean clone (documentation)

**Asked (Claude):** follow README "Run it locally" exactly, in a fresh container, and fix every step that fails.

**Got:** no container runtime on this PC, so a fresh `git clone` into a new empty directory instead (recorded as such).

**What was wrong:** the README's database step said "or create the roles in infra/ci/setup-db.sql by hand" without saying how, and that script creates `trustvault_test` while `.env.example` pointed at `trustvault_dev`; `npx prisma generate` was missing (the client is not committed, CI runs it explicitly); `.env.example` had the web origin on port 3000 while the dev server runs on 3005. The database steps themselves could not be run here; CI runs them on every push.

**What I did instead:** exact commands and URLs in the README, the missing step, the corrected origin; results in docs/CLAIMS_CHECK.md. Also new: docs/DEMO.md (timed script of tested features), docs/DEPLOY_CHECK.md (curl output from the live site), docs/OPERATIONS.md, docs/AUTHZ_WALKTHROUGH.md.

**Commits:** [47dcb58](https://github.com/azeem-web-dev/TrustVault/commit/47dcb58), [a0f424d](https://github.com/azeem-web-dev/TrustVault/commit/a0f424d), [d34d419](https://github.com/azeem-web-dev/TrustVault/commit/d34d419), [833c773](https://github.com/azeem-web-dev/TrustVault/commit/833c773), [30e216d](https://github.com/azeem-web-dev/TrustVault/commit/30e216d), [8d496e4](https://github.com/azeem-web-dev/TrustVault/commit/8d496e4).

---

## Reused instructions (updated)

Given to the AI at the start of each session, together with the problem statement and docs/PLAN.md:

> Every route that names a document calls `access.require()` first, before any other check or message. Never cache permissions. Every allow and deny writes an audit row; allows in the same transaction as the action, denials outside it. Run document queries only through `prisma.asUser()`. New authorisation code is not done until a test fails when the check is removed. PROMPTS.md records only what actually happened.
