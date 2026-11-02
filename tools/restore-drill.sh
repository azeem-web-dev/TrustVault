#!/usr/bin/env bash
# Clean-room restore drill for a TrustVault backup (docs/BACKUP_DR.md).
#
#   tools/restore-drill.sh --backup trustvault-<UTC>.tar.age --identity <age identity file> \
#       [--expect-key <base64 audit public key>] [--witness checkpoints.jsonl] [--rekor] \
#       [--pg postgresql://superuser@host:port/postgres] [--keep] [--report drill-report.txt]
#
# Never touches the production server. Run it on any Linux machine (or WSL)
# that has: age, PostgreSQL 16+ server and client binaries, python3 with the
# `cryptography` package, and optionally node (to run both audit verifiers).
#
# What it does, failing loudly on any mismatch:
#   1. checks the archive against its .sha256 file (if present), decrypts it
#      with the age identity into a private RAM-backed folder, and checks
#      every file against MANIFEST;
#   2. starts a FRESH, throwaway PostgreSQL cluster (socket only, no TCP)
#      — or, with --pg, creates a new database on a server you name — and
#      restores the dump into it with pg_restore --exit-on-error;
#   3. compares every table's row count and the audit chain head with MANIFEST
#      (exact: backup.sh takes them from the same snapshot as the dump);
#   4. runs audit_verify() over the whole chain, and checks row-level
#      security and the audit triggers came back;
#   5. derives the audit signing key from the restored master key, checks it
#      is the expected production key, and verifies every checkpoint with
#      the independent verifier (and the Node verifier, if node is present);
#   6. decrypts EVERY document version and every stored second-factor
#      secret with the restored master key, the way the API does, and checks
#      each file's SHA-256. Plaintext is never written to disk;
#   7. destroys the scratch database/cluster and the decrypted files
#      (unless --keep), and prints a report you can keep as evidence.
#
# Exit 0 = every check passed. Exit 1 = at least one failed. Exit 64 = usage.
set -euo pipefail
umask 077

HERE=$(cd "$(dirname "$0")" && pwd)
PRODUCTION_KEY='OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE='
backup= identity= expect_key=$PRODUCTION_KEY pg_url= keep=0 report= witness= rekor=0
usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
while [[ $# -gt 0 ]]; do
  case $1 in
    --backup) backup=${2:?}; shift 2 ;;
    --identity) identity=${2:?}; shift 2 ;;
    --expect-key) expect_key=${2:?}; shift 2 ;;
    --pg) pg_url=${2:?}; shift 2 ;;
    --witness) witness=${2:?}; shift 2 ;;
    --rekor) rekor=1; shift ;;
    --keep) keep=1; shift ;;
    --report) report=${2:?}; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n $backup && -n $identity ]] || usage
[[ -f $backup ]] || { echo "no such backup: $backup" >&2; exit 64; }
[[ -f $identity ]] || { echo "no such identity file: $identity" >&2; exit 64; }

# ---------------------------------------------------------------- reporting
passed=0 failed=0 log=()
say() { log+=("$*"); echo "$*"; }
pass() { passed=$((passed + 1)); say "PASS  $*"; }
fail() { failed=$((failed + 1)); say "FAIL  $*"; }
info() { say "      $*"; }

need() { command -v "$1" > /dev/null || { echo "restore-drill: '$1' is required ($2)" >&2; exit 64; }; }
need age 'apt install age, or https://github.com/FiloSottile/age/releases'
need tar 'coreutils'
need sha256sum 'coreutils'
need python3 'apt install python3'
python3 -c 'import cryptography' 2> /dev/null || { echo "restore-drill: python3 'cryptography' is required (apt install python3-cryptography)" >&2; exit 64; }
PG_BIN=${PG_BIN:-$( (pg_config --bindir 2> /dev/null) || ls -d /usr/lib/postgresql/*/bin 2> /dev/null | sort -V | tail -1)}
for b in pg_restore psql; do [[ -x $PG_BIN/$b ]] || command -v $b > /dev/null || { echo "restore-drill: $b not found (apt install postgresql-16)" >&2; exit 64; }; done
pgb() { if [[ -x $PG_BIN/$1 ]]; then echo "$PG_BIN/$1"; else command -v "$1"; fi; }

# ---------------------------------------------------------------- workspace
# Decrypted files (including the master key) live in RAM where possible.
base=/tmp; [[ -d /dev/shm && -w /dev/shm ]] && base=/dev/shm
work=$(mktemp -d "$base/tv-drill.XXXXXX")
cluster= db=tv_restore_drill_$(date -u +%Y%m%d%H%M%S) run_pg=()
cleanup() {
  set +e
  if [[ $keep == 1 ]]; then echo "kept: $work${cluster:+ and cluster $cluster}"; return; fi
  if [[ -n $cluster ]]; then "${run_pg[@]}" "$(pgb pg_ctl)" -D "$cluster/data" -m immediate stop > /dev/null 2>&1; rm -rf "$cluster"
  elif [[ -n $pg_url ]]; then "$(pgb psql)" -X -q -d "$pg_url" -c "DROP DATABASE IF EXISTS $db" > /dev/null 2>&1; fi
  rm -rf "$work"
}
trap cleanup EXIT

say "TrustVault restore drill — $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(hostname)"
say "backup: $(basename "$backup") ($(stat -c %s "$backup") bytes)"

# ---------------------------------------------------------------- 1. archive
if [[ -f $backup.sha256 ]]; then
  if [[ $(cut -d' ' -f1 < "$backup.sha256") == $(sha256sum "$backup" | cut -d' ' -f1) ]]; then pass "archive matches its .sha256"; else fail "archive does not match its .sha256"; fi
else
  info "no .sha256 next to the archive; skipped that check"
fi
mkdir -p "$work/x"
if age --decrypt --identity "$identity" "$backup" | tar -x -C "$work/x" 2> "$work/tar.err"; then
  pass "decrypted with the age identity and unpacked"
else
  fail "could not decrypt/unpack the archive (wrong identity or damaged file): $(head -c 300 "$work/tar.err")"
  exit 1
fi
X=$work/x
[[ -f $X/MANIFEST ]] || { fail "archive has no MANIFEST"; exit 1; }
if (cd "$X" && grep -E '^[0-9a-f]{64}  ' MANIFEST | sha256sum --check --strict --quiet); then
  pass "every file matches its SHA-256 in MANIFEST ($(grep -cE '^[0-9a-f]{64}  ' "$X/MANIFEST") files)"
else
  fail "a file in the archive does not match MANIFEST"
fi
for f in trustvault.dump etc/tvkeyd/master.key; do [[ -f $X/$f ]] || fail "archive is missing $f"; done
[[ -d $X/etc/trustvault ]] && pass "app configuration present (etc/trustvault, $(find "$X/etc/trustvault" -type f | wc -l) files)" || fail "archive is missing etc/trustvault"
m() { sed -n "s/^$1=//p" "$X/MANIFEST" | head -1; }
info "created_utc=$(m created_utc) host=$(m host)"
info "release=$(m release)"
manifest_head=$(m audit_head)
has_counts=$(grep -c '^rows ' "$X/MANIFEST" || true)

# ---------------------------------------------------------------- 2. fresh Postgres
if [[ -z $pg_url ]]; then
  cluster=$(mktemp -d /tmp/tv-drill-pg.XXXXXX)
  if [[ $(id -u) == 0 ]]; then chown postgres "$cluster"; run_pg=(runuser -u postgres --); fi
  "${run_pg[@]}" mkdir -m 700 "$cluster/sock"
  "${run_pg[@]}" "$(pgb initdb)" -D "$cluster/data" -U postgres --auth=trust > /dev/null
  # No TCP at all: only a socket in a private folder, so trust auth is safe.
  "${run_pg[@]}" "$(pgb pg_ctl)" -D "$cluster/data" -l "$cluster/log" -w \
    -o "-c listen_addresses='' -k $cluster/sock -p 54329 -c fsync=off" start > /dev/null
  PSQL=("$(pgb psql)" -X -q -v ON_ERROR_STOP=1 -h "$cluster/sock" -p 54329 -U postgres)
  conn=(-h "$cluster/sock" -p 54329 -U postgres)
  pass "started a fresh PostgreSQL $("$(pgb postgres)" --version 2> /dev/null | awk '{print $3}') cluster (socket only) in $cluster"
else
  PSQL=("$(pgb psql)" -X -q -v ON_ERROR_STOP=1 -d "$pg_url")
  conn=(-d "$pg_url")
  info "using the server you named with --pg; a new database $db will be created and dropped"
fi
# The dump's privileges and policies name roles (trustvault_app, and the
# server's login roles). On a rebuilt server provision.sh creates them; here
# every missing one is created as NOLOGIN so the restore can run unchanged.
roles=$("$(pgb pg_restore)" --schema-only -f - "$X/trustvault.dump" \
  | grep -oE '^(GRANT|REVOKE) .* (TO|FROM) [a-z_][a-z0-9_]*|^ +TO [a-z_][a-z0-9_, ]*' \
  | sed -E 's/.*(TO|FROM) //' | tr ', ' '\n\n' | grep -vxE 'public|' | sort -u || true)
created=()
for r in $roles; do
  if [[ $("${PSQL[@]}" -At -c "SELECT 1 FROM pg_roles WHERE rolname = '$r'") != 1 ]]; then
    "${PSQL[@]}" -c "CREATE ROLE \"$r\" NOLOGIN" > /dev/null; created+=("$r")
  fi
done
[[ ${#created[@]} -gt 0 ]] && info "created placeholder NOLOGIN roles the dump refers to: ${created[*]}"
"${PSQL[@]}" -c "CREATE DATABASE $db" > /dev/null
dbconn() { if [[ -n $cluster ]]; then echo "${conn[@]}" -d "$db"; else echo -d "${pg_url%/*}/$db"; fi; }
read -r -a DB <<< "$(dbconn)"
Q() { "$(pgb psql)" -X -At -v ON_ERROR_STOP=1 "${DB[@]}" -c "$1" < /dev/null; }

if "$(pgb pg_restore)" --exit-on-error --no-owner "${DB[@]}" "$X/trustvault.dump" 2> "$work/restore.err"; then
  pass "pg_restore --exit-on-error into the empty database $db"
else
  fail "pg_restore failed: $(head -c 500 "$work/restore.err")"
  exit 1
fi

# ---------------------------------------------------------------- 3. counts and head
if [[ $has_counts -gt 0 ]]; then
  mism=0
  while read -r _ table n; do
    got=$(Q "SELECT count(*) FROM public.\"$table\"")
    if [[ $got != "$n" ]]; then fail "table $table: $got rows restored, MANIFEST says $n"; mism=1; fi
  done < <(grep '^rows ' "$X/MANIFEST")
  extra=$(Q "SELECT string_agg(relname, ' ') FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relkind IN ('r','p')" | tr ' ' '\n' | grep -vxF -f <(grep '^rows ' "$X/MANIFEST" | awk '{print $2}') || true)
  [[ -n $extra ]] && { fail "restored tables not listed in MANIFEST: $extra"; mism=1; }
  [[ $mism == 0 ]] && pass "row counts of all $has_counts tables equal MANIFEST"
  for t in users documents document_versions document_blobs grants audit_events audit_checkpoints; do
    info "$t: $(grep "^rows $t " "$X/MANIFEST" | awk '{print $3}') rows"
  done
else
  info "MANIFEST has no row counts (backup made before backup.sh recorded them); counts not compared"
fi
restored_head=$(Q "SELECT seq::text || ' ' || encode(hash, 'hex') FROM audit_events ORDER BY seq DESC LIMIT 1")
if [[ $restored_head == "$manifest_head" ]]; then pass "audit chain head equals MANIFEST (seq ${restored_head%% *})"
elif [[ $has_counts -eq 0 && ${restored_head%% *} -le ${manifest_head%% *} ]]; then info "audit head ${restored_head%% *} ≤ MANIFEST ${manifest_head%% *} (old backups read the head after the dump)"
else fail "audit head ${restored_head:-none} differs from MANIFEST ${manifest_head:-none}"; fi

# ---------------------------------------------------------------- 4. chain and controls
read -r bad checked < <(Q "SELECT coalesce(first_bad_seq::text, 'none'), checked FROM audit_verify()" | tr '|' ' ')
total=$(Q "SELECT count(*) FROM audit_events")
if [[ $bad == none && $checked == "$total" ]]; then pass "audit_verify(): all $checked events recompute, chain unbroken"
else fail "audit_verify(): first bad seq $bad, checked $checked of $total"; fi
norls=$(Q "SELECT string_agg(DISTINCT c.relname, ' ') FROM pg_policies p JOIN pg_class c ON c.relname = p.tablename JOIN pg_namespace s ON s.oid = c.relnamespace AND s.nspname = p.schemaname WHERE p.schemaname = 'public' AND NOT c.relrowsecurity")
npol=$(Q "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")
ntab=$(Q "SELECT count(*) FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relrowsecurity")
if [[ -z $norls && $npol -gt 0 ]]; then pass "row-level security restored: $npol policies on $ntab tables, enabled on every table that has policies"
else fail "row-level security missing on: ${norls:-(no policies at all)}"; fi
trg=$(Q "SELECT count(*) FROM pg_trigger WHERE tgname IN ('audit_events_chain','audit_events_no_update_delete','audit_events_no_truncate','audit_checkpoints_no_update_delete','audit_checkpoints_no_truncate','audit_checkpoints_guard_insert')")
[[ $trg == 6 ]] && pass "audit append-only and chaining triggers present (6/6)" || fail "audit triggers missing: $trg of 6 present"

# ---------------------------------------------------------------- 5. checkpoints
derived=$(python3 "$HERE/restore-drill-decrypt.py" pubkey "$X/etc/tvkeyd/master.key")
if [[ $derived == "$expect_key" ]]; then pass "restored master key derives the expected audit key $expect_key"
else fail "restored master key derives audit key $derived, expected $expect_key"; fi
ncp=$(Q "SELECT count(*) FROM audit_checkpoints")
if [[ $ncp -gt 0 ]]; then
  newest=$(Q "SELECT max(seq) FROM audit_checkpoints")
  # The bundle covers the chain up to the newest checkpoint; events after it
  # were not yet signed when the backup ran (normal: the next checkpoint is
  # due within a minute) and are covered by audit_verify() above only.
  Q "SELECT json_build_object(
       'format', 'trustvault-audit-bundle-v1',
       'exportedAt', (SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM audit_checkpoints WHERE seq = $newest),
       'genesisPrevHash', (SELECT CASE WHEN prev_hash = '\\x0000000000000000000000000000000000000000000000000000000000000000'::bytea THEN repeat('0', 64) END FROM audit_events ORDER BY seq LIMIT 1),
       'events', (SELECT json_agg(json_build_object(
           'seq', seq::text, 'id', id::text,
           'occurred_at', to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),
           'actor_id', actor_id::text, 'actor_email', actor_email, 'action', action, 'outcome', outcome::text,
           'reason', reason, 'target_type', target_type, 'target_id', target_id, 'document_id', document_id::text,
           'ip', ip, 'user_agent', user_agent, 'request_id', request_id, 'details', details::text,
           'prev_hash', encode(prev_hash, 'hex'), 'hash', encode(hash, 'hex')) ORDER BY seq) FROM audit_events WHERE seq <= $newest),
       'checkpoints', (SELECT json_agg(json_build_object('seq', seq::text, 'headHash', encode(head_hash, 'hex'),
           'signature', replace(encode(signature, 'base64'), E'\n', ''), 'keyId', key_id,
           'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) ORDER BY seq) FROM audit_checkpoints),
       'signingKey', json_build_object('keyId', 'from-restored-master-key', 'publicKey', '$derived', 'algorithm', 'Ed25519'))" > "$work/bundle.json"
  vargs=(--key "$expect_key"); [[ -n $witness ]] && vargs+=(--witness "$witness"); [[ $rekor == 1 ]] && vargs+=(--rekor)
  if out=$(python3 -I "$HERE/independent-verify/verify.py" "$work/bundle.json" "${vargs[@]}" 2>&1); then
    pass "independent verifier: $(tail -1 <<< "$out")"
  else
    fail "independent verifier: $(tr '\n' ' ' <<< "$out" | head -c 600)"
  fi
  if command -v node > /dev/null; then
    if out=$(node "$HERE/verify-audit.mjs" "$work/bundle.json" "${vargs[@]}" 2>&1); then pass "Node verifier agrees: $(tail -1 <<< "$out" | head -c 200)"
    else fail "Node verifier: $(tr '\n' ' ' <<< "$out" | head -c 600)"; fi
  else
    info "node not installed; only the independent verifier was run"
  fi
  tail_n=$(Q "SELECT count(*) FROM audit_events WHERE seq > $newest")
  info "$ncp checkpoints, newest at seq $newest; $tail_n event(s) after it were not yet signed at backup time"
else
  fail "no audit checkpoints in the backup"
fi

# ---------------------------------------------------------------- 6. decrypt everything
missing=$(Q "SELECT count(*) FROM document_versions v LEFT JOIN document_blobs b ON b.version_id = v.id WHERE b.version_id IS NULL")
[[ $missing == 0 ]] || fail "$missing document version(s) have no stored file"
nver=$(Q "SELECT count(*) FROM document_blobs")
if res=$("$(pgb psql)" -X -At -F $'\t' -v ON_ERROR_STOP=1 "${DB[@]}" -c "
    SELECT v.document_id, v.id, v.version_no, encode(v.sha256, 'hex'), b.key_id,
           translate(encode(b.wrapped_key, 'base64'), E'\n', ''), encode(b.nonce, 'hex'), encode(b.auth_tag, 'hex'),
           translate(encode(b.ciphertext, 'base64'), E'\n', '')
      FROM document_blobs b JOIN document_versions v ON v.id = b.version_id ORDER BY v.document_id, v.version_no" \
    | python3 "$HERE/restore-drill-decrypt.py" blobs "$X/etc/tvkeyd/master.key" 2> "$work/dec.err"); then
  read -r ok bad bytes <<< "$res"
  pass "decrypted all $ok of $nver document versions with the restored master key; every SHA-256 matches ($bytes bytes)"
else
  read -r ok bad bytes <<< "${res:-0 ? 0}"
  fail "document decryption: $bad of $nver failed. $(head -c 600 "$work/dec.err")"
fi
ntotp=$(Q "SELECT count(*) FROM users WHERE totp_secret_enc IS NOT NULL")
if [[ $ntotp -gt 0 ]]; then
  if res=$("$(pgb psql)" -X -At -F $'\t' "${DB[@]}" -c "SELECT id, translate(encode(totp_secret_enc, 'base64'), E'\n', '') FROM users WHERE totp_secret_enc IS NOT NULL" \
      | python3 "$HERE/restore-drill-decrypt.py" totp "$X/etc/tvkeyd/master.key" 2> "$work/totp.err"); then
    pass "unwrapped all $ntotp stored authenticator secrets"
  else
    fail "authenticator secrets: $(head -c 400 "$work/totp.err")"
  fi
fi

# ---------------------------------------------------------------- 7. result
say ""
if [[ $failed == 0 ]]; then say "RESULT: PASSED ($passed checks)"; else say "RESULT: FAILED ($failed of $((passed + failed)) checks failed)"; fi
if [[ -n $report ]]; then
  { printf '%s\n' "${log[@]}"; echo "backup_sha256=$(sha256sum "$backup" | cut -d' ' -f1)"; } > "$report"
  echo "report written to $report"
fi
[[ $failed == 0 ]]
