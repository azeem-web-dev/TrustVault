#!/usr/bin/env bash
# One-time: install ClamAV's daemon for upload scanning (THREATS.md U6).
# Run as root. Safe to re-run.
#
# The API streams every upload to clamd over its Unix socket before the
# file is encrypted and stored, and refuses the upload if clamd is down or
# gives anything but a clean answer.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -q clamav-daemon clamav-freshclam >/dev/null

conf=/etc/clamav/clamd.conf
set_opt() { # key value
  if grep -qE "^$1 " "$conf"; then sed -i -E "s|^$1 .*|$1 $2|" "$conf"; else echo "$1 $2" >> "$conf"; fi
}
set_opt LocalSocket /run/clamav/clamd.ctl
set_opt LocalSocketGroup clamav
set_opt LocalSocketMode 666
# Uploads are capped at 25 MB by the API; leave room for that.
set_opt StreamMaxLength 30M
# A file too large or too deep to scan completely is reported as found
# (Heuristics.Limits.Exceeded), so it is refused rather than passed.
set_opt AlertExceedsMax yes
set_opt AlertEncrypted yes
set_opt AlertBrokenExecutables yes
# Do not hold two copies of the signature database while reloading: this
# server is shared, and memory matters more than a few seconds of waiting.
set_opt ConcurrentDatabaseReload no
# Unix socket only: no TCP listener at all.
sed -i -E '/^TCPSocket /d; /^TCPAddr /d' "$conf"

# Keep clamd from crowding out the other services on this machine.
install -d /etc/systemd/system/clamav-daemon.service.d
cat > /etc/systemd/system/clamav-daemon.service.d/trustvault.conf <<'UNIT'
[Service]
MemoryHigh=2G
MemoryMax=2560M
Nice=5
UNIT
systemctl daemon-reload

# First signature download (freshclam keeps them current afterwards).
if [ ! -s /var/lib/clamav/main.cvd ] && [ ! -s /var/lib/clamav/main.cld ]; then
  systemctl stop clamav-freshclam || true
  freshclam --quiet
fi
systemctl enable -q --now clamav-freshclam
systemctl enable -q clamav-daemon
systemctl restart clamav-daemon

# The socket appears before the signatures finish loading; wait for both.
for i in $(seq 1 180); do clamdscan --ping 1 >/dev/null 2>&1 && break; sleep 1; done
[ -S /run/clamav/clamd.ctl ] || { echo "install-clamav: clamd did not start" >&2; exit 1; }

# Prove it detects the standard EICAR test file (assembled here so this
# script is not itself flagged).
eicar='X5O!P%@AP[4\PZX54(P^)7CC)7}$'"EICAR-STANDARD-ANTIVIRUS-TEST-FILE"'!$H+H*'
# clamdscan exits 1 when it finds something, so capture the output first.
result=$(printf '%s' "$eicar" | clamdscan --no-summary --stream - 2>&1 || true)
if grep -q 'Eicar.*FOUND' <<<"$result"; then
  echo "install-clamav: clamd running and detecting EICAR"
else
  echo "install-clamav: clamd did not detect EICAR" >&2; exit 1
fi
