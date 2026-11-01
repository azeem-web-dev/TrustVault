#!/usr/bin/env bash
# One-time: write the app's environment files, install the systemd units
# and the nginx site, and get a TLS certificate. Run as root after
# provision.sh. Re-running keeps existing env files.
set -euo pipefail
DOMAIN=vault.rayyanazeem.cloud
REPO_DIR=${REPO_DIR:-/opt/trustvault/app}
. /etc/trustvault/db.secrets

# Runtime config: readable by the trustvault group (the services), not by others.
if [ ! -f /etc/trustvault/api.env ]; then
  ( umask 027
    cat > /etc/trustvault/api.env <<ENV
NODE_ENV=production
PORT=4100
PUBLIC_ORIGIN=https://$DOMAIN
DATABASE_URL=postgresql://tv_app:$TV_APP_PW@127.0.0.1:5432/trustvault
REDIS_URL=redis://tvprod:$REDIS_PROD_PW@127.0.0.1:6379
REDIS_PREFIX=tv:
ENV
  )
  chown root:trustvault /etc/trustvault/api.env
fi

# Migration credentials: root only. The running services never see them;
# deploy.sh hands them to the one migrate process.
if [ ! -f /etc/trustvault/migrate.env ]; then
  ( umask 077
    echo "DATABASE_OWNER_URL=postgresql://tv_owner:$TV_OWNER_PW@127.0.0.1:5432/trustvault" > /etc/trustvault/migrate.env )
  chown root:root /etc/trustvault/migrate.env
fi

install -m 0644 "$REPO_DIR/infra/systemd/trustvault-api.service" /etc/systemd/system/
install -m 0644 "$REPO_DIR/infra/systemd/trustvault-web.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q trustvault-api trustvault-web

if [ ! -f /etc/nginx/sites-available/trustvault ]; then
  install -m 0644 "$REPO_DIR/infra/nginx/vault.conf" /etc/nginx/sites-available/trustvault
  ln -sf /etc/nginx/sites-available/trustvault /etc/nginx/sites-enabled/trustvault
  nginx -t
  systemctl reload nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --register-unsafely-without-email
fi
echo "install-app: done"
