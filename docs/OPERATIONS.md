# Operations

One page for whoever runs TrustVault: where things are, what to do routinely, and what to do when something goes wrong. Each section names the detailed document; this page does not repeat them.

Server: Ubuntu 24.04, app in `/opt/trustvault/app`, config in `/etc/trustvault/` (root:trustvault, 0640), keys in `/etc/tvkeyd/` (root only). Services: `trustvault-api`, `trustvault-web`, `tvkeyd`, `clamav-daemon`, `postgresql`, `redis`, nginx. Timers: `trustvault-backup` (nightly), `trustvault-anchor` (every minute, Sigstore), and, if installed, `trustvault-demo-reset` (every 4 hours).

## Routine

| What | How | Detail |
|---|---|---|
| Deploy a new version | `sudo bash /opt/trustvault/app/infra/server/deploy.sh` (fetch, install, build, migrate as the schema owner, restart, health check) | README "Deploy" |
| Is it up? | `curl -sS https://vault.rayyanazeem.cloud/api/health` → `{"ok":true}`; the full list of external checks | [DEPLOY_CHECK.md](DEPLOY_CHECK.md) |
| Is the audit log intact? | Admin → Audit log → **Verify integrity**; or export a bundle and run `node tools/verify-audit.mjs bundle.json --key <pinned key> --witness checkpoints.jsonl --rekor` | [VERIFY.md](VERIFY.md) |
| Is the key service consistent with the log? | `$KEYS status` and the hourly reconciliation (`GET /api/admin/keyd/status`, alert on mismatch) | [KEYS.md §6](KEYS.md#6-the-key-use-ledger-and-reconciliation) |
| Backups | Nightly `trustvault-backup.timer` writes an `age`-encrypted tarball (database, master key, config) to `/var/backups/trustvault`; the decryption key is offline. Copy them off the server (`pull-backups.ps1` on the owner's PC; currently by hand) | [RESTORE.md](RESTORE.md), [BACKUP_DR.md](BACKUP_DR.md) |
| Dependency and patch status | `bash infra/server/patch-report.sh`; CI runs `npm audit`, `cargo audit` and the pub audit on every push | [SUPPLY_CHAIN.md](SUPPLY_CHAIN.md) |

## Rotate keys

All key commands are in [KEYS.md §7 "Rotation and recovery procedures"](KEYS.md#7-rotation-and-recovery-procedures). In short:

- **Routine wrapping-key rotation:** add `/etc/tvkeyd/extra/master-2.key`, restart `tvkeyd`, **take a backup first**, then `$KEYS rotate` (resumable), then retire the old generation once `$KEYS verify` is clean.
- **Ticket key:** keep the previous one in `extra/`, write a new `ticket.key`, restart `tvkeyd`, run `infra/server/ticket-key.sh`.
- **Suspected master-key compromise:** new generation, rotate, re-encrypt (`$KEYS reencrypt`), treat the audit signing key as compromised and publish the time, reset every second factor, rotate database passwords.
- **Other credentials** (database roles, Redis ACL, SMTP, `DEVICE_TRUST_KEY`): the list and order are in [INCIDENT.md §6](INCIDENT.md#6-credential-and-key-rotation-list).

## Restore a backup

[RESTORE.md "Restore"](RESTORE.md#restore): decrypt with the offline `age` identity, check every file against `MANIFEST`, restore `/etc/tvkeyd/` first, then `pg_restore` as the schema owner, then `deploy.sh`. Afterwards sign in as an admin and **Verify integrity**: the chain head must match `audit_head` in `MANIFEST`, and the witness/Sigstore copies will show any events that were published after that backup was taken ([BACKUP_DR.md §7](BACKUP_DR.md#7-disaster-scenarios)). A restore drill that needs no server is in RESTORE.md.

## Respond to an alert

Alerts are on Admin → **Alerts**; each one is persistent, has a severity and must be reviewed with a written note (the review history is itself audited). Critical alerts are also emailed to the admins.

| Alert | First move |
|---|---|
| Repeated refusals, attempts after a revoke, an ended session being used | Open the person's audit trail (Audit log, filter by actor). If it looks deliberate, deactivate the account (ends every session on the next request) and follow [INCIDENT.md §4.2](INCIDENT.md#42-stolen-session-sev2) |
| Bulk downloads or page views, unusual hours or networks, high coverage of what someone can open | Check the downloads in the audit log; lower that person's download limit or deactivate; [INCIDENT.md §4.4](INCIDENT.md#44-leaked-document-sev1-or-sev2) for a suspected leak (stamped downloads and page trace codes name whose copy it was) |
| Sign-in after an admin sent a password reset | Possible admin impersonation (THREATS.md S15): contact the person out of band; [INCIDENT.md §4.3](INCIDENT.md#43-malicious-or-compromised-administrator-sev2-sev1-if-they-had-server-access) |
| Break-glass used | Confirm with the approving admin and the owner (who was emailed) that it was expected |
| Integrity failure, key-ledger mismatch | Treat as SEV1: [INCIDENT.md §4.1](INCIDENT.md#41-suspected-root--vps-compromise-sev1) and §4.5. Do not "fix" the database; preserve it |
| Malware found by the nightly re-scan | The version is quarantined automatically (downloads refused). Tell the owner; check who downloaded it before the signature existed |

The full playbooks, severity levels and notification decision tree are in [INCIDENT.md](INCIDENT.md); a rehearsed scenario is in [TABLETOP.md](TABLETOP.md).

## Reset the demo data

The shared demo accounts are published, so visitors change shared state. [DEMO.md "Keeping the shared demo usable"](DEMO.md#keeping-the-shared-demo-usable) explains `DEMO_MODE` and the reset. By hand:

```bash
sudo bash /opt/trustvault/app/infra/server/demo-reset.sh
```

It does nothing unless `DEMO_MODE=true` is in `/etc/trustvault/api.env`. It restores the seed groups, grants, owners, policies and folders, never touches the audit log, and adds one `demo.reset` audit row with what it changed. Status on 2026-11-08: the script and the timer are in the repository; **neither DEMO_MODE nor the timer is switched on in production yet.**
