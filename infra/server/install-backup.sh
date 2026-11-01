#!/usr/bin/env bash
# One-time: install the nightly encrypted backup.
#   bash install-backup.sh age1...   (the PUBLIC key; keep the identity offline)
# Run as root. Safe to re-run (replaces the recipient).
set -euo pipefail
REPO_DIR=${REPO_DIR:-/opt/trustvault/app}
recipient=${1:?usage: install-backup.sh <age-public-key>}
[[ $recipient == age1* ]] || { echo "not an age public key" >&2; exit 1; }

DEBIAN_FRONTEND=noninteractive apt-get install -y -q age >/dev/null
install -d -m 0700 /etc/trustvault-backup /var/backups/trustvault
echo "$recipient" > /etc/trustvault-backup/recipient.txt
chmod 0600 /etc/trustvault-backup/recipient.txt
install -m 0750 "$REPO_DIR/infra/server/backup.sh" /usr/local/sbin/trustvault-backup
install -m 0644 "$REPO_DIR/infra/systemd/trustvault-backup.service" "$REPO_DIR/infra/systemd/trustvault-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q --now trustvault-backup.timer
systemctl start trustvault-backup.service
cat /var/backups/trustvault/LAST_OK
