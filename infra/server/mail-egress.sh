#!/usr/bin/env bash
# Lets the API reach its SMTP server and nothing else on the internet.
# The API unit denies every address except loopback (IPAddressDeny=any);
# this adds a drop-in allowing only the current addresses of SMTP_HOST from
# /etc/trustvault/mail.env. Re-run if the mail provider changes addresses
# (deliveries then fail with "Connection timeout" in the API log). Run as root.
set -euo pipefail
HOST=$(sed -n 's/^SMTP_HOST=//p' /etc/trustvault/mail.env)
[ -n "$HOST" ] || { echo "mail-egress: no SMTP_HOST in /etc/trustvault/mail.env" >&2; exit 1; }
ADDRS=$(getent ahosts "$HOST" | awk '{print $1}' | sort -u | tr '\n' ' ')
[ -n "$ADDRS" ] || { echo "mail-egress: $HOST does not resolve" >&2; exit 1; }
install -d -m 0755 /etc/systemd/system/trustvault-api.service.d
cat > /etc/systemd/system/trustvault-api.service.d/mail-egress.conf <<EOF
# Written by infra/server/mail-egress.sh for $HOST. Only these addresses.
[Service]
IPAddressAllow=$ADDRS
EOF
systemctl daemon-reload
echo "mail-egress: API may reach $HOST at: $ADDRS"
