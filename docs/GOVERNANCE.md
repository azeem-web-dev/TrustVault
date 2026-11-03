# Security governance

Checklist item 27. How security decisions are made, checked and recorded for TrustVault. Today there is one owner-operator; where a control needs two people, this page says so and what to do until there are two.

Documents this governs: [THREATS.md](../THREATS.md) (threat model and assumptions), [ARCHITECTURE.md](ARCHITECTURE.md) (architecture and trust boundaries), [SECURITY.md](../SECURITY.md) (disclosure), [INCIDENT.md](INCIDENT.md) and [TABLETOP.md](TABLETOP.md) (incidents), [BACKUP_DR.md](BACKUP_DR.md) (continuity), [PENTEST_SCOPE.md](PENTEST_SCOPE.md), [COMPLIANCE.md](COMPLIANCE.md), [VERIFY.md](VERIFY.md).

## 1. Ownership

| Area | Owner | Review |
|---|---|---|
| Threat model (THREATS.md) | owner | every release that changes a boundary; full review quarterly |
| Architecture diagram | owner | when a component or boundary changes |
| Disclosure inbox | owner | checked every working day |
| Incident response | owner (incident lead) | runbook reviewed after every incident and every tabletop |
| Backups and restore drills | owner | monthly drill (BACKUP_DR §6) |
| Access reviews | owner; a second person once there is one | §4 |
| Dependencies | owner | §5 |

## 2. Severity levels (vulnerabilities and findings)

Used for reports (SECURITY.md), pentest findings, CI scanner results and our own discoveries. Incident severities (SEV1–4) are in INCIDENT.md §1.

| Level | Definition | Examples | Fix deadline on production |
|---|---|---|---|
| **Critical** | read or change documents or audit history without authorization, at scale or without user interaction; key compromise | RLS bypass, keyd master-key disclosure, forged history that passes verification | mitigate within 24 h, fix within 7 days |
| **High** | the same for one account or document, or with a precondition (a stolen session, an admin account); breaks a documented control | admin impersonation (S15), revocation race (checklist 2), stored XSS in admin views | 30 days |
| **Medium** | defence-in-depth failure, information disclosure of metadata, detectable abuse | alert evasion, enumeration through timing | 90 days |
| **Low** | hardening, best practice | headers, verbose versions | next planned work |

If a deadline cannot be met: record the risk acceptance in THREATS.md (what, why, until when, compensating control), and tell affected customers when they would expect to know.

## 3. Release gates

A change reaches production only through `infra/server/deploy.sh` from `main`. Before merging to `main`:

| Gate | How | Status |
|---|---|---|
| All tests pass (API against real Postgres + Redis, passkeys e2e, keyd, offline verifier, **independent verifier agreement**) | GitHub Actions `ci.yml` | **exists** |
| Mutation check: every authorization rule removed must fail a test | `tools/mutation-check.mjs` in CI on push | **exists** |
| Secret scan | gitleaks in CI | **exists** |
| Type check and web build | CI | **exists** |
| Dependency vulnerability scan (npm, Cargo), SBOM, provenance | **in progress** on branch `supply-chain` | not yet a gate |
| A THREATS.md row for any new boundary, route or stored secret | review | manual |
| Migrations: reviewed for RLS, grants and audit triggers; `audit_verify()` passes after migrating a copy of production data | review + restore drill on a copy | manual |
| Changes to `backup.sh`, schema or key handling: a restore drill passes | BACKUP_DR §6 | manual |
| Second-person review of security-relevant changes | GitHub required review | **not possible with one person**; until then, the owner reviews the diff the next day ("sleep on it") and records it in the PR |

Emergency fixes may skip the waiting period but not the tests; record why.

## 4. Access reviews

| What | Cadence | How | Evidence |
|---|---|---|---|
| TrustVault admin accounts | monthly | Admin → Users, role ADMIN: each still needed? second factor enrolled? | note in the review log |
| All accounts: deactivate leavers, check EXTERNAL end dates, INVITED never accepted > 7 days | monthly | Admin → Users | review log |
| Break-glass uses | monthly | audit log `admin.break_glass`; each had a valid reason and the owner was told | review log |
| Server access: SSH keys in every `authorized_keys`, sudoers, users | quarterly | on the server, compared with the expected list | review log |
| Hosting, DNS, GitHub, mail, backup-storage accounts: who has access, 2FA on | quarterly | provider panels | review log |
| GitHub: branch protection on `main` and `witness`, Actions permissions, deploy keys, PATs | quarterly | repository settings | review log |
| Key custody: where the age identity copies are; still readable (drill) | quarterly | BACKUP_DR §4/§6 | drill report |

The review log is a dated list (who reviewed, what changed) kept with the incident logs, off the server.

## 5. Dependency review

| What | Cadence |
|---|---|
| `npm audit` (production dependencies) and `cargo audit` for keyd | weekly until automated (branch `supply-chain`), then on every CI run |
| Ubuntu security updates on the server (`unattended-upgrades` or manual) | weekly; reboot when the kernel changes |
| Major version upgrades (Node, Next.js, NestJS, Prisma, PostgreSQL) | quarterly review; never on a Friday |
| New dependency added | at review time: maintenance, licence, install scripts (installs use `--ignore-scripts`; THREATS I5) |

## 6. Audit log: retention, access and privacy

| | Policy |
|---|---|
| **Retention** | audit events are kept for the life of the service: the hash chain cannot drop old events without breaking verification. Customers needing deletion of old audit data get a new chain epoch (not built) rather than silent deletion. Backups containing audit data age out per BACKUP_DR §3 |
| **Who can read** | ADMIN role (after second factor) reads the whole log and exports it; document MANAGE holders see that document's history; nobody else. Every export is itself audited (`audit.export`) |
| **Who can change** | nobody through the application or as the table owner (THREATS L1). A database superuser could; signed, published checkpoints make that detectable (L2, L8) |
| **What it contains** | account email and id, action, outcome, reason, target ids, document id, IP address, user agent, request id, details (file names, SHA-256, titles, old/new descriptions: THREATS L11). Never document content |
| **Public parts** | checkpoint numbers, hashes, signatures and times (witness endpoint, Sigstore, `witness` branch). They reveal activity volume (THREATS I9), no content |
| **Personal data** | IP addresses and emails are personal data. Lawful basis: security and accountability of the service the customer asked for. State this in the privacy notice. Access requests: export the person's events by actor email |
| **Evidence handling** | an exported bundle given to a third party is verified (VERIFY.md) and its SHA-256 recorded before handover |

Other personal data: documents are the customer's; TrustVault processes them only to store and deliver them. Deleted documents are purged after `TRASH_RETENTION_DAYS` (30) and leave backups after their retention. Sessions expire after 12 h at most. A privacy notice for users is **owner action** (not written yet).

## 7. Exercises and assurance

| What | Cadence | Where |
|---|---|---|
| Incident tabletop | quarterly, rotating scenarios | TABLETOP.md |
| Restore drill | monthly; full rebuild twice a year | BACKUP_DR.md §6 |
| Independent penetration test | before handling high-value production data, then yearly and after major changes | PENTEST_SCOPE.md |
| Compliance readiness review | yearly, or when a customer asks | COMPLIANCE.md |

## 8. Claims we make and do not make

Public wording follows the review checklist's "wording to use and avoid": we say the audit history is **tamper-evident and independently verifiable**, that we **distinguish integrity from completeness**, and that view-only and watermarks (when shipped) are **deterrence**. We do not say root-proof, unhackable, certified, or that we prove which human read a document.
