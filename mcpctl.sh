#!/usr/bin/env bash
set -Eeuo pipefail

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

temporary_runtime_pid() {
  local pid command cwd
  while read -r pid command; do
    [ -n "$pid" ] || continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [ "$cwd" = "$PWD" ] || continue
    case "$command" in
      *mcp-supervisor.js*) printf '%s' "$pid"; return 0 ;;
    esac
  done < <(ps -eo pid=,args= 2>/dev/null || true)
  return 1
}

show_help() {
  cat <<'HELP'
Uso: ./mcpctl.sh COMANDO

  status          Resumen legible del MCP, conexión y autenticación
  url             Muestra la URL activa para ChatGPT
  chatgpt         Guía paso a paso para agregarlo en ChatGPT
  configure       Reabre el asistente de ngrok, URL, acceso y autenticación
  temporary       Inicia en primer plano; cerrar terminal detiene todo
  persistent      Instala/inicia el servicio persistente
  start           Inicia el servicio instalado
  stop            Detiene el servicio ahora
  restart         Reinicia el servicio persistente
  disable         Detiene y deshabilita el inicio automático
  logs [N]        Actividad legible; N líneas (predeterminado 120)
  logs-follow     Sigue la actividad; Ctrl+C cierra sólo la vista
  logs-raw [N]    Diagnóstico técnico en bruto, con secretos ocultos
  oauth-status    Estado de la cuenta y sesiones OAuth
  oauth-reset     Revoca sesiones OAuth activas
  oauth-reset-all Revoca sesiones y elimina clientes OAuth registrados
  doctor          Diagnóstico técnico; devuelve error si no está listo
  uninstall       Elimina sólo el servicio; conserva repo y configuración
HELP
}

COMMAND="${1:-status}"
case "$COMMAND" in
  status)
    node log-viewer.js --summary-only
    ;;
  url)
    node runtime-diagnostics.js url
    ;;
  chatgpt)
    node chatgpt-guide.js
    ;;
  configure)
    if service_exists && systemctl is-active --quiet "$SERVICE"; then
      echo '[INFO] Deteniendo temporalmente el servicio persistente para cambiar su configuración.'
      root_run systemctl stop "$SERVICE"
    fi
    if PID="$(temporary_runtime_pid)"; then
      echo "[ERROR] Hay una sesión temporal activa en esta carpeta (PID $PID)." >&2
      echo '[ERROR] Volvé a su terminal, presioná Ctrl+C y luego ejecutá nuevamente ./mcpctl.sh configure.' >&2
      exit 1
    fi
    exec ./setup-mcp.sh --reconfigure
    ;;
  temporary)
    exec ./start-mcp.sh --temporary
    ;;
  persistent|install)
    exec ./start-mcp.sh --persistent
    ;;
  start)
    service_exists || { echo "[ERROR] El servicio no está instalado. Usá: ./start-mcp.sh --persistent" >&2; exit 1; }
    root_run systemctl start "$SERVICE"
    sleep 1
    node log-viewer.js --summary-only
    ;;
  stop)
    if service_exists; then
      root_run systemctl stop "$SERVICE"
      echo "[OK] Servicio detenido."
      if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
        echo "[AVISO] Sigue habilitado para el próximo arranque. Para deshabilitar: ./mcpctl.sh disable"
      fi
    else
      echo "[INFO] No hay servicio persistente instalado."
    fi
    ;;
  restart)
    service_exists || { echo "[ERROR] El servicio no está instalado. Usá: ./start-mcp.sh --persistent" >&2; exit 1; }
    root_run systemctl restart "$SERVICE"
    sleep 1
    node log-viewer.js --summary-only
    ;;
  disable)
    if service_exists; then
      root_run systemctl disable --now "$SERVICE"
      echo "[OK] Servicio detenido y deshabilitado. No se iniciará con el equipo."
    else
      echo "[INFO] No hay servicio persistente instalado."
    fi
    ;;
  logs)
    node log-viewer.js --lines "${2:-120}"
    ;;
  logs-follow)
    exec node log-viewer.js --lines "${2:-80}" --follow
    ;;
  logs-raw)
    node runtime-diagnostics.js logs-raw "${2:-120}"
    ;;
  oauth-status)
    node oauth-admin.js status
    ;;
  oauth-reset)
    node oauth-admin.js reset-sessions
    ;;
  oauth-reset-all)
    node oauth-admin.js reset-all
    ;;
  doctor)
    node runtime-diagnostics.js doctor
    ;;
  uninstall)
    if service_exists; then
      root_run systemctl disable --now "$SERVICE" 2>/dev/null || true
      root_run rm -f "/etc/systemd/system/$SERVICE"
      root_run systemctl daemon-reload
      echo "[OK] Servicio eliminado. El repositorio, .env y .private se conservaron."
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
