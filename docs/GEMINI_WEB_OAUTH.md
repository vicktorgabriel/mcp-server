# Integración y Diagnóstico OAuth 2.1 con Google Gemini Web

> Documento técnico de compatibilidad y arquitectura para clientes MCP web, específicamente Google Gemini (`gemini.google.com` - Apps conectadas / Add MCP Server).

Fecha de actualización: 2026-10-14  
Versión: 4.6.1  
Estado: **DCR, descubrimiento de recursos, flujo de autorización OAuth 2.1, PKCE S256 y redirección cruzada validados.**

---

## 1. Contexto y Arquitectura

Google Gemini permite conectar servidores Model Context Protocol (MCP) remotos a través de su interfaz web en **Configuración → Apps conectadas → Add custom app / Add MCP Server**.

A diferencia de clientes locales que operan mediante transporte `stdio`, Gemini Web es un cliente alojado en la nube que interactúa con el servidor mediante **Streamable HTTP** sobre una URL HTTPS pública (por ejemplo, mediante el túnel gestionado de ngrok o Cloudflare).

### Requisitos del protocolo

| Componente | Especificación implementada |
|---|---|
| **Transporte** | Streamable HTTP en `/mcp` (GET/POST con protocolo MCP) |
| **Descubrimiento de recurso** | RFC 9207 / MCP Spec: `/.well-known/oauth-protected-resource/mcp` |
| **Servidor de autorización** | `/.well-known/oauth-authorization-server` |
| **Registro dinámico** | OAuth 2.0 Dynamic Client Registration (RFC 7591) en `/oauth/register` |
| **Protección contra intercepción** | PKCE obligatorio (`code_challenge_method=S256`) |
| **Autenticación en Token Endpoint** | `client_secret_post` / `none` |

---

## 2. Hallazgos y Correcciones de la Versión 4.6.1

Durante la vinculación con Gemini Web se detectaron fricciones específicas derivadas de los mecanismos de aislamiento y redirección cruzada de Chromium y Google:

### A. Bloqueo de redirección cruzada por `form-action` en Chromium
* **Causa:** Gemini registra como `redirect_uri` endpoints bajo `oauth-redirect.googleusercontent.com`. En Chromium, la directiva CSP `form-action` no sólo aplica al destino inicial del formulario (`POST /oauth/authorize`), sino a **cada salto de la cadena de redirección** HTTP 302 subsiguiente.
* **Solución:** `authorizationPageCsp` incluye explícitamente `https://*.googleusercontent.com` y `https://*.google.com` cuando el cliente o callback pertenece a la infraestructura de Google.

### B. Conflicto con `X-Frame-Options: DENY` en la respuesta 302
* **Causa:** La función interna `sendRedirect` aplicaba cabeceras de seguridad estrictas que incluían `X-Frame-Options: DENY` y `Cross-Origin-Resource-Policy: same-origin`. Cuando la interfaz del asistente presenta el consentimiento dentro de su propia superficie o marco web, el navegador cancelaba la navegación 302 hacia el callback externo.
* **Solución:** Se suprime `X-Frame-Options: DENY` en `sendRedirect` y se establece `Cross-Origin-Resource-Policy: cross-origin`, emulando el comportamiento seguro ya probado en `sendHtml`.

### C. Restricción de `frame-ancestors` en CSP
* **Causa:** La política CSP del formulario de autorización restringía los marcos exclusivamente a ChatGPT (`frame-ancestors 'self' https://chatgpt.com ...`).
* **Solución:** Se autorizan adicionalmente los orígenes `https://gemini.google.com` y `https://*.google.com`.

### D. Invalidez por doble envío accidental de transacción
* **Causa:** Dado que la transacción de autorización OAuth es de un solo uso y se consume al emitir el código, un usuario que hacía clic repetido ante una breve latencia de red recibía `HTTP 400: La autorización venció`.
* **Solución:** Se incorporó un script con `nonce` que deshabilita el botón de envío y muestra inmediatamente el estado visual "Autorizando..." al procesar el submit.

---

## 3. Pasos de Conexión en Gemini Web

1. Obtener el endpoint activo del servidor ejecutando:
   ```bash
   ./mcpctl.sh gemini
   # o bien:
   ./mcpctl.sh url
   ```
2. En [gemini.google.com](https://gemini.google.com):
   * Ingresar a **Configuración** → **Apps conectadas** (Connected apps).
   * Seleccionar **Add custom app** / **Add MCP Server**.
   * Pegar la URL pública terminada en `/mcp` (ejemplo: `https://xxxx.ngrok-free.dev/mcp`).
   * Confirmar la detección de herramientas e iniciar sesión con las credenciales locales configuradas en el servidor.
3. Monitorear el progreso en tiempo real desde la consola local:
   ```bash
   ./mcpctl.sh logs-follow
   ```
