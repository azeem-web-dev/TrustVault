# SOC 2 and ISO 27001 readiness map

Checklist item 24. **TrustVault is not SOC 2 attested and not ISO/IEC 27001 certified, and no audit has started.** This page maps what exists to the SOC 2 Trust Services Criteria (2017, revised points of focus 2022) and to ISO/IEC 27001:2022 Annex A, so the owner can see the gap if a customer asks. "Evidence" points at something an auditor could inspect today; "Gap" is what an auditor would likely ask for and is missing.

The biggest gap for either framework is not technical: it is **organisational** (written policies approved by management, a risk register, HR controls, vendor management, evidence collected over a period). A one-person operation can still do most of it, but a SOC 2 Type II needs 3–12 months of operating evidence.

Legend: ✅ in place with evidence · 🟡 partly · ❌ missing · ⏳ being built on a branch (not deployed).

## SOC 2 Trust Services Criteria

| Criterion | Control in TrustVault | Evidence today | Gap |
|---|---|---|---|
| CC1.1–1.5 Control environment (integrity, oversight, structure, competence, accountability) | owner-run; security reasoning documented | THREATS.md, PROMPTS.md, GOVERNANCE.md | ❌ no board/oversight, code of conduct, HR screening, training records |
| CC2.1 Information for internal control | audit log, alerts, verification | `apps/api/src/audit`, Admin → Alerts | 🟡 alert review not recorded (log of reviews needed) |
| CC2.2 Internal communication | runbooks | INCIDENT.md, GOVERNANCE.md | 🟡 one person; no acknowledgement records |
| CC2.3 External communication | disclosure policy, verification guide | SECURITY.md, VERIFY.md | 🟡 security inbox must be created; no customer-facing security page or status page |
| CC3.1–3.4 Risk assessment, fraud risk, change in risk | threat model with status per threat | THREATS.md | 🟡 no likelihood/impact scoring, no risk register with owners and review dates |
| CC4.1–4.2 Monitoring of controls | CI tests, mutation check, witness workflow, daily alerts | `.github/workflows/ci.yml`, `witness.yml`, MUTATION_REPORT.md | 🟡 no periodic control self-assessment; no independent test (⏳ PENTEST_SCOPE.md) |
| CC5.1–5.3 Control activities, policies | deny-by-default code + RLS; documented release gates | access.ts, RLS migrations, GOVERNANCE.md §3 | ❌ formal approved policies (information security, acceptable use, access control, cryptography, change, BC/DR, incident, vendor, data retention) |
| CC6.1 Logical access: identification, authentication, encryption | roles, per-document grants, RLS, Argon2id, TOTP/passkeys, AES-256-GCM per file, keyd | API.md, THREATS.md A*/S*/K*, tests | 🟡 per-role MFA policy ⏳ `mfa-advanced`; keyd authorization ⏳ `keyd-ledger`; DB protection for role changes ⏳ P0 |
| CC6.2 Provisioning | accounts by invitation only, end dates for externals | THREATS S18, `invite.test.ts` | 🟡 no joiner/leaver procedure for staff with server access |
| CC6.3 Role changes, least privilege | roles; admins cannot read content except break-glass | README Roles, `revocation-holes.test.ts` | 🟡 admin password-set route (S15) removed in ⏳ P0; dual approval not built |
| CC6.4 Physical access | hosting provider | — | ❌ provider's SOC 2/ISO report not collected |
| CC6.5 Disposal | trash purge, audited | `jobs.service.ts` retention | 🟡 media disposal is the provider's; backup deletion on PC is manual |
| CC6.6 External threats at boundaries | nginx TLS/HSTS/rate limits; API loopback; firewalling | `infra/nginx/vault.conf` | 🟡 host firewall configuration not in the repo; shared VPS (THREATS I1) |
| CC6.7 Data in transit | TLS everywhere external; Unix sockets internal | nginx config | ✅ |
| CC6.8 Malicious software | ClamAV on upload, nightly re-scan, quarantine; `--ignore-scripts` | THREATS U*, I5, `rescan.test.ts` | 🟡 dependency scanning ⏳ `supply-chain` |
| CC7.1 Vulnerability detection | tests, gitleaks | CI | 🟡 ⏳ npm/cargo audit, SBOM (`supply-chain`); no scheduled OS vuln scan |
| CC7.2 Monitoring for anomalies | alerts (denials, bulk download, after-revoke, ended session, reset-then-sign-in), witness, anchor | `audit-admin.service.ts` alerts | 🟡 fixed thresholds, top-20 lists (⏳ `insider-detect`); no host intrusion detection; no log shipping off the server |
| CC7.3–7.5 Incident evaluation, response, recovery | runbook, tabletop, evidence commands, rebuild procedure | INCIDENT.md, TABLETOP.md | 🟡 never exercised: run the first tabletop and keep the record |
| CC8.1 Change management | PRs, CI gates, deploy script with health check | GOVERNANCE.md §3, `deploy.sh` | 🟡 no second reviewer; no change tickets tied to deploys |
| CC9.1 Business disruption risk | backups, DR targets | BACKUP_DR.md | 🟡 off-site immutable copy and second key copy are owner actions |
| CC9.2 Vendor management | — | — | ❌ list of vendors (Hostinger, GitHub, Sigstore, mail, backup storage) with their assurance reports and data processing terms |
| A1.1 Capacity | single VPS | — | ❌ capacity monitoring |
| A1.2 Backups, environmental protections | nightly encrypted backup, PC copy | BACKUP_DR.md | 🟡 see BACKUP_DR §8 |
| A1.3 Recovery testing | restore tested once on the server; drill tool | RESTORE.md "Tested", `restore-drill.sh`, synthetic drill results | 🟡 no real-key drill on separate infrastructure yet |
| C1.1 Identify and protect confidential information | every document encrypted with its own key, access per document, two independent locks | THREATS A*, K* | ✅ for documents; 🟡 view-only/watermark ⏳ `view-only` |
| C1.2 Disposal of confidential information | trash purge after 30 days, audited | `jobs.service.ts` | 🟡 backups keep deleted data until they expire (document it to customers) |
| PI1.x Processing integrity | upload SHA-256 checked on every download; blob bound to its row; audit chain | THREATS U*, `documents.test.ts` | ✅ (only if PI is in scope) |
| P1–P8 Privacy | data minimisation in the witness endpoint; no tracking | THREATS I9 | ❌ privacy notice, consent/notice records, data subject request process, retention schedule approved |

## ISO/IEC 27001:2022 Annex A (selected controls)

Clauses 4–10 (ISMS scope, leadership, risk assessment and treatment, Statement of Applicability, internal audit, management review) are all ❌: they are the core of certification and none exists yet.

| Control | Evidence today | Gap |
|---|---|---|
| 5.1 Policies for information security | GOVERNANCE.md (draft-level) | ❌ approved policy set |
| 5.2 Roles and responsibilities | GOVERNANCE.md §1 | 🟡 single person |
| 5.3 Segregation of duties | admins cannot read documents; keyd separate from API; witness separate from server | 🟡 one human holds every role |
| 5.7 Threat intelligence | — | ❌ |
| 5.9 Inventory of assets | ARCHITECTURE.md "where each secret lives" | 🟡 no hardware/software/vendor inventory |
| 5.10 Acceptable use | — | ❌ |
| 5.12–5.13 Classification and labelling | documents have categories | ❌ classification scheme |
| 5.15 Access control | API.md, RLS, THREATS A* | ✅ technical; ❌ written policy |
| 5.16–5.18 Identity, authentication, access rights | invitations, MFA, passkeys, access reviews (GOVERNANCE §4) | 🟡 reviews not yet performed and recorded |
| 5.19–5.22 Supplier relationships, cloud services | — | ❌ vendor register and agreements |
| 5.23 Information security for use of cloud services | — | ❌ |
| 5.24–5.28 Incident management, evidence collection | INCIDENT.md, TABLETOP.md | 🟡 not exercised |
| 5.29–5.30 ICT readiness for business continuity | BACKUP_DR.md | 🟡 |
| 5.31 Legal and regulatory requirements | INCIDENT.md §5 (CERT-In, DPDP, GDPR) | ❌ legal register; CERT-In 180-day log retention in India not assessed (server location) |
| 5.33 Protection of records | audit chain, append-only, anchored | ✅ |
| 5.34 Privacy and PII | GOVERNANCE.md §6 | ❌ privacy notice, DPIA |
| 5.35 Independent review | — | ❌ (⏳ PENTEST_SCOPE.md) |
| 6.1–6.6 People controls (screening, terms, awareness, NDA) | — | ❌ |
| 7.x Physical controls | hosting provider | ❌ provider attestation not collected |
| 8.2 Privileged access rights | separate Unix users, DB roles owning nothing, break-glass | 🟡 root on a shared VPS |
| 8.3 Information access restriction | RLS + `decide()` | ✅ |
| 8.5 Secure authentication | Argon2id, lockout, TOTP, passkeys, timing floor | ✅ (`auth.test.ts`, LOGIN_TIMING.md) |
| 8.7 Protection against malware | ClamAV, re-scan | ✅ |
| 8.8 Technical vulnerabilities | tests, gitleaks | 🟡 ⏳ `supply-chain` |
| 8.9 Configuration management | infra scripts in git | 🟡 server drift not checked |
| 8.12 Data leakage prevention | per-document access, alerts | 🟡 no DLP; view-only ⏳ |
| 8.13 Information backup | BACKUP_DR.md | 🟡 |
| 8.15 Logging | audit log, journald | 🟡 system logs stay on the server |
| 8.16 Monitoring activities | alerts, witness | 🟡 |
| 8.20–8.22 Network security, segregation | loopback services, Unix sockets, pg_hba | 🟡 shared VPS |
| 8.24 Use of cryptography | AES-256-GCM, HKDF, Ed25519, age | 🟡 key rotation ⏳ `keyd-ledger`; no written crypto policy |
| 8.25–8.29 Secure development, testing | CI tests, mutation check, THREATS per change | ✅ technical; 🟡 no second reviewer |
| 8.31 Separation of environments | dev/test roles separated by pg_hba | ❌ no staging (PENTEST_SCOPE §4) |
| 8.32 Change management | GOVERNANCE.md §3 | 🟡 |
| 8.34 Protection during audit testing | PENTEST_SCOPE.md rules of engagement | 🟡 |

## Suggested order if a customer asks

1. Write and approve the policy set (short, real, matching what is done); start the review log, risk register and vendor register.
2. Close the P0 items and the backup gaps (off-site immutable copy, second key copy, real-key drill).
3. Staging environment and an independent penetration test; fix and retest.
4. Collect 3+ months of operating evidence (access reviews, drills, tabletop records, change records).
5. Then a SOC 2 Type I readiness assessment, or an ISO 27001 gap assessment, by a qualified firm.
