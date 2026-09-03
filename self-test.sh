#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"
SELFTEST_TMP="$(mktemp -d /tmp/mcp-selftest.XXXXXX)"
cleanup_selftest() {
  rm -rf "$SELFTEST_TMP"
}
trap cleanup_selftest EXIT

export MCP_FULL_ACCESS="${MCP_FULL_ACCESS:-1}"
export WORKING_DIR="${WORKING_DIR:-$(cd .. && pwd)}"
export MCP_AUTH_MODE=none
export MCP_EXPOSURE_MODE=local
export MCP_ALLOW_UNSAFE_NO_AUTH=0
export MCP_HUMAN_LOG="$SELFTEST_TMP/events.log"
export ACTIVITY_LOG="$SELFTEST_TMP/activity.ndjson"
export MCP_ERROR_LOG="$SELFTEST_TMP/errors.log"

printf '== Static checks ==\n'
npm run check

printf '\n== Launcher and administration commands ==\n'
LAUNCHER_HELP="$(./start-mcp.sh --help)"
CONTROL_HELP="$(./mcpctl.sh --help)"
for option in --temporary --persistent --configure --chatgpt; do grep -q -- "$option" <<<"$LAUNCHER_HELP"; done
for command in configure chatgpt logs-follow logs-raw oauth-status oauth-reset; do grep -q "$command" <<<"$CONTROL_HELP"; done
grep -q 'MCP_LAUNCH_MODE=persistent' install-service.sh
echo 'launcher_and_control=OK'

printf '\n== First-run wizard ==\n'
./setup-self-test.sh

printf '\n== Authentication modes ==\n'
node auth-mode-self-test.js

printf '\n== OAuth end-to-end ==\n'
node oauth-self-test.js

printf '\n== OAuth through the supervisor ==\n'
(
  set -Eeuo pipefail
  TEST_DIR="$(mktemp -d "$SELFTEST_TMP/oauth-supervisor.XXXXXX")"
  TEST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  TEST_BASE="http://127.0.0.1:$TEST_PORT"
  TEST_STORE="$TEST_DIR/private/oauth-state.json"
  mkdir -p "$TEST_DIR/allowed" "$TEST_DIR/private" "$TEST_DIR/runtime"
  printf '%s' 'Supervisor-OAuth-Prueba-2026' | MCP_OAUTH_STORE="$TEST_STORE" \
    node oauth-admin.js configure --username supervisor-test --password-stdin >/dev/null
  PORT="$TEST_PORT" HOST=127.0.0.1 MCP_EXPOSURE_MODE=direct \
    PUBLIC_BASE_URL="$TEST_BASE" MCP_PUBLIC_BASE_URL="$TEST_BASE" \
    MCP_AUTH_MODE=oauth MCP_AUTH_TOKEN= MCP_OAUTH_ALLOW_HTTP_LOCALHOST=1 \
    MCP_OAUTH_STORE="$TEST_STORE" MCP_RUNTIME_DIR="$TEST_DIR/runtime" \
    MCP_HUMAN_LOG="$TEST_DIR/runtime/events.log" ACTIVITY_LOG="$TEST_DIR/runtime/activity.ndjson" \
    MCP_ERROR_LOG="$TEST_DIR/runtime/errors.log" ALLOWED_PATHS="$TEST_DIR/allowed" \
    WORKING_DIR="$TEST_DIR/allowed" MCP_FULL_ACCESS=0 MCP_LAUNCH_MODE=temporary \
    node mcp-supervisor.js >"$TEST_DIR/output" 2>&1 &
  TEST_PID=$!
  cleanup_oauth_supervisor() { kill -TERM "$TEST_PID" 2>/dev/null || true; wait "$TEST_PID" 2>/dev/null || true; }
  trap cleanup_oauth_supervisor EXIT
  for _ in $(seq 1 100); do
    curl -fsS "$TEST_BASE/health" >/dev/null 2>&1 && break
    sleep 0.1
  done
  curl -fsS "$TEST_BASE/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);if(!x.ok||x.auth!=="oauth")process.exit(1);});'
  [ "$(curl -sS -o /dev/null -w '%{http_code}' "$TEST_BASE/mcp")" = 401 ]
  curl -fsS "$TEST_BASE/.well-known/oauth-protected-resource/mcp" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);if(!String(x.resource||"").endsWith("/mcp"))process.exit(1);});'
  STATUS_JSON="$(PORT="$TEST_PORT" HOST=127.0.0.1 MCP_EXPOSURE_MODE=direct \
    PUBLIC_BASE_URL="$TEST_BASE" MCP_PUBLIC_BASE_URL="$TEST_BASE" MCP_AUTH_MODE=oauth \
    MCP_OAUTH_STORE="$TEST_STORE" MCP_RUNTIME_DIR="$TEST_DIR/runtime" \
    MCP_HUMAN_LOG="$TEST_DIR/runtime/events.log" node runtime-diagnostics.js status)"
  printf '%s' "$STATUS_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);if(!x.ok||!x.launch.temporary||x.config.authMode!=="oauth"||!x.config.authConfigured)process.exit(1);});'
  grep -q 'autenticación oauth' "$TEST_DIR/runtime/events.log"
  echo 'oauth_supervisor=OK'
)

printf '\n== Human-readable and redacted activity ==\n'
node - "$SELFTEST_TMP/human.log" <<'NODE'
const fs=require('fs');
const [file]=process.argv.slice(2);
process.env.MCP_HUMAN_LOG=file;
const {humanEvent,safeCommand}=require('./human-log');
process.env.MCP_HUMAN_LOG_MAX_BYTES='65536';
humanEvent('ACCION','Ejecutando tarea con token=SECRETO_DE_PRUEBA y password=CLAVE_DE_PRUEBA',{console:false});
const command=safeCommand({command:'bash',args:['-lc','ngrok config add-authtoken TOKEN_POSICIONAL; mysql -pCLAVE_INLINE; app --api-key=API_INLINE']});
for(let i=0;i<90;i+=1) humanEvent('PRUEBA',`evento-${i} ${'x'.repeat(900)}`,{console:false});
const text=[`${file}.1`,file].filter(fs.existsSync).map(p=>fs.readFileSync(p,'utf8')).join('\n');
if(!text.includes('ACCION') || !text.includes('[OCULTO]')) process.exit(1);
if(!fs.existsSync(`${file}.1`)) process.exit(3);
for(const secret of ['SECRETO_DE_PRUEBA','CLAVE_DE_PRUEBA','TOKEN_POSICIONAL','CLAVE_INLINE','API_INLINE']) {
  if(text.includes(secret) || command.includes(secret)) process.exit(2);
}
console.log('human_log_redaction_and_rotation=OK');
NODE

mcp_call() {
  local request="$1"
  printf '%s\n' "$request" | node mcp-server.js --stdio 2>"$SELFTEST_TMP/stdio.stderr"
}

printf '\n== Tool inventory ==\n'
TOOLS_JSON="$(mcp_call '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
printf '%s\n' "$TOOLS_JSON" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const j=JSON.parse(s); const names=j.result.tools.map(t=>t.name); console.log(`tools=${names.length}`); const required=["mcp_runtime_status","mcp_runtime_logs","run_command","screen_capture"]; if(names.length < 51 || required.some(name=>!names.includes(name))) process.exit(2);});'

printf '\n== Runtime diagnostics tool ==\n'
mcp_call '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"mcp_runtime_status","arguments":{}}}' \
  | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const j=JSON.parse(s); if(j.error) throw new Error(j.error.message); const x=j.result.structuredContent; if(!x || !x.config || !x.local || !x.tunnel || x.config.authMode!=="none") throw new Error("runtime status incomplete"); console.log(`runtime_status=OK mode=${x.config.exposureMode} auth=${x.config.authMode}`);});'

printf '\n== Temporary supervisor and readable logs ==\n'
(
  set -Eeuo pipefail
  TEST_DIR="$(mktemp -d "$SELFTEST_TMP/temporary.XXXXXX")"
  TEST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  PORT="$TEST_PORT" HOST=127.0.0.1 MCP_EXPOSURE_MODE=local MCP_AUTH_MODE=none \
    MCP_RUNTIME_DIR="$TEST_DIR/runtime" MCP_HUMAN_LOG="$TEST_DIR/runtime/events.log" \
    ACTIVITY_LOG="$TEST_DIR/runtime/activity.ndjson" MCP_ERROR_LOG="$TEST_DIR/runtime/errors.log" \
    ALLOWED_PATHS="$TEST_DIR" WORKING_DIR="$TEST_DIR" MCP_FULL_ACCESS=0 \
    MCP_LAUNCH_MODE=temporary node mcp-supervisor.js >"$TEST_DIR/output" 2>&1 &
  TEST_PID=$!
  cleanup_temporary_test() {
    kill -TERM "$TEST_PID" 2>/dev/null || true
    wait "$TEST_PID" 2>/dev/null || true
  }
  trap cleanup_temporary_test EXIT
  for _ in $(seq 1 100); do
    curl -fsS "http://127.0.0.1:$TEST_PORT/health" >/dev/null 2>&1 && break
    sleep 0.1
  done
  HEALTH="$(curl -fsS "http://127.0.0.1:$TEST_PORT/health")"
  printf '%s' "$HEALTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);if(!x.ok||x.auth!=="none"||x.allowedRoots!==undefined)process.exit(1);});'
  STATUS_JSON="$(PORT="$TEST_PORT" HOST=127.0.0.1 MCP_EXPOSURE_MODE=local MCP_AUTH_MODE=none MCP_RUNTIME_DIR="$TEST_DIR/runtime" MCP_HUMAN_LOG="$TEST_DIR/runtime/events.log" node runtime-diagnostics.js status)"
  printf '%s' "$STATUS_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(!j.ok||!j.launch.temporary||j.launch.persistent||j.config.authMode!=="none") {console.error(j);process.exit(1)}});'
  VIEW="$(PORT="$TEST_PORT" HOST=127.0.0.1 MCP_EXPOSURE_MODE=local MCP_AUTH_MODE=none MCP_RUNTIME_DIR="$TEST_DIR/runtime" MCP_HUMAN_LOG="$TEST_DIR/runtime/events.log" node log-viewer.js --lines 40)"
  grep -q 'ACTIVIDAD DEL SERVIDOR MCP' <<<"$VIEW"
  grep -q 'Servidor MCP local listo' "$TEST_DIR/runtime/events.log"
  echo 'temporary_runtime_and_logs=OK'
)

printf '\n== ngrok reserved URL compatibility ==\n'
(
  set -Eeuo pipefail
  TEST_DIR="$(mktemp -d "$SELFTEST_TMP/ngrok.XXXXXX")"
  TEST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  FAKE_NGROK="$TEST_DIR/fake-ngrok"
  ARGS_FILE="$TEST_DIR/args"
  cat > "$FAKE_NGROK" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${FAKE_NGROK_ARGS:?}"
trap 'exit 0' TERM INT
while :; do sleep 1; done
FAKE
  chmod +x "$FAKE_NGROK"
  PORT="$TEST_PORT" HOST=127.0.0.1 MCP_EXPOSURE_MODE=ngrok MCP_AUTH_MODE=none \
    MCP_ALLOW_UNSAFE_NO_AUTH=1 MCP_RUNTIME_DIR="$TEST_DIR/runtime" \
    MCP_HUMAN_LOG="$TEST_DIR/runtime/events.log" ALLOWED_PATHS="$TEST_DIR" WORKING_DIR="$TEST_DIR" \
    MCP_FULL_ACCESS=0 NGROK_BIN="$FAKE_NGROK" NGROK_DOMAIN=legacy-example.ngrok-free.dev \
    FAKE_NGROK_ARGS="$ARGS_FILE" node mcp-supervisor.js >"$TEST_DIR/output" 2>&1 &
  TEST_PID=$!
  cleanup_ngrok_test() {
    kill -TERM "$TEST_PID" 2>/dev/null || true
    wait "$TEST_PID" 2>/dev/null || true
  }
  trap cleanup_ngrok_test EXIT
  for _ in $(seq 1 100); do [ -f "$ARGS_FILE" ] && break; sleep 0.1; done
  [ -f "$ARGS_FILE" ]
  grep -Fxq -- '--url' "$ARGS_FILE"
  grep -Fxq -- 'https://legacy-example.ngrok-free.dev' "$ARGS_FILE"
  ! grep -Fxq -- '--domain' "$ARGS_FILE"
  echo 'ngrok_url_compatibility=OK'
)

printf '\n== Capability probe ==\n'
mcp_call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"control_capabilities","arguments":{}}}' \
  | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.error)throw new Error(j.error.message);console.log(`capability_probe=OK platform=${j.result.structuredContent.platform}`);});'

printf '\n== Git wrapper ==\n'
REQ=$(node -e 'console.log(JSON.stringify({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"git_status",arguments:{repo:process.cwd()}}}))')
mcp_call "$REQ" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.error)throw new Error(j.error.message);if(typeof j.result.structuredContent.stdout!=="string")process.exit(1);console.log("git_wrapper=OK")});'

printf '\n== tmux round-trip ==\n'
if command -v tmux >/dev/null 2>&1; then
  SESSION="mcp-selftest-$$"
  trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true' EXIT
  tmux new-session -d -s "$SESSION" -c "$PWD" bash
  tmux send-keys -t "$SESSION" -l -- 'echo MCP_TMUX_SELFTEST_OK'
  tmux send-keys -t "$SESSION" Enter
  sleep 0.2
  CAPTURE="$(tmux capture-pane -p -J -t "$SESSION" -S -50)"
  grep -q 'MCP_TMUX_SELFTEST_OK' <<<"$CAPTURE"
  tmux kill-session -t "$SESSION"
  trap cleanup_selftest EXIT
  echo 'tmux=OK'
else
  echo 'tmux=SKIP (not installed)'
fi

printf '\n== Desktop screenshot ==\n'
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  SCREEN_JSON="$(mcp_call '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"screen_capture","arguments":{"mode":"screen"}}}')"
  printf '%s\n' "$SCREEN_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);if(j.error)throw new Error(j.error.message);const image=j.result.content.find(x=>x.type==="image");if(!image||!image.data)throw new Error("missing screenshot");console.log(`screenshot=OK bytes~${Math.floor(image.data.length*3/4)}`);});'
else
  echo 'screenshot=SKIP (no graphical session in environment)'
fi

printf '\nALL SELF-TESTS PASSED\n'
