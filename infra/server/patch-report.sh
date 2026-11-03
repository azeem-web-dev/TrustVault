#!/usr/bin/env bash
# Operator tool: report pending OS updates. Read-only; changes nothing.
#   sudo bash infra/server/patch-report.sh
# Run `apt-get update` first if you want a fresh package list (this script
# does not, so it never changes apt state).
set -uo pipefail
. /etc/os-release
echo "== host =="
echo "$PRETTY_NAME, kernel $(uname -r), up since $(uptime -s)"
echo
echo "== unattended-upgrades =="
echo "service: $(systemctl is-enabled unattended-upgrades 2>&1)"
grep -h -E '^APT::Periodic::(Update-Package-Lists|Unattended-Upgrade)' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null
tail -n 5 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null
echo
SIM=$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | grep '^Inst')
echo "== pending security updates =="
echo "$SIM" | grep -- '-security' | awk '{print $2, $3, $4}' | sort
echo
echo "== all pending updates (count) =="
if [ -n "$SIM" ]; then echo "$SIM" | wc -l; else echo 0; fi
echo
echo "== reboot needed? =="
if [ -f /var/run/reboot-required ]; then echo "YES"; cat /var/run/reboot-required.pkgs 2>/dev/null; else echo "no"; fi
echo
echo "== services running old libraries or kernel =="
if command -v needrestart >/dev/null; then needrestart -b -r l 2>/dev/null | grep -E '^NEEDRESTART-(SVC|KSTA)'; else echo "(needrestart not installed)"; fi
