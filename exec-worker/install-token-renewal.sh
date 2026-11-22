#!/usr/bin/env bash
# Installs the automatic market-data token renewal on the execution-worker server: a systemd timer that asks the app
# (GET /api/market/token-renewal) every 5 minutes, all day, every day. The app decides whether the Dhan token needs
# renewing (after 15:40 IST, once more near 16:00, or 07:30-09:00 as a second chance; never during market hours
# unless the token would die before the close), so the charts' token is never pasted by hand again.
# Same idea as Neural Core's copy engine. Run as root on the worker server:
#   sudo bash install-token-renewal.sh
# Check it with:  systemctl list-timers traded-token-renewal.timer   and   journalctl -u traded-token-renewal.service -n 20
# It reuses /etc/traded-monitor.env (APP_URL, CRON_SECRET) written by install-monitor.sh, or asks for them.
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

cat > /usr/local/bin/traded-token-renewal-check <<'EOF'
#!/usr/bin/env bash
# One renewal check. The app's answer (not-due / renewed / failed, never the token) goes to the journal.
set -uo pipefail
if ! curl -fsS --max-time 30 -H "Authorization: Bearer ${CRON_SECRET}" "${APP_URL}/api/market/token-renewal"; then
  echo "token renewal check failed"
  exit 1
fi
EOF
chmod 755 /usr/local/bin/traded-token-renewal-check

cat > /etc/systemd/system/traded-token-renewal.service <<EOF
[Unit]
Description=TradeD market-data token renewal check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/traded-token-renewal-check
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
EOF

cat > /etc/systemd/system/traded-token-renewal.timer <<'EOF'
[Unit]
Description=TradeD market-data token renewal, every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now traded-token-renewal.timer
echo "Installed. Next checks:"
systemctl list-timers traded-token-renewal.timer --no-pager
