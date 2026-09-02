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

service_exists() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] \
    && systemctl cat "$SERVICE" >/dev/null 2>&1
}

show_help() {
  cat <<'HELP'
Uso: ./mcpctl.sh COMANDO

  status       Estado del MCP, modo de inicio, health y tunel
  url          Muestra la URL activa para ChatGPT
  temporary    Inicia en primer plano; cerrar terminal detiene todo
  persistent   Instala/inicia el servicio persistente
  start        Inicia el servicio instalado sin cambiar su habilitacion
  stop         Detiene el servicio ahora
  restart      Reinicia el servicio persistente
  disable      Detiene y deshabilita el inicio automatico
  logs         Ultimos logs del servicio, MCP y ngrok
  logs-follow  Sigue el log; Ctrl+C cierra solo la vista
  doctor       Diagnostico; devuelve error si MCP/ngrok no estan listos
  install      Instala o actualiza el servicio persistente
  uninstall    Elimina solo el servicio; conserva repo y .env
HELP
}

COMMAND="${1:-status}"
case "$COMMAND" in
  status)
    if service_exists; then
      systemctl status "$SERVICE" --no-pager --full 2>&1 | sed -n '1,35p' || true
      echo ""
    fi
    node runtime-diagnostics.js status
    ;;
  url)
    node runtime-diagnostics.js url
    ;;
  temporary)
    exec ./start-mcp.sh --temporary
    ;;
  persistent|install)
    exec ./start-mcp.sh --persistent
    ;;
  start)
    service_exists || { echo "[ERROR] El servicio no esta instalado. Usa: ./start-mcp.sh --persistent" >&2; exit 1; }
    root_run systemctl start "$SERVICE"
    sleep 1
    systemctl is-active "$SERVICE" || true
    ;;
  stop)
    if service_exists; then
      root_run systemctl stop "$SERVICE"
      echo "[OK] Servicio detenido."
      if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
        echo "[AVISO] Sigue habilitado para el proximo arranque. Para deshabilitar: ./mcpctl.sh disable"
      fi
    else
      echo "[INFO] No hay servicio persistente instalado."
    fi
    ;;
  restart)
    service_exists || { echo "[ERROR] El servicio no esta instalado. Usa: ./start-mcp.sh --persistent" >&2; exit 1; }
    root_run systemctl restart "$SERVICE"
    sleep 1
    systemctl is-active "$SERVICE" || true
    ;;
  disable)
    if service_exists; then
      root_run systemctl disable --now "$SERVICE"
      echo "[OK] Servicio detenido y deshabilitado. No se iniciara con el equipo."
    else
      echo "[INFO] No hay servicio persistente instalado."
    fi
    ;;
  logs)
    node runtime-diagnostics.js logs 120
    ;;
  logs-follow)
    if service_exists && systemctl is-active --quiet "$SERVICE"; then
      echo "Ctrl+C cierra esta vista; MCP y ngrok siguen funcionando."
      journalctl -u "$SERVICE" -f -n 80 -o short-iso 2>/dev/null \
        || root_run journalctl -u "$SERVICE" -f -n 80 -o short-iso
    else
      echo "Siguiendo logs del modo temporal. Ctrl+C cierra esta vista."
      mkdir -p .runtime
      touch .runtime/mcp-server.log .runtime/ngrok.log
      tail -n 80 -F .runtime/mcp-server.log .runtime/ngrok.log
    fi
    ;;
  doctor)
    node runtime-diagnostics.js doctor
    ;;
  uninstall)
    if service_exists; then
      root_run systemctl disable --now "$SERVICE" 2>/dev/null || true
      root_run rm -f "/etc/systemd/system/$SERVICE"
      root_run systemctl daemon-reload
      echo "[OK] Servicio eliminado. El repositorio y .env se conservaron."
    else
      echo "[INFO] No hay servicio persistente instalado."
    fi
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
