#!/usr/bin/env bash
# Nightly encrypted backup of everything needed to bring TrustVault back:
# the database, the key service's master key, and the app's config.
# Installed as /usr/local/sbin/trustvault-backup, run by trustvault-backup.timer.
#
# The archive is encrypted with `age` to a public key whose private half
# is NOT on this server (the owner keeps it offline). So the backups are
# useless to anyone who copies them, including root on this machine later.
# Without the master key, the stored files cannot be decrypted, which is
# why it is in the archive at all.
set -euo pipefail
umask 077
DEST=/var/backups/trustvault
RECIPIENT_FILE=/etc/trustvault-backup/recipient.txt
KEEP_DAYS=${KEEP_DAYS:-14}

recipient=$(tr -d '[:space:]' < "$RECIPIENT_FILE")
[[ $recipient == age1* ]] || { echo "backup: no age recipient in $RECIPIENT_FILE" >&2; exit 1; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 1. Database, as the postgres superuser so row-level security cannot hide rows.
runuser -u postgres -- pg_dump --format=custom --no-owner --dbname=trustvault > "$work/trustvault.dump"
# A dump that cannot be listed is not a backup.
pg_restore --list "$work/trustvault.dump" > /dev/null

# 2. Keys and config.
mkdir -p "$work/etc"
cp -a /etc/tvkeyd "$work/etc/tvkeyd"
cp -a /etc/trustvault "$work/etc/trustvault"

# 3. Manifest: what is inside, and which release was running.
{
  echo "created_utc=$stamp"
  echo "host=$(hostname)"
  echo "release=$(git -c safe.directory=/opt/trustvault/app -C /opt/trustvault/app log -1 --format='%H %s' 2>/dev/null || echo unknown)"
  echo "audit_head=$(runuser -u postgres -- psql -At -d trustvault -c 'SELECT seq || '' '' || encode(hash, ''hex'') FROM audit_events ORDER BY seq DESC LIMIT 1')"
  ( cd "$work" && find . -type f ! -name MANIFEST -print0 | sort -z | xargs -0 sha256sum )
} > "$work/MANIFEST"

out="$DEST/trustvault-$stamp.tar.age"
tar -C "$work" -cf - . | age --encrypt --recipient "$recipient" > "$out.partial"
mv "$out.partial" "$out"
sha256sum "$out" | sed "s|$DEST/||" > "$out.sha256"

# 4. Keep the last KEEP_DAYS days.
find "$DEST" -maxdepth 1 -name 'trustvault-*.tar.age*' -mtime +"$KEEP_DAYS" -delete
echo "$stamp $(stat -c %s "$out") bytes" > "$DEST/LAST_OK"
echo "backup: wrote $(basename "$out") ($(stat -c %s "$out") bytes)"
