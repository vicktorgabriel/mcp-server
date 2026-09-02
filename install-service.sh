#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$(pwd -P)"
SERVICE="${MCP_SERVICE_NAME:-mcp-local.service}"

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
err() { printf '[ERROR] %s\n' "$*" >&2; }

root_run() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    err "Se requiere sudo o una terminal root para instalar el servicio."
    return 1
  fi
}

repo_owner() {
  local owner
  owner="$(stat -c '%U' "$ROOT_DIR" 2>/dev/null || true)"
  if [ "$(id -u)" -ne 0 ]; then
    id -un
  elif [ -n "$owner" ] && [ "$owner" != "UNKNOWN" ] && [ "$owner" != "root" ] && id "$owner" >/dev/null 2>&1; then
    echo "$owner"
  elif command -v sudo >/dev/null 2>&1 && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ] \
       && id "$SUDO_USER" >/dev/null 2>&1 && sudo -u "$SUDO_USER" test -w "$ROOT_DIR"; then
    echo "$SUDO_USER"
  else
    echo root
  fi
}

TARGET_USER="$(repo_owner)"
TARGET_GROUP="$(id -gn "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || true)"
[ -n "$TARGET_HOME" ] || TARGET_HOME="$HOME"

if [ "$TARGET_USER" = "root" ]; then
  warn "El servicio se instalara como root. Un MCP publico con full-control y sin token es extremadamente sensible."
fi

if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ] && command -v sudo >/dev/null 2>&1; then
  sudo -u "$TARGET_USER" -H env PATH="$TARGET_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" "$ROOT_DIR/setup-mcp.sh"
else
  "$ROOT_DIR/setup-mcp.sh"
fi

if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  err "Este equipo no usa systemd. Ejecuta ./start-mcp.sh --foreground o crea un servicio equivalente."
  exit 1
fi

NODE_BIN="$(command -v node)"
if [ ! -x "$NODE_BIN" ]; then
  err "No se encontro un Node.js ejecutable."
  exit 1
fi

escape_systemd() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g'
}

escape_systemd_path() {
  python3 - "$1" <<'PY'
import sys
value = sys.argv[1]
value = value.replace('\\', '\\x5c').replace(' ', '\\x20').replace('\t', '\\t').replace('%', '%%')
print(value, end='')
PY
}

ROOT_UNIT_PATH="$(escape_systemd_path "$ROOT_DIR")"
ROOT_ESC="$(escape_systemd "$ROOT_DIR")"
HOME_ESC="$(escape_systemd "$TARGET_HOME")"
NODE_ESC="$(escape_systemd "$NODE_BIN")"
PATH_VALUE="$(dirname "$NODE_BIN"):$TARGET_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PATH_ESC="$(escape_systemd "$PATH_VALUE")"
UNIT_TMP="$(mktemp --suffix=.service)"
trap 'rm -f "$UNIT_TMP"' EXIT

cat > "$UNIT_TMP" <<UNIT
[Unit]
Description=MCP Local Full Control with managed exposure tunnel
Documentation=https://github.com/vicktorgabriel/mcp-server
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
WorkingDirectory=$ROOT_UNIT_PATH
Environment="HOME=$HOME_ESC"
Environment="PATH=$PATH_ESC"
Environment="MCP_SERVICE_NAME=$SERVICE"
Environment="MCP_RUNTIME_DIR=$ROOT_ESC/.runtime"
ExecStart="$NODE_ESC" "$ROOT_ESC/mcp-supervisor.js"
Restart=always
RestartSec=4
TimeoutStopSec=20
KillMode=control-group
UMask=0077
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mcp-local

[Install]
WantedBy=multi-user.target
UNIT

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$UNIT_TMP"
fi

stop_legacy_processes() {
  local found=0 pid command cwd
  while read -r pid command; do
    [ -n "$pid" ] || continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [ "$cwd" = "$ROOT_DIR" ] || continue
    case "$command" in
      *"mcp-server.js --http"*|*"mcp-supervisor.js"*|*"ngrok http "*)
        info "Deteniendo proceso anterior pid=$pid"
        kill -TERM "$pid" 2>/dev/null || root_run kill -TERM "$pid" 2>/dev/null || true
        found=1
        ;;
    esac
  done < <(ps -u "$TARGET_USER" -o pid=,args=)

  if [ "$found" = "1" ]; then
    sleep 3
    while read -r pid command; do
      [ -n "$pid" ] || continue
      cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      [ "$cwd" = "$ROOT_DIR" ] || continue
      case "$command" in
        *"mcp-server.js --http"*|*"mcp-supervisor.js"*|*"ngrok http "*)
          kill -KILL "$pid" 2>/dev/null || root_run kill -KILL "$pid" 2>/dev/null || true
          ;;
      esac
    done < <(ps -u "$TARGET_USER" -o pid=,args=)
  fi
}

root_run systemctl stop "$SERVICE" 2>/dev/null || true
stop_legacy_processes
root_run install -m 0644 "$UNIT_TMP" "/etc/systemd/system/$SERVICE"
root_run systemctl daemon-reload
root_run systemctl enable --now "$SERVICE"

CHECK_URL="$(node - <<'NODE'
const { parseDotEnv } = require('./runtime-diagnostics');
const env = parseDotEnv();
let host = env.HOST || '127.0.0.1';
if (host === '0.0.0.0' || host === '::' || host === '[::]') host = '127.0.0.1';
host = host.replace(/^\[|\]$/g, '');
const port = Number(env.PORT || 3000);
process.stdout.write(`http://${host}:${port}/health`);
NODE
)"
info "Esperando health local en $CHECK_URL ..."
READY=0
for _ in $(seq 1 30); do
  if node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" "$CHECK_URL" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if ! systemctl is-active --quiet "$SERVICE"; then
  err "El servicio no quedo activo. Ultimos eventos:"
  root_run journalctl -u "$SERVICE" --no-pager -n 80 -o short-iso || true
  exit 1
fi

if [ "$READY" = "0" ]; then
  warn "El servicio esta activo, pero el health local aun no respondio."
fi

MODE="$(node - <<'NODE'
const { parseDotEnv } = require('./runtime-diagnostics');
process.stdout.write(String(parseDotEnv().MCP_EXPOSURE_MODE || 'ngrok').toLowerCase());
NODE
)"
URL=""
if [ "$MODE" != "local" ]; then
  info "Esperando URL publica..."
  for _ in $(seq 1 30); do
    URL="$(node runtime-diagnostics.js url 2>/dev/null || true)"
    [ -z "$URL" ] || break
    sleep 1
  done
fi

echo ""
echo "========================================================================"
echo " MCP INSTALADO COMO SERVICIO PERSISTENTE"
echo "========================================================================"
echo "Servicio: $SERVICE"
echo "Usuario:  $TARGET_USER"
echo "Estado:   $(systemctl is-active "$SERVICE" || true)"
if [ -n "$URL" ]; then
  echo "URL PARA CHATGPT:"
  echo "  $URL"
else
  echo "URL publica: todavia no disponible."
  echo "Revisar con: ./mcpctl.sh status"
fi
echo ""
echo "La terminal ya puede cerrarse: MCP y ngrok seguiran funcionando."
echo "Estado:  ./mcpctl.sh status"
echo "URL:     ./mcpctl.sh url"
echo "Logs:    ./mcpctl.sh logs"
echo "Reinicio: ./mcpctl.sh restart"
echo "========================================================================"
