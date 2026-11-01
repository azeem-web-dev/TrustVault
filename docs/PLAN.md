# TrustVault — design plan

Started 2026-11-01. This file records the decisions and why I made them. It changes as the build goes; the git history shows how.

**Status:** built and deployed. Where the build differs from this plan it is noted inline; the threat-by-threat state is in [THREATS.md](../THREATS.md) and the honest list of gaps in [WRITEUP.md](WRITEUP.md#what-is-not-finished).

## The three rules everything is built around

1. **A document is reachable only by someone who was granted it** — decided on the server, every request, every route.
2. **I can prove who reached it** — including refused attempts — from a record that cannot be quietly altered.
3. **Revoking access works immediately** — anything issued before the revoke stops working on the next request.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js + React + TypeScript | Next.js also proxies `/api/*` to the backend so the browser sees one origin and session cookies stay first-party (`SameSite=Strict`). |
| Backend | NestJS + TypeScript | Guards give one obvious place where authorisation happens. |
| Database | PostgreSQL 16 + Prisma | Row-Level Security is a second, independent lock on documents. Triggers and role grants protect the audit table. |
| Jobs / limits | Redis + BullMQ | Rate limiting, audit checkpointing, retention purge, alert detection. **Never used to cache permissions.** |
| Key service | Small Rust daemon (`keyd`) | Holds the master key-encryption key and the audit signing key. Runs as a separate Linux user, reachable only over a Unix socket. The API never has either key in memory. Uses audited crates (RustCrypto / `ring`), no home-made crypto. |
| Hosting | Server 136, `https://vault.rayyanazeem.cloud` | Sandboxed: dedicated `trustvault` user, systemd hardening (`ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, private tmp), own Postgres database and role, Redis bound to localhost with a password. nginx + Let's Encrypt in front. |

### Considered and rejected

| Suggestion | Why not |
|---|---|
| Auth0 / Keycloak | They issue JWTs that stay valid until expiry, which breaks rule 3, and add another system to trust and host. Own server-side sessions revoke instantly. |
| JWT access tokens | Same reason. Opaque session tokens, hashed in the DB, looked up on every request. |
| Open Policy Agent | A network hop and a policy language to defend. One pure TypeScript `decide()` function plus Postgres RLS gives two independent layers and is easier to test. |
| End-to-end encryption / X25519 / post-quantum KEM | If the server cannot read files it cannot validate uploads, search them, or let an admin investigate. The threat it covers (a fully compromised server) is accepted and written in THREATS.md. |
| Rust → WASM in the browser | No security gain server-side; Node's `crypto` already provides AES-256-GCM, HKDF and Ed25519. Rust is used only where isolation adds something (keyd). |
| Pre-signed storage URLs | They keep working after revoke. Files are only streamed through the API after `decide()`. |
| Kubernetes, SIEM, CloudHSM | Out of proportion for one server; cost money; nothing they add that the admin alerts and sandbox do not cover at this size. |

## Permission model

### Account roles
| Role | Can | Cannot |
|---|---|---|
| ADMIN | Manage users and groups, deactivate accounts, view all audit and alerts, verify the audit chain | Open document contents (except break-glass: written reason, 1-hour expiry, flagged alert) |
| OWNER | Upload documents (and so own them), everything a viewer can | Touch documents they were not granted |
| VIEWER | Work with documents granted to them | Upload new documents |
| EXTERNAL | Read documents granted to them | Hold EDIT/MANAGE, join groups, hold a grant without an expiry date |

Admins must use a second factor (passkey or TOTP).

### Per-document grants (to a user or a group)
| Level | Allows |
|---|---|
| READ | metadata, download current version |
| EDIT | READ + upload new version, rename, change category/folder |
| MANAGE | EDIT + grant/revoke, see who has access, see the document's own audit history |
| owner (implicit) | MANAGE + delete, restore, purge, transfer ownership |

### Rules `decide(user, document, action)` enforces
1. Deny by default. Folders organise; they never grant.
2. Effective level = highest live grant, direct or via a group. Expired grants, deactivated users and deleted documents give nothing.
3. Nobody grants more than they have. EDIT cannot grant. MANAGE can grant READ/EDIT only.
4. ADMIN role is not document access.
5. Versions, trash, previews, search, counts and the access list all pass through the same check. Search applies it inside the SQL query.
6. Refused → `404` to the caller, audit row with the reason.
7. Postgres RLS repeats rules 1–2 using `app.user_id` set per transaction, so removing the code check still returns nothing.

## Revocation
- Grants and group membership read live, no cache.
- Revoke / deactivate / role change deletes sessions in the same transaction.
- ~~External share links~~ — decided against during the build: outsiders get named EXTERNAL accounts with an expiry instead, so there is never a link that works for whoever holds it.
- `Cache-Control: no-store` on every document response.
- Accepted: a download already streaming finishes; a file already on someone's disk cannot be recalled.

## Audit trail
- `audit_events`: actor, action, target, result (allowed/denied + reason), IP, user agent, time.
- Written in the same transaction as the action; if the audit insert fails, the action fails.
- Each row stores `hash = SHA-256(prev_hash || canonical(row))`.
- Every 5 minutes (when there are new events), keyd signs the chain head with Ed25519 → `audit_checkpoints`. The public key is published in the repo.
- App DB role: `INSERT, SELECT` only on audit tables; triggers reject `UPDATE`/`DELETE`/`TRUNCATE`.
- Outside witness (added after the first release): a GitHub Actions workflow pulls signed checkpoints every 15 minutes from a public read-only endpoint and commits them to the `witness` branch; the server holds no credential for it (THREATS.md L8).
- Admin "Verify chain" recomputes hashes and checks signatures.

## Files
- Upload: size cap, MIME from magic bytes (not extension or browser header) against an allowlist, filename sanitised and stored as metadata only, SHA-256 recorded.
- Malware scan (added after the first release): every upload is streamed to ClamAV before it is stored; no clean answer, no upload.
- Storage: per-version data key (random), AES-256-GCM bound to document+version, key wrapped by keyd. Encrypted bytes kept in Postgres (`bytea`) so a file and its permissions live and die in one transaction.
- Download: always `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, strict CSP; nothing uploaded is ever rendered inline on our origin.

## Feature scope
Required ten, plus: groups, folders, versions, trash + restore, ownership transfer, external expiring access, retention policy job, passkeys, admin 2FA, alerts (repeated denials, bulk downloads, revoked-user attempts, new external grants, break-glass), AI access suggestions (suggest only; owner confirms; suggestion and decision both audited; the AI code path has no grant capability).

## Tests
- Permission matrix: every endpoint × every role × {owner, READ, EDIT, MANAGE, none, revoked, expired, deactivated, deleted doc}.
- Mutation check script: removes each authorisation check one at a time and requires at least one test to fail.
- Audit tamper tests, revocation-timing tests, upload validation tests.
- CI on GitHub Actions against a real Postgres.

## Build order
1. Monorepo, schema, sessions, roles, deploy skeleton.
2. Encrypted upload/download, validation, `decide()`, matrix tests.
3. Grants, groups, revoke, external expiry, ownership transfer.
4. Audit chain, DB lockdown, keyd signing, admin view + alerts.
5. Search, folders, versions, trash, retention.
6. Passkeys + admin 2FA, AI suggestions, mutation check, attack my own deployment.
7. THREATS.md pass, API docs, README, write-up, demo.
