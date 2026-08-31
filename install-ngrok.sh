#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"

if command -v ngrok >/dev/null 2>&1; then
  echo "[OK] ngrok ya está instalado: $(command -v ngrok)"
  ngrok version || true
  exit 0
fi

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) NGROK_ARCH=amd64 ;;
  aarch64|arm64) NGROK_ARCH=arm64 ;;
  *) echo "[ERROR] Arquitectura no soportada por este instalador automático: $ARCH" >&2; exit 1 ;;
esac

URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${NGROK_ARCH}.tgz"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[INFO] Descargando ngrok v3 para Linux $NGROK_ARCH..."
curl -fL "$URL" -o "$TMP/ngrok.tgz"
tar -xzf "$TMP/ngrok.tgz" -C "$TMP"
install -m 0755 "$TMP/ngrok" "$HOME/.local/bin/ngrok"

echo "[OK] ngrok instalado en $HOME/.local/bin/ngrok"
echo ""
echo "Falta asociarlo a tu cuenta de ngrok. Copia tu authtoken desde el panel de ngrok y ejecuta:"
echo "  ngrok config add-authtoken TU_TOKEN"
echo ""
echo "Luego vuelve a ejecutar ./start-mcp.sh"
