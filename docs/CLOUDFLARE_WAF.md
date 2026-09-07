# Guía y Configuración de Cloudflare Tunnel y WAF para Servidor MCP

Esta guía detalla la configuración recomendada de **Cloudflare Tunnel** y las reglas de **WAF / Page Rules / Caching** para exponer el servidor MCP a ChatGPT de forma segura y confiable.

---

## 1. Arquitectura de Exposición

- **Origen Local:** El proceso MCP escucha exclusivamente en loopback (`http://127.0.0.1:3000`), sin abrir puertos en el enrutador local ni requerir IP pública fija.
- **Túnel Supervisado:** `cloudflared` establece una conexión saliente TLS cifrada hacia la red perimetral de Cloudflare.
- **Credenciales Privadas:** El archivo de credenciales del túnel se almacena en `.private/cloudflared.json` con permisos estrictos `0600`.
- **Hostname Estable:** Dominio personalizado gestionado en Cloudflare (ej. `https://mcp.tudominio.com`). No se utilizan Quick Tunnels efímeros (`trycloudflare.com`) ya que no son aptos para sesiones persistentes de streaming HTTP/SSE.

---

## 2. Configuración de Ingress (`.private/cloudflared.yml`)

El asistente genera automáticamente la siguiente plantilla en `.private/cloudflared.yml`:

```yaml
tunnel: <TUNNEL_UUID_O_NOMBRE>
credentials-file: /ruta/al/repo/.private/cloudflared.json

ingress:
  # Enrutamiento al servidor MCP local
  - hostname: mcp.tudominio.com
    service: http://127.0.0.1:3000
    originRequest:
      noTLSVerify: false
      connectTimeout: 30s
      noChunkedEncoding: false
  # Regla de captura final (404 para cualquier otro host)
  - service: http_status:404
```

---

## 3. Reglas de WAF y Seguridad en Cloudflare

### A. Desactivación Total de Caché (Crítico para MCP y OAuth)
Los endpoints MCP utilizan streaming HTTP y Server-Sent Events (SSE). Además, las llamadas a herramientas y flujos OAuth no deben ser cacheados bajo ninguna circunstancia.

En el panel de Cloudflare:
**Caching -> Cache Rules -> Create Rule:**
- **Nombre:** `Bypass MCP and OAuth Cache`
- **Expresión:**
  ```text
  (http.request.uri.path contains "/mcp") or
  (http.request.uri.path contains "/sse") or
  (http.request.uri.path contains "/messages") or
  (http.request.uri.path contains "/oauth/") or
  (http.request.uri.path contains "/.well-known/")
  ```
- **Acción:**
  - Cache Eligibility: **Bypass cache**

### B. Métodos HTTP Permitidos
El protocolo MCP y OAuth requieren únicamente: `GET`, `POST`, `OPTIONS`.
En **Security -> WAF -> Custom Rules:**
- **Nombre:** `Permitir solo metodos MCP necesarios`
- **Expresión:**
  ```text
  (http.host eq "mcp.tudominio.com") and not (http.request.method in {"GET" "POST" "OPTIONS"})
  ```
- **Acción:** **Block**

### C. Rate Limiting Sin Desafíos Interactivos (No CAPTCHA)
> [!IMPORTANT]
> Los clientes automatizados como conectores MCP y ChatGPT invocan los endpoints máquina-a-máquina (`/mcp`, `/oauth/token`). Si se configura un desafío interactivo (Managed Challenge o CAPTCHA) en estos endpoints, las conexiones de ChatGPT fallarán de forma inmediata y opaca.

En **Security -> WAF -> Rate Limiting Rules:**
- **Regla 1 (Endpoint MCP):**
  - **Expresión:** `(http.request.uri.path eq "/mcp")`
  - **Límite:** 120 solicitudes por minuto por IP.
  - **Acción:** **Block** (con código 429) durante 60 segundos. (NO Challenge/CAPTCHA).
- **Regla 2 (Endpoint de Token OAuth):**
  - **Expresión:** `(http.request.uri.path eq "/oauth/token")`
  - **Límite:** 30 solicitudes por minuto por IP.
  - **Acción:** **Block** (código 429) durante 60 segundos.

### D. Cloudflare Access (Zero Trust)
- **Endpoints de Máquina (`/mcp`, `/oauth/*`):** No deben estar detrás de Cloudflare Access por cookies de navegador, ya que el conector de ChatGPT no ejecuta el flujo de autenticación de Cloudflare Access antes de iniciar OAuth.
- **Panel Administrativo Local:** Si se expone un panel administrativo, puede protegerse mediante Cloudflare Access requiriendo autenticación por correo o IdP corporativo.

---

## 4. Pasos Externos Pendientes para el Administrador

1. **Instalar `cloudflared`:**
   ```bash
   # En Debian/Ubuntu:
   sudo curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /etc/apt/keyrings/cloudflare-main.gpg
   echo "deb [signed-by=/etc/apt/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bullseye main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update && sudo apt-get install cloudflared
   ```
2. **Iniciar sesión en Cloudflare:**
   ```bash
   cloudflared tunnel login
   ```
3. **Crear el túnel:**
   ```bash
   cloudflared tunnel create mcp-server
   # Copiar el archivo JSON generado a .private/cloudflared.json
   ```
4. **Configurar el registro CNAME en DNS:**
   ```bash
   cloudflared tunnel route dns mcp-server mcp.tudominio.com
   ```
5. **Reconfigurar el servidor MCP:**
   ```bash
   ./configure-mcp.sh
   # Seleccionar opción 2 (Cloudflare Tunnel)
   ```
