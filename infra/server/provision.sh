#!/usr/bin/env bash
# One-time server setup for TrustVault on Ubuntu 24.04 (run as root).
# Safe to re-run: every step checks before it changes anything.
#
# What it sets up:
#   - Linux users: `trustvault` (runs the API and web app), `tvkeyd` (runs the key service)
#   - /etc/trustvault (secrets, readable by root and the trustvault group only)
#   - Postgres databases trustvault (prod), trustvault_dev, trustvault_test,
#     trustvault_shadow (Prisma's migration scratch database)
#   - Postgres roles:
#       tv_owner      owns the prod schema, used only for migrations
#       tv_app        what the running API connects as: no ownership, so RLS and
#                     the audit triggers apply to it
#       tv_dev_*      the same pair for dev/test, so a developer machine never
#                     holds prod credentials
#   - pg_hba rules so TrustVault roles can reach only TrustVault databases
#   - Redis on localhost only, default user disabled, one ACL user per
#     environment restricted to its own key prefix and no admin commands
set -euo pipefail

PG_VER=16
HBA=/etc/postgresql/$PG_VER/main/pg_hba.conf
SECRETS=/etc/trustvault/db.secrets

gen() { openssl rand -base64 36 | tr -d '/+=' | cut -c1-40; }

# --- Linux users and directories -------------------------------------------
id trustvault >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/trustvault --shell /usr/sbin/nologin trustvault
id tvkeyd     >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tvkeyd
install -d -m 0750 -o root -g trustvault /etc/trustvault
install -d -m 0750 -o trustvault -g trustvault /opt/trustvault /var/log/trustvault

# --- Secrets (generated once, never leave the server) ----------------------
if [ ! -f "$SECRETS" ]; then
  ( umask 077
    { echo "TV_OWNER_PW=$(gen)"; echo "TV_APP_PW=$(gen)"
      echo "TV_DEV_OWNER_PW=$(gen)"; echo "TV_DEV_APP_PW=$(gen)"
      echo "REDIS_PROD_PW=$(gen)"; echo "REDIS_DEV_PW=$(gen)"; } > "$SECRETS" )
fi
chmod 0600 "$SECRETS"
# shellcheck disable=SC1090
. "$SECRETS"

# --- Postgres roles ---------------------------------------------------------
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tv_owner')     THEN CREATE ROLE tv_owner     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tv_app')       THEN CREATE ROLE tv_app       LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tv_dev_owner') THEN CREATE ROLE tv_dev_owner LOGIN NOSUPERUSER CREATEDB   NOCREATEROLE NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tv_dev_app')   THEN CREATE ROLE tv_dev_app   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF;
END \$\$;
ALTER ROLE tv_owner     PASSWORD '$TV_OWNER_PW';
ALTER ROLE tv_app       PASSWORD '$TV_APP_PW';
ALTER ROLE tv_dev_owner PASSWORD '$TV_DEV_OWNER_PW';
ALTER ROLE tv_dev_app   PASSWORD '$TV_DEV_APP_PW';
ALTER ROLE tv_app       SET statement_timeout = '15s';
ALTER ROLE tv_dev_app   SET statement_timeout = '15s';
-- One NOLOGIN group that migrations grant table rights to. Both runtime
-- roles inherit it; pg_hba stops the dev role ever reaching prod.
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='trustvault_app') THEN CREATE ROLE trustvault_app NOLOGIN; END IF;
END \$\$;
ALTER ROLE tv_app INHERIT; ALTER ROLE tv_dev_app INHERIT;
GRANT trustvault_app TO tv_app;
GRANT trustvault_app TO tv_dev_app;
SQL

# --- Databases --------------------------------------------------------------
for spec in "trustvault:tv_owner:tv_app" "trustvault_dev:tv_dev_owner:tv_dev_app" "trustvault_test:tv_dev_owner:tv_dev_app"; do
  IFS=: read -r db own app <<<"$spec"
  sudo -u postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || sudo -u postgres createdb -O "$own" "$db"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$db" <<SQL
REVOKE ALL ON DATABASE $db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE $db TO $own;
GRANT CONNECT ON DATABASE $db TO $app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO $own;
GRANT USAGE ON SCHEMA public TO $app;
SQL
done

# Scratch database Prisma uses to check migrations (dev only)
sudo -u postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname='trustvault_shadow'" | grep -q 1 || sudo -u postgres createdb -O tv_dev_owner trustvault_shadow
sudo -u postgres psql -q -d trustvault_shadow -c "REVOKE ALL ON DATABASE trustvault_shadow FROM PUBLIC; GRANT CONNECT, TEMP ON DATABASE trustvault_shadow TO tv_dev_owner; ALTER SCHEMA public OWNER TO tv_dev_owner;"

# --- pg_hba: TrustVault roles reach only TrustVault databases --------------
if ! grep -q "TRUSTVAULT-BEGIN" "$HBA"; then
  cp "$HBA" "$HBA.bak-trustvault"
  { echo "# TRUSTVAULT-BEGIN"
    echo "host    trustvault                      tv_owner,tv_app          127.0.0.1/32  scram-sha-256"
    echo "host    trustvault_dev,trustvault_test,trustvault_shadow  tv_dev_owner,tv_dev_app  127.0.0.1/32  scram-sha-256"
    echo "host    all   tv_owner,tv_app,tv_dev_owner,tv_dev_app   all   reject"
    echo "local   all   tv_owner,tv_app,tv_dev_owner,tv_dev_app         reject"
    echo "# TRUSTVAULT-END"
    cat "$HBA.bak-trustvault"; } > "$HBA.new"
  mv "$HBA.new" "$HBA"; chown postgres:postgres "$HBA"; chmod 640 "$HBA"
  systemctl reload postgresql
fi

# --- Redis ------------------------------------------------------------------
DEBIAN_FRONTEND=noninteractive apt-get install -y -q redis-server >/dev/null
cat > /etc/redis/users.acl <<ACL
user default off
user tvprod on >$REDIS_PROD_PW ~tv:* &tv:* +@all -@admin -@dangerous +info +ping
user tvdev  on >$REDIS_DEV_PW  ~tvdev:* &tvdev:* +@all -@admin -@dangerous +info +ping
ACL
chown redis:redis /etc/redis/users.acl; chmod 600 /etc/redis/users.acl
RC=/etc/redis/redis.conf
sed -i 's/^bind .*/bind 127.0.0.1 -::1/; s/^protected-mode .*/protected-mode yes/' "$RC"
grep -q '^aclfile' "$RC"    || echo 'aclfile /etc/redis/users.acl' >> "$RC"
grep -q '^maxmemory ' "$RC" || printf 'maxmemory 256mb\nmaxmemory-policy noeviction\n' >> "$RC"
systemctl enable -q redis-server
systemctl restart redis-server

echo "provision: done"
