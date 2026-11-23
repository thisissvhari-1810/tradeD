#!/usr/bin/env bash
# Installs the scheduler of the automated PAPER trading engine: a systemd timer that calls the app's
# GET /api/auto/cron every 30 seconds, 09:00–15:50 IST, Monday–Friday (the app itself skips exchange holidays).
# It only calls TradeD; it never places an order and touches nothing else on this server. Run as root:
#   sudo bash install-auto-engine.sh            (asks for the app URL and AUTO_CRON_SECRET the first time)
# Check it with:  systemctl list-timers traded-auto.timer   and   journalctl -u traded-auto.service -n 20
# Remove it with: sudo systemctl disable --now traded-auto.timer && sudo rm /etc/systemd/system/traded-auto.* /usr/local/bin/traded-auto-tick /etc/traded-auto.env
set -euo pipefail

ENV_FILE=/etc/traded-auto.env
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi
command -v curl >/dev/null || apt-get install -y curl

if [ ! -f "$ENV_FILE" ]; then
  read -r -p "App URL (for example https://traded-one.vercel.app): " APP_URL < /dev/tty
  read -r -s -p "AUTO_CRON_SECRET, as set in the app's environment (input hidden): " SECRET < /dev/tty; echo
  APP_URL="${APP_URL%/}"
  if ! [[ "$APP_URL" =~ ^https://[A-Za-z0-9.-]+$ ]]; then echo "The URL must look like https://host" >&2; exit 1; fi
  if [ "${#SECRET}" -lt 16 ]; then echo "AUTO_CRON_SECRET must be at least 16 characters." >&2; exit 1; fi
  umask 077
  printf 'APP_URL=%s\nAUTO_CRON_SECRET=%s\n' "$APP_URL" "$SECRET" > "$ENV_FILE"
fi

cat > /usr/local/bin/traded-auto-tick <<'EOF'
#!/usr/bin/env bash
# One engine pass, only 09:00–15:50 IST on weekdays. The app's answer goes to the journal.
set -uo pipefail
hhmm=$(TZ=Asia/Kolkata date +%H%M)
weekday=$(TZ=Asia/Kolkata date +%u)
if [ "$weekday" -gt 5 ] || [ "$((10#$hhmm))" -lt 900 ] || [ "$((10#$hhmm))" -gt 1550 ]; then exit 0; fi
if ! curl -fsS --max-time 58 -H "Authorization: Bearer ${AUTO_CRON_SECRET}" "${APP_URL}/api/auto/cron" | cut -c1-600; then
  echo "engine pass failed"
  exit 1
fi
EOF
chmod 755 /usr/local/bin/traded-auto-tick

cat > /etc/systemd/system/traded-auto.service <<EOF
[Unit]
Description=TradeD automated paper trading: one engine pass
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/traded-auto-tick
TimeoutStartSec=70
EOF

cat > /etc/systemd/system/traded-auto.timer <<'EOF'
[Unit]
Description=TradeD automated paper trading: every 30 seconds

[Timer]
OnBootSec=30
OnUnitActiveSec=30
AccuracySec=1
Persistent=false

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now traded-auto.timer
systemctl list-timers traded-auto.timer --no-pager
