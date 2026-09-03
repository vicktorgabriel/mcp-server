#!/usr/bin/env bash
set -Eeuo pipefail

export PATH="$HOME/.local/bin:$PATH"
TARGET="$HOME/.local/bin/ngrok"
mkdir -p "$HOME/.local/bin"

is_snap_binary() {
  local candidate="$1" resolved=''
  [ -n "$candidate" ] || return 1
  case "$candidate" in /snap/*) return 0 ;; esac
  resolved="$(readlink -f "$candidate" 2>/dev/null || true)"
  case "$resolved" in /snap/*|/usr/bin/snap) return 0 ;; esac
  return 1
}

if [ -x "$TARGET" ] && [ "${MCP_FORCE_NGROK_STANDALONE:-0}" != '1' ]; then
  echo "[OK] ngrok standalone ya está instalado: $TARGET"
  "$TARGET" version || true
  exit 0
fi

CURRENT="$(command -v ngrok 2>/dev/null || true)"
if [ -n "$CURRENT" ] && ! is_snap_binary "$CURRENT" \
   && [ "${MCP_FORCE_NGROK_STANDALONE:-0}" != '1' ]; then
  echo "[OK] ngrok ya está instalado: $CURRENT"
  "$CURRENT" version || true
  exit 0
fi

if [ -n "$CURRENT" ] && is_snap_binary "$CURRENT"; then
  echo "[INFO] Se detectó ngrok instalado mediante Snap."
  echo "[INFO] Se instalará una copia standalone en $TARGET para evitar conflictos de confinamiento y rutas de configuración."
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NGROK_ARCH=amd64 ;;
  aarch64|arm64) NGROK_ARCH=arm64 ;;
  *) echo "[ERROR] Arquitectura no soportada por este instalador automático: $ARCH" >&2; exit 1 ;;
esac

URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${NGROK_ARCH}.tgz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[INFO] Descargando ngrok v3 oficial para Linux $NGROK_ARCH..."
curl --fail --location --proto '=https' --tlsv1.2 "$URL" -o "$TMP/ngrok.tgz"
tar -xzf "$TMP/ngrok.tgz" -C "$TMP"
[ -x "$TMP/ngrok" ] || { echo '[ERROR] El paquete descargado no contiene el ejecutable ngrok.' >&2; exit 1; }
install -m 0755 "$TMP/ngrok" "$TARGET"
"$TARGET" version >/dev/null

echo "[OK] ngrok standalone instalado en $TARGET"
echo "[INFO] El asistente continuará en esta misma terminal para pedir el authtoken y la URL pública."
