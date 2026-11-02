# Incident response runbook

For the people running TrustVault at `vault.rayyanazeem.cloud` (today: one owner-operator). Print it, or keep a copy **off** the server: during a server compromise you cannot trust anything stored on it, including this file.

Rehearse it with [TABLETOP.md](TABLETOP.md). Related: [BACKUP_DR.md](BACKUP_DR.md) (restores), [VERIFY.md](VERIFY.md) (checking the audit log from outside), [THREATS.md](../THREATS.md) (what the design accepts: I6 root compromise, L5/L8 audit anchoring).

> **Not legal advice.** The notification section summarises public rules as we understand them on 2026-11-03 so that the operator knows a clock may be running. Confirm obligations with a lawyer for each incident.

Status of tooling referred to here: **exists** = in production today; **in progress** = on a branch, not deployed (do not rely on it); **not built**.

---

## 1. Severity levels

| Level | Meaning | Examples | Response |
|---|---|---|---|
| **SEV1** critical | Confidentiality or integrity of customer documents or the audit log is lost or very likely lost, or the service is controlled by someone else | root/VPS compromise; master key or backup key exposed; audit verification fails; witness alarm not explained by our own action; documents confirmed in the wrong hands | start now, day or night; contain within 15 minutes; regulator clocks may run (§5) |
| **SEV2** high | A single account or a single document is compromised, or a security control has failed without confirmed data loss | stolen session; admin abusing break-glass or the old set-password route (THREATS S15); malware found in a stored file; backups failing for > 2 days | same day; contain within 1 hour |
| **SEV3** medium | A weakness or suspicious activity with no evidence of misuse | repeated denials from one account; one failed witness run that recovers; a dependency CVE that may apply | within 2 working days |
| **SEV4** low | Hygiene | expired test accounts, noisy alerts | next planned work |

When unsure, pick the higher level and downgrade later. Record every change of level and why.

## 2. Roles

| Role | Today | Does |
|---|---|---|
| Incident lead | the owner | decides, keeps the timeline, owns communication |
| Operator | the owner | runs commands, captures evidence |
| Scribe | the owner (write as you go) | timestamps everything in the incident log |
| Legal / privacy contact | **owner to appoint** | notification decisions (§5) |
| Hosting provider | Hostinger support | snapshots, console access, network blocks, abuse reports |

With one person, the danger is skipping steps under pressure. Use the checklists and write the time next to each line.

**Incident log:** a plain text file on the owner's PC (not on the server), e.g. `C:\Users\ridah\TrustVault-incidents\<date>-<name>.md`, starting with the template in §10. Every action gets a UTC time.

## 3. Triggers: how you will find out

| Signal | Where | Likely incident |
|---|---|---|
| "Audit witness" workflow failed (GitHub emails the owner) | GitHub Actions | audit history changed or removed on the server, anchor service down, or the server down |
| `audit_verification_failed`, `file_integrity`, `malware_found` alerts | Admin → Alerts | tampering, storage corruption, malware |
| `reset_then_sign_in`, `ended_session_used`, `access_after_revoke`, `repeated_denials`, `bulk_download`, `break_glass` alerts | Admin → Alerts | stolen session, malicious admin, insider |
| Unknown SSH login, new user, new cron job, odd process | server | root compromise |
| A document appears outside (press, a competitor, a customer report) | outside | leaked document |
| `LAST_OK` older than a day; pull script log `FAILED` | server / PC | backup failure → data-loss risk |
| Hostinger notice (abuse, suspension), DNS change notice | email | account compromise |
| A report to `security@rayyanazeem.cloud` | email | anything (SECURITY.md) |

Alert limits to know: alert lists show the top 20 per kind and thresholds are fixed (checklist item 9; improvements on branch `insider-detect`, **in progress**). Look at the raw audit log too.

---

## 4. Playbooks

### 4.1 Suspected root / VPS compromise (SEV1)

Assume the attacker can read every file and process memory on the server, including keyd's master key (THREATS I6), and can change anything not yet published outside. What they cannot do without detection: change audit history already in Sigstore's public log or the GitHub witness, or decrypt backups (encrypted to the offline key).

**The VPS is shared with other services** (THREATS I1). Containment of the VPS affects them too; tell their owners.

#### First 15 minutes

| Min | Action | How |
|---|---|---|
| 0 | Declare SEV1, open the incident log, note who/what/when you saw | §10 |
| 0–2 | **Do not log in to the server yet** unless you must. Every login changes evidence and may tip off the attacker | |
| 1–4 | **Snapshot the disk from the provider panel** (hPanel → VPS → Snapshots & Backups → Create snapshot). This preserves the disk as it is. Note the time. On Hostinger a new snapshot replaces the previous one: check you are not overwriting the only clean one; if in doubt, download/record the old one first | provider panel |
| 3–6 | **Contain from outside the server.** hPanel → VPS → Firewall: create a rule set that drops all inbound traffic except SSH (22/tcp) from your current IP, and activate it. This takes TrustVault offline (port 443 closed). Taking the site down is the right default when data may be leaving. If you can only block, block; if you can't reach the panel, ask support to null-route the IP | provider panel |
| 5–8 | **Secure the accounts that control the server:** change the Hostinger account password, check its 2FA, check for unknown API tokens and SSH keys added in the panel, check DNS records for `rayyanazeem.cloud` | provider panel, registrar |
| 6–10 | **Check the outside truth**, which the attacker cannot alter: the latest run of the "Audit witness" workflow and the last line of `checkpoints.jsonl` on the `witness` branch; the newest Sigstore entry for the audit key (`rekor-cli search --public-key trustvault-audit.pem --pki-format x509`, see VERIFY.md §6). Write down the last seq known to be published | GitHub, Rekor |
| 8–12 | Decide: **power off** (stops exfiltration, loses memory) or **keep running isolated** (allows memory capture). Default: if you cannot capture memory within the next 30 minutes, power off from the panel after the snapshot | panel |
| 12–15 | Rotate the credentials the attacker can use **from outside** the server right now, in this order: SMTP mailbox password (Hostinger mail, used by `mail.env`); GitHub account/PAT if it was ever on the server (it should not be); Backblaze/S3 keys if off-site push is enabled (the key on the server cannot delete locked objects, but revoke it). Full list in §6 | |

Then: evidence (§4.1.1), scope (§4.1.2), rotation (§6), rebuild (§7), notification decision (§5).

#### 4.1.1 Evidence capture

Best: analyse the **snapshot** on a clean machine, not the live system (the attacker's root may hide things from live tools). Restore the snapshot to a new, firewalled VPS with no public ports, or download the disk image, and mount it read-only.

If you must collect from the live server (for example before powering off), use these **read-only** commands as root, from a fresh SSH session, writing only into a new folder, and then ship the folder off the box with hashes. Run them in this order (most volatile first). Assume output may be lied to by a rootkit; compare with the snapshot later.

```bash
umask 077; IR=/root/ir-$(date -u +%Y%m%dT%H%M%SZ); mkdir "$IR"; cd "$IR"
exec > >(tee -a "$IR/00-commands.log") 2>&1; set -x       # record what was run
date -u; uptime; hostnamectl
# volatile: who, what runs, network
who -a > who.txt; w > w.txt; last -Faiwx > last.txt; lastb -Faiwx > lastb.txt 2>/dev/null
ps auxwwf > ps.txt; ls -l /proc/[0-9]*/exe 2>/dev/null > proc-exe.txt; grep deleted proc-exe.txt > proc-exe-deleted.txt
ss -tanpu > ss.txt; ip -a addr > ip.txt; ip route > route.txt; nft list ruleset > nft.txt 2>&1; iptables-save > iptables.txt 2>&1
lsmod > lsmod.txt; cat /proc/mounts > mounts.txt
# persistence points (see §8)
systemctl list-units --all --no-pager > units.txt; systemctl list-unit-files --no-pager > unit-files.txt; systemctl list-timers --all --no-pager > timers.txt
ls -la /etc/systemd/system /lib/systemd/system /etc/cron* /var/spool/cron/crontabs > cron-systemd-ls.txt 2>&1
for u in $(cut -d: -f1 /etc/passwd); do echo "== $u"; crontab -l -u "$u" 2>/dev/null; done > crontabs.txt
cp -a /etc/passwd /etc/group /etc/sudoers /etc/sudoers.d /etc/ssh/sshd_config /etc/ssh/sshd_config.d . 2>/dev/null
for h in /root $(awk -F: '$6 ~ /^\/home|^\/var|^\/opt/ {print $6}' /etc/passwd); do ls -la "$h/.ssh" 2>/dev/null && cat "$h/.ssh/authorized_keys" 2>/dev/null; done > authorized-keys.txt
sshd -T > sshd-effective.txt 2>&1
find / -xdev \( -perm -4000 -o -perm -2000 \) -type f -printf '%p %u %m %TY-%Tm-%Td\n' 2>/dev/null > setuid.txt
find / -xdev -type f -mtime -14 ! -path '/proc/*' ! -path '/sys/*' ! -path '/var/lib/postgresql/*' -printf '%TY-%Tm-%Td %TH:%TM %p\n' 2>/dev/null | sort > changed-14d.txt
dpkg --verify > dpkg-verify.txt 2>&1   # package files changed since install
# logs
journalctl --since "-30 days" -o export | gzip > journal.export.gz
tar -czf varlog.tgz /var/log 2>/dev/null
# TrustVault-specific (read-only; no secrets copied — the master key is only hashed)
sha256sum /etc/tvkeyd/master.key /etc/trustvault/* /usr/local/sbin/* /opt/trustvault/app/keyd/target/release/tvkeyd > hashes-config.txt 2>&1
git -C /opt/trustvault/app status --porcelain > app-git-status.txt; git -C /opt/trustvault/app log -5 --format='%H %ci %s' > app-git-log.txt
cp -a /var/lib/tvkeyd /var/lib/trustvault-anchor . 2>/dev/null; cat /var/backups/trustvault/LAST_OK > backup-last-ok.txt
runuser -u postgres -- psql -d trustvault -AtX -c "SELECT * FROM audit_verify()" > db-audit-verify.txt
runuser -u postgres -- psql -d trustvault -AtX -c "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid IN ('audit_events'::regclass,'audit_checkpoints'::regclass)" > db-audit-triggers.txt
runuser -u postgres -- psql -d trustvault -AtX -c "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles ORDER BY 1" > db-roles.txt
runuser -u postgres -- psql -d trustvault -AtX -c "SELECT now(), pid, usename, client_addr, state, left(query, 200) FROM pg_stat_activity" > db-activity.txt
runuser -u postgres -- psql -d trustvault -AtX -c "COPY (SELECT seq, encode(head_hash,'hex'), key_id, created_at FROM audit_checkpoints ORDER BY seq) TO STDOUT" > db-checkpoints.tsv
runuser -u postgres -- psql -d trustvault -AtX -c "COPY (SELECT * FROM audit_events WHERE occurred_at > now() - interval '30 days' ORDER BY seq) TO STDOUT WITH CSV HEADER" > db-audit-30d.csv
runuser -u postgres -- psql -d trustvault -AtX -c "COPY (SELECT id, email, role, status, updated_at, deactivated_at FROM users ORDER BY updated_at DESC) TO STDOUT WITH CSV HEADER" > db-users.csv
runuser -u postgres -- psql -d trustvault -AtX -c "COPY (SELECT id, user_id, created_at, last_seen_at, expires_at, revoked_at, revoked_reason, ip, user_agent FROM sessions ORDER BY last_seen_at DESC) TO STDOUT WITH CSV HEADER" > db-sessions.csv
set +x
cd /root && tar -czf "$IR.tgz" "$(basename "$IR")" && sha256sum "$IR.tgz" | tee "$IR.tgz.sha256"
```

Then **pull** it from your PC (the server gets no credential to your machine) and record the hash in the incident log immediately:

```bash
scp root@<server>:/root/ir-<stamp>.tgz* .   &&   sha256sum -c ir-<stamp>.tgz.sha256
```

Keep evidence read-only (copy it to write-once storage if available). Do not open documents found in evidence on your everyday machine. Optional memory capture: `avml` (static binary, Microsoft, MIT licence) to a file, shipped the same way; only if you know how to analyse it.

#### 4.1.2 Scoping: what did they get?

Work through these against the evidence and the outside records:

- **Audit history.** Export a full bundle (from the snapshot or a restored copy, see BACKUP_DR §6 with `--keep`), and run both verifiers with `--key`, `--witness` and `--rekor` (VERIFY.md §9). Anything up to the last published checkpoint that does not match was rewritten. Events after it (the last 1–2 minutes before compromise, THREATS L5) are unprovable.
- **Documents.** With root, assume **every document is readable** by the attacker: the master key is in keyd's memory and on disk, and the encrypted files are in the database. Use the audit log (and from the snapshot, `pg_stat_activity`, shell histories, network logs) to narrow down, but do not tell customers "nothing was accessed" unless you can prove it. keyd does not yet keep its own unwrap ledger (checklist item 6; **in progress** on branch `keyd-ledger`), so there is no independent record of which file keys were unwrapped.
- **Accounts.** Password hashes (Argon2id), TOTP secrets (wrapped by the master key, so exposed), session token hashes, reset/invite token hashes, the SMTP password, database passwords: all exposed.
- **Backups.** Backups on the server are encrypted to the offline key: not readable unless the age identity also leaked. But root could have deleted them, or planted data that later backups captured.
- **Time window.** Earliest attacker activity (logs, file times, first odd audit event) to containment.

### 4.2 Stolen session (SEV2)

Signs: `ended_session_used` alert, sign-in notices a user did not expect, downloads from an unusual IP/user agent.

1. Confirm in the audit log: filter by the account; note IPs, user agents and the documents touched.
2. End the person's sessions: Admin → Users → the user → deactivate and reactivate, or ask them to change their password (a password change ends every session, THREATS S7/L10). A per-session "sign out everywhere" page is **in progress** on branch `mfa-advanced`.
3. If the account has no second factor, require one (admins always have one).
4. List what the session downloaded (`document.download` events with that session's IP/user agent and time range). Those documents are **received by whoever held the session**; decide whether that is a leaked-document incident (§4.4).
5. Look for how it was stolen (malware on the device, shared credentials, Android device rooted: THREATS S13).

### 4.3 Malicious or compromised administrator (SEV2, SEV1 if they had server access)

Admins cannot read documents except through audited, alerted break-glass (one hour, written reason) (README Roles). The known gap: the old `POST /admin/users/:id/password` route lets an admin set a user's password and sign in as them (THREATS S15: detected and alerted, not prevented; the fix is part of the **P0 fixes**, checklist item 1, being merged to main).

1. Look for `admin.break_glass`, `user.password_reset`, `user.mfa_reset`, `user.update` (role changes), `group.member_add`/`group.member_remove`, and `reset_then_sign_in` alerts by that admin.
2. Remove their admin role or deactivate them **from another admin account** (two admins are needed for this to be possible; keep at least two).
3. If they also had SSH/root, it is §4.1.
4. Tell the owners of any documents read through break-glass or an impersonated account; that is a leaked document (§4.4).
5. Preserve the audit export and verify it (VERIFY.md) before anything else changes.

### 4.4 Leaked document (SEV1 or SEV2)

A document is found where it should not be.

1. Identify the exact version (compare its SHA-256 with the versions on the document page; every version's SHA-256 is in the audit details of its upload).
2. From the audit log, list every account that received that version: `document.download` (and view-only events once that ships, **in progress** on `view-only`), break-glass reads, and grants that existed at the time. Export a bundle and verify it, so the list is evidence.
3. Watermarking that ties a copy to one person is **in progress** (`view-only`); until then, the audit log tells you which accounts received the file, not who leaked it. Do not claim more (checklist "wording to avoid").
4. Revoke access where needed. Revocation does not delete copies already downloaded.
5. Contain the outside copy (takedown requests); notification decision (§5) if it contains personal data.

### 4.5 Key compromise (SEV1)

| Key | Exposed when | Do |
|---|---|---|
| keyd master key (`/etc/tvkeyd/master.key`) | root compromise, a leaked backup **and** backup identity, a leaked server snapshot | treat every document and TOTP secret as disclosed. Rotation and re-wrapping tooling is **not built yet** (checklist item 7; **in progress** on `keyd-ledger`). Until it exists: rebuild with a new master key **cannot** re-encrypt existing files; the honest option is a new deployment where users re-upload, or wait for the re-wrap tool. Also see the audit key below |
| audit signing key (derived from the master key) | same | a forger can sign new checkpoints. Already-published checkpoints still protect earlier history. After rotation, publish the new public key (README, SECURITY.md, a signed commit), and deliberately re-pin the witness and anchor (`signing-key.json`) with a commit explaining why. Verifiers must use the old key for old checkpoints |
| age backup identity | PC compromise, lost USB/paper copy | new identity + `install-backup.sh <new public key>`; every old backup is now readable by the holder, and contains the master key → also the row above |
| TLS private key | root compromise | `certbot revoke` then re-issue on the rebuilt server |

### 4.6 Data loss (SEV1 or SEV2)

Database corruption, accidental deletion, failed migration, lost VPS.

1. Stop writes (stop `trustvault-api`) so nothing makes it worse.
2. Snapshot the disk as it is.
3. Pick the newest good backup (`LAST_OK`, the PC copy, Object Lock copy). Drill it first on another machine if time allows (BACKUP_DR §6): it proves the backup before you overwrite anything.
4. Restore per [RESTORE.md](RESTORE.md). Note the lost window (backup time → incident).
5. Expect the witness and the verifiers to flag the lost audit range; follow BACKUP_DR §7 to record and archive it. That flag is evidence, not a fault.

---

## 5. Notification decision tree

```
Is personal data or customer confidential data involved?          (documents, names, emails, IPs, audit records)
├─ No  → internal incident; record it; consider telling affected customers anyway.
└─ Yes → Is the breach CONFIRMED or only SUSPECTED?
         ├─ Suspected (e.g. root compromise, no proof of access)
         │   → Treat as confirmed for clock purposes where the rule says "becomes aware" / "noticed".
         │     CERT-In's 6 hours run from noticing the incident, not from confirming it.
         └─ Confirmed → notify per the table below; tell customers (they may be the data fiduciary/controller
                        with their own obligations and deadlines).
```

| Rule (who it covers) | What and when (summary, verify with counsel) |
|---|---|
| **India, CERT-In Directions of 28 April 2022** (service providers, data centres, body corporates in India) | report listed cyber-security incidents (including unauthorised access to IT systems and data breaches) to CERT-In **within 6 hours of noticing** them (incident@cert-in.org.in, form on cert-in.org.in). Keep logs 180 days within India and synchronise clocks to NTP (operator responsibility) |
| **India, Digital Personal Data Protection Act 2023 and DPDP Rules 2025** | most DPDP obligations, including breach notification, come into force in phases after the Rules were notified in November 2025: **check which provisions are in force on the incident date**. Once in force: a data fiduciary must notify the **Data Protection Board** and **each affected Data Principal** of a personal data breach; the Rules set an initial intimation without delay and a detailed report within **72 hours** of becoming aware. If TrustVault is acting as a **data processor** for a customer, tell that customer at once so they can meet their duty |
| **EU/UK GDPR** (if any EU/UK personal data) | controller notifies the supervisory authority **within 72 hours** of becoming aware unless unlikely to result in risk; tells data subjects without undue delay if high risk. A processor notifies the controller **without undue delay** |
| **Contracts** | customer contracts may set shorter deadlines (often 24–72 h); check them |
| **Hosting provider** | tell Hostinger if their account, network or other tenants are involved |

Notification content (any regulator/customer): what happened, when, what data and how many people, what we did, what they should do, contact. Never say more than we know; say what we do not know yet.

---

## 6. Credential and key rotation list

Rotate in this order after a root compromise. Rebuild first (§7) where noted, so new secrets never touch the compromised server.

| # | Secret | Where | How | Tool exists? |
|---|---|---|---|---|
| 1 | Hostinger account password + 2FA, panel API tokens, panel SSH keys | hPanel | panel | yes (manual) |
| 2 | DNS / registrar account | registrar | panel | yes (manual) |
| 3 | SMTP mailbox password (`updates@rayyanazeem.cloud`) | Hostinger mail; server `/etc/trustvault/mail.env` | change in mail panel; new value only on the rebuilt server | yes (manual) |
| 4 | SSH: owner's key pair if the PC is suspect; server `authorized_keys`; host keys | PC, server | new key pair; rebuild regenerates host keys | yes (manual) |
| 5 | Database role passwords (`tv_owner`, `tv_app`, `tv_dev_owner`, `tv_dev_app`) | `/etc/trustvault/db.secrets`, `api.env`, `migrate.env` | rebuilt server: `provision.sh` generates new ones | yes (rebuild) |
| 6 | Redis ACL password | `/etc/trustvault/...`, Redis ACL | rebuilt server: `provision.sh` | yes (rebuild) |
| 7 | All user sessions | `sessions` table | as `tv_owner`: `UPDATE sessions SET revoked_at = now(), revoked_reason = 'incident' WHERE revoked_at IS NULL;` (keeps the L10 "ended session used" alerts working) | yes (SQL) |
| 8 | Outstanding reset and invitation links | `password_reset_tokens` | `UPDATE password_reset_tokens SET used_at = now() WHERE used_at IS NULL;` | yes (SQL) |
| 9 | User passwords | users | send each user a reset link (Admin → Users → Send reset link); a bulk "force reset everyone" is **not built** | partly |
| 10 | Second factors (TOTP secrets are wrapped by the master key) | users | Admin → reset second factor for each user, who re-enrols; passkeys are public keys and need no rotation | yes (per user) |
| 11 | keyd master key, and with it the audit signing key | `/etc/tvkeyd/master.key` | **not built**: rotation and re-wrapping of document keys is being built on `keyd-ledger` (checklist item 7). See §4.5 | **no** |
| 12 | age backup identity | offline | §4.5 | yes (manual) |
| 13 | Off-site storage key (if enabled) | `/etc/trustvault-backup/offsite-credentials` | revoke in B2/AWS, create a new write-only key | yes (manual) |
| 14 | GitHub: owner account password/2FA, PAT in the PC's credential manager, repository deploy keys and Actions secrets | GitHub | GitHub settings; check `witness` branch protection is still on | yes (manual) |
| 15 | TLS certificate | server | revoke + re-issue on the rebuilt server | yes (certbot) |
| 16 | Demo account passwords and demo admin TOTP secret | `seed.passwords` | they are public by design; re-seed on rebuild | yes |

## 7. Recovery: rebuild from a clean image

Never "clean" a server that had root compromise. Rebuild.

1. Create a **new** VPS from the provider's stock Ubuntu 24.04 image (not from a snapshot of the old one). New IP is fine.
2. Before opening any port: update packages, set SSH key-only login with a **new** key, enable the provider firewall with only 22 (from your IP) and later 80/443.
3. Deploy the code from GitHub at a commit you have verified (compare with `MANIFEST`'s `release` from a pre-compromise backup; review every commit after the suspected start of the compromise).
4. `provision.sh`, `install-app.sh`, `install-keyd.sh`, `install-clamav.sh`, `install-backup.sh <new age public key>` (README "Deploy"). New secrets everywhere (§6).
5. Restore data from a backup taken **before** the compromise started, after drilling it on another machine (BACKUP_DR §6). If the master key may be compromised, read §4.5 before restoring it: restoring it brings the exposure with it.
6. Run Admin → Audit → Verify integrity; export a bundle and verify it with `--key --witness --rekor`. Record the lost range (BACKUP_DR §7).
7. Point DNS at the new server; issue TLS; open 443.
8. Watch closely for two weeks: alerts daily, witness runs, unknown logins.
9. Destroy the old VPS only after evidence is preserved and the investigation no longer needs it.

## 8. Persistence checklist (for the analysis of the old server)

Check each, on the snapshot/evidence, against a clean install:

- [ ] `/etc/passwd`, `/etc/shadow`, `/etc/group`: new users, UID 0 duplicates, shells on system users
- [ ] `authorized_keys` for every user, `sshd_config` and `sshd_config.d` (e.g. `AuthorizedKeysCommand`, `PermitRootLogin`), `/etc/ssh/ssh*_config`
- [ ] sudoers and `sudoers.d`
- [ ] cron: `/etc/crontab`, `/etc/cron.*`, `/var/spool/cron/crontabs/*`; `at` jobs
- [ ] systemd: units and timers in `/etc/systemd/system`, `~/.config/systemd/user`, drop-in `*.d/` overrides of TrustVault units (`trustvault-*.service`, `tvkeyd.service`)
- [ ] shell init files: `/etc/profile*`, `/etc/bash.bashrc`, `~/.bashrc`, `~/.profile`, `/etc/environment`
- [ ] `LD_PRELOAD`: `/etc/ld.so.preload`, unusual libraries in `/etc/ld.so.conf.d`
- [ ] kernel modules not from packages (`lsmod`, `/lib/modules/*/extra`), `dkms`
- [ ] setuid/setgid binaries not from packages (`setuid.txt` vs `dpkg -S`)
- [ ] changed package files (`dpkg --verify`), especially `sshd`, `sudo`, `ps`, `ss`, `node`, `postgres`
- [ ] PAM modules and `/etc/pam.d`
- [ ] nginx config and modules (`/etc/nginx`), TLS keys, any new `server` blocks
- [ ] Postgres: new roles, `rolsuper`/`rolbypassrls`, `ALTER SYSTEM` settings (`postgresql.auto.conf`), `shared_preload_libraries`, untrusted languages, new functions or triggers, **disabled audit triggers** (`tgenabled <> 'O'`), changed RLS policies, `pg_hba.conf`
- [ ] Redis: ACL users, `CONFIG` changes, modules
- [ ] TrustVault: `/opt/trustvault/app` differs from git (`git status`, `git diff`), modified `node_modules`, `dist/`, `keyd/target`; `/usr/local/sbin/trustvault-*`; `/etc/trustvault/*.env` additions (e.g. `NODE_OPTIONS`); keyd env (`/etc/tvkeyd/keyd.env`, e.g. a changed `KEYD_ALLOWED_UID`)
- [ ] Docker/containers, other services on the shared VPS
- [ ] outbound connections and DNS settings (`/etc/resolv.conf`, `/etc/hosts`)

## 9. After the incident

Within 5 working days of closing: a blameless post-incident review, using the template below. Add any new threat to THREATS.md (append rows), and any missing control to the plan with an owner and a date. Update this runbook where it was wrong.

## 10. Templates

### Incident log (start this first)

```
# INC-<yyyymmdd>-<n>: <short name>
Severity: SEV?   (changes: time, from → to, why)
Lead: <name>     Status: open / contained / recovered / closed
Detected: <UTC time>, by <signal>

## Timeline (UTC)                         ← every action, every finding
hh:mm  <what happened / what I did / result>

## Evidence                               ← file, sha256, where stored
## Systems and data affected
## Decisions (time, decision, why, who)
## Notifications (to whom, when, by what channel, reference)
```

### Post-incident review

```
# Review: INC-<id>
Summary (3 sentences, for a customer)
Impact: data, people, duration, money
Timeline: detection → containment → recovery (with gaps)
Root cause(s): technical and process ("five whys"; no blame)
What went well / what went badly / where we were lucky
Detection: how long from start to detection? which signal? what would have caught it sooner?
Actions: | action | owner | due | tracking issue |
Changes to THREATS.md, this runbook, tests
Was the notification decision right and on time?
```
