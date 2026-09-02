#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
err() { printf '[ERROR] %s\n' "$*" >&2; }

command -v ngrok >/dev/null 2>&1 || {
  err "ngrok no esta instalado o no esta en PATH."
  exit 1
}

[ -f .env ] || {
  info "No existe .env; ejecutando preparacion inicial."
  ./setup-mcp.sh
}

CHECK_OUTPUT="$(ngrok config check 2>&1)" || {
  err "La configuracion que usa el comando manual de ngrok no es valida:"
  printf '%s\n' "$CHECK_OUTPUT" | sed -E 's/(authtoken|token|password|secret)([=: ]+)[^ ,"}]+/\1\2[REDACTED]/Ig' >&2
  exit 1
}

CONFIG_PATH="$(printf '%s\n' "$CHECK_OUTPUT" | sed -n 's/^Valid configuration file at //p' | tail -n1)"
if [ -z "$CONFIG_PATH" ]; then
  err "No pude detectar la ruta del archivo usado por 'ngrok config check'."
  printf '%s\n' "$CHECK_OUTPUT" >&2
  exit 1
fi
CONFIG_PATH="$(readlink -f "$CONFIG_PATH" 2>/dev/null || printf '%s' "$CONFIG_PATH")"
[ -f "$CONFIG_PATH" ] || {
  err "La configuracion detectada no existe: $CONFIG_PATH"
  exit 1
}

URL_INPUT="${1:-}"
if [ -z "$URL_INPUT" ]; then
  CURRENT_URL="$(node - <<'NODE'
const { parseDotEnv } = require('./runtime-diagnostics');
process.stdout.write(String(parseDotEnv().NGROK_URL || ''));
NODE
)"
  if [ -n "$CURRENT_URL" ]; then
    read -r -p "URL publica de ngrok [$CURRENT_URL]: " URL_INPUT
    URL_INPUT="${URL_INPUT:-$CURRENT_URL}"
  else
    read -r -p "URL publica de ngrok (ej. https://mi-equipo.ngrok.dev): " URL_INPUT
  fi
fi

URL_INPUT="${URL_INPUT%/}"
case "$URL_INPUT" in
  http://*|https://*) ;;
  '') err "La URL quedo vacia."; exit 1 ;;
  *) URL_INPUT="https://$URL_INPUT" ;;
esac

case "$URL_INPUT" in
  */mcp)
    URL_INPUT="${URL_INPUT%/mcp}"
    warn "Quite /mcp de NGROK_URL; el conector lo agrega al final."
    ;;
esac

python3 - "$CONFIG_PATH" "$URL_INPUT" <<'PY'
from pathlib import Path
import sys
p = Path('.env')
config_path, url = sys.argv[1:3]
updates = {
    'PORT': '3000',
    'MCP_EXPOSURE_MODE': 'ngrok',
    'NGROK_CONFIG': config_path,
    'NGROK_URL': url,
    'NGROK_DOMAIN': '',
}
lines = p.read_text().splitlines()
out = []
seen = set()
for line in lines:
    stripped = line.strip()
    if stripped and not stripped.startswith('#') and '=' in line:
        key = line.split('=', 1)[0].strip()
        if key in updates:
            out.append(f'{key}={updates[key]}')
            seen.add(key)
            continue
    out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f'{key}={value}')
p.write_text('\n'.join(out).rstrip() + '\n')
p.chmod(0o600)
PY

cat <<RESULT

========================================================================
 NGROK SINCRONIZADO
========================================================================
Configuracion/token usado por el comando manual:
  $CONFIG_PATH

URL publica:
  $URL_INPUT

Upstream local del MCP:
  http://127.0.0.1:3000

Ahora ejecuta:
  bash start-mcp.sh

y elige 1 para modo TEMPORAL.
========================================================================
RESULT
