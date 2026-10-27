#!/usr/bin/env bash
# Installs the paper-trading monitor on the execution-worker server: a systemd timer that asks the app to check every
# open paper position (GET /api/algo/cron) every 30 seconds during the NSE session (09:10–15:35 IST, Monday–Friday),
# so targets and exits are monitored with the browser closed. Run as root on the worker server:
#   sudo bash install-monitor.sh
# Check it with:  systemctl list-timers traded-monitor.timer   and   journalctl -u traded-monitor.service -n 20
set -euo pipefail

ENV_FILE=/etc/traded-monitor.env

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi
command -v curl >/dev/null || apt-get install -y curl

if [ ! -f "$ENV_FILE" ]; then
  read -r -p "App URL (for example https://traded-one.vercel.app): " APP_URL < /dev/tty
  read -r -s -p "CRON_SECRET, as set in the app's environment (input hidden): " SECRET < /dev/tty; echo
  APP_URL="${APP_URL%/}"
  if ! [[ "$APP_URL" =~ ^https://[A-Za-z0-9.-]+$ ]]; then echo "The URL must look like https://host" >&2; exit 1; fi
  if [ "${#SECRET}" -lt 16 ]; then echo "CRON_SECRET must be at least 16 characters." >&2; exit 1; fi
  umask 077
  printf 'APP_URL=%s\nCRON_SECRET=%s\n' "$APP_URL" "$SECRET" > "$ENV_FILE"
fi

cat > /usr/local/bin/traded-monitor-check <<'EOF'
#!/usr/bin/env bash
# One monitoring pass, only during the NSE session (IST). The app's answer (sessions checked, open positions, data
# problems) goes to the journal; a failed pass is logged and the next one runs 30 seconds later.
set -uo pipefail
hhmm=$(TZ=Asia/Kolkata date +%H%M)
weekday=$(TZ=Asia/Kolkata date +%u)
if [ "$weekday" -gt 5 ] || [ "$((10#$hhmm))" -lt 910 ] || [ "$((10#$hhmm))" -gt 1535 ]; then exit 0; fi
if ! curl -fsS --max-time 55 -H "Authorization: Bearer ${CRON_SECRET}" "${APP_URL}/api/algo/cron"; then
  echo "monitor pass failed"
  exit 1
fi
EOF
chmod 755 /usr/local/bin/traded-monitor-check

cat > /etc/systemd/system/traded-monitor.service <<EOF
[Unit]
Description=TradeD paper-trading monitor pass
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/traded-monitor-check
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
EOF

cat > /etc/systemd/system/traded-monitor.timer <<'EOF'
[Unit]
Description=TradeD paper-trading monitor, every 30 seconds

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now traded-monitor.timer
echo "Installed. Next passes:"
systemctl list-timers traded-monitor.timer --no-pager
