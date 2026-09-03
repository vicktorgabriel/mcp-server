#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$(pwd -P)"
export PATH="$HOME/.local/bin:$PATH"
ENV_FILE="$ROOT_DIR/.env"
PRIVATE_DIR="$ROOT_DIR/.private"
INTERACTIVE=0
[ -t 0 ] && [ -t 1 ] && INTERACTIVE=1
[ "${MCP_SETUP_NONINTERACTIVE:-0}" = "1" ] && INTERACTIVE=0

line() { printf '%*s\n' 76 '' | tr ' ' '='; }
info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[AVISO] %s\n' "$*" >&2; }
err() { printf '[ERROR] %s\n' "$*" >&2; }

cleanup_pids=()
DIRECT_FIREWALL_REQUESTED=0
restore_private_owner() {
  local uid gid owner
  [ "$(id -u)" -eq 0 ] || return 0
  uid="${MCP_REPO_OWNER_UID:-}"
  gid="${MCP_REPO_OWNER_GID:-}"
  if ! [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]]; then
    owner="${SUDO_USER:-$(stat -c '%U' "$ROOT_DIR" 2>/dev/null || echo root)}"
    id "$owner" >/dev/null 2>&1 || return 0
    uid="$(id -u "$owner")"; gid="$(id -g "$owner")"
  fi
  [ "$uid" != '0' ] || return 0
  [ ! -e "$ENV_FILE" ] || chown -h "$uid:$gid" "$ENV_FILE" 2>/dev/null || true
  for directory in "$PRIVATE_DIR" "$ROOT_DIR/.runtime"; do
    [ ! -e "$directory" ] || chown -R -h "$uid:$gid" "$directory" 2>/dev/null || true
  done
}
cleanup() {
  local pid
  for pid in "${cleanup_pids[@]:-}"; do
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap 'cleanup; restore_private_owner' EXIT INT TERM

ensure_template() {
  if [ ! -f "$ENV_FILE" ]; then
    cp .env.example "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  install -d -m 0700 "$PRIVATE_DIR" "$ROOT_DIR/.runtime"
}

read_env() {
  local key="$1" line value
  if [ -f "$ENV_FILE" ]; then
    line="$(grep -m1 -E "^${key}=" "$ENV_FILE" 2>/dev/null || true)"
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
  fi
}

set_env() {
  python3 - "$ENV_FILE" "$@" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
updates={}
for item in sys.argv[2:]:
    key, value = item.split('=', 1)
    if any(ch in key for ch in '\r\n=') or any(ch in value for ch in '\r\n'):
        raise SystemExit('Invalid .env value')
    updates[key]=value
lines=p.read_text().splitlines() if p.exists() else []
out=[]; seen=set()
for line in lines:
    stripped=line.strip()
    if stripped and not stripped.startswith('#') and '=' in line:
        key=line.split('=',1)[0].strip()
        if key in updates:
            out.append(f'{key}={updates[key]}'); seen.add(key); continue
    out.append(line)
for key,value in updates.items():
    if key not in seen: out.append(f'{key}={value}')
p.write_text('\n'.join(out).rstrip()+'\n')
p.chmod(0o600)
PY
}

prompt_choice() {
  local variable="$1" prompt="$2" default="$3" value
  value="${!variable:-}"
  if [ -z "$value" ] && [ "$INTERACTIVE" = "1" ]; then
    read -r -p "$prompt [$default]: " value
  fi
  printf '%s' "${value:-$default}"
}

prompt_text() {
  local variable="$1" prompt="$2" default="${3:-}" value
  value="${!variable:-}"
  if [ -z "$value" ] && [ "$INTERACTIVE" = "1" ]; then
    if [ -n "$default" ]; then read -r -p "$prompt [$default]: " value
    else read -r -p "$prompt: " value
    fi
  fi
  printf '%s' "${value:-$default}"
}

prompt_secret() {
  local variable="$1" prompt="$2" value
  value="${!variable:-}"
  if [ -z "$value" ] && [ "$INTERACTIVE" = "1" ]; then
    read -r -s -p "$prompt: " value
    printf '\n' >&2
  fi
  printf '%s' "$value"
}

normalize_url() {
  node - "$1" "${2:-https}" <<'NODE'
const value=String(process.argv[2]||'').trim();
const defaultScheme=String(process.argv[3]||'https').replace(/:$/, '');
if(!value) process.exit(0);
const raw=/^[a-z][a-z0-9+.-]*:\/\//i.test(value)?value:`${defaultScheme}://${value}`;
const u=new URL(raw);
if(!['http:','https:'].includes(u.protocol)) throw new Error('La URL debe usar http:// o https://');
if(/IP_PUBLICA/i.test(u.hostname)) throw new Error('Reemplazá IP_PUBLICA por una dirección real');
u.username=''; u.password=''; u.hash=''; u.search='';
u.pathname=u.pathname.replace(/\/+$/,'');
if(u.pathname==='/mcp') u.pathname='';
if(u.pathname && u.pathname!=='/') throw new Error('La URL no debe incluir una ruta.');
process.stdout.write(u.origin);
NODE
}

is_https() {
  case "$1" in https://*) return 0 ;; *) return 1 ;; esac
}

is_snap_ngrok() {
  local candidate="$1" resolved=''
  [ -n "$candidate" ] || return 1
  case "$candidate" in /snap/*) return 0 ;; esac
  resolved="$(readlink -f "$candidate" 2>/dev/null || true)"
  case "$resolved" in /snap/*|/usr/bin/snap) return 0 ;; esac
  return 1
}

find_ngrok() {
  local candidate stored current
  stored="$(read_env NGROK_BIN)"
  current="$(command -v ngrok 2>/dev/null || true)"
  for candidate in "$stored" "$current" "$HOME/.local/bin/ngrok" /usr/local/bin/ngrok /usr/bin/ngrok /snap/bin/ngrok; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    if ! is_snap_ngrok "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  for candidate in "$stored" "$current" /snap/bin/ngrok; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

redact_ngrok() {
  sed -E \
    -e 's/(authtoken|token|password|secret)([=: ]+)[^ ,"}]+/\1\2[OCULTO]/Ig' \
    -e 's/(ngrok config add-authtoken )[[:graph:]]+/\1[OCULTO]/Ig'
}

detect_ngrok_url() {
  local bin="$1" config="$2" requested="$3" port="$4" log pid detected=""
  log="$(mktemp /tmp/mcp-ngrok-first-run.XXXXXX)"
  if [ -n "$requested" ]; then
    "$bin" http "http://127.0.0.1:$port" --config "$config" --url "$requested" --log=stdout >"$log" 2>&1 &
  else
    "$bin" http "http://127.0.0.1:$port" --config "$config" --log=stdout >"$log" 2>&1 &
  fi
  pid=$!
  cleanup_pids+=("$pid")

  for _ in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    detected="$(MCP_NGROK_API_URL="${MCP_NGROK_API_URL:-http://127.0.0.1:4040/api/tunnels}" node - "$port" <<'NODE' 2>/dev/null || true
const port=String(process.argv[2]);
fetch(process.env.MCP_NGROK_API_URL).then(r=>r.json()).then(j=>{
 const expected=`http://127.0.0.1:${port}`;
 const tunnels=(j.tunnels||[]).filter(t=>String(t.config&&t.config.addr||'').replace(/\/+$/,'')===expected);
 const selected=tunnels.find(t=>String(t.public_url||'').startsWith('https://'))||tunnels[0];
 if(selected&&selected.public_url) process.stdout.write(String(selected.public_url).replace(/\/+$/,''));
}).catch(()=>{});
NODE
)"
    [ -z "$detected" ] || break
    sleep 0.25
  done

  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  cleanup_pids=()
  if [ -z "$detected" ]; then
    err 'ngrok no pudo abrir el endpoint solicitado.'
    tail -n 18 "$log" | redact_ngrok >&2 || true
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
  printf '%s' "$detected"
}

detect_public_ip() {
  local ip="${MCP_SETUP_PUBLIC_IP:-}"
  if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then printf '%s' "$ip"; return 0; fi
  ip=''
  for endpoint in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4fsS --max-time 5 "$endpoint" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then printf '%s' "$ip"; return 0; fi
  done
  return 1
}

ensure_ngrok_available_for_probe() {
  local pids answer
  [ "${MCP_SETUP_IGNORE_RUNNING_NGROK:-0}" = '1' ] && return 0
  pids="$(pgrep -x ngrok 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  warn 'Ya hay uno o más procesos ngrok activos. El asistente necesita probar el endpoint sin conflictos.'
  if [ "$INTERACTIVE" = '1' ]; then
    read -r -p '¿Detener los procesos ngrok actuales para continuar? [S/n]: ' answer
    case "${answer:-S}" in n|N) err 'Cerrá ngrok manualmente y volvé a ejecutar el asistente.'; exit 1 ;; esac
  elif [ "${MCP_SETUP_STOP_NGROK:-0}" != '1' ]; then
    err 'Hay un ngrok activo. Cerralo o usá MCP_SETUP_STOP_NGROK=1 en una automatización controlada.'
    exit 1
  fi
  kill -TERM $pids 2>/dev/null || true
  sleep 2
  pids="$(pgrep -x ngrok 2>/dev/null || true)"
  [ -z "$pids" ] || kill -KILL $pids 2>/dev/null || true
}

write_ngrok_token_config() {
  local config="$1"
  python3 -c '
from pathlib import Path
import json, sys
p=Path(sys.argv[1]); token=sys.stdin.read()
if not token or any(ch in token for ch in "\r\n\0"):
    raise SystemExit("Authtoken no válido")
p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
p.write_text("version: \"3\"\nagent:\n    authtoken: " + json.dumps(token) + "\n")
p.chmod(0o600)
' "$config"
}

configure_ngrok() {
  local port="$1" bin token config current_url requested detected check_output
  if ! bin="$(find_ngrok)"; then
    info 'ngrok no está instalado. Se instalará ahora.'
    ./install-ngrok.sh
    bin="$(find_ngrok)" || { err 'No se pudo encontrar ngrok después de instalarlo.'; exit 1; }
  elif is_snap_ngrok "$bin"; then
    warn 'La instalación Snap puede bloquear el acceso al archivo privado del MCP o usar otra cuenta sin advertirlo.'
    MCP_FORCE_NGROK_STANDALONE=1 ./install-ngrok.sh
    bin="$HOME/.local/bin/ngrok"
  fi

  config="$PRIVATE_DIR/ngrok.yml"
  current_url="$(read_env NGROK_URL)"
  ensure_ngrok_available_for_probe

  line
  echo ' CONFIGURACIÓN DE NGROK'
  line
  echo 'Authtoken: https://dashboard.ngrok.com/get-started/your-authtoken'
  echo 'Dominios/endpoints: https://dashboard.ngrok.com/domains'
  echo 'El authtoken se guarda únicamente en:'
  echo "  $config"
  echo 'Ese archivo está excluido de Git y queda con permisos privados.'
  echo

  token="$(prompt_secret MCP_SETUP_NGROK_TOKEN 'Pegá el authtoken de ngrok (entrada oculta)')"
  if [ -n "$token" ]; then
    printf '%s' "$token" | write_ngrok_token_config "$config"
    unset token MCP_SETUP_NGROK_TOKEN
  elif [ ! -s "$config" ]; then
    err 'Hace falta el authtoken de ngrok en la primera configuración.'
    exit 1
  else
    info 'Se conserva el authtoken privado configurado anteriormente.'
  fi
  chmod 600 "$config"
  check_output="$("$bin" config check --config "$config" 2>&1)" || {
    err "La configuración privada de ngrok no es válida: $(printf '%s' "$check_output" | redact_ngrok | tr '\n' ' ')"
    exit 1
  }

  requested="$(prompt_text MCP_SETUP_NGROK_URL 'Pegá la URL asignada o reservada por ngrok; Enter usa y detecta el dominio predeterminado' "$current_url")"
  requested="$(normalize_url "$requested")"
  info 'Comprobando la cuenta y detectando el endpoint público...'
  detected="$(detect_ngrok_url "$bin" "$config" "$requested" "$port")"
  detected="$(normalize_url "$detected")"

  set_env \
    "PORT=$port" \
    'HOST=127.0.0.1' \
    'MCP_EXPOSURE_MODE=ngrok' \
    "NGROK_BIN=$bin" \
    'NGROK_CONFIG=.private/ngrok.yml' \
    "NGROK_URL=$detected" \
    'NGROK_DOMAIN=' \
    'PUBLIC_BASE_URL=' \
    "MCP_PUBLIC_BASE_URL=$detected"

  info "ngrok quedó configurado y la URL persistente es $detected"
  PUBLIC_URL_RESULT="$detected"
}

configure_direct() {
  local port="$1" ip default_url entered normalized open_choice
  ip="$(detect_public_ip || true)"
  default_url=''
  [ -z "$ip" ] || default_url="http://$ip:$port"
  line
  echo ' EXPOSICIÓN DIRECTA SIN NGROK'
  line
  echo "IP pública detectada: ${ip:-no disponible}"
  echo 'El servidor escuchará en todas las interfaces. Esta opción puede requerir:'
  echo '  - abrir o redirigir el puerto en router/firewall;'
  echo '  - una URL HTTPS y certificado válido para que ChatGPT acepte OAuth;'
  echo '  - actualizar el enlace si la IP cambia.'
  echo 'Por esos motivos ngrok es la opción recomendada para la mayoría.'
  echo
  entered="$(prompt_text MCP_SETUP_DIRECT_URL 'URL pública HTTPS propia o IP:puerto' "$default_url")"
  [ -n "$entered" ] || { err 'No se pudo detectar la IP. Ingresá una URL o dirección pública real.'; exit 1; }
  normalized="$(normalize_url "$entered" http)"
  set_env \
    "PORT=$port" \
    'HOST=0.0.0.0' \
    'MCP_EXPOSURE_MODE=direct' \
    "PUBLIC_BASE_URL=$normalized" \
    "MCP_PUBLIC_BASE_URL=$normalized" \
    'NGROK_URL=' \
    'NGROK_DOMAIN='

  open_choice="$(prompt_choice MCP_SETUP_OPEN_FIREWALL '¿Intentar abrir este puerto en UFW/firewalld después de completar la seguridad? 1=sí, 2=no' '2')"
  [ "$open_choice" = '1' ] && DIRECT_FIREWALL_REQUESTED=1 || DIRECT_FIREWALL_REQUESTED=0
  PUBLIC_URL_RESULT="$normalized"
}


apply_direct_firewall() {
  local port="$1"
  [ "$DIRECT_FIREWALL_REQUESTED" = '1' ] || return 0
  if command -v ufw >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      ufw allow "$port/tcp" || warn 'UFW no pudo abrir el puerto automáticamente.'
    elif command -v sudo >/dev/null 2>&1; then
      sudo ufw allow "$port/tcp" || warn 'UFW no pudo abrir el puerto automáticamente.'
    else
      warn 'UFW está instalado, pero faltan permisos para abrir el puerto.'
    fi
  elif command -v firewall-cmd >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      if ! firewall-cmd --permanent --add-port="$port/tcp" || ! firewall-cmd --reload; then
        warn 'firewalld no pudo abrir el puerto automáticamente.'
      fi
    elif command -v sudo >/dev/null 2>&1; then
      if ! sudo firewall-cmd --permanent --add-port="$port/tcp" || ! sudo firewall-cmd --reload; then
        warn 'firewalld no pudo abrir el puerto automáticamente.'
      fi
    else
      warn 'firewalld está instalado, pero faltan permisos para abrir el puerto.'
    fi
  else
    warn 'No se detectó UFW ni firewalld. Revisá el firewall manualmente.'
  fi
}

configure_local() {
  local port="$1"
  set_env \
    "PORT=$port" \
    'HOST=127.0.0.1' \
    'MCP_EXPOSURE_MODE=local' \
    'PUBLIC_BASE_URL=' \
    'MCP_PUBLIC_BASE_URL=' \
    'NGROK_URL=' \
    'NGROK_DOMAIN='
  PUBLIC_URL_RESULT="http://127.0.0.1:$port"
}

random_hex() {
  node - "${1:-32}" <<'NODE'
const crypto=require('crypto');
const bytes=Math.max(16,Math.min(128,Number(process.argv[2]||32)));
process.stdout.write(crypto.randomBytes(bytes).toString('hex'));
NODE
}

configure_auth() {
  local exposure="$1" public_url="$2" choice username password confirm bearer
  if [ "$exposure" = 'local' ]; then
    rm -f "$PRIVATE_DIR/bearer-token.txt" "$PRIVATE_DIR/oauth-state.json"
    set_env 'MCP_AUTH_MODE=none' 'MCP_AUTH_TOKEN=' 'MCP_AUTH_TOKEN_FILE=.private/bearer-token.txt' 'MCP_ALLOW_UNSAFE_NO_AUTH=0' 'MCP_ALLOW_INSECURE_HTTP_AUTH=0'
    AUTH_RESULT='none'
    return
  fi

  line
  echo ' SEGURIDAD DE ACCESO'
  line
  if is_https "$public_url"; then
    echo '  1) OAuth 2.1 (RECOMENDADO para ChatGPT y modo persistente)'
    echo '     ChatGPT abre una pantalla de autorización con usuario y contraseña.'
  else
    echo '  1) OAuth 2.1 (no disponible: la URL pública no usa HTTPS)'
  fi
  echo '  2) Token Bearer estático (compatibilidad avanzada)'
  echo '  3) Sin autenticación (sólo para pruebas temporales; riesgo alto)'
  echo
  choice="$(prompt_choice MCP_SETUP_AUTH_CHOICE 'Opción de autenticación' "$(is_https "$public_url" && echo 1 || echo 2)")"

  case "$choice" in
    1|oauth|OAUTH)
      is_https "$public_url" || { err 'OAuth no puede publicarse sobre HTTP. Elegí ngrok/HTTPS o token Bearer.'; exit 1; }
      username="$(prompt_text MCP_SETUP_OAUTH_USERNAME 'Usuario que usarás en la pantalla OAuth' 'admin')"
      password="$(prompt_secret MCP_SETUP_OAUTH_PASSWORD 'Contraseña OAuth nueva (mínimo 12 caracteres)')"
      if [ "$INTERACTIVE" = '1' ]; then
        confirm="$(prompt_secret MCP_SETUP_OAUTH_PASSWORD_CONFIRM 'Repetí la contraseña OAuth')"
      else
        confirm="${MCP_SETUP_OAUTH_PASSWORD_CONFIRM:-$password}"
      fi
      [ "$password" = "$confirm" ] || { err 'Las contraseñas OAuth no coinciden.'; exit 1; }
      printf '%s' "$password" | MCP_OAUTH_STORE="$PRIVATE_DIR/oauth-state.json" node oauth-admin.js configure --username "$username" --password-stdin
      unset password confirm MCP_SETUP_OAUTH_PASSWORD MCP_SETUP_OAUTH_PASSWORD_CONFIRM
      rm -f "$PRIVATE_DIR/bearer-token.txt"
      set_env \
        'MCP_AUTH_MODE=oauth' \
        'MCP_AUTH_TOKEN=' \
        'MCP_AUTH_TOKEN_FILE=.private/bearer-token.txt' \
        'MCP_OAUTH_STORE=.private/oauth-state.json' \
        'MCP_OAUTH_CIMD=0' \
        'MCP_OAUTH_CIMD_HOSTS=chatgpt.com' \
        'MCP_OAUTH_CIMD_TIMEOUT_MS=5000' \
        'MCP_OAUTH_CIMD_CACHE_TTL=21600' \
        'MCP_OAUTH_JWKS_CACHE_TTL=3600' \
        'MCP_OAUTH_PRIVATE_KEY_JWT=0' \
        'MCP_OAUTH_DYNAMIC_REGISTRATION=1' \
        'MCP_OAUTH_ACCESS_TOKEN_TTL=3600' \
        'MCP_OAUTH_REFRESH_TOKEN_TTL=2592000' \
        'MCP_ALLOW_UNSAFE_NO_AUTH=0' \
        'MCP_ALLOW_INSECURE_HTTP_AUTH=0'
      AUTH_RESULT='oauth'
      ;;
    2|bearer|BEARER)
      bearer="$(prompt_secret MCP_SETUP_BEARER_TOKEN 'Token Bearer; Enter genera uno seguro automáticamente')"
      local insecure_http=0
      if ! is_https "$public_url"; then
        warn 'Un token Bearer enviado por HTTP puede ser interceptado. ChatGPT normalmente exige HTTPS.'
        if [ "$INTERACTIVE" = '1' ]; then
          read -r -p 'Escribí ACEPTO HTTP INSEGURO para permitir únicamente el modo temporal: ' confirm
          [ "$confirm" = 'ACEPTO HTTP INSEGURO' ] || { err 'Configuración cancelada. Usá ngrok o una URL HTTPS.'; exit 1; }
        elif [ "${MCP_SETUP_ALLOW_INSECURE_HTTP_AUTH:-0}" != '1' ]; then
          err 'Bearer sobre HTTP requiere MCP_SETUP_ALLOW_INSECURE_HTTP_AUTH=1 en una automatización explícita.'
          exit 1
        fi
        insecure_http=1
      fi
      [ -n "$bearer" ] || bearer="$(random_hex 32)"
      [ "${#bearer}" -ge 32 ] || { err 'El token Bearer debe tener al menos 32 caracteres.'; exit 1; }
      rm -f "$PRIVATE_DIR/oauth-state.json"
      umask 077
      printf '%s\n' "$bearer" > "$PRIVATE_DIR/bearer-token.txt"
      chmod 600 "$PRIVATE_DIR/bearer-token.txt"
      set_env 'MCP_AUTH_MODE=bearer' 'MCP_AUTH_TOKEN=' 'MCP_AUTH_TOKEN_FILE=.private/bearer-token.txt' \
        'MCP_ALLOW_UNSAFE_NO_AUTH=0' "MCP_ALLOW_INSECURE_HTTP_AUTH=$insecure_http"
      unset bearer MCP_SETUP_BEARER_TOKEN
      AUTH_RESULT='bearer'
      ;;
    3|none|NONE)
      if [ "$INTERACTIVE" = '1' ]; then
        echo
        warn 'Cualquier persona que conozca la URL podrá usar las herramientas del MCP.'
        read -r -p 'Escribí SIN AUTENTICACION para confirmar: ' confirm
        [ "$confirm" = 'SIN AUTENTICACION' ] || { err 'Configuración cancelada.'; exit 1; }
      elif [ "${MCP_SETUP_ALLOW_UNSAFE:-0}" != '1' ]; then
        err 'El modo no autenticado no interactivo requiere MCP_SETUP_ALLOW_UNSAFE=1.'
        exit 1
      fi
      rm -f "$PRIVATE_DIR/bearer-token.txt" "$PRIVATE_DIR/oauth-state.json"
      set_env 'MCP_AUTH_MODE=none' 'MCP_AUTH_TOKEN=' 'MCP_AUTH_TOKEN_FILE=.private/bearer-token.txt' 'MCP_ALLOW_UNSAFE_NO_AUTH=1' 'MCP_ALLOW_INSECURE_HTTP_AUTH=0'
      AUTH_RESULT='none'
      ;;
    *) err "Opción de autenticación no válida: $choice"; exit 2 ;;
  esac
}

configure_tool_access() {
  local choice profile groups denylist
  line
  echo ' PERFIL DE HERRAMIENTAS'
  line
  echo 'Este perfil decide qué herramientas verá ChatGPT. No cambia los permisos del usuario del sistema.'
  echo
  echo '  1) SÓLO LECTURA Y OBSERVACIÓN'
  echo '     Archivos, estado del sistema, Git/tmux de consulta, red y capturas de pantalla.'
  echo '     No permite escribir, ejecutar comandos ni controlar teclado/mouse.'
  echo
  echo '  2) DESARROLLO (RECOMENDADO)'
  echo '     Lectura/escritura de proyectos, comandos, Git, tmux, red, contenedores y pantalla.'
  echo '     No publica cambios directos de servicios/firewall/montajes ni cámara/audio.'
  echo
  echo '  3) ADMINISTRACIÓN'
  echo '     Desarrollo más servicios, procesos, paquetes, firewall, montajes, teclado/mouse, cámara y audio.'
  echo '     No permite apagar o reiniciar el equipo mediante la herramienta dedicada.'
  echo
  echo '  4) CONTROL TOTAL'
  echo '     Publica todas las herramientas, incluida energía. Las acciones críticas exigen confirmación.'
  echo
  echo '  5) PERSONALIZADO'
  echo '     Elegís grupos y podés bloquear herramientas individuales.'
  echo
  choice="$(prompt_choice MCP_SETUP_PROFILE_CHOICE 'Perfil de herramientas' '2')"
  case "$choice" in
    1|read_only|readonly|lectura) profile='read_only'; groups='' ;;
    2|developer|dev|desarrollo) profile='developer'; groups='' ;;
    3|administrator|admin|administracion|administración) profile='administrator'; groups='' ;;
    4|full|total|completo) profile='full'; groups='' ;;
    5|custom|personalizado)
      profile='custom'
      echo
      echo 'Grupos disponibles:'
      node - <<'NODE'
const { GROUPS } = require('./access-policy');
for (const [name, description] of Object.entries(GROUPS)) console.log(`  ${name.padEnd(19)} ${description}`);
NODE
      echo 'Nota: git_write, tmux_write y containers necesitan command_execution para las acciones que ejecutan procesos.'
      groups="$(prompt_text MCP_SETUP_ACCESS_GROUPS 'Grupos habilitados, separados por coma' 'diagnostics,files_read,system_read')"
      node - "$groups" <<'NODE'
const { GROUPS, parseCsv } = require('./access-policy');
const unknown=parseCsv(process.argv[2]).filter((name)=>!Object.hasOwn(GROUPS,name));
if(unknown.length){console.error(`Grupos desconocidos: ${unknown.join(', ')}`);process.exit(1)}
if(!parseCsv(process.argv[2]).length){console.error('Elegí al menos un grupo.');process.exit(1)}
NODE
      ;;
    *) err "Perfil no válido: $choice"; exit 2 ;;
  esac

  denylist="$(prompt_text MCP_SETUP_TOOL_DENYLIST 'Herramientas individuales a bloquear (opcional, separadas por coma)' "$(read_env MCP_TOOL_DENYLIST)")"
  set_env \
    "MCP_ACCESS_PROFILE=$profile" \
    "MCP_ACCESS_GROUPS=$groups" \
    'MCP_TOOL_ALLOWLIST=' \
    "MCP_TOOL_DENYLIST=$denylist"

  case "$profile" in
    read_only|developer)
      set_env 'MCP_DESKTOP_ENABLED=1' 'MCP_INPUT_ENABLED=0'
      ;;
    administrator|full)
      set_env 'MCP_DESKTOP_ENABLED=1' 'MCP_INPUT_ENABLED=1'
      ;;
    custom)
      case ",$groups," in *,desktop_view,*|*,desktop_control,*) set_env 'MCP_DESKTOP_ENABLED=1' ;; *) set_env 'MCP_DESKTOP_ENABLED=0' ;; esac
      case ",$groups," in *,desktop_control,*) set_env 'MCP_INPUT_ENABLED=1' ;; *) set_env 'MCP_INPUT_ENABLED=0' ;; esac
      ;;
  esac
  ACCESS_PROFILE_RESULT="$profile"
}

configure_privilege_mode() {
  local choice confirm default_choice='1' repo_owner
  [ "$(read_env MCP_RUN_AS_ROOT)" = '1' ] && default_choice='2'
  repo_owner="$(stat -c '%U' "$ROOT_DIR" 2>/dev/null || id -un)"

  line
  echo ' CUENTA DEL SISTEMA'
  line
  echo '  1) USUARIO NORMAL / DUEÑO DEL REPOSITORIO (RECOMENDADO)'
  echo "     El MCP se ejecuta como ${repo_owner:-el usuario actual} y respeta sus permisos del sistema."
  echo
  echo '  2) ROOT (RIESGO MUY ALTO)'
  echo '     Puede leer y modificar archivos del sistema, paquetes, servicios, firewall y discos.'
  echo '     Una credencial OAuth robada o una instrucción equivocada puede comprometer todo el equipo.'
  echo '     Para un endpoint público persistente se exigirá OAuth + HTTPS salvo anulación experta.'
  echo
  choice="$(prompt_choice MCP_SETUP_PRIVILEGE_CHOICE 'Cuenta de ejecución' "$default_choice")"
  case "$choice" in
    1|user|usuario|normal)
      set_env 'MCP_RUN_AS_ROOT=0' 'MCP_SERVICE_USER='
      PRIVILEGE_RESULT='usuario normal'
      ;;
    2|root|ROOT)
      if [ "$INTERACTIVE" = '1' ]; then
        echo
        warn 'ROOT elimina la barrera de permisos del sistema. Usalo sólo en equipos propios y con OAuth.'
        read -r -p 'Escribí ACEPTO ROOT TOTAL para habilitarlo: ' confirm
        [ "$confirm" = 'ACEPTO ROOT TOTAL' ] || { err 'No se habilitó la ejecución como root.'; exit 1; }
      elif [ "${MCP_SETUP_ALLOW_ROOT:-0}" != '1' ] \
           && [ "${MCP_SETUP_ROOT_CONFIRM:-}" != 'ACEPTO ROOT TOTAL' ]; then
        err 'Root no interactivo requiere MCP_SETUP_ALLOW_ROOT=1 o MCP_SETUP_ROOT_CONFIRM="ACEPTO ROOT TOTAL".'
        exit 1
      fi
      if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
        err 'Se eligió root, pero sudo no está disponible. Ejecutá el instalador desde una terminal root o instalá sudo.'
        exit 1
      fi
      set_env 'MCP_RUN_AS_ROOT=1' 'MCP_SERVICE_USER=root'
      PRIVILEGE_RESULT='root'
      ;;
    *) err "Cuenta de ejecución no válida: $choice"; exit 2 ;;
  esac
}

configure_confirmation_mode() {
  local choice confirm default_choice='1'
  [ "$(read_env MCP_CRITICAL_CONFIRMATIONS)" = '0' ] && default_choice='2'

  line
  echo ' CONFIRMACIONES PARA ACCIONES CRÍTICAS'
  line
  echo '  1) ACTIVADAS (RECOMENDADO)'
  echo '     Borrado, paquetes, firewall, montajes, contenedores y energía exigen una frase explícita.'
  echo
  echo '  2) DESACTIVADAS (RIESGO MUY ALTO)'
  echo '     Las herramientas dedicadas ejecutan la acción sin pedir DELETE/APPLY/REBOOT.'
  echo '     Esto no agrega permisos: root o sudo siguen siendo necesarios para tareas administrativas.'
  echo
  choice="$(prompt_choice MCP_SETUP_CONFIRMATION_CHOICE 'Modo de confirmación' "$default_choice")"
  case "$choice" in
    1|on|yes|si|sí|activadas)
      set_env 'MCP_CRITICAL_CONFIRMATIONS=1'
      CONFIRMATION_RESULT='activadas'
      ;;
    2|off|no|desactivadas)
      if [ "$INTERACTIVE" = '1' ]; then
        echo
        warn 'Sin confirmaciones, una sola llamada puede borrar datos, cambiar el firewall o apagar el equipo.'
        read -r -p 'Escribí ACEPTO SIN CONFIRMACIONES para continuar: ' confirm
        [ "$confirm" = 'ACEPTO SIN CONFIRMACIONES' ] || { err 'Las confirmaciones permanecen activadas.'; exit 1; }
      elif [ "${MCP_SETUP_ALLOW_NO_CONFIRMATIONS:-0}" != '1' ] \
           && [ "${MCP_SETUP_NO_CONFIRMATIONS_CONFIRM:-}" != 'ACEPTO SIN CONFIRMACIONES' ]; then
        err 'Desactivar confirmaciones en modo no interactivo requiere MCP_SETUP_ALLOW_NO_CONFIRMATIONS=1.'
        exit 1
      fi
      set_env 'MCP_CRITICAL_CONFIRMATIONS=0'
      CONFIRMATION_RESULT='DESACTIVADAS'
      ;;
    *) err "Modo de confirmación no válido: $choice"; exit 2 ;;
  esac
}

configure_access_only() {
  [ -f "$ENV_FILE" ] || { err 'Primero completá la configuración inicial con bash start-mcp.sh.'; exit 1; }
  chmod 600 "$ENV_FILE"
  install -d -m 0700 "$PRIVATE_DIR" "$ROOT_DIR/.runtime"
  configure_tool_access
  configure_privilege_mode
  configure_confirmation_mode
  set_env 'MCP_SETUP_COMPLETE=1' 'MCP_SETUP_VERSION=6'
  line
  echo ' PERFIL DE HERRAMIENTAS ACTUALIZADO'
  line
  echo "Perfil: $ACCESS_PROFILE_RESULT"
  echo "Cuenta: $PRIVILEGE_RESULT"
  echo "Confirmaciones: $CONFIRMATION_RESULT"
  echo 'El cambio se aplicará al próximo inicio o reinicio del MCP.'
  echo 'Detalle: ./mcpctl.sh permissions --tools'
  line
}

main() {
  ensure_template
  local default_root access exposure port current_port
  default_root="$(cd .. && pwd -P)"
  current_port="$(read_env PORT)"
  port="$(prompt_text MCP_SETUP_PORT 'Puerto local del servidor MCP' "${current_port:-3000}")"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || { err 'Puerto no válido.'; exit 1; }

  line
  echo ' ASISTENTE INICIAL DEL SERVIDOR MCP'
  line
  echo 'Esta configuración se guarda sólo en .env y .private/, ambos fuera de Git.'
  echo
  echo 'Nivel de acceso del servidor:'
  echo '  1) RESTRINGIDO: únicamente las carpetas indicadas (recomendado)'
  echo '  2) FULL CONTROL: cualquier ruta permitida por el usuario del sistema'
  access="$(prompt_choice MCP_SETUP_ACCESS_CHOICE 'Opción de acceso' '1')"
  if [[ "$access" =~ ^(2|full|FULL)$ ]]; then
    set_env 'MCP_FULL_ACCESS=1' 'ALLOWED_PATHS=/' 'WORKING_DIR=/'
  else
    local allowed
    allowed="$(prompt_text MCP_SETUP_ALLOWED_PATHS 'Carpetas permitidas, separadas por coma' "$default_root")"
    set_env 'MCP_FULL_ACCESS=0' "ALLOWED_PATHS=$allowed" "WORKING_DIR=${allowed%%,*}"
  fi

  configure_tool_access
  configure_privilege_mode
  configure_confirmation_mode

  echo
  echo 'Cómo publicar el servidor:'
  echo '  1) NGROK (RECOMENDADO: HTTPS, funciona con CGNAT/IP dinámica y no abre el router)'
  echo '  2) IP pública o URL propia (requiere red, firewall y TLS bajo tu control)'
  echo '  3) Sólo local (ChatGPT Web no podrá conectarse)'
  exposure="$(prompt_choice MCP_SETUP_MODE_CHOICE 'Opción de publicación' '1')"
  case "$exposure" in
    1|ngrok|NGROK) exposure='ngrok'; configure_ngrok "$port" ;;
    2|direct|DIRECT) exposure='direct'; configure_direct "$port" ;;
    3|local|LOCAL) exposure='local'; configure_local "$port" ;;
    *) err "Opción de publicación no válida: $exposure"; exit 2 ;;
  esac

  configure_auth "$exposure" "$PUBLIC_URL_RESULT"
  set_env \
    'MCP_SETUP_COMPLETE=1' \
    'MCP_SETUP_VERSION=6' \
    'MCP_FAST_MODE=1' \
    'MCP_HUMAN_LOG=.runtime/events.log' \
    'ACTIVITY_LOG=.runtime/activity.ndjson' \
    'MCP_ERROR_LOG=.runtime/errors.log'

  [ "$exposure" != 'direct' ] || apply_direct_firewall "$port"

  line
  echo ' CONFIGURACIÓN GUARDADA'
  line
  if [ "$exposure" = 'local' ]; then
    echo "Servidor local: $PUBLIC_URL_RESULT/mcp"
  else
    echo "URL para ChatGPT: $PUBLIC_URL_RESULT/mcp"
  fi
  echo "Perfil de herramientas: $ACCESS_PROFILE_RESULT"
  echo "Cuenta de ejecución: $PRIVILEGE_RESULT"
  echo "Confirmaciones críticas: $CONFIRMATION_RESULT"
  case "$AUTH_RESULT" in
    oauth) echo 'Autenticación: OAuth 2.1. ChatGPT mostrará la pantalla de autorización.' ;;
    bearer) echo "Autenticación: Bearer. Token privado: $PRIVATE_DIR/bearer-token.txt" ;;
    none) echo 'Autenticación: ninguna. Usar sólo con plena conciencia del riesgo.' ;;
  esac
  echo 'La configuración ya persiste; no hace falta abrir una segunda terminal.'
  echo 'Guía de ChatGPT: ./mcpctl.sh chatgpt'
  line
}

case "${1:-}" in
  --access-only|--permissions-only) configure_access_only ;;
  *) main "$@" ;;
esac
