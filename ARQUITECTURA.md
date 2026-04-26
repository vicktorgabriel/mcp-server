# Arquitectura del MCP Server

## 📐 Visión General

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP SERVER (localhost:3000)              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────────┐      ┌──────────────────────┐   │
│  │   OAuth2 Provider    │      │  API Endpoints       │   │
│  │  (RFC 6749)          │      │  (/api/read, etc)    │   │
│  │                      │      │                      │   │
│  │  • /oauth/authorize  │      │  • Protegido por JWT │   │
│  │  • /oauth/token      │      │  • O API Key         │   │
│  │  • /oauth/userinfo   │      │                      │   │
│  └──────────────────────┘      └──────────────────────┘   │
│           ▲                              ▲                  │
│           │                              │                  │
│      [1]  │ [2]                      [3] │ [4]              │
│           │                              │                  │
└─────────────────────────────────────────────────────────────┘
           │                              │
      ┌────┴──────┐              ┌────────┴─────┐
      │            │              │               │
   Claude Web    Blender      Claude Web       Blender
   (conexión)    (conexión)    (acceso)        (acceso)
```

---

## 🔐 Flujo 1: OAuth2 Autorización (Primero)

```
1. Claude Web quiere conectar
   └─ Solicita: client_id=claude-web, redirect_uri=https://claude.ai/callback

2. MCP redirige al usuario a:
   └─ http://localhost:3000/oauth/authorize?client_id=claude-web&...

3. Usuario ve formulario de login
   └─ Username: mcp-admin
   └─ Password: ***

4. Usuario ve pantalla de consentimiento
   └─ ¿Autorizar acceso a archivos?
   └─ [Autorizar] [Cancelar]

5. Si autoriza:
   └─ MCP genera authorization_code
   └─ Redirige a: https://claude.ai/callback?code=abc123&state=...

6. Claude Web backend intercambia code por token
   └─ POST /oauth/token (server-to-server)
   └─ Response: {access_token: "jwt...", expires_in: 86400}

7. Claude Web recibe access_token
   └─ Guarda localmente
   └─ Ya tiene acceso
```

---

## 🔌 Flujo 2: API Acceso (Después)

```
1. Claude Web tiene access_token

2. Claude Web solicita archivos:
   └─ GET /api/list
   └─ Header: Authorization: Bearer eyJhbGc...

3. MCP verifica el token:
   └─ jwt.verify(token, JWT_SECRET)
   └─ Valida: no expirado, correcto usuario

4. MCP devuelve datos:
   └─ [lista de archivos]

5. Claude Web procesa
   └─ Muestra archivos al usuario
   └─ El usuario puede trabajar con ellos
```

---

## 🏗️ Estructura de Archivos

```
mcp-server-local/
├─ 🔵 Servidores
│  ├─ server-oauth2-provider.js      [NUEVO] RFC 6749 OAuth2
│  ├─ server-oauth.js                JWT generador (CLI)
│  └─ server.js                      API Key (legacy)
│
├─ 🟢 Scripts
│  ├─ start-mcp.sh                   Entrada principal (menú interactivo)
│  ├─ init-mcp.sh                    Automatización (setup + server)
│  └─ backup.sh                      Comprimir & guardar
│
├─ 🔴 Documentación
│  ├─ README.md                      Guía general
│  ├─ OAUTH2_PROVIDER_GUIDE.md       OAuth2 detallado (NUEVO)
│  └─ ARQUITECTURA.md                Este archivo
│
├─ 🟡 Código cliente
│  ├─ client-oauth.py                Cliente Python (OAuth)
│  ├─ client.py                      Cliente Python (JWT)
│  └─ client.js                      Cliente Node.js
│
└─ ⚙️ Configuración
   ├─ package.json
   ├─ .env                           [Generado] JWT_SECRET, PORT
   ├─ .credentials                   [Generado] Usuario + contraseña
   └─ .users.json                    [Generado] DB usuarios (temporal)
```

---

## 🎯 Opciones de Uso

### Opción A: Claude Web Solo

```
Usuario
  ↓
Cliente web de Claude
  ↓
OAuth2 Autoriza
  ↓
MCP (token)
  ↓
Archivos locales
```

### Opción B: Blender + MCP + Claude Web

```
Blender
  ↓
OAuth2 Autoriza con MCP
  ↓
MCP (token para Blender)
  ↓
Blender accede a archivos
  ↓
Blender envía datos a Claude Web
  └─→ Claude Web (puede conectar con otro token OAuth2)
  
Resultado: Blender es intermediario entre archivos locales e IA
```

### Opción C: Múltiples aplicaciones

```
Claude Web ──┐
GPT Web ────┤→ OAuth2 ──→ MCP ──→ Archivos
Blender ────┤
Custom App ─┘

Cada una con su propio token, acceso independiente
```

---

## 🔒 Seguridad

### Tokens

| Tipo | Duración | Uso | Almacenamiento |
|---|---|---|---|
| Authorization Code | 10 min | Intercambio code↔token | Servidor |
| Access Token (JWT) | 24h | Acceso a API | Cliente |
| Refresh Token | ∞ | Renovar access | Cliente |

### Validaciones

- ✅ Client ID debe ser conocido (en KNOWN_CLIENTS)
- ✅ Client Secret correcto (server-to-server solamente)
- ✅ Redirect URI debe coincidir exactamente
- ✅ Authorization Code expira rápido (10 min)
- ✅ Access Token lleva JWT firmado
- ✅ Todas las rutas logueadas

### RFC 6749 Compliance

- ✅ Authorization Code Grant
- ✅ Refresh Token Grant
- ✅ Client Secret validation
- ✅ Redirect URI validation
- ✅ Authorization Code expiration
- ✅ HTTPS ready (agrega certificate para producción)

---

## 🌐 Endpoints

### OAuth2 (Autorización)

```
GET  /oauth/authorize?client_id=...&redirect_uri=...
     → Formulario login + consentimiento
     → Redirige con code

POST /oauth/token (grant_type=authorization_code)
     → Intercambia code por token

POST /oauth/token (grant_type=refresh_token)
     → Renueva access token

GET  /oauth/userinfo
     → Info del usuario (requiere token)

GET  /.well-known/oauth-authorization-server
     → Discovery (para auto-configuración)
```

### API (Acceso a datos)

```
GET  /api/list
     → Lista archivos (requiere token)

GET  /api/read?path=...
     → Lee archivo (requiere token)

POST /api/write
     → Escribe archivo (requiere token)

POST /api/execute
     → Ejecuta comando (requiere token)
```

---

## 🚀 Flujos de Uso

### 1️⃣ Primera vez (usuario local)

```bash
$ ./start-mcp.sh

Elige: 1 (OAuth2)

[Se genera usuario + contraseña]
[Se inicia servidor]
[Se espera solicitud de cliente]
```

### 2️⃣ Cliente se conecta (ejemplo Claude Web)

```
Claude Web: "Quiero conectar a MCP"
  ↓
Claude Web abre: http://localhost:3000/oauth/authorize?...
  ↓
Usuario ve login y autoriza
  ↓
Claude Web recibe token
  ↓
Claude Web accede a /api/list, /api/read, etc
```

### 3️⃣ Múltiples clientes

```
Mismo servidor, múltiples tokens
Cada cliente autoriza independientemente
Todos acceden simultáneamente
```

---

## 💾 Datos Generados

### Primer Init

```
.env
├─ JWT_SECRET=abc123...
├─ JWT_EXPIRY=24h
├─ PORT=3000
└─ ALLOWED_PATHS=/mnt/4tb-hdd/repo

.credentials
├─ USERNAME=mcp-admin
├─ EMAIL=admin@mcp.local
└─ PASSWORD=random-password

.users.json
└─ {
    "mcp-admin": {
      "email": "admin@mcp.local",
      "passwordHash": "$2b$10/...",
      "createdAt": "2024-..."
    }
  }
```

### Runtime

```
authorizationCodes (Map)
└─ Temporal, se limpia al intercambiarse

refreshTokens (Map)
└─ Guardado en memoria
└─ Se pierde si reinicia servidor
└─ (producción: usar Redis/DB)
```

---

## 🔧 Configuración

### Cambiar puerto

```bash
PORT=8000 ./start-mcp.sh oauth
```

### Agregar nuevo cliente

Editar `server-oauth2-provider.js`:

```javascript
const KNOWN_CLIENTS = {
  'my-client': {
    name: 'Mi Cliente',
    secret: 'my-secret-key',
    redirectUris: ['https://myapp.com/callback']
  }
};
```

### Con ngrok (exponerlo públicamente)

```bash
./start-mcp.sh oauth

¿Activar ngrok? s

Resultado: https://abc123.ngrok.io
→ Usar esta URL en clientes remotos
```

---

## 📈 Escalabilidad

### Desarrollo

```
✅ En-memoria (Maps)
✅ Un usuario
✅ Para testing local
```

### Producción

```
❌ Problemas actuales:
  • tokens en-memoria
  • usuarios en-memoria
  • sesiones no persistentes

✅ Necesitaría:
  • Base de datos (PostgreSQL/MongoDB)
  • Redis para tokens
  • HTTPS (certificados SSL)
  • Rate limiting
  • CORS configurado
  • Audit logs persistidos
```

---

## 🎓 Conceptos Clave

### OAuth2 (RFC 6749)

Es un estándar de delegación. No autenticación, sino autorización.

- **Resource Owner**: Usuario (tú)
- **Client**: App que quiere acceder (Claude Web, Blender)
- **Resource Server**: Servidor que tiene los recursos (MCP)
- **Authorization Server**: Servidor que autoriza (MCP también)

### JWT (JSON Web Token)

Token autofirmado. El servidor firma, el servidor verifica.

```
Header.Payload.Signature

{
  "userId": "mcp-admin",
  "clientId": "claude-web",
  "scope": "full",
  "iat": 1234567890,
  "exp": 1234571490
}
```

### Refresh Token

Token que solo sirve para pedir otro access token.

```
Access Token: Expira en 24h (seguro)
Refresh Token: No expira (guardado seguro)

Cuando exp vence:
  Cliente usa refresh_token
  → Servidor genera nuevo access_token
  → Cliente continúa sin re-autenticar
```

---

## 📚 Referencias

- RFC 6749 - OAuth 2.0 Authorization Framework
- RFC 6750 - OAuth 2.0 Bearer Token Usage
- RFC 7519 - JSON Web Token (JWT)
- OpenID Connect (extensión de OAuth2)

