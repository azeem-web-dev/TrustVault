# Security policy

## Reporting a vulnerability

Please email **security@rayyanazeem.cloud** with a description, steps to reproduce, and what you think the impact is. If you prefer, use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability).

> Owner action: the address `security@rayyanazeem.cloud` must be created (and private vulnerability reporting enabled in the repository settings) before this policy is published. Until then, reports go to the repository owner through GitHub.

Please do **not** open a public issue for a security problem, and do not include real personal data in your report.

What to expect:

| | Target |
|---|---|
| Acknowledgement | within 3 working days |
| First assessment and severity | within 7 working days |
| Fix for critical / high | see [docs/GOVERNANCE.md](docs/GOVERNANCE.md) §2 (critical: 7 days, high: 30 days) |
| Disclosure | coordinated with you; normally when the fix is deployed, or 90 days after the report, whichever is first |

We will credit you in the fix's notes unless you ask us not to. There is no paid bug bounty.

## Scope

In scope:

- The TrustVault application in this repository: API (`apps/api`), web (`apps/web`), Android app (`apps/mobile`), key service (`keyd`), database migrations, audit tools (`tools/`), deployment scripts (`infra/`).
- The live service at `https://vault.rayyanazeem.cloud`, **only** within the safe-harbour rules below.
- The audit verification design ([docs/VERIFY.md](docs/VERIFY.md)): a way to make a false history pass verification is a high-severity finding.

Out of scope:

- Volume-based denial of service, spam, social engineering, physical attacks.
- The hosting provider, GitHub, Sigstore and other third parties (report to them).
- Other services that share the same server.
- Reports from automated scanners without a demonstrated impact; missing headers without an exploit; the published demo credentials (they are public on purpose, see README).

## Safe harbour

If you act in good faith under this policy, we will not pursue or support legal action against you, and we consider your research authorised. Good faith means:

- use only accounts you created or the published demo accounts; do not access, change or delete other people's data; if you reach any, stop, and report it without keeping a copy;
- do not degrade the service for others (no flooding, no mass account creation, no lockout of accounts you do not own);
- do not try to break the protected demo accounts for other visitors;
- give us reasonable time to fix before disclosing;
- do not test the server's operating system or other services on it.

This safe harbour covers our own claims only; we cannot waive the rights of third parties.

## Verifying our audit log

You do not need to report anything to check our audit claims: [docs/VERIFY.md](docs/VERIFY.md) explains how to verify an exported audit bundle independently, with the production audit public key `OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE=` (Ed25519, key id `keyd-ed25519-v1`).

## Supported versions

Only the current `main` branch, as deployed, receives fixes.
