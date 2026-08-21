# MCP Server Local

Servidor MCP para exponer carpetas locales a clientes IA con permisos de lectura y escritura; por defecto en este repo corre en modo de acceso completo (`MCP_FULL_ACCESS=1`).

Soporta dos modos:

- `stdio`: recomendado para clientes locales. El cliente MCP levanta el proceso solo cuando necesita usar una herramienta.
- `HTTP/SSE`: para clientes web como ChatGPT Web y Claude Web, normalmente publicado con ngrok. Este modo deja el servidor corriendo mientras esta expuesto.

## Uso local recomendado: stdio bajo demanda

Para uso local, configura el cliente MCP para ejecutar el servidor por `stdio`. Asi evitas mantener un proceso HTTP abierto y, en clientes compatibles, reduces aprobaciones repetitivas en herramientas de solo lectura porque el servidor ahora las anuncia con metadata `readOnly`.

```json
{
  "mcpServers": {
    "local-files": {
      "command": "node",
      "args": [
        "/mnt/hdd4tb/repo/mcp-server/mcp-server.js",
        "--stdio"
      ],
      "env": {
        "ALLOWED_PATHS": "/mnt/hdd4tb/repo",
        "MCP_FULL_ACCESS": "1",
        "WORKING_DIR": "/mnt/hdd4tb/repo",
        "MCP_FAST_MODE": "1",
        "SEARCH_CACHE_TTL_MS": "60000",
        "SEARCH_MAX_FILE_BYTES": "524288",
        "SEARCH_MAX_TOTAL_BYTES": "16777216",
        "SEARCH_SKIP_DIRS": "node_modules,.git,dist,build,.next,.nuxt,.cache,coverage,.venv,venv,__pycache__,target,out",
        "READ_BATCH_LIMIT": "25",
        "SSE_HEARTBEAT_MS": "15000",
        "KEEP_ALIVE_TIMEOUT_MS": "65000"
      }
    }
  }
}
```

Notas:

- `search`, `fetch`, `list_files` y `read_file` se anuncian como herramientas de solo lectura.
- Con `MCP_FULL_ACCESS=1` (valor recomendado en este repo), el servidor habilita acceso completo local y anuncia metadata menos restrictiva para minimizar confirmaciones del cliente.
- Todas las herramientas exponen `outputSchema` en `tools/list` y devuelven `structuredContent` para facilitar parsing por modelos.
- Si prefieres usar `.env`, deja la seccion `env` minima y coloca ahi las mismas variables.

## Inicio rapido web con ngrok

En Linux / macOS / WSL / Git Bash:

```bash
cd /mnt/hdd4tb/repo/mcp-server
./start-mcp.sh
```

En Windows (CMD / PowerShell):

```cmd
cd \ruta\a\mcp-server
start-mcp.cmd
```

> **Nota:** Ambos scripts verifican la presencia de Node.js e instalan dependencias automáticamente con `npm install` si el proyecto las requiere y no están instaladas en `node_modules`.

El script levanta el servidor HTTP, abre un tunel ngrok y muestra algo como:

```text
ChatGPT Web:   https://abc123.ngrok-free.app/mcp
Claude Web:    https://abc123.ngrok-free.app/sse
Local stdio:   node /mnt/hdd4tb/repo/mcp-server/mcp-server.js --stdio
Allowed paths: /mnt/hdd4tb/repo
Activity log:  activity.log
```

Deja esa terminal abierta. `Ctrl+C` detiene Node y ngrok. Para clientes locales no uses este script: usa `stdio` para arranque bajo demanda.

## Registro de actividad

Cada llamada a herramientas queda registrada en el CLI con prefijo `[ACTIVITY]` y, si `ACTIVITY_LOG` esta configurado, tambien en formato JSONL:

```bash
tail -f activity.log
```

El registro incluye herramienta, ruta/comando, estado, duracion y tamanos aproximados. No guarda contenido de archivos ni el texto completo escrito.

## Configurar carpetas expuestas

Puedes usar variables de entorno o `.env`:

```bash
ALLOWED_PATHS=/mnt/hdd4tb/repo,/tmp/mcp-test
MCP_FULL_ACCESS=1
WORKING_DIR=/mnt/hdd4tb/repo
PORT=3000
HOST=127.0.0.1
ACTIVITY_LOG=activity.log
MCP_FAST_MODE=1
SEARCH_CACHE_TTL_MS=60000
SEARCH_MAX_FILE_BYTES=524288
SEARCH_MAX_TOTAL_BYTES=16777216
SEARCH_SKIP_DIRS=node_modules,.git,dist,build,.next,.nuxt,.cache,coverage,.venv,venv,__pycache__,target,out
READ_BATCH_LIMIT=25
SSE_HEARTBEAT_MS=15000
KEEP_ALIVE_TIMEOUT_MS=65000
```

Con `MCP_FULL_ACCESS=1`, las rutas relativas se resuelven contra `WORKING_DIR` (o `cwd`) y tambien se permiten rutas absolutas fuera de `ALLOWED_PATHS`.

Con `MCP_FULL_ACCESS=0`, las rutas relativas se resuelven contra la primera carpeta de `ALLOWED_PATHS` y las rutas absolutas solo funcionan si estan dentro de alguna carpeta permitida.

Si no defines `WORKING_DIR`, el servidor usa por defecto la carpeta padre del proyecto `mcp-server`, y si `ALLOWED_PATHS` apunta a rutas inexistentes ahora falla al arrancar con un error explicito en vez de quedar respondiendo con errores `ENOENT` en cada herramienta.

## ChatGPT Web

1. Activa Developer Mode en ChatGPT: Settings -> Connectors -> Advanced -> Developer mode.
2. Ve a Settings -> Connectors.
3. Agrega un conector MCP remoto/custom.
4. Usa la URL que imprime el CLI:

```text
https://TU-NGROK.ngrok-free.app/mcp
```

5. Autenticacion: `No authentication`, salvo que configures `MCP_AUTH_TOKEN`.

ChatGPT puede usar `search` y `fetch` como conector normal. Para `list_files`, `read_file` y `write_file`, usa Developer Mode porque son herramientas MCP completas, incluyendo escritura.

## Browser y artifacts

El servidor responde CORS para clientes web, incluyendo preflight `OPTIONS`, headers MCP y Private Network Access. Desde una pagina HTTPS como Claude/ChatGPT suele ser mas estable usar la URL HTTPS de ngrok:

```text
https://TU-NGROK.ngrok-free.app/mcp
```

Evita `http://localhost:3000` desde un artifact si el navegador lo bloquea por politicas de red local o contenido mixto.

## Claude Web

Si tu plan/interfaz permite servidores MCP remotos, agrega:

```text
https://TU-NGROK.ngrok-free.app/sse
```

El servidor tambien expone `/mcp` por Streamable HTTP; si Claude ofrece esa opcion, puedes usar:

```text
https://TU-NGROK.ngrok-free.app/mcp
```

## Claude Desktop o clientes MCP locales

Usa la configuracion `stdio` de la seccion **Uso local recomendado: stdio bajo demanda**. Ese modo hace que el cliente arranque el MCP solo cuando lo necesita, sin dejar un servidor HTTP permanente.

## Herramientas disponibles

- `search`: busca archivos por nombre o contenido. Compatible con conectores ChatGPT.
- `fetch`: lee un archivo devuelto por `search`. Compatible con conectores ChatGPT.
- `list_files`: lista directorios.
- `read_file`: lee archivos UTF-8.
- `write_file`: escribe o agrega contenido en archivos UTF-8.
- `patch_file`: aplica reemplazos exactos `search/replace` sobre archivos UTF-8.
- `run_command`: ejecuta comandos locales; con `MCP_FULL_ACCESS=0` valida `cwd` dentro de `ALLOWED_PATHS`.

## Seguridad

Con `MCP_FULL_ACCESS=1` el servidor permite acceso local completo al filesystem. Usalo solo cuando controles el proceso y el cliente.

Con `MCP_FULL_ACCESS=0`, el servidor nunca permite acceder fuera de `ALLOWED_PATHS`.

`run_command` puede ejecutar procesos locales. Por defecto no usa shell y recibe `command` + `args`; si habilitas `shell: true`, tratalo como acceso completo a tu usuario del sistema dentro del contexto permitido.

Las herramientas de lectura se anuncian como `readOnlyHint`, pero eso no reemplaza la politica del cliente: las herramientas que escriben o ejecutan comandos pueden seguir requiriendo aprobacion.

Opcionalmente puedes exigir bearer token en HTTP:

```bash
MCP_AUTH_TOKEN="$(openssl rand -hex 24)" ./start-mcp.sh
```

Luego configura el cliente con:

```text
Authorization: Bearer <token>
```

Si el cliente web no permite bearer tokens, deja `MCP_AUTH_TOKEN` vacio y usa solo carpetas no sensibles.

## Endpoints

- `GET /health`: estado.
- `GET /config`: configuracion sugerida para clientes.
- `GET /tools`: diagnostico de herramientas MCP expuestas.
- `POST /mcp`: MCP Streamable HTTP.
- `GET /mcp`: stream SSE de Streamable HTTP.
- `GET /sse` y `POST /messages`: transporte SSE legacy.

## Prueba rapida

```bash
node mcp-server.js --http
```

En otra terminal:

```bash
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
