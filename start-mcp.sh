#!/bin/bash

################################################################################
#                                                                              #
#                       MCP SERVER - START                                   #
#                                                                              #
#  Inicia el servidor MCP con opciones interactivas                          #
#                                                                              #
################################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

cd "$SCRIPT_DIR"

# Mostrar menú si no hay argumentos
if [ $# -eq 0 ]; then
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}                 ${BOLD}MCP SERVER - SELECCIONA UNA OPCIÓN${NC}                      ${CYAN}║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${BOLD}1) OAuth2 (recomendado)${NC} - Autenticación con JWT"
    echo "   Ideal para: GPT, Claude, Copilot, etc"
    echo ""
    echo -e "${BOLD}2) API Key (legacy)${NC} - Autenticación simple"
    echo "   Ideal para: Desarrollo rápido"
    echo ""
    echo -e "${BOLD}3) Mostrar ayuda${NC}"
    echo ""
    
    read -p "Elige opción (1-3): " option
    
    case "$option" in
        1)
            exec "$SCRIPT_DIR/init-mcp.sh"
            ;;
        2)
            exec "$SCRIPT_DIR/init-mcp.sh" "legacy"
            ;;
        3)
            echo ""
            echo -e "${BOLD}USO:${NC}"
            echo "  ./start-mcp.sh              # Mostrar menú interactivo"
            echo "  ./start-mcp.sh oauth        # Iniciar OAuth directamente"
            echo "  ./start-mcp.sh legacy       # Iniciar API Key directamente"
            echo ""
            exit 0
            ;;
        *)
            echo -e "${RED}Opción inválida${NC}"
            exit 1
            ;;
    esac
else
    # Ejecutar con argumento directo (sin menú)
    case "$1" in
        oauth)
            exec "$SCRIPT_DIR/init-mcp.sh"
            ;;
        legacy)
            exec "$SCRIPT_DIR/init-mcp.sh" "legacy"
            ;;
        help|-h|--help)
            echo ""
            echo -e "${BOLD}MCP SERVER - QUICK START${NC}"
            echo ""
            echo -e "${BOLD}USO:${NC}"
            echo "  ./start-mcp.sh              # Mostrar menú interactivo"
            echo "  ./start-mcp.sh oauth        # Iniciar OAuth directamente"
            echo "  ./start-mcp.sh legacy       # Iniciar API Key directamente"
            echo ""
            echo -e "${BOLD}EJEMPLOS:${NC}"
            echo ""
            echo "  # Menú interactivo:"
            echo "  ./start-mcp.sh"
            echo ""
            echo "  # OAuth directamente:"
            echo "  ./start-mcp.sh oauth"
            echo ""
            echo "  # API Key directamente:"
            echo "  ./start-mcp.sh legacy"
            echo ""
            exit 0
            ;;
        *)
            echo -e "${RED}Opción desconocida: $1${NC}"
            echo "Usa: ./start-mcp.sh help"
            exit 1
            ;;
    esac
fi
