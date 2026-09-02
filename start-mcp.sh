#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

case "${1:-}" in
  --foreground)
    shift
    ./setup-mcp.sh
    exec node mcp-supervisor.js "$@"
    ;;
  --setup-only)
    exec ./setup-mcp.sh
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
  --restart)
    exec ./mcpctl.sh restart
    ;;
  -h|--help)
    cat <<'HELP'
Uso:
  ./start-mcp.sh              Instala/actualiza y levanta el servicio persistente
  ./start-mcp.sh --foreground Modo visible; Ctrl+C lo detiene
  ./start-mcp.sh --status     Estado del servicio y tunel
  ./start-mcp.sh --url        URL exacta para ChatGPT
  ./start-mcp.sh --logs       Ultimos logs sin seguirlos
  ./start-mcp.sh --restart    Reinicia MCP y ngrok
HELP
    ;;
  *)
    exec ./install-service.sh "$@"
    ;;
esac
