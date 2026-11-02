# Backups and disaster recovery

Checklist item 4 ("offsite, immutable, encrypted backups and prove restoration"). This page says what exists today, what the targets are, who may restore, how the backup key is kept, how to add an immutable off-site copy, and how to prove a backup restores. The mechanics of a restore onto a server are in [RESTORE.md](RESTORE.md).

Status labels: **live** (running in production), **ready** (in the repository, tested, not switched on), **owner action** (needs the owner; cannot be done from the code).

## 1. What exists

| Piece | Status | Where |
|---|---|---|
| Nightly backup 03:30 UTC: `pg_dump` of the whole database (including encrypted file contents, which are stored in Postgres), keyd master key, app config, `MANIFEST` | **live** | `infra/server/backup.sh`, `trustvault-backup.timer` |
| Encryption to an offline `age` key (the server only has the public half) | **live** | `/etc/trustvault-backup/recipient.txt` |
| 14 days kept on the server | **live** | `/var/backups/trustvault` |
| Copy to the owner's PC, checksum-verified | **live, manual run**; daily scheduled task is **owner action** | `C:\Users\ridah\TrustVault-backups\pull-backups.ps1` (outside this repo) |
| Dump, audit head and per-table row counts from one database snapshot | **ready** (merged with this change; live after the next deploy) | `backup.sh` |
| Clean-room restore drill on any Linux/WSL machine | **ready**, tested with synthetic backups only | `tools/restore-drill.sh`, `tools/restore-drill.test.sh` |
| Immutable (Object Lock) off-site copy | **ready, disabled**; needs an account and a bucket (**owner action**) | `infra/server/offsite-push.sh`, `infra/systemd/trustvault-offsite.*` |
| Second, independently stored copy of the backup key | **owner action** | §4 |
| Restore onto a separate, clean server | **not yet done** (the one restore test was on the production server, 2026-11-01) | §6 |

What is **not** in the backup, on purpose or because it is rebuilt: Redis (rate-limit counters and job queue; rebuilt empty), keyd's last-signed-checkpoint state (`/var/lib/tvkeyd`), the anchor service's state (`/var/lib/trustvault-anchor`; it re-submits checkpoints and Rekor answers "already there"), TLS certificates (re-issued by certbot), the operating system and packages (rebuilt by `provision.sh`), and the application code (it is this git repository; `MANIFEST` records the commit that was running).

## 2. Targets

These are targets for this deployment (one VPS, one operator), not measured guarantees. The drill (§6) measures the restore part.

| | Target | Why this number |
|---|---|---|
| **RPO** (data that may be lost), database broken, server fine | 24 h | nightly backup |
| **RPO**, server or hosting account lost | 24 h once the PC copy runs daily (48 h if a pull is missed); today it depends on when the owner last ran the pull | backups leave the server only when pulled |
| **RPO for audit integrity** | about 1 minute | every checkpoint is in Sigstore's public log within about a minute and on the witness branch within 15 minutes. These prove what the history *was*; they do not hold the events themselves, so lost events are detectably lost, not recoverable |
| **RTO** (back in service), database restore on the same server | 2 h | `pg_restore` of a small database plus checks |
| **RTO**, rebuild on a new VPS | 8 h (one working day) | new VPS, `provision.sh`, `install-*.sh`, restore, DNS, TLS; slower if the owner or the key is not at hand |

To shorten the server-loss RPO, run the backup more often (the timer accepts any `OnCalendar`) or add continuous WAL archiving (for example `pgBackRest` or `wal-g` to the same Object Lock bucket). Neither is built.

## 3. Retention

| Copy | Kept | Who can delete |
|---|---|---|
| Server, `/var/backups/trustvault` | 14 days (`KEEP_DAYS`) | root on the server |
| Owner's PC, `C:\Users\ridah\TrustVault-backups` | everything pulled; recommended: 30 daily + 12 monthly (prune by hand) | the owner |
| Object Lock bucket (when enabled) | `OFFSITE_RETAIN_DAYS` (default 35) in COMPLIANCE mode, then a lifecycle rule deletes them | **nobody** before the date, not even the account owner (that is the point); afterwards the account owner |

Backups contain personal data (names, emails, IP addresses in the audit log) and every document. Keep no longer than needed: see [GOVERNANCE.md](GOVERNANCE.md) §6. A person's data deleted from the live system stays in backups until they age out; say so in the privacy notice.

## 4. Who can restore, and key custody

**Everything depends on one secret:** the age identity (`AGE-SECRET-KEY-1…`). Anyone holding it **and** any backup file can read every document, because the archive contains the master key. Anyone who loses every copy of it can never restore.

Today there is **one** copy, offline, in `C:\Users\ridah\TrustVault-backup-key\` on the owner's PC. That is a single point of failure (disk failure, theft, ransomware on the PC).

| Role | Who today | Can |
|---|---|---|
| Key custodian | the owner | holds the age identity |
| Restore operator | the owner | runs the restore and the drill |
| Approver | the owner | decides to restore production; with more staff, the approver should be a second person and both should be present (two-person rule) |

**Recommended now (owner action, about 30 minutes):**

1. **A second copy on separate media in a separate place.** For example:
   - on paper: print the identity (it is one line of about 74 characters) and the date; seal it in an envelope; keep it in a locked place that is not where the PC is (a safe, a bank locker, a trusted family member's safe); and/or
   - on a USB stick, passphrase-encrypted: `age --passphrase --output trustvault-backup-identity.txt.age trustvault-backup-identity.txt`, with the passphrase kept separately from the stick (for example in a password manager).
2. **Test each copy** by running the drill (§6) with it. A key copy that has never decrypted a backup is not a backup of the key.
3. **Never store a key copy with the backups** (not in the backup folder, not in the same cloud account, not in the Object Lock bucket).
4. Optionally protect the primary copy with a passphrase the same way.
5. Write down where the copies are in a sealed note for a successor, so the business can recover without the owner.

**If the identity may have leaked:** make a new identity (`age-keygen`), run `install-backup.sh <new public key>` on the server, and treat every existing backup as readable by the attacker. Because each backup contains the master key, a leaked identity means the master key must be rotated too. **Master-key rotation tooling does not exist yet** (being built on branch `keyd-ledger`); see [INCIDENT.md](INCIDENT.md) §6.

## 5. Off-site immutable copy (choose one)

The server's copies can be deleted by anyone with root on it. The PC copy can be deleted by ransomware on the PC. An Object Lock copy cannot be deleted by anyone before its date, which is what checklist item 4 asks for.

### Option A: Backblaze B2 with Object Lock (cheapest; recommended)

1. Create a Backblaze account **separate from Hostinger**, with a strong password and two-factor sign-in. Its credentials are not stored anywhere on the VPS.
2. Create a **private** bucket with **Object Lock enabled** (this can only be chosen at creation), for example `trustvault-backups-<random>`. Default retention: none (the script sets it per file).
3. Add a lifecycle rule: delete files 40 days after upload (only takes effect after the lock expires).
4. Create an **application key** restricted to that bucket with capabilities `listBuckets, listFiles, readFiles, writeFiles` and **not** `deleteFiles`. Note its key ID and key.
5. On the server, as root:
   ```bash
   apt install -y awscli
   install -d -m 0700 /etc/trustvault-backup
   nano /etc/trustvault-backup/offsite-credentials   # contents below
   nano /etc/trustvault-backup/offsite.env           # contents below
   chmod 0600 /etc/trustvault-backup/offsite-*
   install -m 0750 /opt/trustvault/app/infra/server/offsite-push.sh /usr/local/sbin/trustvault-offsite-push
   install -m 0644 /opt/trustvault/app/infra/systemd/trustvault-offsite.{service,timer} /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now trustvault-offsite.timer
   systemctl start trustvault-offsite.service && journalctl -u trustvault-offsite -n 20
   ```
   `/etc/trustvault-backup/offsite-credentials`:
   ```ini
   [default]
   aws_access_key_id = <B2 key ID>
   aws_secret_access_key = <B2 application key>
   ```
   `/etc/trustvault-backup/offsite.env`:
   ```ini
   OFFSITE_ENABLED=1
   OFFSITE_BUCKET=trustvault-backups-<random>
   OFFSITE_ENDPOINT=https://s3.<region>.backblazeb2.com
   OFFSITE_REGION=<region>
   OFFSITE_RETAIN_DAYS=35
   AWS_SHARED_CREDENTIALS_FILE=/etc/trustvault-backup/offsite-credentials
   ```
6. Check from your PC (not the server) that the newest file is there and locked, and that deleting it is refused.

The script refuses to run if the bucket does not have Object Lock, checks each archive against its `.sha256` before upload, uploads with `COMPLIANCE` mode and a retain-until date, and reads back the size and lock mode. It is **not yet tested against a real bucket** (no account exists); it was only checked for syntax and for its "not configured", "disabled" and "no AWS CLI" paths.

### Option B: AWS S3 with Object Lock

Same script, same steps, with: a bucket created with Object Lock, `OFFSITE_ENDPOINT` empty, `OFFSITE_REGION=<aws region>`, and an IAM user whose policy allows only `s3:PutObject`, `s3:PutObjectRetention`, `s3:GetObject`, `s3:GetObjectRetention`, `s3:ListBucket`, `s3:GetBucketObjectLockConfiguration` on that bucket. Use a separate AWS account from anything else if possible.

### Option C: restic to an append-only server (no cloud account)

Run `rest-server --append-only` on a machine the owner controls (for example the PC in WSL, or a small home server), and `restic backup /var/backups/trustvault` from the VPS. Append-only means the VPS can add snapshots but not delete or rewrite them; pruning is done only from the backup machine. This needs the backup machine to be reachable from the VPS (a tunnel), which is more moving parts than Option A. Not scripted here.

### What any off-site copy does **not** fix

A backup that was already bad when it was made (for example, made after an attacker had altered data) is faithfully preserved. The audit chain helps here: the drill checks the restored chain against the published checkpoints (`--rekor`, `--witness`), so you can tell whether a backup's audit history matches what was public at the time.

## 6. Restore drill

`tools/restore-drill.sh` proves a backup can be restored **without the production server**. It runs on any Linux machine or WSL, starts its own throwaway PostgreSQL (socket only, no network), and checks:

1. the archive's `.sha256`; decrypts with the identity into RAM (`/dev/shm`); every file against `MANIFEST`;
2. `pg_restore --exit-on-error` into the empty cluster (roles the dump refers to are created as NOLOGIN placeholders);
3. every table's row count and the audit chain head equal `MANIFEST` (exact for backups made by the new `backup.sh`);
4. `audit_verify()` over the whole chain; row-level security and the audit triggers are present;
5. the restored master key derives the published audit key, and every checkpoint verifies with the independent verifier (and the Node verifier if `node` is installed); with `--rekor` and `--witness`, also against the public records;
6. **every document version is decrypted** with the restored master key, exactly as the API does, and its SHA-256 matches; every stored authenticator secret unwraps;
7. everything is deleted afterwards and a report is printed (`--report` saves it).

### The command the owner runs (Windows PC, WSL Ubuntu)

One-time setup in WSL: `sudo apt install -y age postgresql-16 python3-cryptography` (the drill uses the PostgreSQL binaries only; it does not touch the system's own cluster).

```bash
cd /mnt/c/Users/ridah/TrustVault && git pull
# newest pulled backup
B=$(ls -t /mnt/c/Users/ridah/TrustVault-backups/trustvault-*.tar.age | head -1)
# the identity file, from your offline key folder (or the second copy you are testing)
ID=/mnt/c/Users/ridah/TrustVault-backup-key/<your identity file>
git clone --branch witness --single-branch https://github.com/azeem-web-dev/TrustVault /tmp/tv-witness 2>/dev/null || git -C /tmp/tv-witness pull -q
sudo bash tools/restore-drill.sh --backup "$B" --identity "$ID" \
     --witness /tmp/tv-witness/checkpoints.jsonl --rekor \
     --report "/mnt/c/Users/ridah/TrustVault-backups/drill-$(date -u +%Y%m%d).txt"
```

`--expect-key` defaults to the production audit key (`OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE=`). `sudo` is needed only so the throwaway cluster can run as the `postgres` user; as a normal user it runs the cluster as you. Exit 0 and `RESULT: PASSED` is a successful drill. Keep the report (it contains counts and hashes, no document content or secrets).

Note: backups made before this change have no row counts in `MANIFEST`; the drill says so and compares only the audit head.

### Drill with synthetic data (what was run for this change)

`tools/restore-drill.test.sh` runs the **real** `backup.sh` (paths overridden) against a test database populated through the API's own test helpers, with a throwaway age identity and a throwaway master key, then runs the drill on the result and on four broken variants. Run on 2026-11-03 in WSL Ubuntu 24.04 (PostgreSQL 16.15, age 1.1.1):

| Case | Expected | Result |
|---|---|---|
| genuine synthetic backup | pass | **PASSED, 15 checks**: 17 tables' counts equal `MANIFEST` (3 users, 3 documents, 4 versions, 13 audit events, 1 checkpoint), audit head equal, `audit_verify()` 13/13, RLS 16 policies on 7 tables, 6/6 audit triggers, restored key = expected key, independent verifier INTACT, **4/4 document versions decrypted with matching SHA-256**, 1/1 authenticator secret unwrapped |
| wrong age identity | fail | failed (cannot decrypt) |
| archive corrupted in the middle | fail | failed |
| archive re-packed with a different master key | fail | failed: wrong audit key **and** every document undecryptable |
| `MANIFEST` row count altered | fail | failed |

The same drill also passed with `--pg` (restoring into a separately started PostgreSQL 16 server and dropping the database afterwards), and with the master key stored both as 32 raw bytes and as base64 (keyd accepts both).

**Not yet done: a drill with the real backup and the real key.** That needs the owner (only the owner may touch the key). Do it once now, then on the schedule below.

### Schedule

| When | What |
|---|---|
| Monthly | drill on the newest PC copy (command above); keep the report |
| Quarterly | drill with the **second** key copy |
| Twice a year | full rebuild on a fresh VPS from an off-site copy, without logging in to the production server at all (checklist: "original VPS and its backups unavailable"); time it against the RTO |
| After any change to `backup.sh`, the schema or key handling | drill before the next release |

## 7. Disaster scenarios

| Scenario | What you use | Notes |
|---|---|---|
| Database corrupted, server fine | newest server backup, [RESTORE.md](RESTORE.md) | events after the backup are lost |
| VPS destroyed or hosting account locked | PC copy (or Object Lock copy) + age identity; new VPS; RESTORE.md "on a fresh server" | DNS for `vault.rayyanazeem.cloud` must be pointed at the new server |
| VPS compromised | do **not** restore onto it; rebuild per [INCIDENT.md](INCIDENT.md) §7 from a backup taken **before** the compromise | rotate everything in INCIDENT.md §6 |
| PC lost or encrypted by ransomware | server copies + Object Lock copy; second key copy | why §4 and §5 matter |
| Backup key lost | no backup can ever be restored | why §4 matters |

### After restoring an older backup: the audit log will (correctly) show the loss

A restore brings the chain back to the backup's head. Events written after that are gone, but their checkpoints are already in Sigstore's public log and on the witness branch. After the restore the service will write **new** events with the same sequence numbers and different hashes. Consequences, all intended, all to be documented in the incident record:

- the GitHub witness workflow fails ("checkpoint N was witnessed but is gone / changed") until the owner archives the witness log: move `checkpoints.jsonl` and `public-log.jsonl` on the `witness` branch to `epoch-<date>/` with a commit message giving the reason, the lost seq range and the incident reference, so the next run pins afresh;
- `verify-audit.mjs --rekor` and `verify.py --rekor` will report the old public entries for that seq range as not matching a **full** bundle. The honest reading is "these events existed and were lost in the restore"; that is the transparency the design is meant to give. A future "restore marker" event that records the lost range in the chain itself is **not built**.

## 8. Gaps (honest list)

- The backup still lives on the same server until the owner turns on the daily pull or Option A/B (checklist item 4, first bullet).
- One copy of the backup key (§4).
- No restore yet onto separate infrastructure; no real-key drill yet.
- RPO is a day; no WAL archiving.
- The pull script on the PC uses root SSH to the server; a dedicated read-only `backupcopy` user limited to `/var/backups/trustvault` (via `rrsync` or an SFTP chroot) would be better.
- A restore loses anchored history and the verifiers will flag it (§7); there is no in-chain restore marker yet.
