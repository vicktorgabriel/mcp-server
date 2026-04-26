# OAuth2 Provider - Guía de Uso

## 📌 Resumen

El MCP Server incluye un proveedor OAuth2 completo que permite:

- **Conectar Claude Web** → Autoriza en tu servidor → Accede a tus archivos
- **Conectar Blender** → Autoriza en tu servidor → Blender accede al MCP → MCP accede a IA
- **Cualquier app que soporte OAuth2**

Sin necesidad de copiar/pegar códigos. Flujo completamente estándar.

---

## 🚀 Inicio Rápido

```bash
# 1. Iniciar el servidor
./start-mcp.sh oauth

# 2. El servidor estará en:
http://localhost:3000

# 3. Discovery endpoint (para que las apps lo encuentren):
http://localhost:3000/.well-known/oauth-authorization-server
```

---

## 🔗 Flujo Completo (Ejemplo: Claude Web)

### Paso 1: Claude Web quiere conectar a tu MCP

Claude Web busca la opción "Agregar MCP Server"

### Paso 2: Ingresar configuración

```
URL del servidor: http://localhost:3000
Client ID: claude-web
```

O si está en otro lado:
```
URL del servidor: https://abc123.ngrok.io
Client ID: claude-web
```

### Paso 3: Claude Web redirige al usuario

Tu navegador se abre automáticamente:
```
http://localhost:3000/oauth/authorize?client_id=claude-web&redirect_uri=https://claude.ai/callback&response_type=code&scope=full
```

### Paso 4: Usuario ve formulario de login

```
╔═════════════════════════════════════╗
║    MCP Server - Iniciar Sesión      ║
╟─────────────────────────────────────╢
║ Claude Web solicita acceso          ║
║                                     ║
║ Usuario:  [mcp-admin____________]   ║
║ Contraseña: [***]                   ║
║                                     ║
║  [Continuar]                        ║
╚═════════════════════════════════════╝
```

### Paso 5: Usuario ve pantalla de consentimiento

```
╔═════════════════════════════════════╗
║     Autorizar Acceso                ║
╟─────────────────────────────────────╢
║ Claude Web solicita acceso          ║
║                                     ║
║ Permisos solicitados:               ║
║ ✓ Acceder a archivos                ║
║ ✓ Leer archivos                     ║
║ ✓ Escribir archivos                 ║
║ ✓ Ejecutar comandos                 ║
║                                     ║
║  [Autorizar]  [Cancelar]            ║
╚═════════════════════════════════════╝
```

### Paso 6: Sistema genera token

```
Usuario autoriza
    ↓
Servidor genera authorization code
    ↓
Redirige a Claude Web con code
    ↓
Claude Web intercambia code por token
    ↓
Claude Web recibe access_token
    ↓
Claude Web ahora puede acceder al MCP
```

### Paso 7: Claude Web accede a tu MCP

```
GET /api/files
Header: Authorization: Bearer eyJhbGc...

Respuesta: Lista de archivos
```

---

## 📋 Clientes Registrados

El sistema conoce estos clientes:

| ID | Nombre | Redirect URIs |
|---|---|---|
| `claude-web` | Claude Web | https://claude.ai/callback, http://localhost:3001/callback |
| `gpt-web` | ChatGPT Web | https://chat.openai.com/callback, http://localhost:3002/callback |
| `blender` | Blender | http://localhost:9000/callback, blender://callback |
| `local-dev` | Desarrollo Local | http://localhost:3000/callback, http://localhost:8000/callback |

### Agregar más clientes

Edita `server-oauth2-provider.js` en la sección `KNOWN_CLIENTS`:

```javascript
const KNOWN_CLIENTS = {
  'my-app': {
    name: 'Mi Aplicación',
    secret: 'my-secret-key',
    redirectUris: ['https://myapp.com/callback']
  }
};
```

---

## 🌐 Endpoints OAuth2

### Authorization Endpoint
```
GET /oauth/authorize?client_id=claude-web&redirect_uri=...&response_type=code&scope=full
```

Muestra formulario de login → consentimiento → redirige con `code`

### Token Endpoint
```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=...&client_id=claude-web&client_secret=...&redirect_uri=...
```

Respuesta:
```json
{
  "access_token": "eyJhbGc...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "..."
}
```

### User Info Endpoint
```
GET /oauth/userinfo
Header: Authorization: Bearer eyJhbGc...
```

Respuesta:
```json
{
  "sub": "mcp-admin",
  "username": "mcp-admin",
  "email": "admin@mcp.local",
  "scope": "full"
}
```

### Discovery
```
GET /.well-known/oauth-authorization-server
```

Retorna configuración OAuth2 completa (para que apps lo encuentren automáticamente)

---

## 🔒 Seguridad

### Flujo seguro

1. **Authorization Code** nunca sale del servidor (sale del navegador, no del cliente)
2. **Access Token** se genera server-to-server (Cliente ↔ Servidor)
3. **Refresh Token** solo el cliente lo tiene

### Validaciones

- ✅ Client ID debe ser conocido
- ✅ Client Secret debe ser correcto (server-to-server)
- ✅ Redirect URI debe coincidir
- ✅ Authorization Code expira en 10 minutos
- ✅ Access Token expira en 24 horas

---

## 📝 Grant Types Soportados

### Authorization Code (estándar, recomendado)
```
1. GET /oauth/authorize          ← Usuario ves login
2. POST /oauth/token             ← Server intercambia code por token
```

### Refresh Token
```
POST /oauth/token
grant_type=refresh_token&refresh_token=...
```

### Password (desarrollo solamente)
```
POST /oauth/token
grant_type=password&username=...&password=...
```

---

## 🔧 Pruebas Locales

### Test con curl

```bash
# 1. Obtener authorization code (en navegador)
open "http://localhost:3000/oauth/authorize?client_id=local-dev&redirect_uri=http://localhost:3000/callback&response_type=code&scope=full"

# 2. Login con: mcp-admin / (tu-contraseña-de-.credentials)

# 3. Copiar el code de la URL: http://localhost:3000/callback?code=abc123...

# 4. Intercambiar code por token
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=abc123..." \
  -d "client_id=local-dev" \
  -d "client_secret=local-dev-secret" \
  -d "redirect_uri=http://localhost:3000/callback"

# 5. Obtener info del usuario
curl http://localhost:3000/oauth/userinfo \
  -H "Authorization: Bearer eyJhbGc..."
```

---

## 🚨 Troubleshooting

### "Invalid Client"
- Verifica que `client_id` esté en `KNOWN_CLIENTS`

### "Invalid Redirect URI"
- Verifica que la `redirect_uri` coincida exactamente
- O que sea un `localhost` permitido

### "Code Expired"
- El authorization code dura 10 minutos
- Intenta nuevamente

### "Invalid Grant"
- El code ya fue usado o no existe
- Verifica que `client_secret` sea correcto

---

## 💡 Casos de Uso

### Caso 1: Claude Web + Blender + MCP

```
Blender
  ↓
Conecta a MCP (mediante OAuth2)
  ↓
MCP solicita autorización a usuario
  ↓
Usuario autoriza en navegador
  ↓
Blender recibe token
  ↓
Blender accede a archivos del MCP
  ↓
Blender envía datos a Claude Web
  ↓
Claude Web procesa y responde
```

### Caso 2: Multiple aplicaciones

```
Claude Web → Autoriza una vez
GPT Web    → Autoriza una vez
Blender    → Autoriza una vez
Custom App → Autoriza una vez

Todas pueden acceder simultáneamente con tokens independientes
```

### Caso 3: Desarrollo local

```
./start-mcp.sh oauth
↓
Tu localhost:3000 es proveedor OAuth2
↓
Tu aplicación local usa client_id=local-dev
↓
Sin ngrok necesario (si está todo en local)
```

---

## 📚 Referencias

- RFC 6749 - OAuth 2.0 Authorization Framework
- RFC 6750 - OAuth 2.0 Bearer Token Usage
- OpenID Connect (compatible)

