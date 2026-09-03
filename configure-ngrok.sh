#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"

cat <<'NOTICE'
[INFO] configure-ngrok.sh se conserva por compatibilidad.
[INFO] La versión actual usa un único asistente para configurar acceso, ngrok y autenticación.
NOTICE

export MCP_SETUP_MODE_CHOICE=1
if [ -n "${1:-}" ]; then
  export MCP_SETUP_NGROK_URL="$1"
fi

exec ./mcpctl.sh configure
