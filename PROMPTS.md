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
