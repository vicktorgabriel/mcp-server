#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$(pwd -P)"
if [ "$(id -u)" -eq 0 ]; then
  OWNER_USER="${SUDO_USER:-$(stat -c '%U' "$ROOT_DIR" 2>/dev/null || echo root)}"
  if id "$OWNER_USER" >/dev/null 2>&1; then
    export MCP_REPO_OWNER_UID="${MCP_REPO_OWNER_UID:-$(id -u "$OWNER_USER")}"
    export MCP_REPO_OWNER_GID="${MCP_REPO_OWNER_GID:-$(id -g "$OWNER_USER")}"
  fi
fi
SERVICE="${MCP_SERVICE_NAME:-mcp-local.service}"
export PATH="$HOME/.local/bin:$PATH"
export MCP_CONFIG_SOURCE=file
SETUP_DONE=0
STARTUP_SUMMARY_SHOWN=0

line() { printf '%*s\n' 72 '' | tr ' ' '='; }
info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
err() { printf '[ERROR] %s\n' "$*" >&2; }

root_run() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    err "Se necesitan permisos de administrador para: $*"
    return 1
  fi
}

read_config() {
  local key="$1" fallback="${2:-}" line value
  if [ -f .env ]; then
    line="$(grep -m1 -E "^${key}=" .env 2>/dev/null || true)"
    if [ -n "$line" ]; then
      value="${line#*=}"
      if [[ "$value" == \"*\" && "$value" == *\" ]] || [[ "$value" == \'*\' && "$value" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi
      printf '%s' "$value"
      return 0
    fi
  fi
  if value="$(printenv "$key" 2>/dev/null)"; then
    printf '%s' "$value"
    return 0
  fi
  printf '%s' "$fallback"
}

show_startup_logo() {
  [ "${MCP_STARTUP_LOGO_SHOWN:-0}" = '1' ] && return 0
  MCP_STARTUP_LOGO_SHOWN=1
  export MCP_STARTUP_LOGO_SHOWN
  node startup-banner.js --logo || true
}

start_update_check() {
  [ "${MCP_STARTUP_UPDATE_STARTED:-0}" = '1' ] && return 0
  MCP_STARTUP_UPDATE_STARTED=1
  export MCP_STARTUP_UPDATE_STARTED
  if node startup-banner.js --needs-update-check >/dev/null 2>&1; then
    (node startup-banner.js --check-update --force --notify || true) &
  fi
}

show_startup_summary() {
  [ "$STARTUP_SUMMARY_SHOWN" = '1' ] && return 0
  STARTUP_SUMMARY_SHOWN=1
  node startup-banner.js --summary || true
  echo
}

prepare_visual_start() {
  show_startup_logo
  start_update_check
}

maybe_reexec_as_root() {
  local mode="$1" run_as_root repo_uid repo_gid preserve=()
  run_as_root="$(read_config MCP_RUN_AS_ROOT 0)"
  [ "$run_as_root" = '1' ] || return 0
  [ "$(id -u)" -ne 0 ] || {
    export MCP_REPO_OWNER_UID="${MCP_REPO_OWNER_UID:-$(stat -c '%u' "$ROOT_DIR" 2>/dev/null || echo 0)}"
    export MCP_REPO_OWNER_GID="${MCP_REPO_OWNER_GID:-$(stat -c '%g' "$ROOT_DIR" 2>/dev/null || echo 0)}"
    return 0
  }
  command -v sudo >/dev/null 2>&1 || { err 'El modo root está habilitado, pero sudo no está disponible.'; return 1; }

  repo_uid="$(stat -c '%u' "$ROOT_DIR" 2>/dev/null || id -u)"
  repo_gid="$(stat -c '%g' "$ROOT_DIR" 2>/dev/null || id -g)"
  for variable in DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR WAYLAND_DISPLAY \
                  XDG_SESSION_TYPE XDG_CURRENT_DESKTOP DESKTOP_SESSION TERM COLORTERM NO_COLOR; do
    if [ -n "${!variable:-}" ]; then preserve+=("$variable=${!variable}"); fi
  done

  warn 'Reiniciando el MCP mediante sudo porque elegiste ejecución como root.'
  warn 'Desde este momento todas las herramientas habilitadas tendrán los permisos de root.'
  exec sudo -- env \
    "HOME=$HOME" \
    "PATH=$PATH" \
    "MCP_ROOT_REEXEC=1" \
    "MCP_SETUP_ALREADY_DONE=1" \
    "MCP_STARTUP_LOGO_SHOWN=1" \
    "MCP_STARTUP_UPDATE_STARTED=1" \
    "MCP_REPO_OWNER_UID=$repo_uid" \
    "MCP_REPO_OWNER_GID=$repo_gid" \
    "${preserve[@]}" \
    "$ROOT_DIR/start-mcp.sh" "--$mode"
}

have_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

service_exists() {
  have_systemd && systemctl cat "$SERVICE" >/dev/null 2>&1
}

read_port() {
  local value
  value="$(read_config PORT 3000)"
  if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ]; then
    printf '%s' "$value"
  else
    printf '3000'
  fi
}

stop_repo_runtime() {
  local port pid command cwd found=0
  port="$(read_port)"

  while read -r pid command; do
    [ -n "$pid" ] || continue
    [ "$pid" != "$$" ] || continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$command" in
      *"mcp-supervisor.js"*|*"mcp-server.js --http"*)
        if [ "$cwd" = "$ROOT_DIR" ]; then
          info "Deteniendo proceso MCP anterior pid=$pid"
          kill -TERM "$pid" 2>/dev/null || root_run kill -TERM "$pid" 2>/dev/null || true
          found=1
        fi
        ;;
      *"ngrok http http://127.0.0.1:$port"*|*"ngrok http $port "*|*"ngrok http $port" )
        if [ "$cwd" = "$ROOT_DIR" ]; then
          info "Deteniendo tunel ngrok anterior pid=$pid"
          kill -TERM "$pid" 2>/dev/null || root_run kill -TERM "$pid" 2>/dev/null || true
          found=1
        fi
        ;;
    esac
  done < <(ps -eo pid=,args=)

  if [ "$found" = "1" ]; then
    sleep 2
    while read -r pid command; do
      [ -n "$pid" ] || continue
      [ "$pid" != "$$" ] || continue
      cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      [ "$cwd" = "$ROOT_DIR" ] || continue
      case "$command" in
        *"mcp-supervisor.js"*|*"mcp-server.js --http"*|*"ngrok http http://127.0.0.1:$port"*|*"ngrok http $port "*|*"ngrok http $port")
          kill -KILL "$pid" 2>/dev/null || root_run kill -KILL "$pid" 2>/dev/null || true
          ;;
      esac
    done < <(ps -eo pid=,args=)
  fi
}

disable_persistent_service() {
  if ! service_exists; then return 0; fi

  local active enabled
  active="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "$SERVICE" 2>/dev/null || true)"
  if [ "$active" != "inactive" ] || [ "$enabled" != "disabled" ]; then
    info "Desactivando el modo persistente para que no quede consumiendo cuando cierres la terminal..."
    root_run systemctl disable --now "$SERVICE" >/dev/null
    sleep 1
  fi
}

start_temporary() {
  prepare_visual_start
  if [ "$SETUP_DONE" != '1' ] && [ "${MCP_SETUP_ALREADY_DONE:-0}" != '1' ]; then
    ./setup-mcp.sh
    SETUP_DONE=1
  fi
  maybe_reexec_as_root temporary
  show_startup_summary
  disable_persistent_service
  stop_repo_runtime

  echo ""
  line
  echo " MCP EN MODO TEMPORAL"
  line
  echo "El MCP y ngrok funcionan solamente mientras esta terminal siga abierta."
  echo "El log queda visible aqui. Ctrl+C o cerrar la terminal detiene todo."
  echo "Este modo NO se inicia con el sistema."
  line
  echo ""

  exec env MCP_LAUNCH_MODE=temporary node mcp-supervisor.js
}

start_persistent() {
  prepare_visual_start
  if [ "$SETUP_DONE" != '1' ] && [ "${MCP_SETUP_ALREADY_DONE:-0}" != '1' ]; then
    ./setup-mcp.sh
    SETUP_DONE=1
  fi
  show_startup_summary
  MCP_SETUP_ALREADY_DONE=1 ./install-service.sh
  SETUP_DONE=1

  if [ -t 0 ] && [ -t 1 ] && [ "${MCP_FOLLOW_PERSISTENT_LOGS:-1}" != "0" ]; then
    echo ""
    echo "Mostrando el log persistente. Ctrl+C cierra solamente esta vista;"
    echo "MCP y ngrok continuaran activos en segundo plano."
    echo ""
    exec ./mcpctl.sh logs-follow
  fi
}

show_menu() {
  line
  echo " MCP Local Full Control - inicio seguro"
  line
  echo "Elegir forma de inicio:"
  echo ""
  echo "  1) TEMPORAL (recomendado para uso ocasional o sin autenticación)"
  echo "     Se ve el log. Al cerrar la terminal se detienen MCP y ngrok."
  echo ""
  echo "  2) PERSISTENTE (recomendado si configuraste OAuth)"
  echo "     Sigue activo al cerrar la terminal y se inicia con el equipo."
  echo "     Consultá la actividad cuando quieras con: ./mcpctl.sh logs"
  echo ""
  echo "  3) SALIR"
  echo ""
  read -r -p "Opcion [1]: " choice
  choice="${choice:-1}"

  case "$choice" in
    1|t|T|temporal|TEMPORAL) start_temporary ;;
    2|p|P|persistente|PERSISTENTE) start_persistent ;;
    3|s|S|salir|SALIR) exit 0 ;;
    *)
      err "Opcion no valida: $choice"
      exit 2
      ;;
  esac
}

show_help() {
  cat <<'HELP'
Uso:
  ./start-mcp.sh                Muestra el menu TEMPORAL / PERSISTENTE
  ./start-mcp.sh --temporary    Log visible; cerrar terminal detiene todo
  ./start-mcp.sh --persistent   Instala e inicia el servicio persistente
  ./start-mcp.sh --status       Estado del MCP, servicio y tunel
  ./start-mcp.sh --url          URL publica activa para ChatGPT
  ./start-mcp.sh --logs         Actividad explicada en lenguaje legible
  ./start-mcp.sh --configure    Reabre el asistente inicial
  ./start-mcp.sh --permissions  Muestra el perfil y las herramientas habilitadas
  ./start-mcp.sh --permissions-set  Cambia sólo el perfil de herramientas
  ./start-mcp.sh --update-check Comprueba ahora si hay una actualización
  ./start-mcp.sh --chatgpt      Guía para agregarlo a ChatGPT
  ./start-mcp.sh --stop         Detiene el servicio persistente
  ./start-mcp.sh --disable      Detiene y deshabilita el inicio automatico
  ./start-mcp.sh --restart      Reinicia el servicio persistente

Compatibilidad:
  --foreground equivale a --temporary
  --service equivale a --persistent

Sin terminal interactiva, el modo predeterminado es TEMPORAL. Puede elegirse
con MCP_START_MODE=temporary o MCP_START_MODE=persistent.
HELP
}

case "${1:-}" in
  --temporary|--foreground|--session)
    shift
    start_temporary "$@"
    ;;
  --persistent|--service|--daemon)
    shift
    start_persistent "$@"
    ;;
  --setup-only)
    exec ./setup-mcp.sh
    ;;
  --configure)
    exec ./mcpctl.sh configure
    ;;
  --permissions|--access)
    shift
    exec ./mcpctl.sh permissions "$@"
    ;;
  --permissions-set|--access-set)
    exec ./mcpctl.sh permissions-set
    ;;
  --update-check)
    exec ./mcpctl.sh update-check
    ;;
  --chatgpt)
    exec ./mcpctl.sh chatgpt
    ;;
  --status)
    exec ./mcpctl.sh status
    ;;
  --url)
    exec ./mcpctl.sh url
    ;;
  --logs)
    exec ./mcpctl.sh logs
    ;;
  --stop)
    exec ./mcpctl.sh stop
    ;;
  --disable)
    exec ./mcpctl.sh disable
    ;;
  --restart)
    exec ./mcpctl.sh restart
    ;;
  -h|--help|help)
    show_help
    ;;
  '')
    case "${MCP_START_MODE:-}" in
      temporary|foreground|session) start_temporary ;;
      persistent|service|daemon) start_persistent ;;
      '')
        if [ -t 0 ] && [ -t 1 ]; then
          prepare_visual_start
          ./setup-mcp.sh
          SETUP_DONE=1
          show_startup_summary
          show_menu
        else
          start_temporary
        fi
        ;;
      *)
        err "MCP_START_MODE no valido: ${MCP_START_MODE}"
        exit 2
        ;;
    esac
    ;;
  *)
    err "Opcion desconocida: $1"
    show_help >&2
    exit 2
    ;;
esac
