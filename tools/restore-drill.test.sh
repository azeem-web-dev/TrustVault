#!/usr/bin/env bash
# End-to-end test of the backup and the restore drill, with NOTHING real:
# a throwaway age identity, a throwaway master key and a test database.
#
#   SRC_PGHOST=127.0.0.1 SRC_PGPORT=5432 SRC_PGUSER=postgres SRC_PGPASSWORD=... SRC_PGDB=trustvault_test \
#   MASTER_KEY_B64=<the LOCAL_MASTER_KEY the test database was populated with> \
#   bash tools/restore-drill.test.sh
#
# The source database must already hold data written by the API (for
# example by `npx vitest run test/independent-verify.test.ts` in apps/api,
# which uploads documents, versions, grants and signs a checkpoint).
#
# It runs the REAL infra/server/backup.sh (with paths overridden) to make a
# backup, then tools/restore-drill.sh on it, and expects:
#   - the genuine backup                         -> drill PASSES
#   - the wrong age identity                     -> drill fails
#   - a corrupted archive                        -> drill fails
#   - a backup carrying a different master key   -> drill fails (key + decryption)
#   - a MANIFEST row count that does not match    -> drill fails
# Needs: age, age-keygen, PostgreSQL 16 client+server binaries, python3 + cryptography. Run as root or a normal user.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
: "${SRC_PGHOST:?}" "${SRC_PGPORT:?}" "${SRC_PGUSER:?}" "${SRC_PGPASSWORD:?}" "${SRC_PGDB:?}" "${MASTER_KEY_B64:?}"

t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
mkdir -p "$t/dest" "$t/etc-tvkeyd" "$t/etc-trustvault" "$t/keys"

# Throwaway age identity (stands in for the owner's offline key).
age-keygen -o "$t/keys/identity.txt" 2> /dev/null
age-keygen -y "$t/keys/identity.txt" > "$t/recipient.txt"
age-keygen -o "$t/keys/wrong-identity.txt" 2> /dev/null
# Throwaway key service and app config, laid out like /etc/tvkeyd and /etc/trustvault.
printf '%s' "$MASTER_KEY_B64" | base64 -d > "$t/etc-tvkeyd/master.key"
echo "NODE_ENV=production   # synthetic config for the drill test" > "$t/etc-trustvault/api.env"
expected_key=$(python3 "$HERE/restore-drill-decrypt.py" pubkey "$t/etc-tvkeyd/master.key")

pass=0 fail=0
check() { # name, expected exit, command...
  local name=$1 want=$2; shift 2
  local got=0
  "$@" > "$t/out" 2>&1 || got=$?
  if [[ $got == "$want" ]]; then pass=$((pass + 1)); echo "ok   $name (exit $got)"; else fail=$((fail + 1)); echo "FAIL $name: exit $got, wanted $want"; cat "$t/out"; fi
}

# 1. The real backup script, pointed at the test database and the throwaway paths.
PGHOST=$SRC_PGHOST PGPORT=$SRC_PGPORT PGUSER=$SRC_PGUSER PGPASSWORD=$SRC_PGPASSWORD \
DEST=$t/dest RECIPIENT_FILE=$t/recipient.txt PG_DB=$SRC_PGDB PG_AS=env \
KEYD_DIR=$t/etc-tvkeyd APP_ETC_DIR=$t/etc-trustvault APP_DIR=$REPO \
  bash "$REPO/infra/server/backup.sh"
backup=$(ls "$t"/dest/trustvault-*.tar.age)

drill() { bash "$HERE/restore-drill.sh" --expect-key "$expected_key" "$@"; }

check "genuine backup passes the drill" 0 drill --backup "$backup" --identity "$t/keys/identity.txt" --report "$t/report.txt"
cp "$t/out" "$t/genuine.out"
check "wrong age identity fails" 1 drill --backup "$backup" --identity "$t/keys/wrong-identity.txt"

cp "$backup" "$t/corrupt.tar.age"
printf '\x00\x00\x00\x00' | dd of="$t/corrupt.tar.age" bs=1 seek=$(( $(stat -c %s "$backup") / 2 )) conv=notrunc status=none
check "corrupted archive fails" 1 drill --backup "$t/corrupt.tar.age" --identity "$t/keys/identity.txt"

# Re-pack the genuine backup with a different master key (MANIFEST hashes updated so only the key is wrong).
repack() { # name, edit-function
  local d=$t/repack-$1; mkdir -p "$d"
  age --decrypt -i "$t/keys/identity.txt" "$backup" | tar -x -C "$d"
  "$2" "$d"
  (cd "$d" && grep -vE '^[0-9a-f]{64}  ' MANIFEST > M.new && find . -type f ! -name MANIFEST ! -name M.new -print0 | sort -z | xargs -0 sha256sum >> M.new && mv M.new MANIFEST)
  tar -C "$d" -cf - . | age -r "$(cat "$t/recipient.txt")" > "$t/$1.tar.age"
}
other_key() { head -c 32 /dev/urandom > "$1/etc/tvkeyd/master.key"; }
bad_count() { sed -i 's/^rows document_versions \([0-9]*\)$/rows document_versions 999999/' "$1/MANIFEST"; }
repack other-key other_key
repack bad-count bad_count
check "backup with a different master key fails" 1 drill --backup "$t/other-key.tar.age" --identity "$t/keys/identity.txt"
grep -q 'FAIL  restored master key derives audit key' "$t/out" && grep -q 'FAIL  document decryption' "$t/out" \
  && { pass=$((pass + 1)); echo "ok   ...and it says why: wrong audit key and undecryptable documents"; } \
  || { fail=$((fail + 1)); echo "FAIL the wrong-key run did not report both problems"; cat "$t/out"; }
check "MANIFEST row count mismatch fails" 1 drill --backup "$t/bad-count.tar.age" --identity "$t/keys/identity.txt"

echo
echo "---- drill output for the genuine synthetic backup ----"
cat "$t/genuine.out"
echo "------------------------------------------------------"
echo "$pass passed, $fail failed"
[[ $fail == 0 ]]
