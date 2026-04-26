#!/bin/bash

################################################################################
#                                                                              #
#                    MCP SERVER - AUTOMATIC SETUP v2.0                        #
#                                                                              #
#  Inicialización automática con OAuth2 + creación de usuario si es necesario #
#                                                                              #
################################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USERS_FILE="$SCRIPT_DIR/.users.json"
CREDENTIALS_FILE="$SCRIPT_DIR/.credentials"
ENV_FILE="$SCRIPT_DIR/.env"
LOG_FILE="$SCRIPT_DIR/mcp-server.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

################################################################################
# FUNCIONES AUXILIARES
################################################################################

print_header() {
    echo -e "\n${CYAN}╔═══════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}                    ${BOLD}MCP SERVER - AUTO SETUP${NC}                            ${CYAN}║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════════╝${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_section() {
    echo -e "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}$1${NC}"
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

################################################################################
# VERIFICAR DEPENDENCIAS
################################################################################

check_dependencies() {
    print_section "🔍 Verificando dependencias"
    
    local missing=0
    
    # Verificar Node.js
    if ! command -v node &> /dev/null; then
        print_error "Node.js no está instalado"
        missing=1
    else
        local version=$(node --version)
        print_success "Node.js: $version"
    fi
    
    # Verificar npm
    if ! command -v npm &> /dev/null; then
        print_error "npm no está instalado"
        missing=1
    else
        local version=$(npm --version)
        print_success "npm: $version"
    fi
    
    # Verificar Python (para cliente)
    if ! command -v python3 &> /dev/null; then
        print_warning "Python3 no encontrado (necesario para cliente-oauth.py)"
    else
        local version=$(python3 --version 2>&1)
        print_success "$version"
    fi
    
    if [ $missing -eq 1 ]; then
        print_error "Faltan dependencias requeridas"
        exit 1
    fi
}

################################################################################
# INICIALIZAR CREDENCIALES
################################################################################

create_default_credentials() {
    print_section "🔐 Creando credenciales por defecto"
    
    # Generar usuario y contraseña aleatorios
    local username="mcp-admin"
    local email="admin@mcp.local"
    local password=$(openssl rand -base64 12)
    
    # Guardar credenciales
    cat > "$CREDENTIALS_FILE" << EOF
# MCP Server Credentials
# IMPORTANTE: Guarda estas credenciales en un lugar seguro
# Date: $(date)

USERNAME=$username
EMAIL=$email
PASSWORD=$password
EOF
    
    chmod 600 "$CREDENTIALS_FILE"
    
    print_success "Credenciales generadas"
    print_info "Usuario: $username"
    print_info "Email: $email"
    print_info "Contraseña: $password"
    
    echo "$username|$email|$password"
}

################################################################################
# VERIFICAR USUARIOS
################################################################################

check_users_exist() {
    [ -f "$USERS_FILE" ] && [ -s "$USERS_FILE" ] && [ "$(cat "$USERS_FILE")" != "{}" ]
}

create_default_user() {
    print_section "👤 Creando usuario por defecto"
    
    # Leer credenciales
    if [ -f "$CREDENTIALS_FILE" ]; then
        source "$CREDENTIALS_FILE"
    else
        local creds=$(create_default_credentials)
        USERNAME=$(echo "$creds" | cut -d'|' -f1)
        EMAIL=$(echo "$creds" | cut -d'|' -f2)
        PASSWORD=$(echo "$creds" | cut -d'|' -f3)
    fi
    
    # Crear archivo de usuarios temporal
    cat > "$USERS_FILE" << EOF
{
  "$USERNAME": {
    "email": "$EMAIL",
    "password_hash": "$PASSWORD",
    "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  }
}
EOF
    
    print_success "Usuario creado: $USERNAME"
}

################################################################################
# VERIFICAR VARIABLES DE ENTORNO
################################################################################

setup_env() {
    print_section "⚙️  Configurando variables de entorno"
    
    # Verificar si .env existe
    if [ ! -f "$ENV_FILE" ]; then
        # Generar JWT_SECRET si no existe
        local jwt_secret=$(openssl rand -base64 32)
        
        cat > "$ENV_FILE" << EOF
# MCP Server OAuth Configuration
# Generated: $(date)

JWT_SECRET=$jwt_secret
JWT_EXPIRY=24h
PORT=3000
NODE_ENV=production

# Allowed paths (comma-separated)
ALLOWED_PATHS=/mnt/4tb-hdd/repo

# OAuth Provider Config (Optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
EOF
        
        print_success ".env creado con configuración OAuth"
    else
        print_success ".env existe"
    fi
    
    # Verificar que JWT_SECRET esté configurado
    if ! grep -q "JWT_SECRET" "$ENV_FILE"; then
        local jwt_secret=$(openssl rand -base64 32)
        echo "JWT_SECRET=$jwt_secret" >> "$ENV_FILE"
        print_success "JWT_SECRET añadido"
    fi
}

################################################################################
# INSTALAR DEPENDENCIAS NPM
################################################################################

install_dependencies() {
    print_section "📦 Instalando dependencias Node.js"
    
    if [ ! -d "node_modules" ]; then
        print_info "Ejecutando npm install..."
        npm install --quiet
        print_success "Dependencias instaladas"
    else
        print_success "Dependencias ya instaladas"
    fi
}

################################################################################
# GENERAR JWT TOKEN
################################################################################

generate_jwt_token() {
    # Este token es generado por el servidor al iniciar
    # Aquí solo lo mostramos en la documentación
    echo "token_será_generado_al_iniciar"
}

################################################################################
# MENÚ INTERACTIVO
################################################################################

show_menu() {
    print_section "🚀 ¿Qué deseas hacer?"
    
    echo -e "${CYAN}1)${NC} ${BOLD}Iniciar servidor OAuth${NC}"
    echo -e "   Usa JWT para seguridad máxima (recomendado para GPT, Claude, Copilot)"
    echo ""
    echo -e "${CYAN}2)${NC} ${BOLD}Iniciar servidor Legacy (API Key)${NC}"
    echo -e "   Usa solo API Key (más simple, menos seguro)"
    echo ""
    echo -e "${CYAN}3)${NC} ${BOLD}Registrar nuevo usuario${NC}"
    echo -e "   Crear credenciales adicionales"
    echo ""
    echo -e "${CYAN}4)${NC} ${BOLD}Mostrar credenciales actuales${NC}"
    echo ""
    echo -e "${CYAN}5)${NC} ${BOLD}Salir${NC}"
    echo ""
    echo -n "Selecciona una opción (1-5): "
}

get_current_credentials() {
    if [ -f "$CREDENTIALS_FILE" ]; then
        source "$CREDENTIALS_FILE"
        echo "$USERNAME|$EMAIL|$PASSWORD"
    else
        echo ""
    fi
}

################################################################################
# INICIAR SERVIDOR OAUTH
################################################################################

check_ngrok_installed() {
    if ! command -v ngrok &> /dev/null; then
        return 1
    fi
    return 0
}

start_ngrok_tunnel() {
    local port=$1
    local log_file="/tmp/ngrok-$port.log"
    
    print_info "Iniciando ngrok en background..."
    
    ngrok http $port --log stdout > "$log_file" 2>&1 &
    local ngrok_pid=$!
    
    # Esperar a que ngrok se inicie
    sleep 3
    
    # Intentar obtener la URL de ngrok
    local ngrok_url=""
    for i in {1..10}; do
        ngrok_url=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"[^"]*' | cut -d'"' -f4 | head -1)
        if [ ! -z "$ngrok_url" ]; then
            break
        fi
        sleep 1
    done
    
    if [ ! -z "$ngrok_url" ]; then
        echo "$ngrok_url"
        return 0
    else
        print_warning "No se pudo obtener URL de ngrok"
        return 1
    fi
}

start_oauth_server() {
    print_section "🔐 Iniciando MCP Server con OAuth2"
    
    # Asegurar que se usa server-oauth.js
    if [ ! -f "server-oauth.js" ]; then
        print_error "server-oauth.js no encontrado"
        exit 1
    fi
    
    # Leer credenciales
    source "$CREDENTIALS_FILE"
    
    print_info "Configuración:"
    echo ""
    print_info "Servidor Local: ${BOLD}http://localhost:3000${NC}"
    print_info "Usuario: ${BOLD}$USERNAME${NC}"
    print_info "Contraseña: ${BOLD}$PASSWORD${NC}"
    echo ""
    
    # Preguntar si usar ngrok
    local use_ngrok=0
    if check_ngrok_installed; then
        echo -n "¿Exponer con ngrok para acceso remoto? (s/n): "
        read -r ngrok_choice
        if [[ "$ngrok_choice" =~ ^[Ss]$ ]]; then
            use_ngrok=1
        fi
    fi
    
    # Iniciar servidor en background
    print_info "Iniciando servidor Express..."
    node server-oauth.js >> "$LOG_FILE" 2>&1 &
    local server_pid=$!
    
    # Esperar a que el servidor se inicie
    sleep 2
    
    # Iniciar ngrok si fue seleccionado
    local ngrok_url=""
    local ngrok_pid=""
    if [ $use_ngrok -eq 1 ]; then
        ngrok_url=$(start_ngrok_tunnel 3000)
        if [ $? -eq 0 ]; then
            print_success "ngrok iniciado: $ngrok_url"
            ngrok_pid=$!
        fi
    fi
    
    # Mostrar instrucciones para diferentes plataformas
    show_setup_instructions "$USERNAME" "$PASSWORD" "$ngrok_url"
    
    echo ""
    echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}✓ Servidor corriendo (PID: $server_pid)${NC}"
    if [ ! -z "$ngrok_pid" ]; then
        echo -e "${GREEN}✓ ngrok corriendo (PID: $ngrok_pid)${NC}"
    fi
    echo -e "${GREEN}Presiona Ctrl+C para detener${NC}"
    echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    
    # Mantener los procesos en background
    trap "kill $server_pid $ngrok_pid 2>/dev/null; exit" EXIT INT TERM
    wait $server_pid
}

################################################################################
# INICIAR SERVIDOR LEGACY
################################################################################

start_legacy_server() {
    print_section "🔑 Iniciando MCP Server con API Key (Legacy)"
    
    if [ ! -f "server.js" ]; then
        print_error "server.js no encontrado"
        exit 1
    fi
    
    if [ ! -f ".api-key" ]; then
        print_error ".api-key no encontrado"
        exit 1
    fi
    
    local api_key=$(cat .api-key)
    
    print_info "Configuración:"
    echo ""
    print_info "Servidor: ${BOLD}http://localhost:3000${NC}"
    print_info "API Key: ${BOLD}$api_key${NC}"
    echo ""
    print_warning "Nota: API Key es menos seguro que OAuth. Considera usar OAuth para GPT/Claude."
    echo ""
    print_info "Uso con curl:"
    echo "  ${BOLD}curl -H 'X-API-Key: $api_key' http://localhost:3000/api/list?path=/${NC}"
    echo ""
    
    echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}Iniciando servidor... (Presiona Ctrl+C para detener)${NC}"
    echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    
    node server.js 2>&1 | tee -a "$LOG_FILE"
}

################################################################################
# MOSTRAR INSTRUCCIONES DE SETUP
################################################################################

show_setup_instructions() {
    local username=$1
    local password=$2
    local ngrok_url=$3
    
    print_section "📋 Instrucciones para conectar con IA"
    
    echo ""
    echo -e "${BOLD}PASO 1: Login para obtener JWT Token${NC}"
    echo "────────────────────────────────────"
    echo ""
    echo "En otra terminal, ejecuta:"
    echo ""
    echo -e "  ${BOLD}cd $SCRIPT_DIR${NC}"
    echo -e "  ${BOLD}python3 client-oauth.py login $username $password${NC}"
    echo ""
    echo "Resultado: JWT Token (eyJ...)"
    echo ""
    
    echo -e "${BOLD}PASO 2: Usar con GPT/Claude/Copilot${NC}"
    echo "─────────────────────────────────────"
    echo ""
    
    # GPT Desktop
    echo -e "${CYAN}A. GPT Desktop / Claude Desktop:${NC}"
    echo "   Edita ~/.claude_desktop_config.json:"
    echo ""
    echo -e "   ${BOLD}{"
    echo "     \"mcpServers\": {"
    echo "       \"mcp_local\": {"
    echo "         \"command\": \"node\","
    echo "         \"args\": [\"$SCRIPT_DIR/server-oauth.js\"]"
    echo "       }"
    echo "     }"
    echo "   }${NC}"
    echo ""
    
    # URLs según disponibilidad de ngrok
    if [ ! -z "$ngrok_url" ]; then
        echo -e "${CYAN}B. Acceso remoto (ngrok):${NC}"
        echo ""
        echo -e "   ${BOLD}URL Pública:${NC} $ngrok_url"
        echo ""
        echo -e "   Usa esta URL en tu aplicación remota:"
        echo -e "   ${BOLD}curl -H 'Authorization: Bearer JWT_TOKEN' \\"
        echo "        $ngrok_url/api/list?path=/${NC}"
        echo ""
    fi
    
    # cURL local
    echo -e "${CYAN}C. Desde cURL local:${NC}"
    echo ""
    echo -e "   ${BOLD}export JWT=\"JWT_TOKEN_AQUI\"${NC}"
    echo -e "   ${BOLD}curl -H \"Authorization: Bearer \$JWT\" \\"
    echo "        http://localhost:3000/api/list?path=/${NC}"
    echo ""
    
    # Python
    echo -e "${CYAN}D. Desde Python:${NC}"
    echo ""
    echo -e "   ${BOLD}export MCP_JWT_TOKEN=\"JWT_TOKEN_AQUI\"${NC}"
    echo -e "   ${BOLD}python3 $SCRIPT_DIR/client-oauth.py list /${NC}"
    echo ""
    
    # Node.js
    echo -e "${CYAN}E. Desde Node.js:${NC}"
    echo ""
    echo -e "   ${BOLD}const token = \"JWT_TOKEN_AQUI\";${NC}"
    echo -e "   ${BOLD}const response = await fetch('http://localhost:3000/api/list?path=/', {"
    echo "     headers: { 'Authorization': \`Bearer \${token}\` }"
    echo "   });${NC}"
    echo ""
    
    echo -e "${YELLOW}💾 CREDENCIALES GUARDADAS EN: $CREDENTIALS_FILE${NC}"
    echo ""
}

################################################################################
# REGISTRAR NUEVO USUARIO
################################################################################

register_new_user() {
    print_section "👤 Registrar nuevo usuario"
    
    echo ""
    read -p "Nombre de usuario: " new_username
    read -p "Email: " new_email
    read -p "Contraseña: " new_password
    
    print_info "Ejecutando registro..."
    
    python3 client-oauth.py register "$new_username" "$new_email" "$new_password"
    
    if [ $? -eq 0 ]; then
        print_success "Usuario $new_username registrado correctamente"
    else
        print_error "Error al registrar usuario"
    fi
    
    echo ""
    read -p "Presiona Enter para continuar..."
}

################################################################################
# MOSTRAR CREDENCIALES
################################################################################

show_credentials() {
    print_section "🔐 Credenciales actuales"
    
    if [ -f "$CREDENTIALS_FILE" ]; then
        echo ""
        source "$CREDENTIALS_FILE"
        echo -e "${BOLD}Usuario:${NC} $USERNAME"
        echo -e "${BOLD}Email:${NC} $EMAIL"
        echo -e "${BOLD}Contraseña:${NC} $PASSWORD"
        echo ""
        echo -e "${YELLOW}Nota: Guarda estas credenciales en un lugar seguro${NC}"
    else
        print_error "No hay credenciales guardadas"
    fi
    
    echo ""
    read -p "Presiona Enter para continuar..."
}

################################################################################
# MAIN
################################################################################

main() {
    local mode="${1:-menu}"
    
    print_header
    
    # Verificar dependencias
    check_dependencies
    
    # Configurar entorno
    setup_env
    
    # Instalar dependencias
    install_dependencies
    
    # Verificar usuarios, crear si es necesario
    if ! check_users_exist; then
        print_warning "No hay usuarios configurados"
        create_default_user
    else
        print_success "Usuarios ya configurados"
    fi
    
    # Si se pasa "oauth" o "legacy", ejecutar directamente sin menú
    if [ "$mode" = "oauth" ]; then
        start_oauth_server
        exit $?
    elif [ "$mode" = "legacy" ]; then
        start_legacy_server
        exit $?
    fi
    
    # Menú interactivo (si no se pasa argumento)
    while true; do
        print_header
        show_menu
        
        read -r choice
        
        case $choice in
            1)
                start_oauth_server
                ;;
            2)
                start_legacy_server
                ;;
            3)
                register_new_user
                ;;
            4)
                show_credentials
                ;;
            5)
                print_info "Hasta luego!"
                exit 0
                ;;
            *)
                print_error "Opción inválida"
                sleep 1
                ;;
        esac
    done
}

# Ejecutar main con argumento si se proporciona
main "$@"
