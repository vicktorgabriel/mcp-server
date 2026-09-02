#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

line() { printf '%*s\n' 72 '' | tr ' ' '='; }
info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }

INTERACTIVE=0
if [ -t 0 ] && [ -t 1 ]; then INTERACTIVE=1; fi

line
echo " MCP Local Full Control - preparacion"
line

chmod +x ./install-deps.sh ./install-ngrok.sh 2>/dev/null || true
./install-deps.sh

if [ ! -f .env ]; then
  info "Primera ejecucion: creando .env"
  cp .env.example .env
  DEFAULT_ROOT="$(cd .. && pwd -P)"
  node - "$DEFAULT_ROOT" <<'NODE'
const fs = require('fs');
const root = process.argv[2];
let content = fs.readFileSync('.env', 'utf8');
content = content.replace(/^WORKING_DIR=.*$/m, `WORKING_DIR=${root}`);
content = content.replace(/^ALLOWED_PATHS=.*$/m, `ALLOWED_PATHS=${root}`);
fs.writeFileSync('.env', content);
NODE

  ACCESS_CHOICE="${MCP_SETUP_ACCESS_CHOICE:-1}"
  MODE_CHOICE="${MCP_SETUP_MODE_CHOICE:-1}"
  if [ "$INTERACTIVE" = "1" ]; then
    echo "Elegir nivel de acceso inicial:"
    echo "  1) RESTRINGIDO: solo ALLOWED_PATHS"
    echo "  2) FULL CONTROL: todo lo permitido por el usuario"
    read -r -p "Opcion [1]: " ACCESS_INPUT
    ACCESS_CHOICE=${ACCESS_INPUT:-1}

    echo ""
    echo "Como se publicara el MCP:"
    echo "  1) NGROK"
    echo "  2) URL HTTPS PROPIA"
    echo "  3) SOLO LOCAL"
    read -r -p "Opcion [1]: " MODE_INPUT
    MODE_CHOICE=${MODE_INPUT:-1}
  else
    info "Modo no interactivo: usando acceso restringido y ngrok por defecto."
  fi

  if [ "$ACCESS_CHOICE" = "2" ]; then
    sed -i 's/^MCP_FULL_ACCESS=.*/MCP_FULL_ACCESS=1/' .env
  else
    sed -i 's/^MCP_FULL_ACCESS=.*/MCP_FULL_ACCESS=0/' .env
  fi

  case "$MODE_CHOICE" in
    2)
      PUBLIC_URL_INPUT="${PUBLIC_BASE_URL:-}"
      if [ "$INTERACTIVE" = "1" ]; then
        read -r -p "URL publica HTTPS sin /mcp: " PUBLIC_URL_INPUT
      fi
      sed -i 's/^MCP_EXPOSURE_MODE=.*/MCP_EXPOSURE_MODE=direct/' .env
      node - "$PUBLIC_URL_INPUT" <<'NODE'
const fs = require('fs');
const url = String(process.argv[2] || '').replace(/\/+$/, '');
let content = fs.readFileSync('.env', 'utf8');
content = content.replace(/^PUBLIC_BASE_URL=.*$/m, `PUBLIC_BASE_URL=${url}`);
fs.writeFileSync('.env', content);
NODE
      ;;
    3)
      sed -i 's/^MCP_EXPOSURE_MODE=.*/MCP_EXPOSURE_MODE=local/; s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=|' .env
      ;;
    *)
      sed -i 's/^MCP_EXPOSURE_MODE=.*/MCP_EXPOSURE_MODE=ngrok/; s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=|' .env
      ;;
  esac
fi

chmod 600 .env 2>/dev/null || true
mkdir -p .runtime
chmod 700 .runtime 2>/dev/null || true

read_config() {
  node - "$1" "$2" <<'NODE'
const { parseDotEnv } = require('./runtime-diagnostics');
const key = process.argv[2];
const fallback = process.argv[3];
const env = parseDotEnv();
process.stdout.write(String(process.env[key] ?? env[key] ?? fallback));
NODE
}

MODE="$(read_config MCP_EXPOSURE_MODE ngrok)"
FULL_ACCESS="$(read_config MCP_FULL_ACCESS 0)"
AUTH_TOKEN="$(read_config MCP_AUTH_TOKEN '')"
PUBLIC_URL="$(read_config PUBLIC_BASE_URL '')"

if [ "$MODE" = "direct" ] && [ -z "$PUBLIC_URL" ]; then
  warn "MCP_EXPOSURE_MODE=direct requiere PUBLIC_BASE_URL en .env"
  exit 1
fi

if [ "$MODE" = "ngrok" ]; then
  if ! command -v ngrok >/dev/null 2>&1; then
    INSTALL_NGROK="${MCP_INSTALL_NGROK:-1}"
    if [ "$INTERACTIVE" = "1" ]; then
      read -r -p "ngrok no esta instalado. Instalarlo ahora? [S/n]: " ANSWER
      case "${ANSWER:-S}" in n|N) INSTALL_NGROK=0 ;; *) INSTALL_NGROK=1 ;; esac
    fi
    if [ "$INSTALL_NGROK" = "1" ]; then ./install-ngrok.sh; fi
  fi

  if command -v ngrok >/dev/null 2>&1; then
    NGROK_CHECK_OUTPUT=""
    if ! NGROK_CHECK_OUTPUT="$(ngrok config check 2>&1)"; then
      warn "La configuracion de ngrok no pudo validarse; intento actualizarla automaticamente."
      ngrok config upgrade >/dev/null 2>&1 || true
      if NGROK_CHECK_OUTPUT="$(ngrok config check 2>&1)"; then
        info "Configuracion de ngrok actualizada y validada."
      else
        warn "ngrok config check: ${NGROK_CHECK_OUTPUT//$'\n'/ }"
      fi
    fi
  else
    warn "ngrok no esta disponible; el MCP local iniciara, pero no tendra URL publica."
  fi
fi

if [ "$FULL_ACCESS" = "1" ] && [ -z "$AUTH_TOKEN" ] && [ "$MODE" != "local" ]; then
  warn "FULL CONTROL se publicara sin bearer token. Revisa MCP_AUTH_TOKEN en .env."
elif [ -z "$AUTH_TOKEN" ] && [ "$MODE" != "local" ]; then
  warn "El MCP se publicara sin bearer token."
fi

info "Preparacion completa: modo=$MODE, full_access=$FULL_ACCESS"
