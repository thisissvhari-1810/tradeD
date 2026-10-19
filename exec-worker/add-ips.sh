#!/usr/bin/env bash
# Configures every private IPv4 that AWS assigned to this server's network interface, so the worker can send
# each family member's orders from that member's own Elastic IP. Run it after assigning IPs in the AWS console:
#   curl -fsSL https://raw.githubusercontent.com/thisissvhari-1810/tradeD/main/exec-worker/add-ips.sh | sudo bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi

TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 120")
md() { curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }

MAC=$(md mac)
PRIMARY=$(md local-ipv4)
CIDR=$(md "network/interfaces/macs/$MAC/subnet-ipv4-cidr-block")
PREFIX=${CIDR#*/}
IFACE=$(ip -o link | awk -v mac="$MAC" 'index($0, mac) { sub(":", "", $2); print $2; exit }')
if [ -z "$IFACE" ]; then echo "Could not find the network interface for $MAC." >&2; exit 1; fi

mapfile -t PRIVATE < <(md "network/interfaces/macs/$MAC/local-ipv4s")
SECONDARY=()
for ip in "${PRIVATE[@]}"; do [ "$ip" != "$PRIMARY" ] && SECONDARY+=("$ip"); done

FILE=/etc/netplan/60-traded-secondary.yaml
if [ "${#SECONDARY[@]}" -eq 0 ]; then
  rm -f "$FILE"
  echo "No secondary private IPs are assigned yet. In AWS: EC2 > Instances > traded-exec > Actions > Networking > Manage IP addresses > Assign new IP address."
else
  {
    echo "network:"
    echo "  version: 2"
    echo "  ethernets:"
    echo "    $IFACE:"
    echo "      addresses:"
    for ip in "${SECONDARY[@]}"; do echo "        - $ip/$PREFIX"; done
  } > "$FILE"
  chmod 600 "$FILE"
  netplan apply
fi

echo
echo "Private IP      ->  Public (Elastic) IP"
mapfile -t PUBLIC < <(md "network/interfaces/macs/$MAC/ipv4-associations/" 2>/dev/null || true)
for ip in "${PRIVATE[@]}"; do
  public="(no Elastic IP associated)"
  for pub in "${PUBLIC[@]}"; do
    [ -n "$pub" ] && [ "$(md "network/interfaces/macs/$MAC/ipv4-associations/$pub")" = "$ip" ] && public="$pub"
  done
  marker=""; [ "$ip" = "$PRIMARY" ] && marker="  (primary)"
  printf '%-15s ->  %s%s\n' "$ip" "$public" "$marker"
done
echo
echo "Configured on $IFACE:"
ip -4 -o addr show dev "$IFACE" | awk '{print "  " $4}'
echo
echo "Next: register each public IP in that family member's Dhan account, then map client ids in /etc/traded-exec.env:"
echo "  CLIENT_ROUTES=<your client id>=$PRIMARY,<member client id>=<their private IP>"
echo "and run: sudo systemctl restart traded-exec"
