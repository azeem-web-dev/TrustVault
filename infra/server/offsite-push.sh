#!/usr/bin/env bash
# OPTIONAL, OFF BY DEFAULT. Copies each encrypted backup to S3-compatible
# object storage with Object Lock (write once, read many), so that someone
# who takes over this server — or the hosting account — cannot delete or
# overwrite the copies before their retention date. See docs/BACKUP_DR.md.
#
# Works with Backblaze B2 (S3 API) and AWS S3; any S3 service that supports
# Object Lock in COMPLIANCE mode should work. Uses the AWS CLI.
#
# Configuration: /etc/trustvault-backup/offsite.env (root, 0600), e.g.
#   OFFSITE_ENABLED=1
#   OFFSITE_BUCKET=trustvault-backups-<random>
#   OFFSITE_ENDPOINT=https://s3.eu-central-003.backblazeb2.com   # empty for AWS
#   OFFSITE_REGION=eu-central-003
#   OFFSITE_RETAIN_DAYS=35                                       # Object Lock retention
#   AWS_SHARED_CREDENTIALS_FILE=/etc/trustvault-backup/offsite-credentials
# The credentials file holds a key that can upload and list but NOT delete
# (B2: capabilities listBuckets,listFiles,readFiles,writeFiles; AWS: an IAM
# policy with s3:PutObject, s3:PutObjectRetention, s3:GetObject*, s3:ListBucket
# only). Nothing secret is ever in this repository.
#
# Installed (only when the owner chooses) as /usr/local/sbin/trustvault-offsite-push,
# run by trustvault-offsite.timer after the nightly backup.
#
# Exit 0: nothing to do, or every new backup uploaded and its lock confirmed.
# Exit 1: a failure (the timer's unit fails; check `journalctl -u trustvault-offsite`).
set -euo pipefail
umask 077
CONFIG=${OFFSITE_CONFIG:-/etc/trustvault-backup/offsite.env}
SRC=${OFFSITE_SRC:-/var/backups/trustvault}
STATE=${OFFSITE_STATE:-/var/lib/trustvault-offsite/uploaded.txt}

if [[ ! -f $CONFIG ]]; then echo "offsite: not configured ($CONFIG missing); nothing done"; exit 0; fi
# shellcheck disable=SC1090
set -a; . "$CONFIG"; set +a
if [[ ${OFFSITE_ENABLED:-0} != 1 ]]; then echo "offsite: disabled (OFFSITE_ENABLED is not 1); nothing done"; exit 0; fi
: "${OFFSITE_BUCKET:?OFFSITE_BUCKET is required}"
RETAIN_DAYS=${OFFSITE_RETAIN_DAYS:-35}
[[ $RETAIN_DAYS =~ ^[0-9]+$ && $RETAIN_DAYS -ge 1 ]] || { echo "offsite: OFFSITE_RETAIN_DAYS must be a positive integer" >&2; exit 1; }
command -v aws > /dev/null || { echo "offsite: the AWS CLI is required (apt install awscli, or the v2 installer)" >&2; exit 1; }

aws_s3() { aws ${OFFSITE_ENDPOINT:+--endpoint-url "$OFFSITE_ENDPOINT"} ${OFFSITE_REGION:+--region "$OFFSITE_REGION"} s3api "$@"; }

# The bucket must have Object Lock on; refuse to "back up" somewhere deletable.
lock=$(aws_s3 get-object-lock-configuration --bucket "$OFFSITE_BUCKET" --query 'ObjectLockConfiguration.ObjectLockEnabled' --output text 2> /dev/null || true)
[[ $lock == Enabled ]] || { echo "offsite: bucket $OFFSITE_BUCKET does not have Object Lock enabled; refusing" >&2; exit 1; }

mkdir -p "$(dirname "$STATE")"; touch "$STATE"
uploaded=0
for f in "$SRC"/trustvault-*.tar.age; do
  [[ -e $f ]] || continue
  name=$(basename "$f")
  grep -qxF "$name" "$STATE" && continue
  # Only complete backups: the checksum file is written after the archive.
  [[ -f $f.sha256 ]] || continue
  (cd "$SRC" && sha256sum --check --strict --quiet "$name.sha256") || { echo "offsite: $name does not match its checksum; not uploading" >&2; exit 1; }
  sha_b64=$(openssl dgst -sha256 -binary "$f" | base64)
  until=$(date -u -d "+$RETAIN_DAYS days" +%Y-%m-%dT%H:%M:%SZ)
  for obj in "$name" "$name.sha256"; do
    extra=(); [[ $obj == "$name" ]] && extra=(--checksum-algorithm SHA256 --checksum-sha256 "$sha_b64")
    aws_s3 put-object --bucket "$OFFSITE_BUCKET" --key "$obj" --body "$SRC/$obj" \
      --object-lock-mode COMPLIANCE --object-lock-retain-until-date "$until" "${extra[@]}" > /dev/null
  done
  # Read back: size and lock must be what we asked for.
  head=$(aws_s3 head-object --bucket "$OFFSITE_BUCKET" --key "$name" --query '[ContentLength,ObjectLockMode,ObjectLockRetainUntilDate]' --output text)
  read -r size mode retain <<< "$head"
  [[ $size == "$(stat -c %s "$f")" && $mode == COMPLIANCE ]] || { echo "offsite: $name uploaded but read-back differs ($head)" >&2; exit 1; }
  echo "$name" >> "$STATE"
  uploaded=$((uploaded + 1))
  echo "offsite: $name locked until $retain"
done
echo "offsite: $uploaded new backup(s) uploaded to $OFFSITE_BUCKET"
