#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$(pwd -P)"
SERVICE="${MCP_SERVICE_NAME:-mcp-local.service}"
export PATH="$HOME/.local/bin:$PATH"
SETUP_DONE=0

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

have_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

service_exists() {
  have_systemd && systemctl cat "$SERVICE" >/dev/null 2>&1
}

read_port() {
  node - <<'NODE'
const { parseDotEnv } = require('./runtime-diagnostics');
const value = Number(parseDotEnv().PORT || process.env.PORT || 3000);
process.stdout.write(String(Number.isInteger(value) && value > 0 && value < 65536 ? value : 3000));
NODE
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
  if [ "$SETUP_DONE" != '1' ]; then
    ./setup-mcp.sh
    SETUP_DONE=1
  fi
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
  MCP_SETUP_ALREADY_DONE="$SETUP_DONE" ./install-service.sh
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
          if [ ! -f .env ]; then
            ./setup-mcp.sh
            SETUP_DONE=1
          fi
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
