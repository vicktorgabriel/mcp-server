#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export MCP_FULL_ACCESS="${MCP_FULL_ACCESS:-1}"
export WORKING_DIR="${WORKING_DIR:-$(cd .. && pwd)}"

printf '== Static checks ==\n'
npm run check

printf '\n== Launcher modes ==\n'
LAUNCHER_HELP="$(./start-mcp.sh --help)"
grep -q -- '--temporary' <<<"$LAUNCHER_HELP"
grep -q -- '--persistent' <<<"$LAUNCHER_HELP"
grep -q 'TEMPORAL / PERSISTENTE' <<<"$LAUNCHER_HELP"
grep -q 'MCP_LAUNCH_MODE=persistent' install-service.sh
echo 'launcher_modes=OK'

mcp_call() {
  local request="$1"
  printf '%s\n' "$request" | node mcp-server.js --stdio 2>/tmp/mcp-self-test.stderr
}

printf '\n== Tool inventory ==\n'
TOOLS_JSON="$(mcp_call '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
printf '%s\n' "$TOOLS_JSON" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const j=JSON.parse(s); const names=j.result.tools.map(t=>t.name); console.log(`tools=${names.length}`); console.log(names.join(", ")); const required=["mcp_runtime_status","mcp_runtime_logs"]; if(names.length < 51 || required.some(name=>!names.includes(name))) process.exit(2);});'

printf '\n== Runtime diagnostics ==\n'
mcp_call '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"mcp_runtime_status","arguments":{}}}' \
  | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const j=JSON.parse(s); if(j.error) throw new Error(j.error.message); const x=j.result.structuredContent; if(!x || !x.config || !x.local || !x.tunnel) throw new Error("runtime status incomplete"); console.log(`runtime_status=OK mode=${x.config.exposureMode}`);});'

printf '\n== Temporary runtime mode ==\n'
(
  set -euo pipefail
  TEST_DIR="$(mktemp -d /tmp/mcp-temporary-mode-test.XXXXXX)"
  TEST_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  PORT="$TEST_PORT" MCP_EXPOSURE_MODE=local MCP_RUNTIME_DIR="$TEST_DIR/runtime" \
    MCP_LAUNCH_MODE=temporary node mcp-supervisor.js >"$TEST_DIR/output" 2>&1 &
  TEST_PID=$!
  cleanup_temporary_test() {
    kill -TERM "$TEST_PID" 2>/dev/null || true
    wait "$TEST_PID" 2>/dev/null || true
    rm -rf "$TEST_DIR"
  }
  trap cleanup_temporary_test EXIT
  for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:$TEST_PORT/health" >/dev/null 2>&1 && break
    sleep 0.1
  done
  curl -fsS "http://127.0.0.1:$TEST_PORT/health" >/dev/null
  STATUS_JSON="$(PORT="$TEST_PORT" MCP_EXPOSURE_MODE=local MCP_RUNTIME_DIR="$TEST_DIR/runtime" node runtime-diagnostics.js status)"
  printf '%s' "$STATUS_JSON" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const j=JSON.parse(s); if(!j.ok || !j.launch || !j.launch.temporary || j.launch.persistent || j.launch.mode!=="temporary") {console.error(j); process.exit(1)}; console.log("temporary_runtime=OK");});'
)

printf '\n== ngrok reserved URL compatibility ==\n'
(
  set -euo pipefail
  TEST_DIR="$(mktemp -d /tmp/mcp-ngrok-url-test.XXXXXX)"
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
  PORT="$TEST_PORT" MCP_EXPOSURE_MODE=ngrok MCP_RUNTIME_DIR="$TEST_DIR/runtime" \
    NGROK_BIN="$FAKE_NGROK" NGROK_DOMAIN=legacy-example.ngrok-free.dev \
    FAKE_NGROK_ARGS="$ARGS_FILE" node mcp-supervisor.js >"$TEST_DIR/output" 2>&1 &
  TEST_PID=$!
  cleanup_ngrok_test() {
    kill -TERM "$TEST_PID" 2>/dev/null || true
    wait "$TEST_PID" 2>/dev/null || true
    rm -rf "$TEST_DIR"
  }
  trap cleanup_ngrok_test EXIT
  for _ in $(seq 1 50); do
    [ -f "$ARGS_FILE" ] && break
    sleep 0.1
  done
  [ -f "$ARGS_FILE" ]
  grep -Fxq -- '--url' "$ARGS_FILE"
  grep -Fxq -- 'https://legacy-example.ngrok-free.dev' "$ARGS_FILE"
  ! grep -Fxq -- '--domain' "$ARGS_FILE"
  echo 'ngrok_url=OK'
)

printf '\n== Capability probe ==\n'
mcp_call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"control_capabilities","arguments":{}}}' \
  | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify(j.result.structuredContent,null,2));});'

printf '\n== Git wrapper ==\n'
REQ=$(node -e 'console.log(JSON.stringify({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"git_status",arguments:{repo:process.cwd()}}}))')
mcp_call "$REQ" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const j=JSON.parse(s); if(j.error) throw new Error(j.error.message); console.log(j.result.structuredContent.stdout);});'

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
  trap - EXIT
  echo 'tmux=OK'
else
  echo 'tmux=SKIP (not installed)'
fi

printf '\n== Desktop screenshot ==\n'
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  SCREEN_JSON="$(mcp_call '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"screen_capture","arguments":{"mode":"screen"}}}')"
  printf '%s\n' "$SCREEN_JSON" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const j=JSON.parse(s); if(j.error) throw new Error(j.error.message); const image=j.result.content.find(x=>x.type==="image"); if(!image || !image.data) throw new Error("screenshot did not return image content"); console.log(`screenshot=OK bytes~${Math.floor(image.data.length*3/4)}`);});'
else
  echo 'screenshot=SKIP (no graphical session in environment)'
fi

printf '\nALL SELF-TESTS PASSED\n'
