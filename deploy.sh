#!/usr/bin/env bash
# ============================================================
#  MyDroidGrid — Remote Deploy (apne computer se server par bhejna)
#  Sirf server ki details deni hain: IP, username, key file.
#  Ye script poora bundle server par bhej kar install chala degi.
#  Chalana:  bash deploy.sh      (Linux / Mac / Windows Git-Bash / WSL)
# ============================================================
set -Eeuo pipefail

BASE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$BASE/app/server.js" && -f "$BASE/install-on-server.sh" ]] || { echo "ERROR: Poora bundle ek folder me rakho."; exit 1; }

ask() {
  local var="$1" label="$2" def="$3"
  local val=""; read -r -p "$label${def:+ [$def]}: " val
  printf -v "$var" '%s' "${val:-$def}"
}

echo "Server ki details do (Oracle Console me machine ke page par milti hain):"
ask SERVER_HOST "1) Server ka Public IP" ""
[[ -n "$SERVER_HOST" ]] || { echo "ERROR: IP zaroori hai."; exit 1; }
ask SSH_USER "2) SSH username (Oracle Ubuntu par aksar: ubuntu)" "ubuntu"
ask SSH_KEY "3) SSH key file ka path (.key/.pem) — Enter = pehle se saved login" ""
ask MDG_MAX_PHONES "4) Kitne phones chahiye?" "4"
ask MDG_PORT "5) Website ka port" "4000"

case "$SERVER_HOST" in *[!A-Za-z0-9._-]*) echo "ERROR: IP/hostname sahi likho."; exit 1;; esac
case "$SSH_USER" in *[!A-Za-z0-9._-]*) echo "ERROR: username sahi likho."; exit 1;; esac
case "$MDG_MAX_PHONES" in *[!0-9]*|'') echo "ERROR: phones number me do."; exit 1;; esac
case "$MDG_PORT" in *[!0-9]*|'') echo "ERROR: port number me do."; exit 1;; esac

SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
if [[ -n "$SSH_KEY" ]]; then
  [[ -f "$SSH_KEY" ]] || { echo "ERROR: key file nahi mili: $SSH_KEY"; exit 1; }
  SSH_OPTS+=(-i "$SSH_KEY")
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
printf 'MDG_MAX_PHONES=%q\nMDG_PORT=%q\n' "$MDG_MAX_PHONES" "$MDG_PORT" > "$TMP/deploy-values.env"
cp "$TMP/deploy-values.env" "$BASE/deploy-values.env"
tar -C "$BASE" --exclude='deploy.sh' -czf "$TMP/bundle.tgz" .

echo
echo "Server se connect karke install ho raha hai... (5-10 minute lag sakte hain)"
scp "${SSH_OPTS[@]}" "$TMP/bundle.tgz" "${SSH_USER}@${SERVER_HOST}:/tmp/mydroidgrid-bundle.tgz"
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_HOST}" \
  'rm -rf /tmp/mydroidgrid && mkdir -p /tmp/mydroidgrid && tar -xzf /tmp/mydroidgrid-bundle.tgz -C /tmp/mydroidgrid && sudo -E bash /tmp/mydroidgrid/install-on-server.sh'
rm -f "$BASE/deploy-values.env"
echo
echo "Ho gaya! Upar wali akhri lines me website ka address diya hai."
