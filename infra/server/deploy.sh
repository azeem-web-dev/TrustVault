#!/usr/bin/env bash
# Deploy a release: fetch, install, build, migrate, restart, health-check.
# Run as root:  bash /opt/trustvault/app/infra/server/deploy.sh [git-ref]
set -euo pipefail
APP=/opt/trustvault/app
REPO=https://github.com/azeem-web-dev/TrustVault.git
REF=${1:-main}
as_tv() { sudo -u trustvault -H "$@"; }

if [ ! -d "$APP/.git" ]; then
  as_tv git clone --quiet "$REPO" "$APP"
fi
as_tv git -C "$APP" fetch --quiet origin
as_tv git -C "$APP" checkout --quiet --force --detach "origin/$REF"
echo "deploying $(as_tv git -C "$APP" log -1 --format='%h %s')"

cd "$APP"
# npm 10 on the server would run every package's install script. Install
# with scripts off, then run only the three that are needed (and approved
# in package.json allowScripts): Prisma's engines and esbuild.
as_tv npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
as_tv npm rebuild prisma @prisma/engines esbuild --loglevel=error

as_tv bash -c 'cd apps/api && npx prisma generate >/dev/null && npx tsc -p tsconfig.build.json'
as_tv bash -c 'cd apps/web && NEXT_TELEMETRY_DISABLED=1 npx next build >/dev/null'
as_tv install -d -m 0750 apps/web/.next/cache

# Migrations run as the schema owner. Only this process gets those
# credentials, passed on its command line environment from a root-only file.
OWNER_URL=$(sed -n 's/^DATABASE_OWNER_URL=//p' /etc/trustvault/migrate.env)
as_tv env DATABASE_OWNER_URL="$OWNER_URL" bash -c 'cd apps/api && npx prisma migrate deploy'
unset OWNER_URL

systemctl restart trustvault-api trustvault-web
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4100/api/health >/dev/null && curl -fsS -o /dev/null http://127.0.0.1:4101/login; then
    echo "deploy: healthy"; exit 0
  fi
  sleep 1
done
echo "deploy: health check FAILED" >&2
journalctl -u trustvault-api -u trustvault-web -n 40 --no-pager >&2
exit 1
