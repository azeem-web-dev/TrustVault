# Backups and restore

## What is backed up

`trustvault-backup.timer` runs every night at 03:30 UTC and writes one file to `/var/backups/trustvault/`:

```
trustvault-<UTC time>.tar.age          the archive, encrypted
trustvault-<UTC time>.tar.age.sha256   its checksum
LAST_OK                                time and size of the last good backup
```

Inside the archive:

| Path | What |
|---|---|
| `trustvault.dump` | `pg_dump --format=custom` of the whole database, taken as the postgres superuser so row-level security hides nothing. Checked with `pg_restore --list` before it is kept |
| `etc/tvkeyd/` | the key service's keys: `master.key`, later generations in `extra/master-N.key`, and `ticket.key`. **Without the master keys, no stored file can be decrypted** |
| `etc/trustvault/` | the app's configuration and database passwords |
| `MANIFEST` | creation time, the git commit that was running, the audit chain head (seq and hash), and a SHA-256 of every file |

The archive is encrypted with [age](https://age-encryption.org) to a **public** key (`/etc/trustvault-backup/recipient.txt`). The matching private key is not on the server; the owner keeps it offline. So a copied backup is useless without it, and someone who later gets root on the server still cannot read older backups. 14 days are kept.

Backups stay on this server, by the owner's choice. That covers mistakes and a broken database, but not losing the machine. To keep a copy elsewhere, copy the newest file off the server, for example `scp root@server:/var/backups/trustvault/trustvault-*.tar.age .`; it is safe to store anywhere because it is encrypted.

## Restore

On a machine that has the private key (`trustvault-backup-identity.txt`):

```bash
age --decrypt --identity trustvault-backup-identity.txt trustvault-20261101T033000Z.tar.age > backup.tar
mkdir restore && tar -C restore -xf backup.tar
cd restore && sha256sum -c <(grep -v '=' MANIFEST)    # every file intact
```

On the server (a fresh one: run `provision.sh` and `install-app.sh` first):

```bash
systemctl stop trustvault-api trustvault-web
install -d -o root -g root -m 0700 /etc/tvkeyd && install -o root -g root -m 0400 etc/tvkeyd/master.key /etc/tvkeyd/master.key   # the original master key (keyd reads it via LoadCredential)
install -d -o root -g root -m 0700 /etc/tvkeyd/extra && cp -a etc/tvkeyd/extra/. /etc/tvkeyd/extra/   # later key generations, if any (docs/KEYS.md)
install -o root -g root -m 0400 etc/tvkeyd/ticket.key /etc/tvkeyd/ticket.key   # or generate a new one: it is not needed for recovery
systemctl restart tvkeyd
# fed on stdin: the postgres user cannot read files under /root
runuser -u postgres -- pg_restore --clean --if-exists --no-owner --role=tv_owner --dbname=trustvault < trustvault.dump
bash /opt/trustvault/app/infra/server/deploy.sh   # re-grants, migrates if needed, starts, health check
```

Then sign in as an admin and run **Audit → Verify integrity**. The chain head should match the `audit_head` line in `MANIFEST`. Check the audit chain against the outside witness too: export a bundle and run `node tools/verify-audit.mjs bundle.json --witness checkpoints.jsonl`.

## Tested

2026-11-01, on the production server: the newest backup was decrypted with the offline key (piped in over SSH, never written to the server's disk), every file matched its checksum in `MANIFEST`, the master key matched the live one byte for byte, and the dump was restored into a scratch database with `pg_restore --exit-on-error`. Every table matched the live database (users 5, documents 5, versions 5, blobs 5, grants 5, audit events 51, checkpoints 4), and `audit_verify()` on the restored copy reported an unbroken chain of 51 events. The scratch database and the decrypted files were then deleted.
