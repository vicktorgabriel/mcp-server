#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export MCP_FULL_ACCESS="${MCP_FULL_ACCESS:-1}"
export WORKING_DIR="${WORKING_DIR:-$(cd .. && pwd)}"

printf '== Static checks ==\n'
npm run check

mcp_call() {
  local request="$1"
  printf '%s\n' "$request" | node mcp-server.js --stdio 2>/tmp/mcp-self-test.stderr
}

printf '\n== Tool inventory ==\n'
TOOLS_JSON="$(mcp_call '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
printf '%s\n' "$TOOLS_JSON" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const j=JSON.parse(s); const names=j.result.tools.map(t=>t.name); console.log(`tools=${names.length}`); console.log(names.join(", ")); if(names.length < 40) process.exit(2);});'

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
