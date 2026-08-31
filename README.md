# MCP Local Full Control

Servidor MCP local para dar a ChatGPT, Codex, Claude u otros clientes MCP acceso controlado al equipo del usuario. La version 3 amplía el servidor original de archivos con herramientas de sistema, Git, `tmux`, escritorio, captura de pantalla, mouse/teclado, cámara y audio.

El objetivo principal de este repo es permitir un flujo de trabajo como este:

```text
ChatGPT / Chief
  ├─ inspecciona repos, logs, procesos, pantalla y estado del sistema
  ├─ decide prioridades y audita resultados
  └─ supervisa sesiones tmux
        ├─ Codex CLI / proyecto A
        ├─ Codex CLI / proyecto B
        └─ otros workers
```

Todas las acciones se ejecutan con los permisos del usuario que inicia el MCP. `MCP_FULL_ACCESS=1` elimina la restricción de rutas del propio servidor, pero **no** salta permisos de Linux, `sudo`, ACLs o permisos de dispositivos.

## Modos de transporte

- `stdio`: recomendado para clientes locales. El cliente arranca el MCP bajo demanda.
- `HTTP / Streamable HTTP`: usado por ChatGPT Web mediante un túnel como ngrok.
- `SSE`: compatibilidad con clientes web que todavía usan el transporte MCP SSE.

## Inicio rápido con ngrok

```bash
cd /mnt/hdd4tb/repo/mcp-server
./start-mcp.sh
```

El script inicia Node en `127.0.0.1:3000`, abre el túnel ngrok y muestra la URL pública de ChatGPT:

```text
https://TU-TUNEL.ngrok-free.app/mcp
```

El MCP existe públicamente sólo mientras el script/ngrok estén levantados. `Ctrl+C` cierra ambos procesos.

## Actualizar otra máquina

```bash
cd /ruta/al/mcp-server
git pull
npm test
./self-test.sh
./start-mcp.sh
```

`self-test.sh` comprueba sintaxis, inventario de herramientas, capacidades locales, Git, tmux y una captura de pantalla cuando existe una sesión gráfica accesible.

## Requisitos

Base:

- Node.js
- Git
- bash (Linux)
- ngrok para ChatGPT Web remoto

Para el conjunto completo en Linux:

- `tmux`
- `systemctl` / `journalctl`
- `wmctrl`
- `gnome-screenshot`, `grim` o `scrot`
- `python3` + `python-xlib` para mouse/teclado X11
- `ffmpeg` para cámaras V4L2
- `pactl` o herramientas ALSA para inventario de audio

En X11 el control de teclado/mouse usa `desktop-control.py` + XTEST. En KDE Plasma Wayland, `screen_capture` usa Spectacle en segundo plano y devuelve una imagen MCP; la inyección global de teclado/mouse sigue estando restringida por el compositor y las herramientas X11 sólo alcanzan ventanas XWayland.

## Configuración

Ejemplo `.env`:

```bash
PORT=3000
HOST=127.0.0.1
WORKING_DIR=/mnt/hdd4tb/repo
ALLOWED_PATHS=/mnt/hdd4tb/repo
MCP_FULL_ACCESS=1

MCP_FAST_MODE=1
SEARCH_CACHE_TTL_MS=60000
SEARCH_MAX_FILE_BYTES=524288
SEARCH_MAX_TOTAL_BYTES=16777216
SEARCH_SKIP_DIRS=node_modules,.git,dist,build,.next,.nuxt,.cache,coverage,.venv,venv,__pycache__,target,out
READ_BATCH_LIMIT=25

MCP_DESKTOP_ENABLED=1
MCP_INPUT_ENABLED=1
MCP_CONTROL_TIMEOUT_MS=120000
MCP_IMAGE_LIMIT_BYTES=26214400

SSE_HEARTBEAT_MS=15000
KEEP_ALIVE_TIMEOUT_MS=65000
ACTIVITY_LOG=activity.log

# Opcional para HTTP/ngrok
MCP_AUTH_TOKEN=
```

### Acceso a archivos

Con:

```bash
MCP_FULL_ACCESS=1
```

el servidor acepta rutas absolutas de todo el filesystem y las rutas relativas se resuelven desde `WORKING_DIR`.

Con:

```bash
MCP_FULL_ACCESS=0
```

las rutas quedan limitadas a `ALLOWED_PATHS`.

## Herramientas

La version 3 expone actualmente 49 herramientas.

### Filesystem

- `search`
- `fetch`
- `list_files`
- `read_file`
- `write_file`
- `patch_file`
- `file_info`
- `read_image`
- `tail_file`
- `run_command`

`read_image` devuelve contenido MCP `image`, por lo que el modelo puede ver realmente PNG/JPEG/WebP/GIF locales en lugar de recibir sólo una ruta.

### Diagnóstico y sistema

- `control_capabilities`
- `system_snapshot`
- `hardware_info`
- `disk_usage`
- `network_status`
- `gpu_status`
- `process_list`
- `process_info`
- `process_signal`
- `process_start`
- `service_status`
- `service_action`
- `journal_tail`

`process_start` sirve para lanzar trabajos persistentes sin depender del timeout de `run_command`; devuelve PID y archivo de log.

### Git

- `git_status`
- `git_diff`
- `git_log`
- `git_branches`
- `git_worktrees`
- `git_command`

`git_command` permite ejecutar cualquier subcomando Git dentro de un repo: `fetch`, `pull`, `push`, `checkout`, `commit`, `worktree`, etc.

### tmux / workers

- `tmux_list`
- `tmux_panes`
- `tmux_create`
- `tmux_capture`
- `tmux_send`
- `tmux_interrupt`
- `tmux_kill`

Estas herramientas permiten que ChatGPT supervise una sesión de Codex CLI sin reemplazar su entorno local:

```text
ChatGPT
  ↓ tmux_capture
lee qué está haciendo Codex
  ↓ git_diff / tests / logs
lo audita
  ↓ tmux_send
le entrega la siguiente instrucción o corrección
```

Ejemplo conceptual:

```text
tmux_create(session="ailen", cwd="/repo/ailen", command="codex")
tmux_capture(target="ailen")
tmux_send(target="ailen", text="Auditá renderer y ejecutá los tests")
```

### Escritorio y visión

- `desktop_info`
- `screen_capture`
- `list_windows`
- `window_action`
- `mouse_move`
- `mouse_click`
- `mouse_scroll`
- `keyboard_hotkey`
- `keyboard_type`
- `desktop_open`

`screen_capture` devuelve la captura como contenido MCP `image` y prueba backends con fallback. En KDE Plasma Wayland prioriza Spectacle para evitar bloqueos de `gnome-screenshot`. Modos:

- `screen`: escritorio completo.
- `active_window`: ventana activa.

`window_action` soporta:

- focus
- close
- maximize
- unmaximize
- minimize
- raise
- move_resize

En Linux/X11, mouse y teclado usan `python-xlib` y XTEST, por lo que no requieren `xdotool`.

### Cámara y audio

- `camera_list`
- `camera_snapshot`
- `audio_devices`

`camera_snapshot` usa `ffmpeg`/V4L2 y devuelve un frame como imagen MCP. Esto permite inspección visual de cámaras locales cuando el usuario del MCP tiene permisos sobre `/dev/video*`.

## Flujo recomendado ChatGPT + Codex CLI

Para proyectos grandes conviene separar roles:

```text
ChatGPT
  = análisis, planificación, auditoría, coordinación y supervisión

Codex CLI
  = edición intensiva del repo, compilación, tests y debugging

MCP
  = acceso de ChatGPT al equipo y a las sesiones de Codex
```

Un flujo típico:

1. ChatGPT usa `git_status`, `git_diff`, logs y métricas para inspeccionar el proyecto.
2. Si ya hay un Codex trabajando, usa `tmux_capture` para leer su estado.
3. ChatGPT determina la siguiente acción.
4. Usa `tmux_send` para orientar al worker.
5. Codex modifica código y ejecuta pruebas localmente.
6. ChatGPT vuelve a auditar diff/tests/logs/pantalla.
7. Aprueba, corrige o reasigna el trabajo.

Así el contexto de estrategia puede quedar en ChatGPT mientras Codex conserva el contexto técnico del repo.

## Seguridad HTTP/ngrok

`GET /health` queda público para diagnóstico del túnel.

Si `MCP_AUTH_TOKEN` está configurado, el resto de endpoints (`/config`, `/tools`, `/mcp`, `/sse`, `/messages`) requiere:

```text
Authorization: Bearer <token>
```

La version 3 ya **no devuelve el token** desde `/config` ni lo imprime en claro en el log de arranque.

Generar uno opcionalmente:

```bash
export MCP_AUTH_TOKEN="$(openssl rand -hex 24)"
./start-mcp.sh
```

Si el cliente web que estés usando no soporta bearer token, puede mantenerse vacío. En ese caso la protección efectiva es que el proceso y el túnel sólo estén activos cuando vos los levantes, además de las protecciones que aplique el proveedor del túnel.

### Importante sobre `MCP_FULL_ACCESS=1`

Con acceso completo y `run_command`/`process_signal`/`service_action`/input de escritorio habilitados, el MCP tiene aproximadamente los mismos permisos que la cuenta Linux que lo ejecuta. No puede convertirse en root por sí solo, pero sí puede modificar archivos y procesos que pertenezcan al usuario.

Cada llamada queda registrada como `[ACTIVITY]`; si `ACTIVITY_LOG` está definido también se escribe JSONL. Para herramientas que reciben texto (`tmux_send`, `keyboard_type`, escritura de archivos), el registro guarda tamaño/metadatos y no el contenido completo.

## Endpoints

- `GET /health`: estado básico; permanece público.
- `GET /config`: configuración sugerida; requiere auth cuando hay token.
- `GET /tools`: diagnóstico del inventario; requiere auth cuando hay token.
- `POST /mcp`: Streamable HTTP MCP.
- `GET /mcp`: stream compatible.
- `GET /sse` + `POST /messages`: transporte SSE legacy.

## Clientes locales por stdio

Ejemplo:

```json
{
  "mcpServers": {
    "local-control": {
      "command": "node",
      "args": [
        "/mnt/hdd4tb/repo/mcp-server/mcp-server.js",
        "--stdio"
      ],
      "env": {
        "WORKING_DIR": "/mnt/hdd4tb/repo",
        "MCP_FULL_ACCESS": "1",
        "MCP_FAST_MODE": "1",
        "MCP_DESKTOP_ENABLED": "1",
        "MCP_INPUT_ENABLED": "1"
      }
    }
  }
}
```

## Desarrollo y pruebas

```bash
npm test
```

Prueba funcional completa:

```bash
./self-test.sh
```

La prueba funcional no pulsa teclas ni hace clicks. Sí puede realizar una captura de pantalla y crea una sesión `tmux` temporal que elimina al finalizar.
