#!/usr/bin/env bash
# Put the shared public demo back to its seed state (docs/DEMO.md, THREATS.md I15).
#
# Restores the MFA policy, role-wide rules, the demo groups, the seed
# documents' owners, status and grants, and removes demo accounts' folders.
# Never deletes audit rows; adds one 'demo.reset' row. Never deletes
# documents or files.
#
# Run as root (systemd: trustvault-demo-reset.timer), or by hand:
#   sudo bash /opt/trustvault/app/infra/server/demo-reset.sh
# Does nothing unless DEMO_MODE=true is set in /etc/trustvault/api.env.
set -euo pipefail
APP=/opt/trustvault/app

if ! grep -qx 'DEMO_MODE=true' /etc/trustvault/api.env; then
  echo "demo-reset: DEMO_MODE=true is not set in /etc/trustvault/api.env; nothing to do"
  exit 0
fi

# The schema owner's URL, from the root-only file migrations use. Passed on
# this one process's environment, never written anywhere else.
OWNER_URL=$(sed -n 's/^DATABASE_OWNER_URL=//p' /etc/trustvault/migrate.env)
[ -n "$OWNER_URL" ] || { echo "demo-reset: DATABASE_OWNER_URL missing from /etc/trustvault/migrate.env" >&2; exit 1; }

cd "$APP/apps/api"
sudo -u trustvault -H env DEMO_MODE=true DATABASE_OWNER_URL="$OWNER_URL" npx tsx prisma/demo-reset.ts
