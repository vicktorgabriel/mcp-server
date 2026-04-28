# MCP Server Local

Servidor MCP para exponer carpetas locales a clientes IA con permisos de lectura y escritura controlados por `ALLOWED_PATHS`.

Soporta dos modos:

- `stdio`: para clientes locales como Claude Desktop.
- `HTTP/SSE`: para clientes web como ChatGPT Web y Claude Web, normalmente publicado con ngrok.

## Inicio rapido con ngrok

```bash
cd /mnt/4tb-hdd/repo/mcp-server-local
./start-mcp.sh
```

El script levanta el servidor HTTP, abre un tunel ngrok y muestra algo como:

```text
ChatGPT Web:   https://abc123.ngrok-free.app/mcp
Claude Web:    https://abc123.ngrok-free.app/sse
Claude local:  node /mnt/4tb-hdd/repo/mcp-server-local/mcp-server.js --stdio
Allowed paths: /mnt/4tb-hdd/repo
Activity log:  activity.log
```

Deja esa terminal abierta. `Ctrl+C` detiene Node y ngrok.

## Registro de actividad

Cada llamada a herramientas queda registrada en el CLI con prefijo `[ACTIVITY]` y, si `ACTIVITY_LOG` esta configurado, tambien en formato JSONL:

```bash
tail -f activity.log
```

El registro incluye herramienta, ruta/comando, estado, duracion y tamanos aproximados. No guarda contenido de archivos ni el texto completo escrito.

## Configurar carpetas expuestas

Puedes usar variables de entorno o `.env`:

```bash
ALLOWED_PATHS=/mnt/4tb-hdd/repo,/tmp/mcp-test
WORKING_DIR=/mnt/4tb-hdd/repo
PORT=3000
HOST=127.0.0.1
ACTIVITY_LOG=activity.log
```

Las rutas relativas que reciba la IA se resuelven contra la primera carpeta de `ALLOWED_PATHS`. Las rutas absolutas solo funcionan si estan dentro de alguna carpeta permitida.

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

Usa el transporte stdio:

```json
{
  "mcpServers": {
    "local-files": {
      "command": "node",
      "args": [
        "/mnt/4tb-hdd/repo/mcp-server-local/mcp-server.js",
        "--stdio"
      ],
      "env": {
        "ALLOWED_PATHS": "/mnt/4tb-hdd/repo"
      }
    }
  }
}
```

Tambien puedes ejecutar:

```bash
./start-mcp-real.sh
```

## Herramientas disponibles

- `search`: busca archivos por nombre o contenido. Compatible con conectores ChatGPT.
- `fetch`: lee un archivo devuelto por `search`. Compatible con conectores ChatGPT.
- `list_files`: lista directorios.
- `read_file`: lee archivos UTF-8.
- `write_file`: escribe o agrega contenido en archivos UTF-8.
- `patch_file`: aplica reemplazos exactos `search/replace` sobre archivos UTF-8.
- `run_command`: ejecuta comandos locales con `cwd` validado dentro de `ALLOWED_PATHS`.

## Seguridad

El servidor nunca permite acceder fuera de `ALLOWED_PATHS`. No expongas carpetas sensibles.

`run_command` puede ejecutar procesos locales. Por defecto no usa shell y recibe `command` + `args`; si habilitas `shell: true`, tratalo como acceso completo a tu usuario del sistema dentro del contexto permitido.

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
