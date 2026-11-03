#!/usr/bin/env bash
# Installs keyd's ticket key in the database, where only the schema owner
# can read it (table keyd_ticket_keys; docs/KEYS.md). Root only. Idempotent:
# installing the same key again changes nothing; a different key becomes
# the active one and the previous one is deactivated.
#
# Called by install-keyd.sh (after generating the key) and by deploy.sh
# (after migrations). The key reaches the CLI on stdin, never on a command line.
set -euo pipefail
APP=/opt/trustvault/app
KEY=/etc/tvkeyd/ticket.key
CLI=$APP/apps/api/dist/cli/keys.js
[ -f "$KEY" ] || { echo "ticket-key: $KEY is missing (run install-keyd.sh)" >&2; exit 1; }
[ -f "$CLI" ] || { echo "ticket-key: the app is not built yet; deploy.sh will install the key"; exit 0; }
OWNER_URL=$(sed -n 's/^DATABASE_OWNER_URL=//p' /etc/trustvault/migrate.env)
sudo -u trustvault -H env DATABASE_OWNER_URL="$OWNER_URL" node "$CLI" install-ticket-key < "$KEY"
unset OWNER_URL
