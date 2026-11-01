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

---

## Reused context

The problem statement and [docs/PLAN.md](docs/PLAN.md) are given to the AI at the start of each working session, with the instruction: *"Every endpoint must go through decide(); never cache permissions; every allow and deny writes an audit row in the same transaction."*

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

**What was wrong (found before running it, by reading which tests exercise which line):**
1. The session lookup re-checks "account deactivated" and "password changed since this session" on every request. But every API path that deactivates or changes a password **also deletes the sessions**, so removing those re-checks would have left every test green. They are a backup layer that no test exercised.
2. Search has an app-side access filter and RLS underneath. Remove the app filter and RLS still hides everything, so no API test can tell. Defence in depth makes a single layer untestable through the API.

**What I did instead:** (1) tests that deactivate an account, move `password_changed_at` or expire an external account **directly in the database**, so only the per-request check stands between the old cookie and the app; (2) moved the search filter into `buildSearchWhere()` and tested it with a database connection as the table owner (which RLS does not apply to), so the app filter is tested alone. RLS is tested alone in `rls.test.ts`, and `decide()` alone in `access.unit.test.ts`. The mutation report shows each removal caught: [docs/MUTATION_REPORT.md](docs/MUTATION_REPORT.md).

---

## 2026-11-01 — Toolchain surprises (not security, recorded because they cost time)

- NestJS 12 ships as ES modules, and TypeScript 7 was the default install; Nest's dependency injection needs the older decorator metadata. Pinned TypeScript 5.9 and used explicit `@Inject()` on every constructor parameter, so injection works the same under the dev runner, the test runner and the build.
- Ubuntu 24.04's default Rust (1.75) cannot build current crates (edition 2024). Used the archive's versioned `rustc-1.91` instead of piping an install script into a shell.
- The Redis ACL I wrote refused `KEYS` in my own test cleanup. Correct behaviour, so the tests use `SCAN`.

---

## 2026-11-01 — Login timing: "equalised by design" was not true (authentication)

**Asked (Claude):** "Fix the remaining gaps" — one of them was that login timing was equalised by design (a dummy Argon2 verify for unknown emails) but never measured. So it wrote `npm run measure:timing`: hundreds of failed logins of three kinds (unknown email, real account with a wrong password, locked account), interleaved randomly, through the full HTTP stack with production Argon2 settings, then fits an attacker's best threshold on half the samples and scores it on the other half.

**What was wrong:** the first run failed its own check. A wrong password on a real account was 40 ms slower than an unknown email, and the threshold guessed right **78%** of the time — anyone could have tested which emails have accounts. The cause: the wrong-password path also updated the failed-login counter, one extra database round trip.

**Then the AI's first fix made it worse:** it moved the counter update and the audit row into one transaction, reasoning that the extra *commit* was the cost. Measured again: 152 ms and **99%**. A breakdown of each step showed every query cost about 50 ms on this machine (the database is behind a forwarded port) and an interactive transaction adds BEGIN and COMMIT round trips; the number of round trips was the leak, not commits.

**What I did instead:** the counter, the lock and the audit row are now **one SQL statement** (a data-modifying CTE), so every failure path costs one Argon2 verify plus one statement. As a second layer, every failed login is padded to 450 ms. Measured again with the padding off: 56% and 51% (chance); with it on: see [docs/LOGIN_TIMING.md](docs/LOGIN_TIMING.md). A new test checks the single statement still locks for 15 minutes and then doubles, with the right audit reason.

---

## 2026-11-01 — Closing the audit and upload gaps (audit trail)

**Asked (Claude):** build an outside witness for the audit chain, malware scanning, encrypted backups and a full passkey test.

**Decisions I made, and why:**
- **Witness is pulled, not pushed.** If the server pushed checkpoints somewhere, it would need a credential, and whoever owns the server would own that credential. Instead a public read-only endpoint serves checkpoints only, and a scheduled GitHub Actions job pulls them into the `witness` branch. The test that matters re-signs a forged history **with the real signing key** — the witness still rejects it, because the heads already recorded on GitHub cannot be matched.
- **The scanner fails closed,** and only an exact `stream: OK` counts as clean. The tests run the real clamd protocol code against a fake daemon that can refuse connections, answer nonsense or never answer.
- **Passkeys are tested with a software authenticator** that builds real WebAuthn bytes and P-256 signatures, so the server's verification runs unchanged.

**What was wrong:** the witness test helper first read only the first 1000 checkpoints. Checkpoints can never be deleted from the test database, so after enough test runs the newest ones would have fallen off the page and the test would have failed for no real reason. It now pages exactly as the real tool does. Small, but it would have looked like a real alarm.

**And one in the mutation check itself:** running the full suite showed the local test database's audit log had been wiped earlier. The mutation check disables the audit table's append-only trigger and then runs the test "even the table owner cannot TRUNCATE audit rows". With the trigger gone the TRUNCATE succeeded: the test failed as intended (mutation caught), but it also emptied the log, leaving signed checkpoints that pointed at events that no longer existed. Only the test database was affected. Those owner attempts now run inside a transaction that is always rolled back, so a missing guard fails the test without destroying anything; the orphaned test checkpoints were removed.

---

## Reused instructions (updated)

Given to the AI at the start of each session, together with the problem statement and docs/PLAN.md:

> Every route that names a document calls `access.require()` first, before any other check or message. Never cache permissions. Every allow and deny writes an audit row; allows in the same transaction as the action, denials outside it. Run document queries only through `prisma.asUser()`. New authorisation code is not done until a test fails when the check is removed. PROMPTS.md records only what actually happened.
