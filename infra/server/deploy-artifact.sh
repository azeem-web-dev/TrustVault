#!/usr/bin/env bash
# ALTERNATIVE deploy path (not the default; deploy.sh is unchanged):
# install a signed release tarball instead of building on the server.
# Run as root:  bash deploy-artifact.sh vX.Y.Z
# Needs `gh` on the server. Nothing is compiled here (no tsc, next or cargo),
# so a compromised build dependency never runs on the production host.
# See docs/SUPPLY_CHAIN.md for the migration plan. UNTESTED on the server.
set -euo pipefail
TAG=${1:?usage: deploy-artifact.sh vX.Y.Z}
REPO=azeem-web-dev/TrustVault
ROOT=/opt/trustvault
REL=$ROOT/releases/$TAG
DL=$(mktemp -d /var/tmp/tv-release.XXXXXX); trap 'rm -rf "$DL"' EXIT
as_tv() { sudo -u trustvault -H "$@"; }
HERE=$(cd "$(dirname "$0")" && pwd)

# 1. download and verify BEFORE anything is extracted or executed
gh release download "$TAG" --repo "$REPO" --dir "$DL" --pattern "trustvault-$TAG.tar.gz*"
bash "$HERE/verify-release.sh" "$DL/trustvault-$TAG.tar.gz" "refs/tags/$TAG"

# 2. unpack to a new versioned directory owned by trustvault
install -d -o trustvault -g trustvault -m 0755 "$ROOT/releases"
[ ! -e "$REL" ] || { echo "release $TAG already unpacked at $REL" >&2; exit 1; }
tar -xzf "$DL/trustvault-$TAG.tar.gz" -C "$ROOT/releases"
mv "$ROOT/releases/trustvault-$TAG" "$REL"
chown -R trustvault:trustvault "$REL"

# 3. dependencies from the lockfile (scripts off, three approved rebuilds)
cd "$REL"
as_tv npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
as_tv npm rebuild prisma @prisma/engines esbuild --loglevel=error
as_tv install -d -m 0750 apps/web/.next/cache

# 4. migrations as the schema owner (same as deploy.sh)
OWNER_URL=$(sed -n 's/^DATABASE_OWNER_URL=//p' /etc/trustvault/migrate.env)
as_tv env DATABASE_OWNER_URL="$OWNER_URL" bash -c 'cd apps/api && npx prisma migrate deploy'
unset OWNER_URL

# 5. keyd binary from the same signed tarball (root-owned, like install-keyd.sh)
install -m 0755 -o root -g root "$REL/bin/tvkeyd" /usr/local/bin/tvkeyd

# 6. switch: the units' WorkingDirectory is $ROOT/app, which becomes a symlink.
#    (If $ROOT/app is still the git clone from deploy.sh, move it aside once.)
[ ! -d "$ROOT/app" ] || [ -L "$ROOT/app" ] || { echo "$ROOT/app is a real directory; move it to $ROOT/app.git first" >&2; exit 1; }
ln -sfn "$REL" "$ROOT/app.new" && mv -T "$ROOT/app.new" "$ROOT/app"
systemctl restart tvkeyd trustvault-api trustvault-web
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4100/api/health >/dev/null && curl -fsS -o /dev/null http://127.0.0.1:4101/login; then
    echo "deploy-artifact: $TAG healthy (older releases kept in $ROOT/releases for rollback)"; exit 0
  fi
  sleep 1
done
echo "deploy-artifact: health check FAILED; roll back: ln -sfn <old release> $ROOT/app && systemctl restart trustvault-api trustvault-web" >&2
exit 1
