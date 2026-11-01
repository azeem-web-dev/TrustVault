#!/usr/bin/env bash
# Builds and installs tvkeyd, the TrustVault key service. Run as root.
# Safe to re-run: keeps the existing master key (losing it means losing
# every stored file), rebuilds and restarts the service.
#
# The build runs as an unprivileged `tvbuild` user from a fresh clone, so
# crate build scripts never run as root and cannot touch the app's files.
set -euo pipefail
REPO=https://github.com/azeem-web-dev/TrustVault.git
REF=${1:-main}
BUILD=/var/lib/tvbuild

DEBIAN_FRONTEND=noninteractive apt-get install -y -q rustc cargo >/dev/null

getent group tvkeysock >/dev/null || groupadd --system tvkeysock
id tvkeyd  >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --gid tvkeysock tvkeyd
usermod -g tvkeysock tvkeyd
usermod -aG tvkeysock trustvault           # the API may talk to the socket
id tvbuild >/dev/null 2>&1 || useradd --system --create-home --home-dir "$BUILD" --shell /usr/sbin/nologin tvbuild

# --- master key (generated once, root-only, never leaves this machine) ----
install -d -m 0700 -o root -g root /etc/tvkeyd
if [ ! -f /etc/tvkeyd/master.key ]; then
  ( umask 077; head -c 32 /dev/urandom > /etc/tvkeyd/master.key )
  echo "install-keyd: generated a new master key. BACK UP /etc/tvkeyd/master.key OFFLINE."
fi
chmod 0400 /etc/tvkeyd/master.key
cat > /etc/tvkeyd/keyd.env <<ENV
KEYD_ALLOWED_UID=$(id -u trustvault)
ENV
chmod 0644 /etc/tvkeyd/keyd.env

# --- build as tvbuild ------------------------------------------------------
sudo -u tvbuild -H bash -c "
  set -euo pipefail
  if [ ! -d '$BUILD/src/.git' ]; then git clone --quiet '$REPO' '$BUILD/src'; fi
  cd '$BUILD/src' && git fetch --quiet origin && git checkout --quiet --force --detach 'origin/$REF'
  cd keyd && cargo test --release --quiet && cargo build --release --quiet
"
install -m 0755 -o root -g root "$BUILD/src/keyd/target/release/tvkeyd" /usr/local/bin/tvkeyd

install -m 0644 "$BUILD/src/infra/systemd/tvkeyd.service" /etc/systemd/system/tvkeyd.service
systemctl daemon-reload
systemctl enable -q tvkeyd
systemctl restart tvkeyd
sleep 1
systemctl is-active tvkeyd
ls -l /run/tvkeyd/
echo "install-keyd: done"
