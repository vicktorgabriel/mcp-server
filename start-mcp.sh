#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

line() { printf '%*s\n' 72 '' | tr ' ' '='; }
info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }

line
echo " MCP Local Full Control"
echo " ChatGPT / Codex / Claude <-> tu PC mediante MCP"
line
echo "Este servidor puede exponer archivos, terminal, Git, tmux, procesos,"
echo "capturas de pantalla y otras herramientas del equipo."
echo ""
echo "NGROK NO ES OBLIGATORIO. Se usa cuando no tenés una URL HTTPS pública"
echo "propia, estás detrás de CGNAT/Starlink, no podés abrir puertos o querés"
echo "la forma más simple de conectar ChatGPT Web."
echo "Con IP pública/fija también podés usar una URL HTTPS propia mediante"
echo "DNS + TLS + reverse proxy/port-forward correctamente configurado."
line
echo ""

chmod +x ./install-deps.sh ./install-ngrok.sh 2>/dev/null || true
./install-deps.sh

if [ ! -f .env ]; then
  info "Primera ejecución: creando .env"
  cp .env.example .env
  DEFAULT_ROOT="$(cd .. && pwd)"
  node - <<'NODE' "$DEFAULT_ROOT"
const fs=require('fs'); const root=process.argv[2]; let s=fs.readFileSync('.env','utf8');
s=s.replace(/^WORKING_DIR=.*$/m,`WORKING_DIR=${root}`);
s=s.replace(/^ALLOWED_PATHS=.*$/m,`ALLOWED_PATHS=${root}`);
fs.writeFileSync('.env',s);
NODE

  echo "Elegí el nivel de acceso inicial:"
  echo "  1) RESTRINGIDO (recomendado): sólo ALLOWED_PATHS"
  echo "  2) FULL CONTROL: todo lo permitido por tu usuario"
  read -r -p "Opción [1]: " ACCESS_CHOICE
  ACCESS_CHOICE=${ACCESS_CHOICE:-1}
  if [ "$ACCESS_CHOICE" = "2" ]; then
    sed -i 's/^MCP_FULL_ACCESS=.*/MCP_FULL_ACCESS=1/' .env
  else
    sed -i 's/^MCP_FULL_ACCESS=.*/MCP_FULL_ACCESS=0/' .env
  fi

  echo ""
  echo "¿Cómo se conectará un cliente web como ChatGPT?"
  echo "  1) NGROK (IP dinámica, CGNAT/Starlink, sin abrir puertos)"
  echo "  2) URL HTTPS PROPIA (IP pública/fija o DDNS + TLS/reverse proxy)"
  echo "  3) SOLO LOCAL (stdio/localhost; sin ChatGPT Web remoto)"
  read -r -p "Opción [1]: " MODE_CHOICE
  MODE_CHOICE=${MODE_CHOICE:-1}
  case "$MODE_CHOICE" in
    2)
      read -r -p "URL pública HTTPS sin /mcp (ej. https://mcp.midominio.com): " PUBLIC_URL_INPUT
      sed -i 's/^MCP_EXPOSURE_MODE=.*/MCP_EXPOSURE_MODE=direct/' .env
      node -e "const fs=require('fs');let s=fs.readFileSync('.env','utf8');s=s.replace(/^PUBLIC_BASE_URL=.*$/m,'PUBLIC_BASE_URL='+process.argv[1]);fs.writeFileSync('.env',s)" "${PUBLIC_URL_INPUT%/}"
      ;;
    3)
      sed -i 's/^MCP_EXPOSURE_MODE=.*/MCP_EXPOSURE_MODE=local/; s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=|' .env
      ;;
    *)
      sed -i 's/^MCP_EXPOSURE_MODE=.*/MCP_EXPOSURE_MODE=ngrok/; s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=|' .env
      ;;
  esac
fi

read_config() {
  local key="$1" fallback="$2"
  node -e "const fs=require('fs');const k=process.argv[1],f=process.argv[2],e={};if(fs.existsSync('.env'))for(const l of fs.readFileSync('.env','utf8').split(/\\r?\\n/)){const s=l.trim(),i=s.indexOf('=');if(!s||s.startsWith('#')||i<1)continue;e[s.slice(0,i).trim()]=s.slice(i+1).trim().replace(/^['\\\"]|['\\\"]$/g,'')}console.log(process.env[k]??e[k]??f)" "$key" "$fallback"
}

PORT="$(read_config PORT 3000)"
HOST="$(read_config HOST 127.0.0.1)"
ALLOWED_PATHS="$(read_config ALLOWED_PATHS "$(cd .. && pwd)")"
WORKING_DIR="$(read_config WORKING_DIR "$(cd .. && pwd)")"
MCP_FULL_ACCESS="$(read_config MCP_FULL_ACCESS 0)"
MCP_AUTH_TOKEN="$(read_config MCP_AUTH_TOKEN '')"
ACTIVITY_LOG="$(read_config ACTIVITY_LOG activity.log)"
MCP_FAST_MODE="$(read_config MCP_FAST_MODE 1)"
SEARCH_CACHE_TTL_MS="$(read_config SEARCH_CACHE_TTL_MS 60000)"
SEARCH_MAX_FILE_BYTES="$(read_config SEARCH_MAX_FILE_BYTES 524288)"
SEARCH_MAX_TOTAL_BYTES="$(read_config SEARCH_MAX_TOTAL_BYTES 16777216)"
SEARCH_SKIP_DIRS="$(read_config SEARCH_SKIP_DIRS node_modules,.git,dist,build,.next,.nuxt,.cache,coverage,.venv,venv,__pycache__,target,out)"
READ_BATCH_LIMIT="$(read_config READ_BATCH_LIMIT 25)"
MCP_DESKTOP_ENABLED="$(read_config MCP_DESKTOP_ENABLED 1)"
MCP_INPUT_ENABLED="$(read_config MCP_INPUT_ENABLED 1)"
MCP_CONTROL_TIMEOUT_MS="$(read_config MCP_CONTROL_TIMEOUT_MS 120000)"
MCP_IMAGE_LIMIT_BYTES="$(read_config MCP_IMAGE_LIMIT_BYTES 26214400)"
SSE_HEARTBEAT_MS="$(read_config SSE_HEARTBEAT_MS 15000)"
KEEP_ALIVE_TIMEOUT_MS="$(read_config KEEP_ALIVE_TIMEOUT_MS 65000)"
MCP_EXPOSURE_MODE="$(read_config MCP_EXPOSURE_MODE ngrok)"
PUBLIC_BASE_URL="$(read_config PUBLIC_BASE_URL '')"
export PORT HOST ALLOWED_PATHS WORKING_DIR MCP_FULL_ACCESS MCP_AUTH_TOKEN ACTIVITY_LOG MCP_FAST_MODE SEARCH_CACHE_TTL_MS SEARCH_MAX_FILE_BYTES SEARCH_MAX_TOTAL_BYTES SEARCH_SKIP_DIRS READ_BATCH_LIMIT MCP_DESKTOP_ENABLED MCP_INPUT_ENABLED MCP_CONTROL_TIMEOUT_MS MCP_IMAGE_LIMIT_BYTES SSE_HEARTBEAT_MS KEEP_ALIVE_TIMEOUT_MS

SERVER_LOG="${SERVER_LOG:-mcp-server.log}"
NGROK_LOG="${NGROK_LOG:-ngrok.log}"

cleanup() {
  [ -z "${TAIL_PID:-}" ] || kill "$TAIL_PID" 2>/dev/null || true
  [ -z "${SERVER_PID:-}" ] || kill "$SERVER_PID" 2>/dev/null || true
  [ -z "${NGROK_PID:-}" ] || kill "$NGROK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

info "Iniciando MCP HTTP en http://${HOST}:${PORT} ..."
: >"$SERVER_LOG"
node mcp-server.js --http >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
tail -n 0 -f "$SERVER_LOG" &
TAIL_PID=$!
sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "[ERROR] El servidor MCP no pudo iniciar."
  tail -n 100 "$SERVER_LOG" || true
  exit 1
fi

PUBLIC_URL=""
case "$MCP_EXPOSURE_MODE" in
  ngrok)
    if ! command -v ngrok >/dev/null 2>&1; then
      warn "ngrok no está instalado."
      read -r -p "¿Instalar ngrok automáticamente en ~/.local/bin? [S/n]: " INSTALL_NGROK
      INSTALL_NGROK=${INSTALL_NGROK:-S}
      if [[ "$INSTALL_NGROK" =~ ^[SsYy]$ ]]; then ./install-ngrok.sh || true; fi
    fi
    if command -v ngrok >/dev/null 2>&1; then
      info "Iniciando túnel ngrok..."
      : >"$NGROK_LOG"
      ngrok http "http://${HOST}:${PORT}" --log=stdout >"$NGROK_LOG" 2>&1 &
      NGROK_PID=$!
      for _ in $(seq 1 30); do
        PUBLIC_URL="$(node -e "fetch('http://127.0.0.1:4040/api/tunnels').then(r=>r.json()).then(j=>{const t=(j.tunnels||[]).find(x=>x.public_url&&x.public_url.startsWith('https://'));if(t)console.log(t.public_url)}).catch(()=>{})" 2>/dev/null || true)"
        [ -z "$PUBLIC_URL" ] || break
        sleep 1
      done
      if [ -z "$PUBLIC_URL" ]; then
        warn "No pude obtener la URL pública de ngrok. Revisa $NGROK_LOG."
        warn "Primera vez: ejecuta 'ngrok config add-authtoken TU_TOKEN'."
      fi
    else
      warn "Sin ngrok no habrá URL pública en este modo. El MCP local sigue activo."
    fi
    ;;
  direct) PUBLIC_URL="${PUBLIC_BASE_URL%/}" ;;
  local) ;;
  *) warn "Modo desconocido '$MCP_EXPOSURE_MODE'; usando local."; MCP_EXPOSURE_MODE=local ;;
esac

CURRENT_DIR="$(pwd)"
echo ""
line
echo " MCP READY"
line
printf '%-18s %s\n' "Modo:" "$MCP_EXPOSURE_MODE"
printf '%-18s %s\n' "Health local:" "http://${HOST}:${PORT}/health"
printf '%-18s %s\n' "Config local:" "http://${HOST}:${PORT}/config"
printf '%-18s %s\n' "Stdio local:" "node ${CURRENT_DIR}/mcp-server.js --stdio"
printf '%-18s %s\n' "Rutas permitidas:" "$ALLOWED_PATHS"
printf '%-18s %s\n' "Full access:" "$MCP_FULL_ACCESS"
printf '%-18s %s\n' "Desktop/input:" "${MCP_DESKTOP_ENABLED}/${MCP_INPUT_ENABLED}"
printf '%-18s %s\n' "Auth:" "$([ -n "$MCP_AUTH_TOKEN" ] && echo 'Bearer configurado' || echo 'sin autenticación')"

if [ -n "$PUBLIC_URL" ]; then
  echo ""
  echo "URL PARA CHATGPT:"
  echo "  ${PUBLIC_URL}/mcp"
  echo "URL SSE LEGACY:"
  echo "  ${PUBLIC_URL}/sse"
  echo ""
  echo "Agregar en ChatGPT (la ubicación exacta puede variar según la interfaz):"
  echo "  1. Configuración -> Apps/Conectores -> opciones avanzadas / Developer Mode."
  echo "  2. Crear/agregar un servidor MCP personalizado."
  echo "  3. Nombre: por ejemplo 'MCP Mi PC'."
  echo "  4. URL: ${PUBLIC_URL}/mcp"
  echo "  5. Autenticación: la configurada en el servidor (si corresponde)."
  echo "  6. Guardar, habilitarlo y probar control_capabilities."
  echo "  Nota: los permisos disponibles dependen del plan/rollout de ChatGPT."
else
  echo ""
  echo "No hay URL pública. Este modo sirve para clientes MCP locales por stdio."
  echo "ChatGPT Web remoto no puede acceder directamente a 127.0.0.1."
fi

if [ "$MCP_EXPOSURE_MODE" = "direct" ]; then
  echo ""
  echo "NOTA URL PROPIA: una IP fija por sí sola NO alcanza para ChatGPT Web."
  echo "Publicá el MCP con HTTPS válido (normalmente dominio/DNS + Caddy/Nginx/"
  echo "Traefik) y redirigí esa URL hacia http://${HOST}:${PORT}."
fi
if [ "$MCP_FULL_ACCESS" = "1" ]; then
  warn "FULL CONTROL ACTIVO: el modelo puede acceder a todo lo permitido por tu usuario."
fi

echo ""
line
echo "Dejá esta terminal abierta. Ctrl+C detiene MCP y, si corresponde, ngrok."
echo "Editar opciones: ${CURRENT_DIR}/.env"
line

wait "$SERVER_PID"
