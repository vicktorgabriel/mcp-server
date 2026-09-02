#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
SERVICE="${MCP_SERVICE_NAME:-mcp-local.service}"

root_run() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "[ERROR] Se necesitan permisos de administrador para: $*" >&2
    return 1
  fi
}

show_help() {
  cat <<'HELP'
Uso: ./mcpctl.sh COMANDO

  status       Estado del servicio, health local y tunel
  url          Muestra la URL exacta para ChatGPT
  start        Inicia el servicio
  stop         Detiene el servicio
  restart      Reinicia MCP y ngrok
  logs         Ultimas 120 lineas, sin dejar la terminal enganchada
  logs-follow  Sigue el log hasta Ctrl+C; no detiene el servicio
  doctor       Diagnostico; devuelve error si MCP/ngrok no estan listos
  install      Instala o actualiza el servicio persistente
  uninstall    Detiene y elimina solo el servicio; conserva repo y .env
HELP
}

COMMAND="${1:-status}"
case "$COMMAND" in
  status)
    systemctl status "$SERVICE" --no-pager --full 2>&1 | sed -n '1,45p' || true
    echo ""
    node runtime-diagnostics.js status
    ;;
  url)
    node runtime-diagnostics.js url
    ;;
  start|stop|restart)
    root_run systemctl "$COMMAND" "$SERVICE"
    sleep 1
    systemctl is-active "$SERVICE" || true
    ;;
  logs)
    journalctl -u "$SERVICE" --no-pager -n 120 -o short-iso 2>/dev/null \
      || root_run journalctl -u "$SERVICE" --no-pager -n 120 -o short-iso
    ;;
  logs-follow)
    echo "Ctrl+C cierra esta vista; MCP y ngrok siguen funcionando."
    journalctl -u "$SERVICE" -f -n 80 -o short-iso 2>/dev/null \
      || root_run journalctl -u "$SERVICE" -f -n 80 -o short-iso
    ;;
  doctor)
    node runtime-diagnostics.js doctor
    ;;
  install)
    exec ./install-service.sh
    ;;
  uninstall)
    root_run systemctl disable --now "$SERVICE" 2>/dev/null || true
    root_run rm -f "/etc/systemd/system/$SERVICE"
    root_run systemctl daemon-reload
    echo "[OK] Servicio eliminado. El repositorio y .env se conservaron."
    ;;
  -h|--help|help)
    show_help
    ;;
  *)
    echo "Comando desconocido: $COMMAND" >&2
    show_help >&2
    exit 2
    ;;
esac
