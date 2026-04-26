#!/bin/bash

################################################################################
#                                                                              #
#                    MCP SERVER - BACKUP & COMPRESS SCRIPT                    #
#                                                                              #
#  Facilita la compresión de la carpeta para guardar o compartir              #
#                                                                              #
################################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$REPO_DIR/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║${NC}       MCP SERVER - BACKUP & COMPRESS UTILITY         ${BLUE}║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}\n"

# Crear directorio de backups si no existe
mkdir -p "$BACKUP_DIR"

echo -e "${BOLD}¿Qué tipo de backup deseas crear?${NC}\n"
echo -e "${BLUE}1)${NC} ${BOLD}Backup LIGERO${NC}"
echo "   ├─ Sin node_modules (se regenerarán)"
echo "   ├─ Sin .env, .credentials, .users.json (se crearán en primer inicio)"
echo "   ├─ Sin logs"
echo "   ├─ Tamaño: ~100KB"
echo "   └─ Ideal para: guardar/compartir la base del proyecto"
echo ""
echo -e "${BLUE}2)${NC} ${BOLD}Backup COMPLETO${NC}"
echo "   ├─ Con todo: configuración, usuarios, dependencias"
echo "   ├─ Tamaño: ~100-500MB (por node_modules)"
echo "   └─ Ideal para: compartir setup ya configurado"
echo ""
echo -e "${BLUE}3)${NC} ${BOLD}Backup OPTIMIZADO${NC}"
echo "   ├─ Sin node_modules (pesado)"
echo "   ├─ Con .env, .credentials, .users.json"
echo "   ├─ Tamaño: ~200KB"
echo "   └─ Ideal para: mejor balance"
echo ""
echo -e "${BLUE}4)${NC} ${BOLD}Cancelar${NC}"
echo ""
echo -n "Selecciona (1-4): "

read -r choice

case $choice in
    1)
        # Backup ligero
        echo -e "\n${YELLOW}⏳ Creando backup LIGERO...${NC}\n"
        
        BACKUP_FILE="$BACKUP_DIR/mcp-server-light_${TIMESTAMP}.tar.gz"
        
        cd "$REPO_DIR"
        tar --exclude='mcp-server-local/node_modules' \
            --exclude='mcp-server-local/.env' \
            --exclude='mcp-server-local/.credentials' \
            --exclude='mcp-server-local/.users.json' \
            --exclude='mcp-server-local/.api-key' \
            --exclude='mcp-server-local/mcp-server.log' \
            --exclude='.git' \
            --exclude='.DS_Store' \
            -czf "$BACKUP_FILE" mcp-server-local/
        
        SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
        
        echo -e "${GREEN}✓ Backup creado exitosamente${NC}"
        echo -e "${GREEN}✓ Ubicación: $BACKUP_FILE${NC}"
        echo -e "${GREEN}✓ Tamaño: $SIZE${NC}"
        echo ""
        echo -e "${YELLOW}Nota:${NC} Este backup NO incluye:"
        echo "  - node_modules (se regenerarán con npm install)"
        echo "  - .env (se creará en primer inicio)"
        echo "  - .credentials (se creará en primer inicio)"
        echo "  - .users.json (se creará en primer inicio)"
        echo ""
        echo -e "${BLUE}Para restaurar:${NC}"
        echo "  tar -xzf $BACKUP_FILE -C /destino/"
        echo "  cd /destino/mcp-server-local"
        echo "  ./start-mcp.sh"
        ;;
        
    2)
        # Backup completo
        echo -e "\n${YELLOW}⏳ Creando backup COMPLETO...${NC}\n"
        
        BACKUP_FILE="$BACKUP_DIR/mcp-server-full_${TIMESTAMP}.tar.gz"
        
        cd "$REPO_DIR"
        tar --exclude='.git' \
            --exclude='.DS_Store' \
            -czf "$BACKUP_FILE" mcp-server-local/
        
        SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
        
        echo -e "${GREEN}✓ Backup creado exitosamente${NC}"
        echo -e "${GREEN}✓ Ubicación: $BACKUP_FILE${NC}"
        echo -e "${GREEN}✓ Tamaño: $SIZE${NC}"
        echo ""
        echo -e "${YELLOW}Nota:${NC} Este backup INCLUYE:"
        echo "  - node_modules (peso: ~200MB)"
        echo "  - .env (configuración)"
        echo "  - .credentials (usuarios y contraseñas)"
        echo "  - .users.json (base de datos)"
        echo ""
        echo -e "${BLUE}Para restaurar:${NC}"
        echo "  tar -xzf $BACKUP_FILE -C /destino/"
        echo "  cd /destino/mcp-server-local"
        echo "  ./start-mcp.sh"
        ;;
        
    3)
        # Backup optimizado
        echo -e "\n${YELLOW}⏳ Creando backup OPTIMIZADO...${NC}\n"
        
        BACKUP_FILE="$BACKUP_DIR/mcp-server-opt_${TIMESTAMP}.tar.gz"
        
        cd "$REPO_DIR"
        tar --exclude='mcp-server-local/node_modules' \
            --exclude='mcp-server-local/mcp-server.log' \
            --exclude='.git' \
            --exclude='.DS_Store' \
            -czf "$BACKUP_FILE" mcp-server-local/
        
        SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
        
        echo -e "${GREEN}✓ Backup creado exitosamente${NC}"
        echo -e "${GREEN}✓ Ubicación: $BACKUP_FILE${NC}"
        echo -e "${GREEN}✓ Tamaño: $SIZE${NC}"
        echo ""
        echo -e "${YELLOW}Nota:${NC} Este backup EXCLUYE:"
        echo "  - node_modules (se regenerarán)"
        echo "  - logs"
        echo ""
        echo -e "${YELLOW}Este backup INCLUYE:${NC}"
        echo "  - .env (configuración)"
        echo "  - .credentials (usuarios)"
        echo "  - .users.json (base de datos)"
        echo ""
        echo -e "${BLUE}Para restaurar:${NC}"
        echo "  tar -xzf $BACKUP_FILE -C /destino/"
        echo "  cd /destino/mcp-server-local"
        echo "  npm install"
        echo "  ./start-mcp.sh"
        ;;
        
    4)
        echo -e "${YELLOW}Cancelado${NC}"
        exit 0
        ;;
        
    *)
        echo -e "${YELLOW}Opción inválida${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Backup guardado en: /mnt/4tb-hdd/repo/backups/${NC}"
echo -e "${GREEN}✓ Puedes comprimir y guardar en otro lado${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}\n"
