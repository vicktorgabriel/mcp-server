#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

read_config() {
  local key="$1"
  local fallback="$2"
  node -e "const fs=require('fs'); const key=process.argv[1], fallback=process.argv[2]; if (process.env[key]) { console.log(process.env[key]); process.exit(0); } let value=''; if (fs.existsSync('.env')) { for (const line of fs.readFileSync('.env','utf8').split(/\\r?\\n/)) { const s=line.trim(); if (!s || s.startsWith('#')) continue; const i=s.indexOf('='); if (i < 1) continue; if (s.slice(0,i).trim() === key) value=s.slice(i+1).trim().replace(/^['\\\"]|['\\\"]$/g,''); } } console.log(value || fallback)" "$key" "$fallback"
}

PORT="$(read_config PORT 3000)"
HOST="$(read_config HOST 127.0.0.1)"
ALLOWED_PATHS="$(read_config ALLOWED_PATHS /mnt/4tb-hdd/repo)"
MCP_AUTH_TOKEN="$(read_config MCP_AUTH_TOKEN '')"
ACTIVITY_LOG="$(read_config ACTIVITY_LOG activity.log)"
MCP_FAST_MODE="$(read_config MCP_FAST_MODE 1)"
SEARCH_CACHE_TTL_MS="$(read_config SEARCH_CACHE_TTL_MS 60000)"
SEARCH_MAX_FILE_BYTES="$(read_config SEARCH_MAX_FILE_BYTES 524288)"
SEARCH_MAX_TOTAL_BYTES="$(read_config SEARCH_MAX_TOTAL_BYTES 16777216)"
SEARCH_SKIP_DIRS="$(read_config SEARCH_SKIP_DIRS node_modules,.git,dist,build,.next,.nuxt,.cache,coverage,.venv,venv,__pycache__,target,out)"
READ_BATCH_LIMIT="$(read_config READ_BATCH_LIMIT 25)"
SSE_HEARTBEAT_MS="$(read_config SSE_HEARTBEAT_MS 15000)"
KEEP_ALIVE_TIMEOUT_MS="$(read_config KEEP_ALIVE_TIMEOUT_MS 65000)"
export PORT HOST ALLOWED_PATHS MCP_AUTH_TOKEN ACTIVITY_LOG MCP_FAST_MODE SEARCH_CACHE_TTL_MS SEARCH_MAX_FILE_BYTES SEARCH_MAX_TOTAL_BYTES SEARCH_SKIP_DIRS READ_BATCH_LIMIT SSE_HEARTBEAT_MS KEEP_ALIVE_TIMEOUT_MS

SERVER_LOG="${SERVER_LOG:-mcp-server.log}"
NGROK_LOG="${NGROK_LOG:-ngrok.log}"

cleanup() {
  if [ -n "${TAIL_PID:-}" ]; then kill "$TAIL_PID" 2>/dev/null || true; fi
  if [ -n "${SERVER_PID:-}" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  if [ -n "${NGROK_PID:-}" ]; then kill "$NGROK_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

echo "Starting MCP HTTP server..."
: >"$SERVER_LOG"
node mcp-server.js --http >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
tail -n 0 -f "$SERVER_LOG" &
TAIL_PID=$!

sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "MCP server failed to start. Log:"
  tail -n 80 "$SERVER_LOG" || true
  exit 1
fi

echo "Starting ngrok tunnel..."
if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok is not installed or is not in PATH."
  echo "Local MCP URL: http://${HOST}:${PORT}/mcp"
  echo "Install/configure ngrok, then rerun this script for ChatGPT Web and Claude Web."
  wait "$SERVER_PID"
  exit $?
fi

ngrok http "http://${HOST}:${PORT}" --log=stdout >"$NGROK_LOG" 2>&1 &
NGROK_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 30); do
  PUBLIC_URL="$(node -e "fetch('http://127.0.0.1:4040/api/tunnels').then(r=>r.json()).then(j=>{const t=(j.tunnels||[]).find(x=>x.public_url&&x.public_url.startsWith('https://')); if(t) console.log(t.public_url)}).catch(()=>{})" 2>/dev/null || true)"
  if [ -n "$PUBLIC_URL" ]; then break; fi
  sleep 1
done

echo ""
echo "=== MCP READY ==="
BASE_URL="${PUBLIC_URL:-http://${HOST}:${PORT}}"
echo "Local health:  http://${HOST}:${PORT}/health"
echo "Local config:  http://${HOST}:${PORT}/config"
echo "ChatGPT Web:   ${BASE_URL}/mcp"
echo "Claude Web:    ${BASE_URL}/sse"
echo "Claude local:  node $(pwd)/mcp-server.js --stdio"
echo "Allowed paths: ${ALLOWED_PATHS}"
echo "Fast mode:     ${MCP_FAST_MODE}"
echo "Activity log:  ${ACTIVITY_LOG}"
if [ -n "${MCP_AUTH_TOKEN:-}" ]; then
  echo "Auth:          Bearer ${MCP_AUTH_TOKEN}"
else
  echo "Auth:          none"
fi
echo "Logs:          $SERVER_LOG, $NGROK_LOG"
if [ -z "$PUBLIC_URL" ]; then
  echo "Warning:       ngrok public URL was not detected. Check $NGROK_LOG."
fi
echo "================="
echo ""
echo "Leave this terminal open. Press Ctrl+C to stop MCP and ngrok."

wait "$SERVER_PID"
