#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"
TEST_ROOT="$(mktemp -d /tmp/mcp-first-run-test.XXXXXX)"
cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

mkdir -p "$TEST_ROOT/repo" "$TEST_ROOT/bin" "$TEST_ROOT/allowed"
cp -a . "$TEST_ROOT/repo/"
rm -rf "$TEST_ROOT/repo/.git" "$TEST_ROOT/repo/.env" "$TEST_ROOT/repo/.private" "$TEST_ROOT/repo/.runtime"

API_PORT="$(python3 - <<'PY'
import socket
s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()
PY
)"
MCP_PORT="$(python3 - <<'PY'
import socket
s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()
PY
)"

cat >"$TEST_ROOT/bin/ngrok" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  version)
    echo 'ngrok version test'
    ;;
  config)
    case "${2:-}" in
      add-authtoken)
        TOKEN="${3:-}"
        CONFIG=''
        shift 3
        while [ "$#" -gt 0 ]; do
          case "$1" in --config) CONFIG="$2"; shift 2 ;; *) shift ;; esac
        done
        mkdir -p "$(dirname "$CONFIG")"
        printf 'version: 3\nauthtoken: %s\n' "$TOKEN" >"$CONFIG"
        chmod 600 "$CONFIG"
        ;;
      check)
        exit 0
        ;;
      *) exit 2 ;;
    esac
    ;;
  http)
    TARGET="${2:-http://127.0.0.1:3000}"
    URL='https://example-device.ngrok.dev'
    shift 2
    while [ "$#" -gt 0 ]; do
      case "$1" in --url) URL="$2"; shift 2 ;; *) shift ;; esac
    done
    exec python3 - "$TARGET" "$URL" "${MCP_NGROK_API_PORT:?}" <<'PY'
import json,sys
from http.server import BaseHTTPRequestHandler,HTTPServer
target,url,port=sys.argv[1],sys.argv[2],int(sys.argv[3])
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body=json.dumps({'tunnels':[{'name':'test','proto':'https','public_url':url,'config':{'addr':target}}]}).encode()
        self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self,*args): pass
HTTPServer(('127.0.0.1',port),H).serve_forever()
PY
    ;;
  *) exit 2 ;;
esac
FAKE
chmod +x "$TEST_ROOT/bin/ngrok"

TOKEN='TEST_AUTHTOKEN_DO_NOT_PUBLISH_123456789'
PASSWORD='Prueba-OAuth-Instalador-2026'
OUTPUT="$TEST_ROOT/setup.out"
(
  cd "$TEST_ROOT/repo"
  PATH="$TEST_ROOT/bin:$PATH" \
  MCP_SETUP_NONINTERACTIVE=1 \
  MCP_SETUP_PORT="$MCP_PORT" \
  MCP_SETUP_ACCESS_CHOICE=1 \
  MCP_SETUP_ALLOWED_PATHS="$TEST_ROOT/allowed" \
  MCP_SETUP_PROFILE_CHOICE=2 \
  MCP_SETUP_MODE_CHOICE=1 \
  MCP_SETUP_NGROK_TOKEN="$TOKEN" \
  MCP_SETUP_NGROK_URL='https://example-device.ngrok.dev' \
  MCP_SETUP_IGNORE_RUNNING_NGROK=1 \
  MCP_SETUP_AUTH_CHOICE=1 \
  MCP_SETUP_OAUTH_USERNAME='tester' \
  MCP_SETUP_OAUTH_PASSWORD="$PASSWORD" \
  MCP_SETUP_OAUTH_PASSWORD_CONFIRM="$PASSWORD" \
  MCP_NGROK_API_PORT="$API_PORT" \
  MCP_NGROK_API_URL="http://127.0.0.1:$API_PORT/api/tunnels" \
  ./configure-mcp.sh >"$OUTPUT" 2>&1
)

ENV_FILE="$TEST_ROOT/repo/.env"
PRIVATE="$TEST_ROOT/repo/.private"
grep -Fxq 'MCP_SETUP_COMPLETE=1' "$ENV_FILE"
grep -Fxq 'MCP_EXPOSURE_MODE=ngrok' "$ENV_FILE"
grep -Fxq 'NGROK_URL=https://example-device.ngrok.dev' "$ENV_FILE"
grep -Fxq 'MCP_PUBLIC_BASE_URL=https://example-device.ngrok.dev' "$ENV_FILE"
grep -Fxq 'MCP_AUTH_MODE=oauth' "$ENV_FILE"
grep -Fxq 'MCP_ACCESS_PROFILE=developer' "$ENV_FILE"
grep -Fxq 'MCP_ACCESS_GROUPS=' "$ENV_FILE"
grep -Fxq 'MCP_DESKTOP_ENABLED=1' "$ENV_FILE"
grep -Fxq 'MCP_INPUT_ENABLED=0' "$ENV_FILE"
grep -Fxq 'MCP_AUTH_TOKEN=' "$ENV_FILE"
grep -q "^NGROK_BIN=$TEST_ROOT/bin/ngrok$" "$ENV_FILE"
grep -Fxq 'NGROK_CONFIG=.private/ngrok.yml' "$ENV_FILE"
[ "$(stat -c %a "$ENV_FILE")" = 600 ]
[ "$(stat -c %a "$PRIVATE/ngrok.yml")" = 600 ]
[ "$(stat -c %a "$PRIVATE/oauth-state.json")" = 600 ]

grep -Fq "$TOKEN" "$PRIVATE/ngrok.yml"
! grep -Fq "$TOKEN" "$ENV_FILE"
! grep -Fq "$TOKEN" "$OUTPUT"
! grep -Fq "$PASSWORD" "$PRIVATE/oauth-state.json"
! grep -Fq "$PASSWORD" "$OUTPUT"
node -e 'const s=require(process.argv[1]); if(!s.admin || s.admin.username!=="tester" || !String(s.admin.passwordHash||"").startsWith("scrypt$")) process.exit(1)' "$PRIVATE/oauth-state.json"

echo 'first_run_ngrok_oauth=OK'

printf '\n== ChatGPT setup guide ==\n'
GUIDE_OUTPUT="$(
  cd "$TEST_ROOT/repo"
  env -i HOME="$HOME" USER="$(id -un)" PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    node chatgpt-guide.js
)"
grep -q 'Modo desarrollador' <<<"$GUIDE_OUTPUT"
grep -q 'Configuración → Apps → Configuración avanzada' <<<"$GUIDE_OUTPUT"
grep -q 'Complementos → Explorar complementos → Agregar' <<<"$GUIDE_OUTPUT"
grep -q 'Escanear herramientas / Scan tools' <<<"$GUIDE_OUTPUT"
grep -q 'https://example-device.ngrok.dev/mcp' <<<"$GUIDE_OUTPUT"
grep -q 'Autenticación: elegí OAuth' <<<"$GUIDE_OUTPUT"
! grep -Fq "$TOKEN" <<<"$GUIDE_OUTPUT"
! grep -Fq "$PASSWORD" <<<"$GUIDE_OUTPUT"
echo 'chatgpt_guide=OK'

printf '\n== direct exposure + bearer ==\n'
mkdir -p "$TEST_ROOT/direct-repo" "$TEST_ROOT/direct-allowed"
cp -a . "$TEST_ROOT/direct-repo/"
rm -rf "$TEST_ROOT/direct-repo/.git" "$TEST_ROOT/direct-repo/.env" "$TEST_ROOT/direct-repo/.private" "$TEST_ROOT/direct-repo/.runtime"
DIRECT_OUTPUT="$TEST_ROOT/direct.out"
(
  cd "$TEST_ROOT/direct-repo"
  MCP_SETUP_NONINTERACTIVE=1 \
  MCP_SETUP_PORT=43123 \
  MCP_SETUP_ACCESS_CHOICE=1 \
  MCP_SETUP_ALLOWED_PATHS="$TEST_ROOT/direct-allowed" \
  MCP_SETUP_PROFILE_CHOICE=2 \
  MCP_SETUP_MODE_CHOICE=2 \
  MCP_SETUP_PUBLIC_IP=198.51.100.10 \
  MCP_SETUP_DIRECT_URL=https://direct-device.example \
  MCP_SETUP_OPEN_FIREWALL=2 \
  MCP_SETUP_AUTH_CHOICE=2 \
  ./configure-mcp.sh >"$DIRECT_OUTPUT" 2>&1
)
DIRECT_ENV="$TEST_ROOT/direct-repo/.env"
DIRECT_PRIVATE="$TEST_ROOT/direct-repo/.private"
grep -Fxq 'HOST=0.0.0.0' "$DIRECT_ENV"
grep -Fxq 'PORT=43123' "$DIRECT_ENV"
grep -Fxq 'MCP_EXPOSURE_MODE=direct' "$DIRECT_ENV"
grep -Fxq 'PUBLIC_BASE_URL=https://direct-device.example' "$DIRECT_ENV"
grep -Fxq 'MCP_PUBLIC_BASE_URL=https://direct-device.example' "$DIRECT_ENV"
grep -Fxq 'MCP_AUTH_MODE=bearer' "$DIRECT_ENV"
grep -Fxq 'MCP_ACCESS_PROFILE=developer' "$DIRECT_ENV"
grep -Fxq 'MCP_AUTH_TOKEN=' "$DIRECT_ENV"
grep -Fxq 'MCP_AUTH_TOKEN_FILE=.private/bearer-token.txt' "$DIRECT_ENV"
DIRECT_TOKEN="$(cat "$DIRECT_PRIVATE/bearer-token.txt")"
[ "${#DIRECT_TOKEN}" -ge 64 ]
! grep -Fq "$DIRECT_TOKEN" "$DIRECT_ENV"
! grep -Fq "$DIRECT_TOKEN" "$DIRECT_OUTPUT"
echo 'first_run_direct_bearer=OK'

printf '\n== access-only reconfiguration preserves connection/auth ==\n'
DIRECT_TOKEN_BEFORE="$(cat "$DIRECT_PRIVATE/bearer-token.txt")"
(
  cd "$TEST_ROOT/direct-repo"
  MCP_SETUP_NONINTERACTIVE=1 \
  MCP_SETUP_PROFILE_CHOICE=1 \
  MCP_SETUP_TOOL_DENYLIST='' \
  MCP_SERVICE_NAME=mcp-access-only-test.service ./mcpctl.sh permissions-set >"$TEST_ROOT/access-only.out" 2>&1
)
grep -Fxq 'MCP_ACCESS_PROFILE=read_only' "$DIRECT_ENV"
grep -Fxq 'MCP_AUTH_MODE=bearer' "$DIRECT_ENV"
grep -Fxq 'MCP_PUBLIC_BASE_URL=https://direct-device.example' "$DIRECT_ENV"
[ "$(cat "$DIRECT_PRIVATE/bearer-token.txt")" = "$DIRECT_TOKEN_BEFORE" ]
! grep -Fq "$DIRECT_TOKEN_BEFORE" "$TEST_ROOT/access-only.out"
echo 'access_only_reconfigure=OK'

printf '\n== custom tool profile ==\n'
mkdir -p "$TEST_ROOT/custom-repo" "$TEST_ROOT/custom-allowed"
cp -a . "$TEST_ROOT/custom-repo/"
rm -rf "$TEST_ROOT/custom-repo/.git" "$TEST_ROOT/custom-repo/.env" "$TEST_ROOT/custom-repo/.private" "$TEST_ROOT/custom-repo/.runtime"
(
  cd "$TEST_ROOT/custom-repo"
  MCP_SETUP_NONINTERACTIVE=1 \
  MCP_SETUP_PORT=43125 \
  MCP_SETUP_ACCESS_CHOICE=1 \
  MCP_SETUP_ALLOWED_PATHS="$TEST_ROOT/custom-allowed" \
  MCP_SETUP_PROFILE_CHOICE=5 \
  MCP_SETUP_ACCESS_GROUPS='diagnostics,files_read,files_write,desktop_view' \
  MCP_SETUP_TOOL_DENYLIST='write_file' \
  MCP_SETUP_MODE_CHOICE=3 \
  ./configure-mcp.sh >"$TEST_ROOT/custom.out" 2>&1
)
CUSTOM_ENV="$TEST_ROOT/custom-repo/.env"
grep -Fxq 'MCP_ACCESS_PROFILE=custom' "$CUSTOM_ENV"
grep -Fxq 'MCP_ACCESS_GROUPS=diagnostics,files_read,files_write,desktop_view' "$CUSTOM_ENV"
grep -Fxq 'MCP_TOOL_DENYLIST=write_file' "$CUSTOM_ENV"
grep -Fxq 'MCP_DESKTOP_ENABLED=1' "$CUSTOM_ENV"
grep -Fxq 'MCP_INPUT_ENABLED=0' "$CUSTOM_ENV"
CUSTOM_TOOLS="$(
  cd "$TEST_ROOT/custom-repo"
  env -i HOME="$HOME" USER="$(id -un)" PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    node - <<'NODE'
const { spawnSync } = require('child_process');
const request={jsonrpc:'2.0',id:1,method:'tools/list',params:{}};
const result=spawnSync(process.execPath,['mcp-server.js','--stdio'],{input:JSON.stringify(request)+'\n',encoding:'utf8'});
if(result.status!==0){process.stderr.write(result.stderr);process.exit(result.status||1)}
const names=JSON.parse(result.stdout.trim()).result.tools.map((tool)=>tool.name);
process.stdout.write(names.join('\n'));
NODE
)"
grep -Fxq 'tool_policy_status' <<<"$CUSTOM_TOOLS"
grep -Fxq 'read_file' <<<"$CUSTOM_TOOLS"
grep -Fxq 'patch_file' <<<"$CUSTOM_TOOLS"
! grep -Fxq 'write_file' <<<"$CUSTOM_TOOLS"
! grep -Fxq 'run_command' <<<"$CUSTOM_TOOLS"
echo 'custom_tool_profile=OK'

printf '\n== legacy configuration migration ==\n'
mkdir -p "$TEST_ROOT/legacy-repo" "$TEST_ROOT/legacy-allowed" "$TEST_ROOT/legacy-private"
cp -a . "$TEST_ROOT/legacy-repo/"
rm -rf "$TEST_ROOT/legacy-repo/.git" "$TEST_ROOT/legacy-repo/.env" "$TEST_ROOT/legacy-repo/.private" "$TEST_ROOT/legacy-repo/.runtime"
printf 'version: 3\nauthtoken: legacy-test-only\n' >"$TEST_ROOT/legacy-private/ngrok.yml"
chmod 600 "$TEST_ROOT/legacy-private/ngrok.yml"
cat >"$TEST_ROOT/legacy-repo/.env" <<EOF_LEGACY
PORT=39011
HOST=127.0.0.1
ALLOWED_PATHS=$TEST_ROOT/legacy-allowed
WORKING_DIR=$TEST_ROOT/legacy-allowed
MCP_FULL_ACCESS=0
MCP_EXPOSURE_MODE=ngrok
NGROK_BIN=$TEST_ROOT/bin/ngrok
NGROK_CONFIG=$TEST_ROOT/legacy-private/ngrok.yml
NGROK_URL=https://legacy-device.example
PUBLIC_BASE_URL=
MCP_AUTH_TOKEN=
EOF_LEGACY
chmod 600 "$TEST_ROOT/legacy-repo/.env"
LEGACY_OUTPUT="$TEST_ROOT/legacy.out"
(
  cd "$TEST_ROOT/legacy-repo"
  env -i HOME="$HOME" USER="$(id -un)" \
    PATH="$TEST_ROOT/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    MCP_INSTALL_OPTIONAL=0 MCP_SETUP_QUIET=1 \
    ./setup-mcp.sh >"$LEGACY_OUTPUT" 2>&1
)
LEGACY_ENV="$TEST_ROOT/legacy-repo/.env"
grep -Fxq 'MCP_SETUP_COMPLETE=1' "$LEGACY_ENV"
grep -Fxq 'MCP_SETUP_VERSION=5' "$LEGACY_ENV"
grep -Fxq 'MCP_AUTH_MODE=none' "$LEGACY_ENV"
grep -Fxq 'MCP_ACCESS_PROFILE=full' "$LEGACY_ENV"
grep -Fxq 'MCP_AUTH_TOKEN_FILE=.private/bearer-token.txt' "$LEGACY_ENV"
grep -Fxq 'MCP_ALLOW_UNSAFE_NO_AUTH=1' "$LEGACY_ENV"
grep -Fxq 'MCP_PUBLIC_BASE_URL=https://legacy-device.example' "$LEGACY_ENV"
grep -Fxq "ALLOWED_PATHS=$TEST_ROOT/legacy-allowed" "$LEGACY_ENV"
! grep -q 'ASISTENTE INICIAL' "$LEGACY_OUTPUT"
echo 'legacy_migration=OK'

printf '\n== v4 incremental access-profile migration ==\n'
mkdir -p "$TEST_ROOT/v4-repo" "$TEST_ROOT/v4-allowed"
cp -a . "$TEST_ROOT/v4-repo/"
rm -rf "$TEST_ROOT/v4-repo/.git" "$TEST_ROOT/v4-repo/.env" "$TEST_ROOT/v4-repo/.private" "$TEST_ROOT/v4-repo/.runtime"
cat >"$TEST_ROOT/v4-repo/.env" <<EOF_V4
MCP_SETUP_COMPLETE=1
MCP_SETUP_VERSION=4
PORT=43126
HOST=127.0.0.1
ALLOWED_PATHS=$TEST_ROOT/v4-allowed
WORKING_DIR=$TEST_ROOT/v4-allowed
MCP_FULL_ACCESS=0
MCP_EXPOSURE_MODE=local
MCP_PUBLIC_BASE_URL=
MCP_AUTH_MODE=none
MCP_AUTH_TOKEN=
MCP_ALLOW_UNSAFE_NO_AUTH=0
EOF_V4
chmod 600 "$TEST_ROOT/v4-repo/.env"
(
  cd "$TEST_ROOT/v4-repo"
  env -i HOME="$HOME" USER="$(id -un)" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    MCP_INSTALL_OPTIONAL=0 MCP_SETUP_QUIET=1 ./setup-mcp.sh >"$TEST_ROOT/v4.out" 2>&1
)
grep -Fxq 'MCP_SETUP_VERSION=5' "$TEST_ROOT/v4-repo/.env"
grep -Fxq 'MCP_ACCESS_PROFILE=full' "$TEST_ROOT/v4-repo/.env"
! grep -q 'ASISTENTE INICIAL' "$TEST_ROOT/v4.out"
echo 'v4_access_profile_migration=OK'

printf '\n== configure refuses an active temporary runtime ==\n'
mkdir -p "$TEST_ROOT/active-repo" "$TEST_ROOT/active-allowed"
cp -a . "$TEST_ROOT/active-repo/"
rm -rf "$TEST_ROOT/active-repo/.git" "$TEST_ROOT/active-repo/.env" "$TEST_ROOT/active-repo/.private" "$TEST_ROOT/active-repo/.runtime"
ACTIVE_PORT="$(python3 - <<'PY'
import socket
s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()
PY
)"
cat >"$TEST_ROOT/active-repo/.env" <<EOF_ACTIVE
MCP_SETUP_COMPLETE=1
MCP_SETUP_VERSION=5
PORT=$ACTIVE_PORT
HOST=127.0.0.1
ALLOWED_PATHS=$TEST_ROOT/active-allowed
WORKING_DIR=$TEST_ROOT/active-allowed
MCP_FULL_ACCESS=0
MCP_ACCESS_PROFILE=developer
MCP_EXPOSURE_MODE=local
MCP_PUBLIC_BASE_URL=
MCP_AUTH_MODE=none
MCP_AUTH_TOKEN=
MCP_ALLOW_UNSAFE_NO_AUTH=0
MCP_HUMAN_LOG=.runtime/events.log
ACTIVITY_LOG=.runtime/activity.ndjson
MCP_ERROR_LOG=.runtime/errors.log
EOF_ACTIVE
chmod 600 "$TEST_ROOT/active-repo/.env"
(
  cd "$TEST_ROOT/active-repo"
  PORT="$ACTIVE_PORT" HOST=127.0.0.1 MCP_EXPOSURE_MODE=local MCP_AUTH_MODE=none \
    MCP_AUTH_TOKEN= MCP_ALLOW_UNSAFE_NO_AUTH=0 MCP_FULL_ACCESS=0 \
    ALLOWED_PATHS="$TEST_ROOT/active-allowed" WORKING_DIR="$TEST_ROOT/active-allowed" \
    MCP_RUNTIME_DIR="$TEST_ROOT/active-repo/.runtime" MCP_HUMAN_LOG="$TEST_ROOT/active-repo/.runtime/events.log" \
    MCP_LAUNCH_MODE=temporary node mcp-supervisor.js >"$TEST_ROOT/active-supervisor.out" 2>&1 &
  ACTIVE_PID=$!
  cleanup_active() { kill -TERM "$ACTIVE_PID" 2>/dev/null || true; wait "$ACTIVE_PID" 2>/dev/null || true; }
  trap cleanup_active EXIT
  for _ in $(seq 1 100); do
    curl -fsS "http://127.0.0.1:$ACTIVE_PORT/health" >/dev/null 2>&1 && break
    sleep 0.1
  done
  curl -fsS "http://127.0.0.1:$ACTIVE_PORT/health" >/dev/null
  if MCP_SERVICE_NAME="mcp-test-$ACTIVE_PORT.service" ./mcpctl.sh configure >"$TEST_ROOT/active-configure.out" 2>&1; then
    echo 'configure unexpectedly succeeded while runtime was active' >&2
    exit 1
  fi
  grep -q 'sesión temporal activa' "$TEST_ROOT/active-configure.out"
)
echo 'active_runtime_guard=OK'

printf '\n== persistent service unit dry-run ==\n'
SERVICE_OUTPUT="$TEST_ROOT/service-unit.out"
(
  cd "$TEST_ROOT/active-repo"
  env -i HOME="$HOME" USER="$(id -un)" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    MCP_SERVICE_NAME=mcp-dry-run-test.service MCP_SERVICE_DRY_RUN=1 MCP_INSTALL_OPTIONAL=0 MCP_SETUP_QUIET=1 \
    ./install-service.sh >"$SERVICE_OUTPUT" 2>&1
)
grep -Fq 'Environment="MCP_LAUNCH_MODE=persistent"' "$SERVICE_OUTPUT"
grep -Fq 'LimitCORE=0' "$SERVICE_OUTPUT"
grep -Fq 'LockPersonality=true' "$SERVICE_OUTPUT"
grep -Fq 'RestrictRealtime=true' "$SERVICE_OUTPUT"
grep -Fq 'SystemCallArchitectures=native' "$SERVICE_OUTPUT"
! grep -Fq 'MCP_AUTH_TOKEN=' "$SERVICE_OUTPUT"
echo 'persistent_service_unit=OK'

printf '\n== insecure persistent mode is rejected ==\n'
if (
  cd "$TEST_ROOT/legacy-repo"
  env -i HOME="$HOME" USER="$(id -un)" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    MCP_SERVICE_NAME=mcp-unsafe-dry-run.service MCP_SERVICE_DRY_RUN=1 MCP_INSTALL_OPTIONAL=0 MCP_SETUP_QUIET=1 \
    ./install-service.sh >"$TEST_ROOT/unsafe-persistent.out" 2>&1
); then
  echo 'public persistent no-auth unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'endpoint público no tiene autenticación' "$TEST_ROOT/unsafe-persistent.out"
echo 'unsafe_persistent_guard=OK'

printf '\n== bearer over public HTTP requires explicit acknowledgement ==\n'
mkdir -p "$TEST_ROOT/http-repo" "$TEST_ROOT/http-allowed"
cp -a . "$TEST_ROOT/http-repo/"
rm -rf "$TEST_ROOT/http-repo/.git" "$TEST_ROOT/http-repo/.env" "$TEST_ROOT/http-repo/.private" "$TEST_ROOT/http-repo/.runtime"
if (
  cd "$TEST_ROOT/http-repo"
  MCP_SETUP_NONINTERACTIVE=1 \
  MCP_SETUP_PORT=43124 \
  MCP_SETUP_ACCESS_CHOICE=1 \
  MCP_SETUP_ALLOWED_PATHS="$TEST_ROOT/http-allowed" \
  MCP_SETUP_PROFILE_CHOICE=2 \
  MCP_SETUP_MODE_CHOICE=2 \
  MCP_SETUP_DIRECT_URL=198.51.100.10:43124 \
  MCP_SETUP_OPEN_FIREWALL=2 \
  MCP_SETUP_AUTH_CHOICE=2 \
  ./configure-mcp.sh >"$TEST_ROOT/http-denied.out" 2>&1
); then
  echo 'bearer over HTTP unexpectedly succeeded without acknowledgement' >&2
  exit 1
fi
grep -q 'requiere MCP_SETUP_ALLOW_INSECURE_HTTP_AUTH=1' "$TEST_ROOT/http-denied.out"
rm -f "$TEST_ROOT/http-repo/.env"
rm -rf "$TEST_ROOT/http-repo/.private" "$TEST_ROOT/http-repo/.runtime"
(
  cd "$TEST_ROOT/http-repo"
  MCP_SETUP_NONINTERACTIVE=1 \
  MCP_SETUP_PORT=43124 \
  MCP_SETUP_ACCESS_CHOICE=1 \
  MCP_SETUP_ALLOWED_PATHS="$TEST_ROOT/http-allowed" \
  MCP_SETUP_PROFILE_CHOICE=2 \
  MCP_SETUP_MODE_CHOICE=2 \
  MCP_SETUP_DIRECT_URL=198.51.100.10:43124 \
  MCP_SETUP_OPEN_FIREWALL=2 \
  MCP_SETUP_AUTH_CHOICE=2 \
  MCP_SETUP_ALLOW_INSECURE_HTTP_AUTH=1 \
  ./configure-mcp.sh >"$TEST_ROOT/http-allowed.out" 2>&1
)
grep -Fxq 'MCP_ALLOW_INSECURE_HTTP_AUTH=1' "$TEST_ROOT/http-repo/.env"
grep -Fxq 'MCP_AUTH_MODE=bearer' "$TEST_ROOT/http-repo/.env"
grep -Fxq 'PUBLIC_BASE_URL=http://198.51.100.10:43124' "$TEST_ROOT/http-repo/.env"
grep -Fxq 'MCP_PUBLIC_BASE_URL=http://198.51.100.10:43124' "$TEST_ROOT/http-repo/.env"
if (
  cd "$TEST_ROOT/http-repo"
  env -i HOME="$HOME" USER="$(id -un)" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    MCP_SERVICE_NAME=mcp-http-dry-run.service MCP_SERVICE_DRY_RUN=1 MCP_INSTALL_OPTIONAL=0 MCP_SETUP_QUIET=1 \
    ./install-service.sh >"$TEST_ROOT/http-persistent.out" 2>&1
); then
  echo 'persistent HTTP unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'HTTP sin cifrado' "$TEST_ROOT/http-persistent.out"
echo 'insecure_http_guards=OK'
