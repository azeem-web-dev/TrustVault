# Documentation index

Every file in `docs/`, one line each. At the repository root: [README.md](../README.md) (start there), [THREATS.md](../THREATS.md) (threat model, defences and the tests that prove them), [PROMPTS.md](../PROMPTS.md) (AI usage log) and [SECURITY.md](../SECURITY.md) (how to report a vulnerability).

## Start here

| File | What it is |
|---|---|
| [WRITEUP.md](WRITEUP.md) | What was built, what was deliberately not, the permission model, how AI was used, what is unfinished |
| [DEMO.md](DEMO.md) | The five-minute demo script |
| [PLAN.md](PLAN.md) | The design plan and the decisions behind it |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components and trust boundaries in one place |
| [AUTHZ_WALKTHROUGH.md](AUTHZ_WALKTHROUGH.md) | The authorisation code path, written to speak from in the interview |
| [CLAIMS_CHECK.md](CLAIMS_CHECK.md) | Every checkable claim in the README, write-up and API docs, how it was checked and what was found |

## Security

| File | What it is |
|---|---|
| [KEYS.md](KEYS.md) | Key hierarchy, keyd and its tickets, the signed key-use ledger, rotation and recovery |
| [ACCESS_POLICIES.md](ACCESS_POLICIES.md) | Conditions on a share (download approval, working hours, networks, devices), role rules, emergency exceptions |
| [VERIFY.md](VERIFY.md) | How anyone can verify an audit export without our code |
| [MUTATION_REPORT.md](MUTATION_REPORT.md) | Each authorisation rule removed in turn, and the test that caught it |
| [LOGIN_TIMING.md](LOGIN_TIMING.md) | Measured: failed-login response time does not reveal which emails have accounts |
| [LOGIN_TIMING_floor0.md](LOGIN_TIMING_floor0.md) | The same measurement with the timing padding switched off |
| [SUPPLY_CHAIN.md](SUPPLY_CHAIN.md) | Pinned actions, lockfiles, dependency audit, SBOMs, reproducible keyd, signed releases |
| [PENTEST_SCOPE.md](PENTEST_SCOPE.md) | Brief for an independent penetration tester (none has been done yet) |
| [COMPLIANCE.md](COMPLIANCE.md) | SOC 2 / ISO 27001 readiness map (not attested or certified) |
| [GOVERNANCE.md](GOVERNANCE.md) | How security decisions are made, checked and recorded |
| [E2E_DESIGN.md](E2E_DESIGN.md) | Design for an optional end-to-end encryption mode (not built) |

## Operations

| File | What it is |
|---|---|
| [OPERATIONS.md](OPERATIONS.md) | One page for whoever runs it: where things are, routine tasks, what to do when something breaks |
| [DEPLOY_CHECK.md](DEPLOY_CHECK.md) | Copy-paste checks against the live site, with the expected answers |
| [BACKUP_DR.md](BACKUP_DR.md) | Backups, off-site copy, restore drill, recovery targets |
| [RESTORE.md](RESTORE.md) | The nightly backup and how to restore from one |
| [INCIDENT.md](INCIDENT.md) | Incident response runbook |
| [TABLETOP.md](TABLETOP.md) | Incident tabletop exercises |

## Development

| File | What it is |
|---|---|
| [API.md](API.md) | Every endpoint and who may call it |
| [AI_CONTEXT.md](AI_CONTEXT.md) | The context given to the AI assistant at the start of each session |

## Android

| File | What it is |
|---|---|
| [ANDROID_SECURITY.md](ANDROID_SECURITY.md) | The Android app's security tests and what they cover |
| [ANDROID_RELEASE.md](ANDROID_RELEASE.md) | Release builds of the Android app |

The app itself is described in [apps/mobile/README.md](../apps/mobile/README.md).
