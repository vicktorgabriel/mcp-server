#!/usr/bin/env bash
set -u

# Instala dependencias base y, cuando es posible, extras de control de escritorio.
# Diseñado para ser llamado desde start-mcp.sh, pero también puede ejecutarse solo.

export PATH="$HOME/.local/bin:$PATH"

QUIET=${MCP_SETUP_QUIET:-0}
INSTALL_OPTIONAL=${MCP_INSTALL_OPTIONAL:-1}
APT_UPDATED=0

info() { [ "$QUIET" = "1" ] || printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
err()  { printf '[ERROR] %s\n' "$*" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  elif have pkexec; then
    pkexec "$@"
  else
    err "Se necesitan privilegios de administrador para instalar paquetes. Instala sudo/pkexec o ejecuta como root."
    return 1
  fi
}

pkg_manager() {
  if have apt-get; then echo apt
  elif have dnf; then echo dnf
  elif have pacman; then echo pacman
  elif have zypper; then echo zypper
  elif have apk; then echo apk
  elif have brew; then echo brew
  else echo none
  fi
}

apt_update_once() {
  if [ "$APT_UPDATED" -eq 0 ]; then
    info "Actualizando índice APT..."
    run_root apt-get update
    APT_UPDATED=1
  fi
}

install_packages() {
  local pm="$1"; shift
  [ "$#" -gt 0 ] || return 0
  case "$pm" in
    apt)
      apt_update_once || return 1
      run_root apt-get install -y "$@"
      ;;
    dnf) run_root dnf install -y "$@" ;;
    pacman) run_root pacman -Sy --needed --noconfirm "$@" ;;
    zypper) run_root zypper --non-interactive install "$@" ;;
    apk) run_root apk add "$@" ;;
    brew) brew install "$@" ;;
    *) return 1 ;;
  esac
}

install_one_optional() {
  local pm="$1" pkg="$2"
  case "$pm" in
    apt) dpkg -s "$pkg" >/dev/null 2>&1 && return 0 ;;
    dnf) rpm -q "$pkg" >/dev/null 2>&1 && return 0 ;;
    pacman) pacman -Q "$pkg" >/dev/null 2>&1 && return 0 ;;
    zypper) rpm -q "$pkg" >/dev/null 2>&1 && return 0 ;;
    apk) apk info -e "$pkg" >/dev/null 2>&1 && return 0 ;;
    brew) brew list "$pkg" >/dev/null 2>&1 && return 0 ;;
  esac
  info "Instalando herramienta opcional: $pkg"
  install_packages "$pm" "$pkg" >/dev/null 2>&1 || return 1
}

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

PM=$(pkg_manager)
info "Gestor de paquetes detectado: $PM"

# Dependencias base. Node >=18 es necesario para los helpers HTTP usados por los scripts.
BASE_MISSING=()
have node || BASE_MISSING+=(node)
have npm || BASE_MISSING+=(npm)
have git || BASE_MISSING+=(git)
have curl || BASE_MISSING+=(curl)
have python3 || BASE_MISSING+=(python3)

if [ "${#BASE_MISSING[@]}" -gt 0 ]; then
  info "Faltan dependencias base: ${BASE_MISSING[*]}"
  case "$PM" in
    apt) install_packages apt nodejs npm git curl python3 ca-certificates ;;
    dnf) install_packages dnf nodejs npm git curl python3 ca-certificates ;;
    pacman) install_packages pacman nodejs npm git curl python ca-certificates ;;
    zypper) install_packages zypper nodejs npm git curl python3 ca-certificates ;;
    apk) install_packages apk nodejs npm git curl python3 ca-certificates ;;
    brew) install_packages brew node git curl python ;;
    *)
      err "No pude detectar un gestor de paquetes compatible. Instala Node.js 18+, npm, Git, curl y Python 3 manualmente."
      exit 1
      ;;
  esac
fi

if ! have node; then
  err "Node.js sigue sin estar disponible después de la instalación."
  exit 1
fi

NODE_MAJOR=$(node_major)
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js $NODE_MAJOR detectado. Se requiere Node.js 18 o superior. Actualízalo y vuelve a ejecutar."
  exit 1
fi

if ! have npm; then
  err "npm no está disponible. Instálalo y vuelve a ejecutar."
  exit 1
fi

# Dependencias npm del repo (hoy son cero, pero esto deja el bootstrap preparado para futuras versiones).
if [ -f package.json ]; then
  if ! node -e "const p=require('./package.json'); process.exit(Object.keys(p.dependencies||{}).every(d=>{try{require.resolve(d);return true}catch{return false}})?0:1)" 2>/dev/null; then
    info "Instalando dependencias npm..."
    npm install
  fi
fi

if [ "$INSTALL_OPTIONAL" = "1" ] && [ "$PM" != "none" ]; then
  info "Comprobando herramientas opcionales de control..."

  # Se instalan individualmente para que un paquete ausente en una distro no aborte todo el setup.
  case "$PM" in
    apt)
      OPTIONAL=(tmux wmctrl scrot python3-xlib xdotool ffmpeg v4l-utils gnome-screenshot grim slurp zip unzip)
      if [ "${XDG_CURRENT_DESKTOP:-}" = "KDE" ] || [ "${DESKTOP_SESSION:-}" = "plasma" ]; then OPTIONAL+=(kde-spectacle); fi
      ;;
    dnf) OPTIONAL=(tmux wmctrl scrot python3-xlib xdotool ffmpeg v4l-utils grim slurp zip unzip)
      ;;
    pacman) OPTIONAL=(tmux wmctrl scrot python-xlib xdotool ffmpeg v4l-utils grim slurp zip unzip)
      ;;
    zypper) OPTIONAL=(tmux wmctrl scrot python3-xlib xdotool ffmpeg v4l-utils grim slurp zip unzip)
      ;;
    apk) OPTIONAL=(tmux python3 py3-xlib ffmpeg v4l-utils zip unzip)
      ;;
    brew) OPTIONAL=(tmux ffmpeg zip)
      ;;
    *) OPTIONAL=() ;;
  esac

  for pkg in "${OPTIONAL[@]}"; do
    # No intentamos mapear paquete->binario aquí: el objetivo es completar capacidades sin bloquear el arranque.
    install_one_optional "$PM" "$pkg" || true
  done
fi

info "Dependencias base listas. Node $(node -v), npm $(npm -v)."
exit 0
