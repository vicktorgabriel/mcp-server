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

SETUP_USER="$(repo_owner)"
SETUP_HOME="$(getent passwd "$SETUP_USER" 2>/dev/null | cut -d: -f6 || true)"
[ -n "$SETUP_HOME" ] || SETUP_HOME="$HOME"

if [ "${MCP_SETUP_ALREADY_DONE:-0}" != '1' ]; then
  if [ "$(id -u)" -eq 0 ] && [ "$SETUP_USER" != "root" ] && command -v sudo >/dev/null 2>&1; then
    sudo -u "$SETUP_USER" -H env PATH="$SETUP_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" "$ROOT_DIR/setup-mcp.sh"
  else
    "$ROOT_DIR/setup-mcp.sh"
  fi
fi

config_value() {
  local key="$1" fallback="${2:-}" line value
  line="$(grep -m1 -E "^${key}=" "$ROOT_DIR/.env" 2>/dev/null || true)"
  if [ -n "$line" ]; then
    value="${line#*=}"
    if [[ "$value" == \"*\" && "$value" == *\" ]] || [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s' "$value"
  else
    printf '%s' "$fallback"
  fi
}

RUN_AS_ROOT="$(config_value MCP_RUN_AS_ROOT 0)"
CONFIGURED_SERVICE_USER="$(config_value MCP_SERVICE_USER '')"
if [ "$RUN_AS_ROOT" = '1' ] || [ "$CONFIGURED_SERVICE_USER" = 'root' ]; then
  TARGET_USER=root
elif [ -n "$CONFIGURED_SERVICE_USER" ]; then
  id "$CONFIGURED_SERVICE_USER" >/dev/null 2>&1 || { err "El usuario configurado no existe: $CONFIGURED_SERVICE_USER"; exit 1; }
  TARGET_USER="$CONFIGURED_SERVICE_USER"
else
  TARGET_USER="$SETUP_USER"
fi
TARGET_GROUP="$(id -gn "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || true)"
[ -n "$TARGET_HOME" ] || TARGET_HOME="$HOME"
REPO_OWNER_UID="$(id -u "$SETUP_USER")"
REPO_OWNER_GID="$(id -g "$SETUP_USER")"
DESKTOP_HOME="$SETUP_HOME"
DESKTOP_UID="$REPO_OWNER_UID"

if [ "$TARGET_USER" = "root" ]; then
  warn "El servicio se instalará como root. Una credencial comprometida puede afectar todo el equipo."
fi

AUTH_MODE="$(config_value MCP_AUTH_MODE none)"
EXPOSURE_MODE="$(config_value MCP_EXPOSURE_MODE ngrok)"
ACCESS_PROFILE="$(config_value MCP_ACCESS_PROFILE developer)"
CRITICAL_CONFIRMATIONS="$(config_value MCP_CRITICAL_CONFIRMATIONS 1)"
PUBLIC_URL="$(config_value MCP_PUBLIC_BASE_URL '')"
[ -n "$PUBLIC_URL" ] || PUBLIC_URL="$(config_value NGROK_URL '')"
[ -n "$PUBLIC_URL" ] || PUBLIC_URL="$(config_value PUBLIC_BASE_URL '')"

if [ "$AUTH_MODE" = 'none' ] && [ "$EXPOSURE_MODE" != 'local' ] \
   && [ "${MCP_ALLOW_UNSAFE_PERSISTENT:-0}" != '1' ]; then
  err 'Se rechazó el modo persistente porque el endpoint público no tiene autenticación. Ejecutá ./mcpctl.sh configure y elegí OAuth.'
  exit 1
fi
if [ "$EXPOSURE_MODE" != 'local' ] && [[ "$PUBLIC_URL" = http://* ]] \
   && [ "${MCP_ALLOW_UNSAFE_PERSISTENT:-0}" != '1' ]; then
  err 'Se rechazó el modo persistente sobre HTTP sin cifrado. Usá ngrok o una URL HTTPS propia.'
  exit 1
fi
if [ "$EXPOSURE_MODE" != 'local' ] && [ "$TARGET_USER" = 'root' ] \
   && [ "$AUTH_MODE" != 'oauth' ] && [ "${MCP_ALLOW_UNSAFE_ROOT_PERSISTENT:-0}" != '1' ]; then
  err 'Se rechazó el servicio root público sin OAuth. Configurá OAuth + HTTPS o usá una sesión temporal.'
  exit 1
fi
if [ "$EXPOSURE_MODE" != 'local' ] && [ "$CRITICAL_CONFIRMATIONS" = '0' ] \
   && [ "$AUTH_MODE" != 'oauth' ] && [ "${MCP_ALLOW_UNSAFE_NO_CONFIRM_PERSISTENT:-0}" != '1' ]; then
  err 'Se rechazó el servicio público sin confirmaciones y sin OAuth. Configurá OAuth o usá una sesión temporal.'
  exit 1
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
DESKTOP_HOME_ESC="$(escape_systemd "$DESKTOP_HOME")"
NODE_ESC="$(escape_systemd "$NODE_BIN")"
PATH_VALUE="$(dirname "$NODE_BIN"):$SETUP_HOME/.local/bin:$TARGET_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
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
Environment="MCP_LAUNCH_MODE=persistent"
Environment="MCP_CONFIG_SOURCE=file"
Environment="MCP_REPO_OWNER_UID=$REPO_OWNER_UID"
Environment="MCP_REPO_OWNER_GID=$REPO_OWNER_GID"
Environment="MCP_DESKTOP_UID=$DESKTOP_UID"
Environment="MCP_DESKTOP_HOME=$DESKTOP_HOME_ESC"
ExecStart="$NODE_ESC" "$ROOT_ESC/mcp-supervisor.js"
Restart=always
RestartSec=4
TimeoutStopSec=20
KillMode=control-group
UMask=0077
LimitCORE=0
LockPersonality=true
RestrictRealtime=true
SystemCallArchitectures=native
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mcp-local

[Install]
WantedBy=multi-user.target
UNIT

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$UNIT_TMP"
fi

if [ "${MCP_SERVICE_DRY_RUN:-0}" = '1' ]; then
  cat "$UNIT_TMP"
  exit 0
fi

stop_legacy_processes() {
  local found=0 pid command cwd user users="$TARGET_USER"
  [ "$SETUP_USER" = "$TARGET_USER" ] || users="$users $SETUP_USER"
  for user in $users; do
    while read -r pid command; do
      [ -n "$pid" ] || continue
      cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      [ "$cwd" = "$ROOT_DIR" ] || continue
      case "$command" in
        *"mcp-server.js --http"*|*"mcp-supervisor.js"*|*"ngrok http "*)
          info "Deteniendo proceso anterior pid=$pid usuario=$user"
          kill -TERM "$pid" 2>/dev/null || root_run kill -TERM "$pid" 2>/dev/null || true
          found=1
          ;;
      esac
    done < <(ps -u "$user" -o pid=,args= 2>/dev/null || true)
  done

  if [ "$found" = "1" ]; then
    sleep 2
    for user in $users; do
      while read -r pid command; do
        [ -n "$pid" ] || continue
        cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
        [ "$cwd" = "$ROOT_DIR" ] || continue
        case "$command" in
          *"mcp-server.js --http"*|*"mcp-supervisor.js"*|*"ngrok http "*)
            kill -KILL "$pid" 2>/dev/null || root_run kill -KILL "$pid" 2>/dev/null || true
            ;;
        esac
      done < <(ps -u "$user" -o pid=,args= 2>/dev/null || true)
    done
  fi
}

root_run systemctl stop "$SERVICE" 2>/dev/null || true
stop_legacy_processes
root_run install -m 0644 "$UNIT_TMP" "/etc/systemd/system/$SERVICE"
root_run systemctl daemon-reload
if [ "${MCP_SERVICE_INSTALL_ONLY:-0}" = '1' ]; then
  echo "[OK] Unidad $SERVICE actualizada sin cambiar su estado de inicio."
  exit 0
fi
root_run systemctl enable --now "$SERVICE"

CHECK_HOST="$(config_value HOST 127.0.0.1)"
case "$CHECK_HOST" in 0.0.0.0|::|'[::]') CHECK_HOST=127.0.0.1 ;; esac
CHECK_HOST="${CHECK_HOST#[}"
CHECK_HOST="${CHECK_HOST%]}"
CHECK_PORT="$(config_value PORT 3000)"
CHECK_URL="http://$CHECK_HOST:$CHECK_PORT/health"

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

MODE="${EXPOSURE_MODE,,}"

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
echo "Seguridad: $AUTH_MODE"
echo "Perfil:    $ACCESS_PROFILE"
echo "Cuenta:    $TARGET_USER"
echo "Confirmaciones: $([ "$CRITICAL_CONFIRMATIONS" = '0' ] && echo desactivadas || echo activadas)"
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
echo "Actividad: ./mcpctl.sh logs"
echo "Seguir:   ./mcpctl.sh logs-follow"
echo "ChatGPT:  ./mcpctl.sh chatgpt"
echo "Reinicio: ./mcpctl.sh restart"
echo "========================================================================"
