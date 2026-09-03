#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[AVISO] %s\n' "$*" >&2; }
err() { printf '[ERROR] %s\n' "$*" >&2; }

restore_private_owner() {
  local uid gid owner root_dir
  [ "$(id -u)" -eq 0 ] || return 0
  root_dir="$(pwd -P)"
  uid="${MCP_REPO_OWNER_UID:-}"; gid="${MCP_REPO_OWNER_GID:-}"
  if ! [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]]; then
    owner="${SUDO_USER:-$(stat -c '%U' "$root_dir" 2>/dev/null || echo root)}"
    id "$owner" >/dev/null 2>&1 || return 0
    uid="$(id -u "$owner")"; gid="$(id -g "$owner")"
  fi
  [ "$uid" != '0' ] || return 0
  [ ! -e .env ] || chown -h "$uid:$gid" .env 2>/dev/null || true
  for directory in .private .runtime; do
    [ ! -e "$directory" ] || chown -R -h "$uid:$gid" "$directory" 2>/dev/null || true
  done
}
trap restore_private_owner EXIT

chmod +x ./install-deps.sh ./install-ngrok.sh ./configure-mcp.sh ./oauth-admin.js ./log-viewer.js ./startup-banner.js 2>/dev/null || true
install -d -m 0700 .runtime .private

read_config() {
  local key="$1" fallback="${2:-}" line value
  if [ -f .env ]; then
    line="$(grep -m1 -E "^${key}=" .env 2>/dev/null || true)"
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
    return 0
  fi
  printf '%s' "$fallback"
}

dependency_fingerprint() {
  {
    printf 'platform=%s\n' "$(uname -srm 2>/dev/null || true)"
    for file in install-deps.sh package.json package-lock.json; do
      [ -f "$file" ] && cksum "$file"
    done
    for command in node npm git curl python3; do
      printf '%s=' "$command"
      command -v "$command" 2>/dev/null || true
      printf '\n'
    done
    node --version 2>/dev/null || true
  } | cksum | awk '{print $1":"$2}'
}

ensure_dependencies() {
  local stamp=.runtime/dependencies.ready fingerprint
  fingerprint="$(dependency_fingerprint)"
  if [ "${MCP_FORCE_DEPENDENCY_CHECK:-0}" != '1' ] && [ -f "$stamp" ] \
     && grep -Fxq "$fingerprint" "$stamp" \
     && command -v node >/dev/null 2>&1 \
     && command -v npm >/dev/null 2>&1 \
     && command -v git >/dev/null 2>&1 \
     && command -v curl >/dev/null 2>&1 \
     && command -v python3 >/dev/null 2>&1; then
    [ "${MCP_SETUP_QUIET:-0}" = '1' ] || info 'Dependencias ya verificadas; se omite la comprobación completa.'
    return 0
  fi
  ./install-deps.sh
  fingerprint="$(dependency_fingerprint)"
  printf '%s\n' "$fingerprint" > "$stamp"
  chmod 600 "$stamp"
}

ensure_dependencies

read_secret_file() {
  local configured="$1" file
  [ -n "$configured" ] || return 0
  if [[ "$configured" = /* ]]; then file="$configured"; else file="$PWD/$configured"; fi
  [ -f "$file" ] || return 0
  tr -d '\r\n' <"$file"
}

set_config() {
  python3 - .env "$@" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); updates={item.split('=',1)[0]:item.split('=',1)[1] for item in sys.argv[2:]}
lines=p.read_text().splitlines() if p.exists() else []; out=[]; seen=set()
for line in lines:
    if line.strip() and not line.lstrip().startswith('#') and '=' in line:
        key=line.split('=',1)[0].strip()
        if key in updates:
            out.append(f'{key}={updates[key]}'); seen.add(key); continue
    out.append(line)
for key,value in updates.items():
    if key not in seen: out.append(f'{key}={value}')
p.write_text('\n'.join(out).rstrip()+'\n'); p.chmod(0o600)
PY
}

migrate_existing_config() {
  local auth_mode public_base mode token access_profile run_as_root service_user critical_confirmations
  mode="$(read_config MCP_EXPOSURE_MODE ngrok)"
  token="$(read_config MCP_AUTH_TOKEN '')"
  auth_mode="$(read_config MCP_AUTH_MODE '')"
  access_profile="$(read_config MCP_ACCESS_PROFILE '')"
  [ -n "$access_profile" ] || access_profile='full'
  run_as_root="$(read_config MCP_RUN_AS_ROOT 0)"
  service_user="$(read_config MCP_SERVICE_USER '')"
  critical_confirmations="$(read_config MCP_CRITICAL_CONFIRMATIONS 1)"
  [ "$run_as_root" = '1' ] && service_user='root'
  if [ -z "$auth_mode" ]; then
    if [ -n "$token" ]; then auth_mode='bearer'; else auth_mode='none'; fi
  fi
  public_base="$(read_config MCP_PUBLIC_BASE_URL '')"
  if [ -z "$public_base" ]; then
    if [ "$mode" = 'ngrok' ]; then public_base="$(read_config NGROK_URL "$(read_config NGROK_DOMAIN '')")"; fi
    if [ "$mode" = 'direct' ]; then public_base="$(read_config PUBLIC_BASE_URL '')"; fi
  fi
  if [ "$auth_mode" = 'bearer' ] && [ -n "$token" ]; then
    umask 077
    printf '%s\n' "$token" > .private/bearer-token.txt
    chmod 600 .private/bearer-token.txt
    token=''
  fi
  set_config \
    "MCP_AUTH_MODE=$auth_mode" \
    "MCP_ACCESS_PROFILE=$access_profile" \
    'MCP_ACCESS_GROUPS=' \
    'MCP_TOOL_ALLOWLIST=' \
    'MCP_TOOL_DENYLIST=' \
    "MCP_RUN_AS_ROOT=$run_as_root" \
    "MCP_SERVICE_USER=$service_user" \
    "MCP_CRITICAL_CONFIRMATIONS=$critical_confirmations" \
    "MCP_AUTH_TOKEN=$token" \
    'MCP_AUTH_TOKEN_FILE=.private/bearer-token.txt' \
    "MCP_PUBLIC_BASE_URL=$public_base" \
    'MCP_SETUP_COMPLETE=1' \
    'MCP_SETUP_VERSION=6' \
    'MCP_HUMAN_LOG=.runtime/events.log' \
    'ACTIVITY_LOG=.runtime/activity.ndjson'
  if [ "$auth_mode" = 'none' ] && [ "$mode" != 'local' ]; then
    set_config 'MCP_ALLOW_UNSAFE_NO_AUTH=1'
    warn 'Se conservó la instalación existente sin autenticación. Ejecutá ./mcpctl.sh configure para activar OAuth.'
  fi
}

if [ ! -f .env ] || [ "${MCP_FORCE_SETUP:-0}" = '1' ] || [ "${1:-}" = '--reconfigure' ]; then
  ./configure-mcp.sh
else
  chmod 600 .env
  SETUP_MARKER="$(read_config MCP_SETUP_COMPLETE '')"
  SETUP_VERSION="$(read_config MCP_SETUP_VERSION 0)"
  ACCESS_PROFILE_MARKER="$(read_config MCP_ACCESS_PROFILE '')"
  ROOT_MODE_MARKER="$(read_config MCP_RUN_AS_ROOT '')"
  CONFIRMATION_MARKER="$(read_config MCP_CRITICAL_CONFIRMATIONS '')"
  if [ "$SETUP_MARKER" = '0' ]; then
    info 'El archivo .env existe, pero la configuración inicial todavía no fue completada.'
    ./configure-mcp.sh
  elif [ -z "$SETUP_MARKER" ] || ! [[ "$SETUP_VERSION" =~ ^[0-9]+$ ]] \
       || [ "$SETUP_VERSION" -lt 6 ] || [ -z "$ACCESS_PROFILE_MARKER" ] \
       || [ -z "$ROOT_MODE_MARKER" ] || [ -z "$CONFIRMATION_MARKER" ]; then
    info 'Actualizando la configuración existente al nuevo formato sin cambiar el acceso anterior.'
    migrate_existing_config
  fi
fi

MODE="$(read_config MCP_EXPOSURE_MODE ngrok)"
AUTH_MODE="$(read_config MCP_AUTH_MODE none)"
ACCESS_PROFILE="$(read_config MCP_ACCESS_PROFILE developer)"
RUN_AS_ROOT="$(read_config MCP_RUN_AS_ROOT 0)"
CRITICAL_CONFIRMATIONS="$(read_config MCP_CRITICAL_CONFIRMATIONS 1)"
FULL_ACCESS="$(read_config MCP_FULL_ACCESS 0)"
PUBLIC_URL="$(read_config MCP_PUBLIC_BASE_URL '')"
case "$RUN_AS_ROOT" in 0|1) ;; *) err 'MCP_RUN_AS_ROOT debe ser 0 o 1.'; exit 1 ;; esac
case "$CRITICAL_CONFIRMATIONS" in 0|1) ;; *) err 'MCP_CRITICAL_CONFIRMATIONS debe ser 0 o 1.'; exit 1 ;; esac
if [ "$RUN_AS_ROOT" = '1' ] && [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
  err 'La configuración solicita root, pero sudo no está disponible.'
  exit 1
fi
node - <<'NODE'
const { parseDotEnv } = require('./runtime-diagnostics');
const { createAccessPolicy } = require('./access-policy');
const fileEnv = parseDotEnv();
const filePriority = String(process.env.MCP_CONFIG_SOURCE || '').toLowerCase() === 'file';
createAccessPolicy(filePriority ? { ...process.env, ...fileEnv } : { ...fileEnv, ...process.env });
NODE

if [ "$MODE" = 'ngrok' ]; then
  NGROK_BIN_VALUE="$(read_config NGROK_BIN '')"
  [ -n "$NGROK_BIN_VALUE" ] || NGROK_BIN_VALUE="$(command -v ngrok 2>/dev/null || true)"
  if [ -z "$NGROK_BIN_VALUE" ] || [ ! -x "$NGROK_BIN_VALUE" ]; then
    err 'ngrok está seleccionado pero no se encuentra instalado. Ejecutá ./mcpctl.sh configure.'
    exit 1
  fi
  NGROK_CONFIG_VALUE="$(read_config NGROK_CONFIG '')"
  if [ -n "$NGROK_CONFIG_VALUE" ]; then
    "$NGROK_BIN_VALUE" config check --config "$NGROK_CONFIG_VALUE" >/dev/null 2>&1 || {
      err 'La configuración privada de ngrok no es válida. Ejecutá ./mcpctl.sh configure.'
      exit 1
    }
  else
    "$NGROK_BIN_VALUE" config check >/dev/null 2>&1 || {
      err 'ngrok no tiene un authtoken válido. Ejecutá ./mcpctl.sh configure.'
      exit 1
    }
  fi
fi

if [ "$AUTH_MODE" = 'oauth' ]; then
  [ -n "$PUBLIC_URL" ] || { err 'OAuth requiere una URL pública estable. Ejecutá ./mcpctl.sh configure.'; exit 1; }
  case "$PUBLIC_URL" in https://*) ;; *) err 'OAuth requiere HTTPS. Elegí ngrok o una URL HTTPS propia.'; exit 1 ;; esac
  node oauth-admin.js status | grep -q 'Configurado: sí' || {
    err 'OAuth está seleccionado pero todavía no tiene usuario/contraseña. Ejecutá ./mcpctl.sh configure.'
    exit 1
  }
elif [ "$AUTH_MODE" = 'bearer' ]; then
  BEARER_VALUE="$(read_config MCP_AUTH_TOKEN '')"
  if [ -z "$BEARER_VALUE" ]; then
    BEARER_VALUE="$(read_secret_file "$(read_config MCP_AUTH_TOKEN_FILE '.private/bearer-token.txt')")"
  fi
  [ -n "$BEARER_VALUE" ] || { err 'El modo Bearer no tiene token configurado.'; exit 1; }
  [ "${#BEARER_VALUE}" -ge 32 ] || { err 'El token Bearer anterior es demasiado corto. Ejecutá ./mcpctl.sh configure para generar uno seguro.'; exit 1; }
  if [ "$MODE" != 'local' ] && [[ "$PUBLIC_URL" = http://* ]] \
     && [ "$(read_config MCP_ALLOW_INSECURE_HTTP_AUTH 0)" != '1' ]; then
    err 'Bearer sobre HTTP está bloqueado porque el token viajaría sin cifrado. Usá ngrok/HTTPS o reconfigurá explícitamente para una prueba temporal.'
    exit 1
  fi
elif [ "$AUTH_MODE" = 'none' ] && [ "$MODE" != 'local' ]; then
  [ "$(read_config MCP_ALLOW_UNSAFE_NO_AUTH 0)" = '1' ] || { err 'Publicar sin autenticación requiere reconfigurar y confirmar el riesgo.'; exit 1; }
  warn 'El servidor se publicará sin autenticación. No lo dejes activo permanentemente salvo que sea una decisión explícita.'
fi

info "Preparación completa: exposición=$MODE, autenticación=$AUTH_MODE, perfil=$ACCESS_PROFILE, full_access=$FULL_ACCESS, root=$RUN_AS_ROOT, confirmaciones=$CRITICAL_CONFIRMATIONS"
