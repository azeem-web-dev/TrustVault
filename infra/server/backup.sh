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
#
# The dump, the per-table row counts and the audit head in MANIFEST all come
# from ONE database snapshot, so a restore drill (tools/restore-drill.sh)
# can demand exact equality. Every path below can be overridden from the
# environment for testing; on the server the defaults apply.
set -euo pipefail
umask 077
DEST=${DEST:-/var/backups/trustvault}
RECIPIENT_FILE=${RECIPIENT_FILE:-/etc/trustvault-backup/recipient.txt}
KEEP_DAYS=${KEEP_DAYS:-14}
PG_DB=${PG_DB:-trustvault}
KEYD_DIR=${KEYD_DIR:-/etc/tvkeyd}
APP_ETC_DIR=${APP_ETC_DIR:-/etc/trustvault}
APP_DIR=${APP_DIR:-/opt/trustvault/app}
# How to run psql/pg_dump as a role that bypasses row-level security.
# Default: the postgres superuser over the local socket.
if [[ -n ${PG_AS:-} ]]; then read -r -a as_pg <<< "$PG_AS"; else as_pg=(runuser -u postgres --); fi

recipient=$(tr -d '[:space:]' < "$RECIPIENT_FILE")
[[ $recipient == age1* ]] || { echo "backup: no age recipient in $RECIPIENT_FILE" >&2; exit 1; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
psql_pid=
cleanup() { if [[ -n $psql_pid ]]; then kill "$psql_pid" 2>/dev/null || true; fi; rm -rf "$work"; }
trap cleanup EXIT

# 1. One read-only snapshot, held open by a psql session and shared with
# pg_dump. (The shell opens the pipes as root before switching user.)
mkfifo "$work/q" "$work/a"
"${as_pg[@]}" psql -qAtX -v ON_ERROR_STOP=1 -d "$PG_DB" < "$work/q" > "$work/a" &
psql_pid=$!
exec 3> "$work/q" 4< "$work/a"
ask() { # sends SQL; prints the answer lines up to a sentinel
  printf '%s\nSELECT %s;\n' "$1" "'--END--'" >&3
  local line
  while IFS= read -r -t 120 line <&4; do
    [[ $line == --END-- ]] && return 0
    printf '%s\n' "$line"
  done
  echo "backup: the database session stopped answering" >&2
  return 1
}
snapshot=$(ask "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();")
[[ $snapshot =~ ^[0-9A-F-]+$ ]] || { echo "backup: could not export a snapshot" >&2; exit 1; }

# 2. Database, as the superuser so row-level security cannot hide rows.
"${as_pg[@]}" pg_dump --format=custom --no-owner --snapshot="$snapshot" --dbname="$PG_DB" > "$work/trustvault.dump"
# A dump that cannot be listed is not a backup.
pg_restore --list "$work/trustvault.dump" > /dev/null

# Audit head and row counts from the same snapshot as the dump. Computed
# into variables first so a failing query stops the backup.
audit_head=$(ask "SELECT seq::text || ' ' || encode(hash, 'hex') FROM audit_events ORDER BY seq DESC LIMIT 1;")
row_counts=$(ask "SELECT 'rows ' || c.relname || ' ' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname;")
[[ -n $audit_head && -n $row_counts ]] || { echo "backup: could not read the audit head or row counts" >&2; exit 1; }
ask "COMMIT;" > /dev/null
exec 3>&- 4<&-
wait "$psql_pid" || true
psql_pid=
rm -f "$work/q" "$work/a"

# 3. Keys and config.
mkdir -p "$work/etc"
cp -a "$KEYD_DIR" "$work/etc/tvkeyd"
cp -a "$APP_ETC_DIR" "$work/etc/trustvault"

# 4. Manifest: creation time, the release that was running, the audit chain
# head and every table's row count at the moment of the dump, and a SHA-256
# of every file.
release=$(git -c safe.directory="$APP_DIR" -C "$APP_DIR" log -1 --format='%H %s' 2>/dev/null || echo unknown)
{
  echo "created_utc=$stamp"
  echo "host=$(hostname)"
  echo "release=$release"
  echo "audit_head=$audit_head"
  echo "$row_counts"
  ( cd "$work" && find . -type f ! -name MANIFEST -print0 | sort -z | xargs -0 sha256sum )
} > "$work/MANIFEST"

out="$DEST/trustvault-$stamp.tar.age"
tar -C "$work" -cf - . | age --encrypt --recipient "$recipient" > "$out.partial"
mv "$out.partial" "$out"
sha256sum "$out" | sed "s|$DEST/||" > "$out.sha256"

# 5. Keep the last KEEP_DAYS days.
find "$DEST" -maxdepth 1 -name 'trustvault-*.tar.age*' -mtime +"$KEEP_DAYS" -delete
echo "$stamp $(stat -c %s "$out") bytes" > "$DEST/LAST_OK"
echo "backup: wrote $(basename "$out") ($(stat -c %s "$out") bytes)"
