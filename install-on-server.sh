#!/usr/bin/env bash
# ============================================================
#  MyDroidGrid — One-Click Installer (Ubuntu server par chalta hai)
#  User ko sirf 2 sawalo ke jawab dene hain (ya Enter dabana hai).
#  Baqi sab — Node, Docker, kernel modules, service — khud hota hai.
# ============================================================
set -Eeuo pipefail

if [[ $EUID -ne 0 ]]; then exec sudo -E bash "$0" "$@"; fi

BASE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_SRC="$BASE/app"
INSTALL_DIR="/opt/mydroidgrid"
SERVICE_USER="mydroidgrid"

# Agar deploy.sh ne values bheji hain to wo pehle load karo (koi sawal nahi puchega)
if [[ -f "$BASE/deploy-values.env" ]]; then set -a; . "$BASE/deploy-values.env"; set +a; fi

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }

[[ -f "$APP_SRC/server.js" ]] || { echo "ERROR: app folder nahi mila. Poora bundle ek sath rakho."; exit 1; }

# ---------- Sirf 2 asaan sawal (Enter = default) ----------
ask() {
  local var="$1" label="$2" def="$3"
  if [[ -n "${!var:-}" ]]; then return; fi
  if [[ -r /dev/tty ]]; then
    local val=""; read -r -p "$label [$def]: " val < /dev/tty || true
    printf -v "$var" '%s' "${val:-$def}"
  else
    printf -v "$var" '%s' "$def"
  fi
}
ask MDG_MAX_PHONES "Kitne phones chahiye? (baad me badal sakte ho)" 4
ask MDG_PORT "Website kis port par chale? (Enter hi dabao)" 4000
export MDG_MAX_PHONES MDG_PORT
MDG_PHONE_DATA_DIR="${MDG_PHONE_DATA_DIR:-/srv/mydroidgrid/phone-data}"
export MDG_PHONE_DATA_DIR
# Oracle ki 200 GB disk me se system ka hissa nikaal kar phones ke liye 150 GB mehfooz pool
MDG_STORAGE_POOL_GB="${MDG_STORAGE_POOL_GB:-150}"
export MDG_STORAGE_POOL_GB

case "$MDG_MAX_PHONES" in *[!0-9]*|'') echo "ERROR: phones ki tadaad number me do."; exit 1;; esac
case "$MDG_PORT" in *[!0-9]*|'') echo "ERROR: port number me do."; exit 1;; esac

say "Step 1/5: Zaroori software (Node.js + Docker)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl jq ufw >/dev/null
# ffmpeg: live screen ki tasveer halki (JPEG) karne ke liye — na mile to bhi site chalegi (PNG par)
apt-get install -y -qq ffmpeg >/dev/null 2>&1 || true

need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 18 ]] && need_node=0
fi
if [[ $need_node -eq 1 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node: $(node --version)"

if ! command -v docker >/dev/null 2>&1; then
  apt-get install -y -qq docker.io >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
echo "Docker: $(docker --version 2>/dev/null || echo 'installed')"

say "Step 2/5: Android engine ke kernel modules (binder / ashmem)"
modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || true
modprobe ashmem_linux 2>/dev/null || true
if ! lsmod | grep -q '^binder_linux'; then
  apt-get install -y -qq "linux-modules-extra-$(uname -r)" >/dev/null 2>&1 || true
  modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || true
  modprobe ashmem_linux 2>/dev/null || true
fi
printf 'binder_linux\nashmem_linux\n' > /etc/modules-load.d/mydroidgrid.conf
printf 'options binder_linux devices="binder,hwbinder,vndbinder"\n' > /etc/modprobe.d/binder_linux.conf
if lsmod | grep -q '^binder_linux'; then
  echo "Kernel modules: OK — asal phones chal sakte hain."
  lsmod | grep -q '^ashmem_linux' || echo "(ashmem nahi hai — koi baat nahi, naye Android versions us ke baghair chalte hain.)"
else
  warn "Kernel module (binder) is server ke kernel ($(uname -r)) par load nahi hua."
  warn "Website/dashboard chalega, lekin asal phone engine ke liye kernel support chahiye hoga."
fi

say "Step 3/5: MyDroidGrid files + apne server ki setting khud lagana"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
usermod -aG docker "$SERVICE_USER" || true
mkdir -p "$INSTALL_DIR" "$MDG_PHONE_DATA_DIR"
# Purani data (accounts/phones list) mehfooz rakho — update par kuch nahi urta
[[ -d "$INSTALL_DIR/data" ]] && cp -a "$INSTALL_DIR/data" /tmp/mdg-data-backup
cp -a "$APP_SRC/." "$INSTALL_DIR/"
cp -a "$BASE/configure.js" "$INSTALL_DIR/configure.js"
[[ -d /tmp/mdg-data-backup ]] && { cp -a /tmp/mdg-data-backup "$INSTALL_DIR/data"; rm -rf /tmp/mdg-data-backup; }
MDG_HOST_RAM_GB="$(awk '/MemTotal/ {print int($2/1048576)}' /proc/meminfo)"
MDG_HOST_CORES="$(nproc)"
export MDG_HOST_RAM_GB MDG_HOST_CORES
node "$INSTALL_DIR/configure.js" "$INSTALL_DIR"
# Purani jagah (app ke data folder ke andar) phones ka data ho aur nayi
# jagah khali ho, to use utha kar nayi jagah le ao — update par koi phone
# apna data nahi khoyega.
if [[ -d "$INSTALL_DIR/data/phone-data" ]] && [[ -z "$(ls -A "$MDG_PHONE_DATA_DIR" 2>/dev/null)" ]]; then
  cp -a "$INSTALL_DIR/data/phone-data/." "$MDG_PHONE_DATA_DIR/" 2>/dev/null || true
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" "$MDG_PHONE_DATA_DIR"

say "Step 4/5: Service banana (server restart ho to website khud chalegi)"
cat > /etc/systemd/system/mydroidgrid.service <<EOF
[Unit]
Description=MyDroidGrid cloud phone dashboard
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
Environment=MDG_PHONE_DATA_DIR=$MDG_PHONE_DATA_DIR
ExecStartPre=-+/usr/sbin/modprobe binder_linux
ExecStartPre=-+/bin/sh -c 'mkdir -p /dev/binderfs; mountpoint -q /dev/binderfs || mount -t binder binder /dev/binderfs'
ExecStart=/usr/bin/node $INSTALL_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now mydroidgrid >/dev/null 2>&1
systemctl restart mydroidgrid

say "Step 5/5: Firewall + check"
if ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow "${MDG_PORT}/tcp" >/dev/null || true
  ufw allow OpenSSH >/dev/null || true
fi

ok=0
for _ in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${MDG_PORT}/api/config" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

PUBIP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "============================================================"
if [[ $ok -eq 1 ]]; then
  echo "  MUBARAK! MyDroidGrid tayyar hai."
else
  echo "  Website abhi jawab nahi de rahi — ye command chala kar dekho:"
  echo "  journalctl -u mydroidgrid -n 50"
fi
echo "  Apne browser me kholo:  http://${PUBIP}:${MDG_PORT}"
echo
echo "  AKHRI STEP (Oracle par lazmi): Oracle Console > apni machine >"
echo "  Subnet > Security List > Ingress Rules me TCP port ${MDG_PORT}"
echo "  (source 0.0.0.0/0) ADD karo, warna website bahar se nahi khulegi."
echo "  Website khulte hi pehli screen par apna admin account bana lena."
echo "============================================================"
