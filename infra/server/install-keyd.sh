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

# Ubuntu's default rustc (1.75) is too old for current crates; use the
# versioned toolchain packages from the Ubuntu archive (no curl | sh).
RUST_VER=1.91
DEBIAN_FRONTEND=noninteractive apt-get install -y -q "rustc-$RUST_VER" "cargo-$RUST_VER" >/dev/null
export CARGO="cargo-$RUST_VER" RUSTC="rustc-$RUST_VER"

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
# --- ticket key: keyd only unwraps document keys against tickets MACed with it
if [ ! -f /etc/tvkeyd/ticket.key ]; then
  ( umask 077; head -c 32 /dev/urandom > /etc/tvkeyd/ticket.key )
  echo "install-keyd: generated a new ticket key (not needed for recovery: a new one can be made at any time)."
fi
chmod 0400 /etc/tvkeyd/ticket.key
# Later master key generations and a previous ticket key go here (docs/KEYS.md).
install -d -m 0700 -o root -g root /etc/tvkeyd/extra
# Keep operator settings (KEYD_LIMIT_*, KEYD_WRAP_GENERATION, ...); only (re)set the uid.
touch /etc/tvkeyd/keyd.env
sed -i '/^KEYD_ALLOWED_UID=/d' /etc/tvkeyd/keyd.env
echo "KEYD_ALLOWED_UID=$(id -u trustvault)" >> /etc/tvkeyd/keyd.env
chmod 0644 /etc/tvkeyd/keyd.env

# --- build as tvbuild ------------------------------------------------------
sudo -u tvbuild -H bash -c "
  set -euo pipefail
  if [ ! -d '$BUILD/src/.git' ]; then git clone --quiet '$REPO' '$BUILD/src'; fi
  cd '$BUILD/src' && git fetch --quiet origin && git checkout --quiet --force --detach 'origin/$REF'
  cd keyd && RUSTC=rustc-$RUST_VER cargo-$RUST_VER test --release --quiet && RUSTC=rustc-$RUST_VER cargo-$RUST_VER build --release --quiet
"
install -m 0755 -o root -g root "$BUILD/src/keyd/target/release/tvkeyd" /usr/local/bin/tvkeyd

# The database must hold the same ticket key before keyd starts refusing
# ticket-less unwraps (needs the app migrated; otherwise deploy.sh does it).
# (Not run from the tvbuild clone: root never executes scripts a less trusted user can edit.)
if [ -f /opt/trustvault/app/apps/api/dist/cli/keys.js ] && [ -f /etc/trustvault/migrate.env ]; then
  OWNER_URL=$(sed -n 's/^DATABASE_OWNER_URL=//p' /etc/trustvault/migrate.env)
  sudo -u trustvault -H env DATABASE_OWNER_URL="$OWNER_URL" node /opt/trustvault/app/apps/api/dist/cli/keys.js install-ticket-key < /etc/tvkeyd/ticket.key     || echo "install-keyd: ticket key not installed in the database yet (migrations pending?); deploy.sh will do it"
  unset OWNER_URL
else
  echo "install-keyd: app not deployed yet; deploy.sh will install the ticket key in the database"
fi

install -m 0644 "$BUILD/src/infra/systemd/tvkeyd.service" /etc/systemd/system/tvkeyd.service
systemctl daemon-reload
systemctl enable -q tvkeyd
systemctl restart tvkeyd
sleep 1
systemctl is-active tvkeyd
ls -l /run/tvkeyd/
echo "install-keyd: done"
