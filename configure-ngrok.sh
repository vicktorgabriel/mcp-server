#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$(pwd -P)"
SERVICE="${MCP_SERVICE_NAME:-mcp-local.service}"
export PATH="$HOME/.local/bin:$PATH"

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

redact() {
  sed -E \
    -e 's/(authtoken|token|password|secret)([=: ]+)[^ ,"}]+/\1\2[REDACTED]/Ig' \
    -e 's/(ngrok config add-authtoken )[[:graph:]]+/\1[REDACTED]/Ig'
}

read_env_value() {
  node - "$1" <<'NODE'
const { parseDotEnv } = require('./runtime-diagnostics');
process.stdout.write(String(parseDotEnv()[process.argv[2]] || ''));
NODE
}

write_env() {
  local bin="$1" config="$2" url="$3"
  python3 - "$bin" "$config" "$url" <<'PY'
from pathlib import Path
import sys
p = Path('.env')
binary, config, url = sys.argv[1:4]
updates = {
    'PORT': '3000',
    'MCP_EXPOSURE_MODE': 'ngrok',
    'NGROK_BIN': binary,
    'NGROK_CONFIG': config,
    'NGROK_URL': url,
    'NGROK_DOMAIN': '',
}
lines = p.read_text().splitlines() if p.exists() else []
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
}

[ -f .env ] || {
  info "No existe .env; ejecutando preparacion inicial."
  ./setup-mcp.sh
}

URL_INPUT="${1:-}"
CURRENT_URL="$(read_env_value NGROK_URL)"
if [ -z "$URL_INPUT" ]; then
  if [ -n "$CURRENT_URL" ] && [ -t 0 ]; then
    read -r -p "URL publica de ngrok [$CURRENT_URL]: " URL_INPUT
    URL_INPUT="${URL_INPUT:-$CURRENT_URL}"
  elif [ -n "$CURRENT_URL" ]; then
    URL_INPUT="$CURRENT_URL"
  elif [ -t 0 ]; then
    read -r -p "URL publica de ngrok (ej. https://mi-equipo.ngrok.dev): " URL_INPUT
  else
    err "Falta la URL publica. Uso: ./configure-ngrok.sh https://tu-endpoint.ngrok.dev"
    exit 2
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

if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  warn "El servicio persistente esta activo y debe detenerse durante la prueba."
  if [ -t 0 ]; then
    read -r -p "Detenerlo ahora? [S/n]: " ANSWER
    case "${ANSWER:-S}" in n|N) exit 1 ;; esac
  fi
  root_run systemctl stop "$SERVICE"
fi

ACTIVE_REPO_RUNTIME=0
while read -r pid command; do
  [ -n "$pid" ] || continue
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  if [ "$cwd" = "$ROOT_DIR" ]; then
    case "$command" in
      *"mcp-supervisor.js"*|*"mcp-server.js --http"*) ACTIVE_REPO_RUNTIME=1 ;;
    esac
  fi
done < <(ps -eo pid=,args=)

if [ "$ACTIVE_REPO_RUNTIME" = "1" ]; then
  err "Todavia hay una sesion MCP temporal abierta en otra terminal."
  err "Volvé a esa terminal, presiona Ctrl+C y ejecuta nuevamente este script."
  exit 1
fi

if [ "${MCP_NGROK_REPAIR_TEST:-0}" != "1" ] && pgrep -x ngrok >/dev/null 2>&1; then
  warn "Hay un proceso ngrok activo. La prueba necesita liberarlo temporalmente."
  if [ -t 0 ]; then
    read -r -p "Detener ngrok ahora? [S/n]: " ANSWER
    case "${ANSWER:-S}" in n|N) exit 1 ;; esac
  fi
  pkill -TERM -x ngrok 2>/dev/null || root_run pkill -TERM -x ngrok 2>/dev/null || true
  sleep 2
  pkill -KILL -x ngrok 2>/dev/null || root_run pkill -KILL -x ngrok 2>/dev/null || true
fi

# Reunir combinaciones posibles. Se prueba primero el ejecutable Snap sin
# --config, que reproduce exactamente el comando manual en instalaciones Snap.
declare -a CANDIDATE_BINS=()
declare -a CANDIDATE_CONFIGS=()
declare -a CANDIDATE_LABELS=()
declare -A SEEN=()

add_candidate() {
  local bin="$1" config="$2" label="$3" key
  [ -n "$bin" ] && [ -x "$bin" ] || return 0
  if [ -n "$config" ]; then
    [ -f "$config" ] || return 0
    config="$(readlink -f "$config" 2>/dev/null || printf '%s' "$config")"
  fi
  key="$bin|$config"
  [ -z "${SEEN[$key]:-}" ] || return 0
  SEEN[$key]=1
  CANDIDATE_BINS+=("$bin")
  CANDIDATE_CONFIGS+=("$config")
  CANDIDATE_LABELS+=("$label")
}

CURRENT_BIN="$(read_env_value NGROK_BIN)"
CURRENT_CONFIG="$(read_env_value NGROK_CONFIG)"
SHELL_BIN="$(command -v ngrok 2>/dev/null || true)"

if [ "${MCP_NGROK_ONLY_CANDIDATE:-0}" = "1" ]; then
  add_candidate "${MCP_NGROK_CANDIDATE_BIN:-$SHELL_BIN}" "${MCP_NGROK_CANDIDATE_CONFIG:-}" 'Candidato de prueba'
else
  add_candidate /snap/bin/ngrok '' 'Snap, configuracion predeterminada'
  add_candidate "$SHELL_BIN" '' 'Comando ngrok de esta terminal'
  add_candidate "$CURRENT_BIN" "$CURRENT_CONFIG" 'Configuracion actual de .env'
  add_candidate "$CURRENT_BIN" '' 'Ejecutable actual sin --config'
  add_candidate "$HOME/.local/bin/ngrok" '' '~/.local/bin sin --config'
  add_candidate /usr/local/bin/ngrok '' '/usr/local/bin sin --config'
  add_candidate /usr/bin/ngrok '' '/usr/bin sin --config'

  # Configuraciones comunes, incluyendo la ruta confinada de Snap.
  declare -a CONFIGS=()
  [ -z "$CURRENT_CONFIG" ] || CONFIGS+=("$CURRENT_CONFIG")
  CONFIGS+=(
    "$HOME/.config/ngrok/ngrok.yml"
    "$HOME/snap/ngrok/current/.config/ngrok/ngrok.yml"
  )
  while IFS= read -r config; do CONFIGS+=("$config"); done < <(
    find "$HOME/snap/ngrok" -type f -path '*/.config/ngrok/ngrok.yml' -printf '%T@ %p\n' 2>/dev/null \
      | sort -nr | cut -d' ' -f2-
  )

  for config in "${CONFIGS[@]}"; do
    add_candidate /snap/bin/ngrok "$config" "Snap + $config"
    add_candidate "$SHELL_BIN" "$config" "ngrok de terminal + $config"
    add_candidate "$CURRENT_BIN" "$config" "ngrok de .env + $config"
  done
fi

if [ "${#CANDIDATE_BINS[@]}" -eq 0 ]; then
  err "No encontre ningun ejecutable de ngrok."
  exit 1
fi

probe_candidate() {
  local bin="$1" config="$2" label="$3" log pid success=0 loops
  loops="${MCP_NGROK_PROBE_LOOPS:-30}"
  [[ "$loops" =~ ^[0-9]+$ ]] || loops=30
  [ "$loops" -ge 5 ] || loops=5
  [ "$loops" -le 150 ] || loops=150
  log="$(mktemp /tmp/mcp-ngrok-probe.XXXXXX)"
  PROBE_LOGS+=("$log")

  info "Probando: $label"
  if [ -n "$config" ]; then
    "$bin" http 3000 --url "$URL_INPUT" --config "$config" --log=stdout >"$log" 2>&1 &
  else
    "$bin" http 3000 --url "$URL_INPUT" --log=stdout >"$log" 2>&1 &
  fi
  pid=$!

  # Los rechazos de cuenta, token o plan terminan casi de inmediato. Un tunel
  # que sigue vivo durante varios segundos reproduce el comando manual valido.
  for _ in $(seq 1 "$loops"); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    if grep -Eq 'ERR_NGROK_|failed to start tunnel|authentication failed|command failed' "$log"; then break; fi
    sleep 0.2
  done

  if kill -0 "$pid" 2>/dev/null \
     && ! grep -Eq 'ERR_NGROK_|failed to start tunnel|authentication failed|command failed' "$log"; then
    success=1
  fi

  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  sleep 0.5

  if [ "$success" = "1" ]; then
    SELECTED_BIN="$bin"
    SELECTED_CONFIG="$config"
    SELECTED_LABEL="$label"
    return 0
  fi

  LAST_FAILURE="$(tail -n 25 "$log" | redact | tail -n 12)"
  return 1
}

PROBE_LOGS=()
SELECTED_BIN=''
SELECTED_CONFIG=''
SELECTED_LABEL=''
LAST_FAILURE=''
cleanup() {
  if [ "${MCP_NGROK_REPAIR_TEST:-0}" != "1" ]; then
    pkill -TERM -x ngrok 2>/dev/null || true
  fi
  for log in "${PROBE_LOGS[@]:-}"; do rm -f "$log"; done
}
trap cleanup EXIT INT TERM

for index in "${!CANDIDATE_BINS[@]}"; do
  if probe_candidate \
      "${CANDIDATE_BINS[$index]}" \
      "${CANDIDATE_CONFIGS[$index]}" \
      "${CANDIDATE_LABELS[$index]}"; then
    break
  fi
done

if [ -z "$SELECTED_BIN" ]; then
  err "Ninguna combinacion pudo publicar $URL_INPUT."
  [ -z "$LAST_FAILURE" ] || {
    err "Ultimo error de ngrok:"
    printf '%s\n' "$LAST_FAILURE" >&2
  }
  err "Como el comando manual funciona, comproba que lo hayas cerrado antes de ejecutar este reparador."
  exit 1
fi

write_env "$SELECTED_BIN" "$SELECTED_CONFIG" "$URL_INPUT"
trap - EXIT INT TERM
cleanup

cat <<RESULT

========================================================================
 NGROK REPARADO Y SINCRONIZADO
========================================================================
Metodo que funciono:
  $SELECTED_LABEL

Ejecutable:
  $SELECTED_BIN

Configuracion explicita:
  ${SELECTED_CONFIG:-ninguna; se usa la predeterminada del ejecutable}

URL publica:
  $URL_INPUT

Destino local:
  http://127.0.0.1:3000
========================================================================
RESULT

if [ -t 0 ] && [ -t 1 ]; then
  read -r -p "Iniciar ahora MCP en modo TEMPORAL? [S/n]: " START_ANSWER
  case "${START_ANSWER:-S}" in
    n|N) ;;
    *) exec ./start-mcp.sh --temporary ;;
  esac
fi
