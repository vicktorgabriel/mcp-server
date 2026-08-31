# MCP Local Full Control

Servidor MCP open source para conectar ChatGPT, Codex, Claude u otros clientes compatibles con una PC propia. Permite que el modelo, según los permisos configurados, pueda inspeccionar archivos, ejecutar comandos, revisar Git, procesos y logs, supervisar sesiones `tmux`, ver capturas de pantalla, consultar hardware, cámaras y audio, y realizar otras tareas locales.

La idea es convertir al asistente en un auditor/orquestador del equipo, mientras herramientas como Codex CLI pueden quedar trabajando directamente dentro de los repositorios.

```text
ChatGPT / Chief
  ├─ archivos, logs, procesos y sistema
  ├─ Git, tests y métricas
  ├─ capturas de pantalla
  └─ tmux
      ├─ Codex CLI / proyecto A
      └─ Codex CLI / proyecto B
```

> **Seguridad:** el primer arranque usa acceso restringido por defecto. `MCP_FULL_ACCESS=1` debe elegirse explícitamente y otorga al MCP acceso a cualquier ruta/acción que ya permita el usuario del sistema. No convierte al proceso en root ni evita `sudo`, ACLs o permisos del sistema operativo.

## Inicio rápido en Linux

Clonar el repositorio y ejecutar:

```bash
git clone https://github.com/vicktorgabriel/mcp-server.git
cd mcp-server
chmod +x start-mcp.sh
./start-mcp.sh
```

El launcher:

1. comprueba Node.js, npm, Git, curl y Python;
2. intenta instalar automáticamente lo que falte usando `apt`, `dnf`, `pacman`, `zypper`, `apk` o Homebrew;
3. intenta completar herramientas opcionales de escritorio, `tmux`, ffmpeg, V4L2, etc.;
4. crea `.env` en el primer arranque;
5. pregunta si querés acceso restringido o full-control;
6. pregunta cómo vas a publicar el MCP: ngrok, URL HTTPS propia o sólo local;
7. inicia el servidor y muestra en la terminal la URL exacta que hay que copiar a ChatGPT.

Algunas instalaciones de paquetes pueden pedir la contraseña de administrador mediante `sudo`/Polkit.

## ¿Necesito ngrok?

**No siempre.** Hay tres escenarios.

### 1. ngrok — recomendado para la mayoría

Elegí `NGROK` si:

- tenés Starlink o CGNAT;
- tu IP pública cambia;
- no podés/querés abrir puertos del router;
- no tenés dominio + certificado HTTPS;
- querés la forma más sencilla de conectar ChatGPT Web.

El launcher puede descargar ngrok v3 automáticamente en `~/.local/bin`. La primera vez todavía tenés que asociarlo a tu cuenta:

```bash
ngrok config add-authtoken TU_TOKEN
```

Luego:

```bash
./start-mcp.sh
```

La terminal mostrará algo similar a:

```text
URL PARA CHATGPT:
  https://xxxx.ngrok-free.app/mcp
```

El túnel existe sólo mientras ngrok esté ejecutándose. Si usás el dominio gratuito de ngrok, la URL puede cambiar al crear un túnel nuevo; en ese caso actualizá la URL del conector en ChatGPT.

### 2. IP pública/fija o DDNS — sin ngrok

Podés prescindir de ngrok si ya tenés una **URL HTTPS pública** que llegue a la máquina.

Una IP fija por sí sola no alcanza. Normalmente necesitás:

```text
Internet
  -> https://mcp.midominio.com
  -> DNS a tu IP pública/fija
  -> certificado TLS válido
  -> Caddy / Nginx / Traefik u otro reverse proxy
  -> http://127.0.0.1:3000
```

También puede usarse una IP dinámica con DDNS, siempre que resuelvas el acceso público y HTTPS correctamente.

En el primer arranque elegí:

```text
2) URL HTTPS PROPIA
```

y escribí, por ejemplo:

```text
https://mcp.midominio.com
```

El launcher mostrará para ChatGPT:

```text
https://mcp.midominio.com/mcp
```

### 3. Sólo local

Para Claude Desktop, Codex u otros clientes MCP instalados en la misma computadora podés usar `stdio` y no publicar nada en Internet.

Ejemplo:

```text
node /ruta/mcp-server/mcp-server.js --stdio
```

ChatGPT Web remoto no puede acceder directamente a `127.0.0.1`; para ese caso necesitás una URL alcanzable desde Internet, ya sea mediante un túnel o infraestructura propia.

## Configurar ChatGPT

Con el MCP y el túnel/URL pública levantados:

1. Abrí **Configuración** de ChatGPT.
2. Buscá **Apps / Connectors / Conectores** y las opciones avanzadas o **Developer Mode / Modo desarrollador**. El nombre exacto puede variar según la versión de la interfaz.
3. Agregá un servidor MCP personalizado.
4. Elegí un nombre, por ejemplo `MCP Mi PC`.
5. Pegá la URL que imprimió el launcher, terminada en `/mcp`:

```text
https://xxxx.ngrok-free.app/mcp
```

6. Seleccioná la autenticación correspondiente. Si dejaste `MCP_AUTH_TOKEN` vacío, configurá el conector sin autenticación si la interfaz lo permite.
7. Guardá y habilitá el MCP en el chat.
8. Una primera prueba útil es pedir:

```text
Usá MCP Mi PC y ejecutá control_capabilities.
```

Después podés pedir, por ejemplo:

```text
Mostrame el estado del sistema.
Revisá este repositorio y el git diff.
Listá las sesiones tmux.
Hacé una captura de pantalla.
Auditá lo que está haciendo Codex en la sesión tmux "proyecto".
```

## Configuración `.env`

El launcher crea `.env` automáticamente. También podés editarlo a mano:

```bash
PORT=3000
HOST=127.0.0.1
ALLOWED_PATHS=/home/usuario/Proyectos
WORKING_DIR=/home/usuario/Proyectos

# 0 recomendado; 1 acceso completo permitido por el usuario
MCP_FULL_ACCESS=0

# ngrok | direct | local
MCP_EXPOSURE_MODE=ngrok

# Sólo para direct. No agregar /mcp al final.
PUBLIC_BASE_URL=https://mcp.midominio.com

MCP_DESKTOP_ENABLED=1
MCP_INPUT_ENABLED=1
MCP_AUTH_TOKEN=
```

Para volver a ejecutar el asistente inicial, podés guardar/borrar `.env` y lanzar otra vez `./start-mcp.sh`.

## Acceso restringido vs full-control

### Restringido — recomendado

```bash
MCP_FULL_ACCESS=0
ALLOWED_PATHS=/home/usuario/Proyectos,/otro/directorio
```

Las rutas quedan limitadas a `ALLOWED_PATHS`.

### Full-control

```bash
MCP_FULL_ACCESS=1
```

El servidor acepta rutas de todo el filesystem que pueda leer/escribir el usuario que lo ejecuta. Herramientas como `run_command`, señales de proceso, servicios, Git y control de escritorio siguen limitadas por los permisos reales del sistema operativo.

No publiques un MCP full-control sin entender qué estás exponiendo. Cerrá el túnel cuando no lo necesites y considerá autenticación/red privada para instalaciones permanentes.

## Herramientas disponibles

Actualmente expone 49 herramientas.

### Archivos

`search`, `fetch`, `list_files`, `read_file`, `write_file`, `patch_file`, `file_info`, `read_image`, `tail_file`, `run_command`.

`read_image` devuelve PNG/JPEG/WebP/GIF como contenido visual MCP, por lo que el modelo puede ver la imagen y no solamente su ruta.

### Sistema

`control_capabilities`, `system_snapshot`, `hardware_info`, `disk_usage`, `network_status`, `gpu_status`, `process_list`, `process_info`, `process_signal`, `process_start`, `service_status`, `service_action`, `journal_tail`.

### Git

`git_status`, `git_diff`, `git_log`, `git_branches`, `git_worktrees`, `git_command`.

### tmux / Codex workers

`tmux_list`, `tmux_panes`, `tmux_create`, `tmux_capture`, `tmux_send`, `tmux_interrupt`, `tmux_kill`.

Esto permite un flujo como:

```text
ChatGPT -> tmux_capture -> lee a Codex
ChatGPT -> git_diff/tests/logs -> audita
ChatGPT -> tmux_send -> corrige/orienta al worker
Codex CLI -> sigue trabajando directamente en el repo
```

### Escritorio y visión

`desktop_info`, `screen_capture`, `list_windows`, `window_action`, `mouse_move`, `mouse_click`, `mouse_scroll`, `keyboard_hotkey`, `keyboard_type`, `desktop_open`.

En X11 hay control global mediante XTEST/python-xlib. En KDE Plasma Wayland la captura prioriza Spectacle; Wayland puede restringir mouse/teclado global y algunas acciones de ventanas.

### Cámara y audio

`camera_list`, `camera_snapshot`, `audio_devices`.

## Dependencias

El launcher intenta instalarlas automáticamente cuando puede.

Base:

- Node.js 18+
- npm
- Git
- curl
- Python 3

Extras útiles en Linux:

- `tmux`
- `wmctrl`
- `scrot`, `gnome-screenshot`, `grim` o KDE Spectacle
- `python3-xlib`
- `xdotool`
- `ffmpeg`
- `v4l-utils`
- PulseAudio/PipeWire o ALSA para audio

Instalación manual de dependencias:

```bash
./install-deps.sh
```

Instalación manual de ngrok:

```bash
./install-ngrok.sh
```

## Seguridad y autenticación

`GET /health` se mantiene disponible para comprobar si el servidor está vivo.

Si configurás `MCP_AUTH_TOKEN`, los demás endpoints esperan:

```text
Authorization: Bearer <token>
```

La aplicación no devuelve el token desde `/config` ni lo imprime en claro en el arranque.

Generar un token:

```bash
openssl rand -hex 24
```

Cada llamada MCP se registra como actividad. Las acciones destructivas conservan metadata MCP de riesgo aunque `MCP_FULL_ACCESS=1` esté activo.

## Endpoints

```text
GET  /health
GET  /config
GET  /tools
POST /mcp
GET  /mcp
GET  /sse
POST /messages
```

Para ChatGPT moderno usá principalmente:

```text
https://TU_URL_PUBLICA/mcp
```

## Actualizar

```bash
git pull
./start-mcp.sh
```

O para probar antes:

```bash
git pull
npm test
./self-test.sh
```

## Pruebas

Chequeo estático:

```bash
npm test
```

Chequeo funcional:

```bash
./self-test.sh
```

`self-test.sh` crea y elimina una sesión tmux temporal y puede tomar una captura de pantalla. No hace clicks ni escribe texto en otras aplicaciones.

## Windows

El núcleo MCP (archivos, comandos, Git, procesos compatibles) funciona con Node.js. `start-mcp.cmd` sigue disponible como launcher para Windows, pero las herramientas de escritorio X11 son específicas de Linux. En Windows el nivel exacto de herramientas disponibles se puede consultar con `control_capabilities`.

Para una instalación orientada a control de escritorio completo, Linux/X11 es actualmente el entorno con mayor cobertura de este proyecto.

## Licencia

MIT. Usalo bajo tu propia responsabilidad, especialmente cuando habilites acceso completo o publiques el servidor en Internet.
