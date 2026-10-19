#!/usr/bin/env bash
# Installs the TradeD execution worker on Ubuntu: Node.js, Caddy (automatic HTTPS) and a hardened systemd service.
# Run as root on the server whose static IP is registered with Dhan:
#   curl -fsSL https://raw.githubusercontent.com/thisissvhari-1810/tradeD/main/exec-worker/install.sh | sudo bash
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/thisissvhari-1810/tradeD/main/exec-worker"
APP_DIR=/opt/traded-exec
ENV_FILE=/etc/traded-exec.env

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi

PUBLIC_IP=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
HOST="${PUBLIC_IP//./-}.sslip.io"
echo "Public IP: $PUBLIC_IP  ->  https://$HOST"

apt-get update -y
apt-get install -y nodejs caddy curl
node --version

mkdir -p "$APP_DIR"
curl -fsSL "$REPO_RAW/lib.mjs" -o "$APP_DIR/lib.mjs"
curl -fsSL "$REPO_RAW/server.mjs" -o "$APP_DIR/server.mjs"
chmod 644 "$APP_DIR"/*.mjs

if [ ! -f "$ENV_FILE" ]; then
  # Read from the terminal even when this script is piped into bash.
  read -r -s -p "Paste EXECUTION_SERVICE_SECRET (input hidden): " SECRET < /dev/tty; echo
  read -r -p "Dhan client id(s) allowed, comma separated: " CLIENTS < /dev/tty
  if [ "${#SECRET}" -lt 32 ]; then echo "Secret must be at least 32 characters." >&2; exit 1; fi
  umask 077
  cat > "$ENV_FILE" <<EOF
EXECUTION_SERVICE_SECRET=$SECRET
ALLOWED_CLIENT_IDS=$CLIENTS
ORDERS_ENABLED=true
MAX_ORDER_QUANTITY=1800
PORT=8787
EOF
  echo "Saved $ENV_FILE (readable by root only)."
fi

cat > /etc/systemd/system/traded-exec.service <<EOF
[Unit]
Description=TradeD execution worker
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node $APP_DIR/server.mjs
EnvironmentFile=$ENV_FILE
DynamicUser=yes
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
LockPersonality=yes
MemoryDenyWriteExecute=no
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  encode zstd gzip
  request_body {
    max_size 16KB
  }
  reverse_proxy 127.0.0.1:8787
  header -Server
}
EOF

systemctl daemon-reload
systemctl enable --now traded-exec
systemctl restart caddy
sleep 3
systemctl --no-pager --lines=5 status traded-exec || true
echo
echo "Waiting for the HTTPS certificate..."
for i in $(seq 1 30); do
  if curl -fsS "https://$HOST/health" >/dev/null 2>&1; then
    echo "OK: https://$HOST/health -> $(curl -fsS "https://$HOST/health")"
    echo "Set EXECUTION_SERVICE_URL=https://$HOST in Vercel."
    exit 0
  fi
  sleep 2
done
echo "Health check did not pass yet. Check that ports 80 and 443 are open in the AWS security group, then run: journalctl -u caddy -n 50" >&2
exit 1
