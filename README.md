# MCP Server - Servidor de Archivos con OAuth2

**Todo completamente automatizado. Un comando, un archivo de guía.**

---

## 🚀 Inicio Rápido

```bash
cd /mnt/4tb-hdd/repo/mcp-server-local
./start-mcp.sh
```

**Se mostrará un menú interactivo donde puedes elegir:**

```
1) OAuth2 (recomendado)
2) API Key (legacy)
3) Mostrar ayuda
```

**Elige una opción y presiona Enter.**

---

## 📋 Primer Inicio vs Próximos Inicios

### 🟢 PRIMER INICIO (15-30 segundos)

```bash
$ ./start-mcp.sh

↓ Verás el menú interactivo:

  1) OAuth2 (recomendado)
     Usa JWT para seguridad máxima
  
  2) API Key (legacy)
     Usa solo API Key (más simple)
  
  3) Mostrar ayuda

Selecciona una opción (1-3): 1
↓ (presiona Enter después de escribir)

↓ El script automáticamente:
  1. Crea .env con JWT_SECRET
  2. Instala dependencias npm
  3. Crea usuario: mcp-admin
  4. Genera contraseña ALEATORIA
  5. Muestra en pantalla ← GUARDA ESTA CONTRASEÑA
  6. Crea .credentials (permisos 600)
  7. Inicia servidor OAuth (puerto 3000)
  8. Pregunta: ¿ngrok? (s/n)
  9. Muestra instrucciones finales
  10. Servidor esperando
```

**Debes guardar:**
```
Username:   mcp-admin
Email:      admin@mcp.local
Password:   (mostrada en pantalla)
```

---

### 🔄 PRÓXIMOS INICIOS (10-20 segundos)

```bash
$ ./start-mcp.sh

↓ Verás el menú interactivo (igual que antes)

Selecciona una opción (1-3): 1
↓ (presiona Enter después de escribir)

↓ El script automáticamente:
  1. Lee .env (ya existe)
  2. Lee node_modules (ya existe)
  3. Lee .users.json (usuario ya existe)
  4. NO crea nuevo usuario
  5. NO genera nueva contraseña
  6. Inicia servidor OAuth
  7. Pregunta: ¿ngrok? (s/n)
  8. Muestra instrucciones
  9. Servidor esperando
```

**Más rápido porque reutiliza todo.**

---

## 🔐 Credenciales

### Primer Inicio: Generadas Automáticamente

```
Username:   mcp-admin
Email:      admin@mcp.local
Password:   (ALEATORIA, mostrada en pantalla)
```

**Guardadas en `.credentials`** (permisos 600 - solo lectura)

### Próximos Inicios: Reutilizadas

```bash
cat .credentials
```

Mismo usuario, misma contraseña de siempre.

---

## 🔐 Dos Modos de OAuth2

El sistema tiene dos servidores disponibles:

### 1️⃣ OAuth2 Provider (para conectar desde web)

**Archivo:** `server-oauth2-provider.js`

Proveedor OAuth2 estándar (RFC 6749) compatible con:
- ✅ Claude Web
- ✅ ChatGPT Web  
- ✅ Blender
- ✅ Cualquier aplicación que soporte OAuth2
- ✅ Intermediario entre aplicaciones e IA

**Flujo de autorización:**
```
Aplicación (Blender/Claude Web)
    ↓
Redirige a: http://localhost:3000/oauth/authorize
    ↓
Usuario ve formulario de login
    ↓
Usuario autoriza
    ↓
Sistema envía token a la aplicación
    ↓
Aplicación puede acceder al MCP con el token
```

**Endpoints OAuth2 estándar:**
- `GET /oauth/authorize` - Formulario de login y consentimiento
- `POST /oauth/token` - Obtener access token
- `GET /oauth/userinfo` - Información del usuario
- `GET /.well-known/oauth-authorization-server` - Discovery

### 2️⃣ OAuth2 Simple (servidor actual)

**Archivo:** `server-oauth.js`

Genera JWT tokens de manera simple para CLI.

---

## 🌐 Conectar desde GPT/Claude/Copilot

El servidor proporciona instrucciones automáticamente al iniciar:

```
────────────────────────────────────────────────────
INSTRUCCIONES PARA CONECTAR
────────────────────────────────────────────────────

1. En tu cliente (GPT/Claude/Copilot):

   URL Base: http://localhost:3000
   Username: mcp-admin
   Password: [tu contraseña]
   
   (O si activaste ngrok: https://[tu-ngrok-url])

2. Autenticación:

   POST /auth/login
   {
     "username": "mcp-admin",
     "password": "[tu-contraseña]"
   }
   
   Respuesta:
   {
     "token": "eyJhbGc..."
   }

3. Usar el token:

   GET /api/list
   Header: Authorization: Bearer [tu-token]

4. Operaciones disponibles:

   GET  /api/list      - Listar archivos
   GET  /api/read      - Leer archivo
   POST /api/write     - Escribir archivo
   POST /api/execute   - Ejecutar comando

5. Renovar token (cada 24h):

   POST /auth/refresh
   Header: Authorization: Bearer [tu-token]

────────────────────────────────────────────────────
```

### Con ngrok (túnel público)

Si respondiste **sí** a la pregunta `¿ngrok?`:

```
ngrok iniciado: https://abc123def.ngrok.io

Usa esta URL en lugar de http://localhost:3000
```

**Nueva URL pública cada vez que inicies.**

---

## 📁 Estructura de Archivos

```
mcp-server-local/
├── README.md                 ← Este archivo (guía completa)
├── start-mcp.sh              ← Único arrancador
├── init-mcp.sh               ← Automatización (no tocar)
├── package.json
├── server-oauth.js           ← Servidor OAuth2
├── client-oauth.py           ← Cliente Python
├── server.js                 ← Servidor legacy (opcional)
├── client.py                 ← Cliente legacy (opcional)
└── [Generados en primer inicio]
    ├── .env                  ← JWT_SECRET + configuración
    ├── .credentials          ← Usuario + contraseña
    ├── .users.json           ← Base de datos usuarios (temporal)
    ├── node_modules/         ← Dependencias npm
    └── mcp-server.log        ← Logs del servidor
```

---

## 🗜️ Comprimir y Guardar en Otro Lado

### Opción 1: Ligero (SIN dependencias)

```bash
./backup.sh
# Elige opción 1 (LIGERO)
```

**Resultado:** `~/backups/backup_TIMESTAMP.tar.gz` (~100KB)

Ideal para guardar proyecto limpio, sin node_modules.

### Opción 2: Manual rápido

```bash
tar --exclude='node_modules' \
    --exclude='.env' \
    --exclude='.credentials' \
    --exclude='.users.json' \
    --exclude='mcp-server.log' \
    -czf mcp-server-local-backup.tar.gz mcp-server-local/
```

### Restaurar en otra máquina

```bash
tar -xzf mcp-server-local-backup.tar.gz
cd mcp-server-local
./start-mcp.sh    ← El script crea usuario si es necesario
```

---

## 📊 Comportamiento Resumido

| Aspecto | Primer Inicio | Próximos Inicios |
|--------|--------------|-----------------|
| **Crear usuario** | ✓ SÍ | ✓ NO |
| **Generar contraseña** | ✓ SÍ (muestra) | ✓ NO (reutiliza) |
| **npm install** | ✓ SÍ (si falta) | ✓ NO (ya existe) |
| **Tiempo** | 15-30 seg | 10-20 seg |
| **.env** | CREADO | Reutilizado |
| **.credentials** | CREADO | Reutilizado |
| **Instrucciones** | Mostradas | Mostradas |

---

## 🔧 Configuración Avanzada

### Usar directamente sin menú

```bash
# Iniciar OAuth directamente
./start-mcp.sh oauth

# Iniciar API Key directamente
./start-mcp.sh legacy

# Ver ayuda
./start-mcp.sh help
```

### Cambiar puerto (por defecto 3000)

```bash
# En start-mcp.sh o init-mcp.sh, busca:
PORT=${PORT:-3000}

# Cambia a:
PORT=${PORT:-8080}
```

### Cambiar carpeta expuesta (por defecto /mnt/4tb-hdd/repo)

```bash
# En .env:
ALLOWED_PATHS=/ruta/que/quieras
```

### Desactivar ngrok (siempre local)

```bash
# En start-mcp.sh, busca:
read -p "¿Activar ngrok? (s/n): " ngrok_answer

# Cambia a:
ngrok_answer="n"
```

---

## 🐛 Troubleshooting

### Error: "Node.js no encontrado"
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install nodejs
```

### Error: "ngrok no encontrado"
```bash
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok-v3-stable-linux-amd64.zip | unzip -
sudo mv ngrok /usr/local/bin/
```

### Cambiar credenciales (crear nuevo usuario)

```bash
# Elimina archivos de estado:
rm .credentials .users.json .env

# Reinicia:
./start-mcp.sh

# El script automáticamente crea nuevo usuario
```

### Ver contraseña guardada

```bash
cat .credentials
```

### Ver logs del servidor

```bash
tail -f mcp-server.log
```

---

## 📌 Resumen

```
1 GUÍA COMPLETA:   README.md (este archivo)
1 ARRANCADOR:      start-mcp.sh
1 AUTOMATIZACIÓN:  init-mcp.sh (se ejecuta automáticamente)

COMANDO ÚNICO:     ./start-mcp.sh

Primer inicio:     Crea usuario + contraseña
Próximos inicios:  Reutiliza usuario + contraseña
Comprime:          ./backup.sh
Restaura:          tar -xzf + ./start-mcp.sh
```

---

## ✅ Listo

Ejecuta:
```bash
./start-mcp.sh
```

Guarda la contraseña (primer inicio).

**Eso es todo.**

