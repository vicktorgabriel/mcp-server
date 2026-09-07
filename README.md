# MCP Local Full Control

> **4.6.0:** 86 herramientas registradas, diez nuevas capacidades de proyecto y seguimiento, catalogo humano por cliente, parches con hash obligatorio, restauraciones propias con deteccion de conflictos, trabajos idempotentes y trazas de comunicacion. Mantiene las correcciones de limites de recursos de la entrega anterior.

> **4.5.3:** corrige el retorno OAuth desde el formulario sandboxed de ChatGPT. La CSP permite ahora únicamente el issuer y el origen del callback registrado, evitando que `form-action` bloquee el redirect después del login. También separa completamente Autorizar/Cancelar, acepta `Origin: null` sólo con Fetch Metadata de navegación segura, serializa el estado OAuth entre procesos, mejora el diagnóstico sin registrar secretos y ordena módulos, pruebas y documentación en carpetas específicas.

Servidor MCP para administrar un equipo propio desde ChatGPT y otros clientes compatibles. Expone herramientas de archivos, comandos, procesos, servicios, Git, tmux, escritorio, captura de pantalla, cámara, audio y diagnóstico del sistema.

Incluye:

- un panel de inicio con logo, versión, cantidad de herramientas, perfil, cuenta, confirmaciones y estado de actualización;
- configuración inicial completa en **una sola terminal**;
- perfiles de acceso que deciden qué herramientas verá ChatGPT;
- 86 herramientas verificadas para archivos, red, paquetes, firewall, montajes, contenedores, escritorio y administración;
- ejecución opcional como `root`, siempre mediante una aceptación de riesgo explícita;
- confirmaciones críticas opcionales para quienes necesiten automatización total;
- comprobación de actualizaciones en segundo plano, con aviso de color cuando hay una versión nueva;
- arranque y detección de capacidades optimizados;
- guardado automático del endpoint de ngrok;
- OAuth 2.1 integrado para ChatGPT con CIMD + DCR, PKCE, `none`/`private_key_jwt` y refresh tokens;
- modo temporal o servicio persistente;
- registros explicados en lenguaje legible;
- separación estricta entre configuración pública del repositorio y secretos locales.

> **Advertencia de seguridad:** este servidor puede leer, escribir, ejecutar comandos y controlar el escritorio con los permisos del usuario que lo inicia. Instalalo solamente en equipos propios, restringí las carpetas permitidas y preferí OAuth para cualquier endpoint permanente.

## Plataformas

La experiencia completa está preparada para Linux con Bash y systemd, especialmente Debian y Ubuntu.

- **Linux con systemd:** asistente inicial, modo temporal y servicio persistente.
- **Linux sin systemd/macOS:** asistente y modo temporal; el servicio persistente debe adaptarse al gestor de servicios del sistema.
- **Windows:** para la experiencia completa se recomienda WSL. El launcher `start-mcp.cmd` se mantiene para compatibilidad básica.

Requisitos mínimos: Node.js 18 o superior, npm, Git, curl y Python 3. El launcher intenta instalar dependencias faltantes en distribuciones compatibles.

## Instalación rápida

```bash
git clone https://github.com/vicktorgabriel/mcp-server.git
cd mcp-server
bash start-mcp.sh
```

En el primer inicio aparece un asistente. No hace falta abrir otra terminal ni editar `.env` a mano.

El asistente pregunta:

1. qué carpetas puede administrar el MCP;
2. qué perfil de herramientas se publicará;
3. si el proceso se ejecutará como usuario normal o como `root`;
4. si las acciones críticas exigirán una confirmación adicional;
5. si se publicará mediante ngrok, una URL/IP propia o solamente en local;
6. el authtoken y el endpoint de ngrok, cuando corresponda;
7. si usará OAuth, token Bearer o ninguna autenticación;
8. si se iniciará en modo temporal o persistente.

La configuración se conserva para los próximos inicios.

## Docker

MCP Server también puede ejecutarse con Docker Compose sin modificar la instalación nativa existente.

Para una instalación nueva:

```bash
cp .env.example .env
docker compose build
docker compose run --rm mcp ./mcpctl.sh configure
docker compose up -d
```

`docker compose run --rm` inicia un contenedor temporal para ejecutar el asistente interactivo. La configuración generada se conserva en los directorios montados y luego es reutilizada por `docker compose up`.

Si `.env` y `.private` ya están configurados, basta con:

```bash
docker compose up -d
```

El directorio de trabajo del host se monta en `/workspace`. Puede seleccionarse explícitamente definiendo `MCP_DOCKER_WORKSPACE` antes de iniciar Compose.

Para revisar el estado y los logs:

```bash
docker compose ps
docker compose logs -f mcp
```

## Dónde se guardan la configuración y los secretos

| Archivo/directorio | Contenido | Git |
|---|---|---|
| `.env` | URL, puerto, rutas, perfil, cuenta del proceso, confirmaciones y modos seleccionados | Ignorado |
| `.private/ngrok.yml` | Authtoken de ngrok | Ignorado, modo `0600` |
| `.private/oauth-state.json` | Hash de contraseña, clientes y hashes de tokens OAuth | Ignorado, modo `0600` |
| `.private/bearer-token.txt` | Token Bearer, sólo si se eligió ese modo | Ignorado, modo `0600` |
| `.runtime/` | estado, actividad y diagnóstico local | Ignorado |

No copies secretos dentro del README, scripts, commits, capturas públicas ni mensajes de soporte.

## Estructura del repositorio

La raíz conserva solamente los entrypoints y comandos que usa una persona o el
servicio. El código interno, las pruebas y los informes no se mezclan con esos
comandos:

```text
mcp-server/
├── mcp-server.js          # servidor MCP HTTP/stdio
├── mcp-supervisor.js      # proceso supervisor y túnel
├── mcpctl.sh              # administración cotidiana
├── start-mcp.sh           # instalación y arranque
├── lib/                   # OAuth, políticas, herramientas, logs y diagnóstico
├── tests/                 # self-tests aislados; nunca usan el estado OAuth real
├── docs/                  # informes técnicos sin secretos
├── .private/              # credenciales/estado local, ignorado por Git
└── .runtime/              # logs y estado de ejecución, ignorado por Git
```

Las comprobaciones principales siguen siendo:

```bash
npm test
npm run selftest
npm audit --audit-level=low
```

El informe de esta corrección está en
[`docs/OAUTH_DIAGNOSTICO.md`](docs/OAUTH_DIAGNOSTICO.md).

## Arquitectura Gateway / Ejecutor sobre IPC

Para garantizar el principio de mínimo privilegio y una separación clara de responsabilidades, el servidor implementa un modelo de dos procesos comunicados mediante IPC local:

```text
[ Cliente / ChatGPT ]
        │  (HTTP/SSE/stdio + OAuth 2.1)
        ▼
[ Gateway MCP sin privilegios ] (mcp-server.js)
        │
        │  Socket Unix protegido (.runtime/ipc/mcp.sock - modo 0700)
        │  Enmarcado binario 4-byte BE (límite 16MB) + Request IDs
        │  Tiempos de espera, cancelación y contrapresión
        ▼
[ Ejecutor Seguro de Herramientas ] (lib/ipc-executor.js)
        │
        ├─► Validación estricta de política efectiva y cliente autenticado (lib/access-policy.js)
        ├─► Verificación de aprobaciones humanas anti-tamper (lib/approvals.js)
        ├─► Confinamiento sandbox y defensas SSRF/path (lib/sandbox.js)
        └─► Gestión de trabajos asíncronos y procesos (lib/job-manager.js)
```

- **Validación determinista:** El Ejecutor evalúa por llamada la política efectiva, la identidad autenticada y el alcance. No confía en parámetros `"authorized": true` ni asunciones enviadas por el cliente o capas intermedias.
- **Frontera de seguridad y máquinas virtuales:** Dos procesos que comparten el mismo UID de usuario no constituyen una barrera de aislamiento del SO. Si el host no soporta aislamiento real, los perfiles restringidos fallan de forma cerrada (`fail-closed`). Para mitigar código o modelos hostiles, se recomienda correr el ejecutor con un usuario dedicado sin acceso a Docker/sudo ni sesión gráfica, o aislarlo en una **Máquina Virtual (VM)** dedicada.
- **Trazabilidad completa:** Cada invocación registra la cadena `Cliente -> Autenticación -> Política -> Ejecutor -> Resultado`, midiendo con precisión milimétrica latencias individuales (`t_auth_ms`, `t_policy_ms`, `t_executor_ms`), bytes transmitidos y request ID.

## Trabajos Asíncronos, Vistas Previas y Sandbox

- **Control de procesos asíncronos (`lib/job-manager.js`):** Soporta comandos de larga duración (`job_start`, `job_status`, `job_output`, `job_cancel`) con aislamiento por `clientId`, paginación de salida (`bytesRead`), buffers acotados y terminación de todo el árbol de procesos mediante grupos de procesos (`SIGTERM` + `SIGKILL`).
- **Parada de emergencia y pausa:** Permite suspender la admisión de nuevas acciones y forzar la detención inmediata de tareas en curso.
- **Defensas del Sandbox (`lib/sandbox.js`):**
  - **Aislamiento con Bubblewrap (`bwrap`):** En perfil `trabajo_restringido`, los comandos se ejecutan con `bwrap` con sistema de archivos montado de sólo lectura (`--ro-bind`) excepto las raíces autorizadas (`--bind`), red deshabilitada (`--unshare-net`), namespace PID aislado (`--unshare-pid`) y protección de archivos de control del servidor (`.env`, `.runtime`, `.private`, tokens y código del servidor).
  - **Límites de recursos (CPU, Memoria, Tareas/Procesos):** Motor dual para restringir consumo:
    1. **cgroups v2 / systemd scopes:** (`systemd-run --user --scope`) limitando `MemoryMax`, `CPUQuota` y `TasksMax`.
    2. **prlimit:** (`--as`, `--nproc`, `--cpu`) para contención en entornos unprivileged sin cgroups v2.
    - Soporta modo estricto fail-closed (`MCP_REQUIRE_RESOURCE_LIMITS=1`).
    - Guía detallada y plantillas en [`docs/RESOURCE_LIMITS_CGROUPS.md`](docs/RESOURCE_LIMITS_CGROUPS.md).
  - **Path traversal:** Resolución con `fs.realpathSync` para impedir escapes mediante symlinks.
  - **Zip-Slip:** Bloqueo de rutas relativas maliciosas en archivos comprimidos TAR/ZIP.
  - **Egress SSRF:** Bloqueo determinista de direcciones IPv4 privadas (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), IPv6 privadas/link-local (fc00::/7, fe80::/10), loopback (`127.0.0.1`, `::1`) y la IP de metadatos (`169.254.169.254`).

## Perfiles de acceso

El asistente separa cuatro decisiones diferentes:

- **Alcance de archivos:** únicamente las carpetas indicadas o todo lo permitido por el usuario del sistema.
- **Perfil de herramientas:** cuáles de las 86 herramientas se anuncian a ChatGPT y cuáles se rechazan aunque un cliente intente invocarlas directamente.
- **Cuenta de ejecución:** usuario normal o `root`. `root` puede superar las barreras de permisos del sistema.
- **Confirmaciones críticas:** exigir o no las frases adicionales de seguridad antes de borrar, instalar paquetes, cambiar firewall/montajes, modificar contenedores o apagar el equipo.

| Perfil | Herramientas visibles | Uso recomendado |
|---|---:|---|
| `observacion` | Segun politica efectiva | Auditorías y lectura de archivos/sistema sin red ni capturas de pantalla/cámara/audio por defecto. |
| `trabajo_restringido` | Segun politica efectiva | Tareas acotadas de desarrollo en carpetas explícitas, sin red externa ni herramientas de administración del sistema. |
| `read_only` | Segun politica efectiva | Perfil clásico de sólo lectura: archivos, estado del sistema, Git/tmux de consulta, red y capturas. |
| `developer` | Segun politica efectiva | Desarrollo cotidiano: archivos, comandos, Git, tmux, descargas y Compose. Es el valor predeterminado. |
| `administrator` | Segun politica efectiva | Administración del equipo: servicios, procesos, paquetes, firewall, montajes, teclado/mouse, cámara y audio. |
| `full` | Segun politica efectiva | Todo lo anterior más la herramienta dedicada de reinicio/apagado. |
| `custom` | Variable | Grupos elegidos manualmente y bloqueos por herramienta. |

El perfil personalizado permite combinar grupos como `files_read`, `files_write`, `system_read`, `system_manage`, `git_read`, `git_write`, `network`, `packages`, `firewall`, `mounts`, `containers`, `desktop_view`, `desktop_control`, `camera`, `audio` y `power`. También se pueden aplicar `MCP_TOOL_ALLOWLIST` y `MCP_TOOL_DENYLIST` para filtrar nombres concretos.

Podés consultar la política activa desde ChatGPT con `tool_policy_status` o localmente con:

```bash
./mcpctl.sh status
```

> **Límite importante:** los perfiles son una barrera de herramientas, no una máquina virtual. `run_command`, control de teclado, tmux y algunas operaciones Git/Compose son capacidades amplias. Para una separación estricta, elegí `observacion`, `trabajo_restringido` o un perfil `custom` sin `command_execution`, ejecutá el MCP con un usuario dedicado y restringí `ALLOWED_PATHS`.

### Usuario normal o root

El modo recomendado ejecuta el MCP con el propietario del repositorio. Las herramientas administrativas no elevan privilegios por sí solas; `control_capabilities` informa si el usuario tiene acceso real mediante `root` o `sudo` no interactivo.

El asistente también permite elegir **root**. Para habilitarlo exige escribir exactamente `ACEPTO ROOT TOTAL`. En modo temporal, el launcher vuelve a iniciarse mediante `sudo`. En modo persistente, la unidad systemd utiliza `User=root`. Los archivos privados y logs generados por el proceso se devuelven al propietario del repositorio cuando es posible.

Un MCP root puede leer secretos del sistema, instalar software, cambiar servicios, firewall y discos, o inutilizar el equipo. Para un servicio público persistente, el instalador exige OAuth sobre HTTPS por defecto.

### Confirmaciones críticas y Aprobaciones Fuera de Banda (Anti-Tamper)

1. **Confirmaciones en línea (Legacy):**
   Por defecto, herramientas de mayor riesgo admiten frases como `DELETE`, `APPLY PACKAGES`, etc. Sin embargo, dado que estas frases pueden ser generadas directamente por un modelo LLM o mediante inyecciones de prompt, **no representan un consentimiento humano real**.

2. **Aprobaciones Fuera de Banda (Reales / Anti-Tamper):**
   Para operaciones que requieren intervención humana genuina, el servidor implementa un gestor criptográfico de aprobaciones (`lib/approvals.js`):
   - Cada solicitud sensible genera un ticket pendiente enlazado a: `clientId` + `herramienta` + `hash canónico SHA-256 de los argumentos exactos` + `versión de política`.
   - El modelo **no** puede auto-aprobarse ni alterar la política.
   - La aprobación o rechazo se realiza exclusivamente desde la terminal local autenticada:
     ```bash
     ./mcpctl.sh pending              # Listar solicitudes pendientes
     ./mcpctl.sh approve <ticket-id>  # Aprobar ejecución (uso único atómico)
     ./mcpctl.sh reject <ticket-id>   # Rechazar solicitud
     ```
   - Cada ticket aprobado se consume de forma atómica y unívoca en `.runtime/approvals.json` con candado concurrente (`.lock`), impidiendo ataques de repetición (replay) o modificación de argumentos.

Para cambiar el perfil, la cuenta de ejecución o las confirmaciones sin volver a ingresar ngrok ni OAuth:

```bash
./mcpctl.sh permissions-set
```

`./mcpctl.sh configure` continúa disponible para reconfigurar todo. Después de cambiar herramientas o confirmaciones, volvé a escanear la app en ChatGPT.

## Panel de inicio y actualizaciones

Cada inicio muestra un logo ASCII de **MCP-Server**, la versión instalada, la versión de Node.js, cuántas herramientas se publican, el perfil elegido, el alcance de archivos, la cuenta del proceso, el estado de las confirmaciones, la autenticación y el método de publicación.

La comprobación de Git utiliza un caché de 15 minutos y se actualiza en segundo plano para no bloquear el inicio. Cuando `origin/main` contiene una revisión nueva aparece un aviso destacado en otro color. También se avisa si el árbol local tiene cambios o si el historial divergió.

Comprobación manual:

```bash
./mcpctl.sh update-check
```

Ajustes locales opcionales:

```text
MCP_UPDATE_CHECK=1
MCP_UPDATE_CHECK_TTL_SECONDS=900
MCP_UPDATE_CHECK_TIMEOUT_MS=5000
```

El servidor se mantiene como código JavaScript ejecutado por Node.js. Compilarlo no aporta una mejora significativa para las tareas dominadas por disco, red, Git, procesos y herramientas externas; además dificultaría las actualizaciones y la compatibilidad entre distribuciones. Node.js compila en tiempo de ejecución las partes activas, y el panel indica expresamente el motor utilizado.

## Rendimiento

El inicio guarda una huella de las dependencias verificadas en `.runtime/dependencies.ready`. Mientras no cambien `install-deps.sh`, `package.json`, `package-lock.json`, la plataforma ni los ejecutables base, no repite la comprobación completa. Puede forzarse con:

```bash
MCP_FORCE_DEPENDENCY_CHECK=1 bash start-mcp.sh
```

La detección de programas ya no abre un shell por cada herramienta y el catálogo MCP se construye una sola vez por proceso. Esto reduce especialmente la demora de `control_capabilities`, el listado de herramientas y los reinicios sucesivos.

## Publicación del MCP

### Opción 1: ngrok — recomendada

ngrok proporciona HTTPS, funciona detrás de CGNAT, evita abrir puertos en el router y permite usar una URL estable si la cuenta tiene un endpoint reservado.

Durante el primer inicio:

- el asistente solicita el **authtoken** con entrada oculta;
- solicita la URL asignada o reservada, por ejemplo `https://mi-equipo.ngrok.dev`;
- también permite presionar Enter para detectar el endpoint predeterminado de la cuenta;
- comprueba realmente el túnel;
- guarda el endpoint en `.env` para reutilizarlo;
- guarda el authtoken únicamente en `.private/ngrok.yml`.

No escribas `/mcp` dentro de `NGROK_URL`. El launcher lo agrega al mostrar la dirección final.

### Opción 2: IP pública o URL propia

El asistente detecta la IP externa, cambia el servidor para escuchar en `0.0.0.0` y muestra una dirección directa. También puede intentar abrir el puerto en UFW o firewalld después de pedir confirmación.

Esta modalidad requiere administrar correctamente:

- firewall del VPS o router;
- redirección de puertos cuando corresponda;
- DNS;
- certificado TLS válido;
- cambios de IP;
- reverse proxy, si se desea HTTPS.

Una dirección HTTP con IP puede servir para pruebas con clientes compatibles, pero **OAuth y ChatGPT requieren una URL HTTPS válida**. Además, un token Bearer sobre HTTP viajaría sin cifrado: el asistente exige una confirmación explícita y sólo lo considera apto para modo temporal. Por eso ngrok es la opción recomendada para una instalación sencilla.

### Opción 3: sólo local

Escucha únicamente en `127.0.0.1`. Sirve para clientes instalados en la misma computadora mediante HTTP o `stdio`, pero ChatGPT Web no puede conectarse directamente a un servidor local.

### Opción 4: Cloudflare Tunnel (cloudflared)

Cloudflare Tunnel permite exponer el servidor MCP sobre HTTPS con un hostname propio y estable sin abrir puertos ni depender de reenvíos NAT:
- El supervisor gestiona el proceso `cloudflared` apuntando únicamente al origen loopback `http://127.0.0.1:3000`.
- Los secretos del túnel se almacenan protegidos en `.private/`.
- Soporta streaming HTTP y eventos Server-Sent Events (SSE) del protocolo MCP.
- Guía de endurecimiento, mitigación de abusos y configuración WAF documentada en [`docs/CLOUDFLARE_WAF.md`](docs/CLOUDFLARE_WAF.md) (reglas de rate limiting, no-cache para `/mcp` y `/oauth`, y omisión de desafíos CAPTCHA interactivos en llamadas de máquinas).

## Autenticación

### Compatibilidad actual de ChatGPT (4.5.3)

El servidor debe continuar configurado con **OAuth 2.1**; no es necesario cambiarlo a sin autenticación ni a un token Bearer. En la pantalla de creación de ChatGPT elegí **Mixtas / Mixed authentication**, no la opción global **OAuth**. Esta selección no rebaja la seguridad: permite que ChatGPT ejecute `initialize` y `tools/list` sin sesión para descubrir el MCP, pero ninguna herramienta puede ejecutarse hasta completar OAuth.

El flujo validado es:

1. crear la app con autenticación **Mixtas** y escanear sus herramientas;
2. seleccionar la app en un chat y pedir `tool_policy_status`;
3. pulsar **Actualizar acceso / Update access** cuando ChatGPT lo solicite;
4. ingresar las credenciales en la página del MCP y autorizar una sola vez;
5. esperar el regreso automático a ChatGPT y la respuesta autenticada de la herramienta.

La opción global **OAuth** también puede iniciar el protocolo estándar, pero la interfaz de ChatGPT ha mostrado intentos que quedan esperando antes de enviar siquiera `GET /oauth/authorize`. El flujo Mixtas por herramienta es el camino reproducible y comprobado para esta versión.

Por defecto se usa **DCR + authorization code + PKCE S256**. El servidor no anuncia `authorization_response_iss_parameter_supported` salvo que `MCP_OAUTH_RESPONSE_ISS=1`, porque RFC 9207 exige devolver `iss` en absolutamente todas las respuestas de autorización. Con el valor predeterminado `0`, ChatGPT registra un callback específico por conexión.

Las herramientas publican `securitySchemes: [{type: "oauth2", scopes: ["mcp:tools"]}]` y el mismo descriptor en `_meta` por compatibilidad. Antes de enlazar la cuenta, `initialize` y `tools/list` pueden responder para que ChatGPT descubra el servidor; ninguna herramienta se ejecuta sin token. Un `tools/call` no autenticado devuelve un resultado de error con `_meta["mcp/www_authenticate"]`, tal como requiere el flujo de linking de ChatGPT.

Después de actualizar desde 4.4.x, **eliminá y recreá la app/conector en ChatGPT una vez** para que ChatGPT registre el nuevo callback DCR. No borres `.env` ni `.private/oauth-state.json`.


### OAuth 2.1 — recomendada

El servidor incluye un proveedor OAuth para la cuenta administradora local. Implementa:

- autorización por código;
- PKCE con `S256`;
- Protected Resource Metadata;
- Authorization Server Metadata;
- registro dinámico de clientes (DCR) como camino predeterminado y validado;
- Client ID Metadata Documents (CIMD) opcional y con validación remota fail-closed;
- tokens de acceso de corta duración;
- refresh tokens rotativos y detección de reutilización, con revocación de toda la familia de sesión;
- validación estricta del recurso `/mcp`;
- revocación de sesiones;
- límites de intentos;
- hashes scrypt para la contraseña;
- almacenamiento de códigos y tokens únicamente como hashes.

En el asistente del servidor elegí OAuth y definí un usuario y una contraseña distinta de la contraseña del sistema. En ChatGPT elegí Mixtas: el escaneo descubre las herramientas y la página de autorización se abre al invocar una herramienta protegida y pulsar **Actualizar acceso**. Esa pantalla muestra el destino, el perfil elegido, la cantidad de herramientas y alertas rojas si se habilitaron `root` o las confirmaciones desactivadas; revisalos antes de autorizar.

El proveedor integrado está orientado a una instalación privada y de un solo administrador. Para publicar un servicio multiusuario, empresarial o de terceros, conviene usar un proveedor de identidad establecido y auditar su configuración por separado.

El modo predeterminado anuncia **DCR** y deja CIMD desactivado para máxima compatibilidad con ChatGPT. Para CIMD acepta por defecto únicamente `chatgpt.com`, exige descargar y validar el documento HTTPS y comprueba `redirect_uri`, PKCE y `resource`. El modo predeterminado del token endpoint es `none + PKCE`, que ChatGPT soporta oficialmente y no necesita `client_secret` ni JWKS. `private_key_jwt` queda implementado pero se habilita sólo con `MCP_OAUTH_PRIVATE_KEY_JWT=1`; entonces se verifican RS256, `iss`/`sub`, audiencia, vigencia, replay y el JWKS HTTPS del mismo origen.

Cuando el cliente registra el grant `refresh_token`, el servidor entrega un
refresh token rotativo aunque la autorización solicite únicamente el scope de
recurso `mcp:tools`. `offline_access` continúa anunciado como scope opcional,
pero no se fuerza dentro de `WWW-Authenticate` ni de los metadatos del recurso.

Si la descarga de un CIMD falla, el servidor no fabrica metadatos ni confía en
un cliente que no pudo verificar. La solicitud se rechaza y DCR continúa
disponible. Para el enlace reproducible de ChatGPT mantené la configuración
predeterminada y elegí **Mixtas**.

Comandos de administración:

```bash
./mcpctl.sh oauth-status
./mcpctl.sh oauth-reset
./mcpctl.sh oauth-reset-all
```

`oauth-reset` revoca las sesiones. `oauth-reset-all` también elimina los clientes registrados, por lo que ChatGPT deberá registrarse y autorizarse nuevamente.

### Autenticación Multifactor (MFA) y Revocación

El servidor implementa autenticación multifactor (`lib/mfa.js`) para proteger el inicio de sesión OAuth y las operaciones administrativas sensibles:
- **WebAuthn / Passkeys / FIDO2:** método preferido con verificación de usuario criptográfica (basado en `@simplewebauthn`), validación estricta de RP ID y Origin HTTPS, y protección contra suplantación (phishing).
- **TOTP (RFC 6238):** compatible con Google Authenticator / Aegis / Bitwarden, con tolerancia de deriva temporal de ±1 intervalo, protección contra repetición de códigos y bloqueo automático tras 5 intentos fallidos consecutivos.
- **Recuperación segura:** códigos de emergencia de un solo uso generados localmente y almacenados únicamente como hashes criptográficos SHA-256 en `.private/mfa-state.json` (modo `0600`).
- **Cero fugas:** ni las semillas ni los códigos se exponen en logs ni respuestas del protocolo MCP.
- **Revocación por cliente:** permite desautorizar inmediatamente un cliente específico sin afectar al resto:
  ```bash
  ./mcpctl.sh revoke <clientId>
  ```
- **Gestión local de MFA:**
  ```bash
  ./mcpctl.sh mfa status    # Verificar estado de MFA
  ./mcpctl.sh mfa enroll    # Enrolar WebAuthn o TOTP
  ./mcpctl.sh mfa reset     # Restablecer MFA (requiere acceso a la máquina local)
  ```
> **Nota de seguridad:** MFA refuerza el flujo de autenticación inicial y el consentimiento OAuth; no sustituye el cifrado en tránsito HTTPS ni revoca de inmediato un bearer token robado si no se ejecuta una revocación explícita.

### Token Bearer

Se ofrece como alternativa de compatibilidad. El asistente genera un token aleatorio si se deja el campo vacío y lo guarda únicamente en `.private/bearer-token.txt`; no lo copia dentro de `.env`.

No es tan cómodo como OAuth para una app de ChatGPT y obliga a proteger y actualizar manualmente el token en cada cliente. Nunca lo uses sobre una URL pública HTTP sin cifrado.

### Sin autenticación

Sólo debe utilizarse durante pruebas controladas. El asistente exige escribir una confirmación explícita porque cualquiera que conozca la URL podría ejecutar las herramientas habilitadas.

No dejes un MCP con acceso de escritura o control total publicado permanentemente sin autenticación.

## Inicio temporal y persistente

Al ejecutar:

```bash
bash start-mcp.sh
```

aparece este criterio de selección:

- **Temporal:** el log queda visible; `Ctrl+C` o cerrar la terminal detiene MCP y ngrok. Es la opción apropiada para uso ocasional.
- **Persistente:** instala `mcp-local.service`, continúa después de cerrar la terminal y se inicia con el equipo. El instalador rechaza por defecto un endpoint público sin autenticación o sobre HTTP; se recomienda OAuth con HTTPS.

Accesos directos:

```bash
bash start-mcp.sh --temporary
bash start-mcp.sh --persistent
```

El modo persistente mantiene activo el endpoint de ngrok. Revisá los límites y costos de tu cuenta de ngrok si sólo necesitás el MCP durante períodos puntuales. Los modos públicos sin autenticación o sin HTTPS quedan limitados al uso temporal, salvo una anulación experta deliberada mediante `MCP_ALLOW_UNSAFE_PERSISTENT=1`.

## Registros legibles

El registro principal describe **qué se está haciendo**, quién lo solicitó, si funcionó y cuánto demoró. No muestra el contenido de contraseñas, tokens ni texto escrito mediante el teclado.

```bash
./mcpctl.sh logs
```

Ejemplo conceptual:

```text
2026-09-04T18:42:10.123-03:00 | ACCION     | Revisando el estado Git del proyecto. Solicitud de usuario OAuth mediante ChatGPT.
2026-09-04T18:42:10.207-03:00 | RESULTADO  | Operación Git finalizada correctamente. Duración: 84 ms.
```

Seguir la actividad en tiempo real:

```bash
./mcpctl.sh logs-follow
```

`Ctrl+C` cierra solamente la vista; no detiene el servicio persistente.

Para diagnóstico técnico:

```bash
./mcpctl.sh logs-raw
```

Los registros se rotan automáticamente al alcanzar el límite configurado por `MCP_RUNTIME_LOG_MAX_BYTES` —10 MiB de forma predeterminada— y conservan una copia anterior con sufijo `.1`. Los registros técnicos también aplican redacción básica de secretos, pero pueden contener más información del sistema. No los publiques sin revisarlos.

## Cómo agregarlo a ChatGPT

Primero iniciá el MCP y obtené la guía con la URL exacta:

```bash
./mcpctl.sh chatgpt
```

La ruta oficial actual en ChatGPT Web es:

1. Abrí **Configuración → Apps → Configuración avanzada / Advanced settings**.
2. Activá **Modo desarrollador / Developer mode**.
3. Volvé a **Configuración → Apps** y pulsá **Crear / Create**.
4. Escribí un nombre que identifique al equipo, por ejemplo `MCP Taller`.
5. Pegá la URL que muestra `./mcpctl.sh url`, siempre terminada en `/mcp`.
6. Elegí el método configurado:
   - Si el servidor usa **OAuth:** elegí **Mixtas / Mixed authentication** en ChatGPT. No elijas la opción global OAuth para el primer enlace.
   - **Bearer:** ingresá el token privado si la interfaz ofrece ese método.
   - **Sin autenticación:** elegí `No authentication`.
7. Pulsá **Escanear herramientas / Scan tools**, esperá que termine y revisá las acciones detectadas.
8. Pulsá **Crear / Create**.
9. En un chat nuevo, seleccioná la app desde el menú de herramientas, `+` → **Más** o mediante una mención con `@`, según la interfaz disponible.
10. Pedí que ejecute `tool_policy_status`. ChatGPT mostrará **Necesita más acceso**; pulsá **Actualizar acceso**, completá el login del MCP y autorizá una sola vez.
11. Esperá que ChatGPT vuelva al chat y muestre el resultado de `tool_policy_status`. No vuelvas a pulsar Conectar sobre el formulario ya enviado.

En interfaces anteriores, el recorrido equivalente puede aparecer como **Configuración → Complementos → Configuración avanzada → Modo desarrollador**, seguido de **Complementos → Explorar complementos → Agregar**.

Actualmente, el MCP completo con acciones de escritura/modificación está disponible para Business y Enterprise/Edu según la política del workspace. En Pro, los MCP personalizados continúan limitados a lectura/obtención. La creación se realiza en ChatGPT Web y requiere modo desarrollador. Consultá la documentación oficial: `https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt`.

Sólo agregues servidores que controles y revisá las herramientas antes de habilitarlas para otros usuarios.

## Comandos principales

```bash
./mcpctl.sh status          # Estado resumido
./mcpctl.sh url             # URL exacta para ChatGPT
./mcpctl.sh chatgpt         # Guía de conexión
./mcpctl.sh configure       # Reconfigurar carpetas, perfil, exposición y autenticación
./mcpctl.sh permissions     # Mostrar perfil y herramientas permitidas/bloqueadas
./mcpctl.sh permissions --tools  # Mostrar las listas completas
./mcpctl.sh permissions-set # Cambiar perfil, root y confirmaciones sin tocar ngrok/OAuth
./mcpctl.sh pending         # Ver solicitudes de aprobación pendientes
./mcpctl.sh approve <id>    # Aprobar una operación sensible fuera de banda
./mcpctl.sh reject <id>     # Rechazar una solicitud de aprobación
./mcpctl.sh mfa status      # Consultar estado de autenticación multifactor
./mcpctl.sh mfa enroll      # Enrolar WebAuthn o TOTP
./mcpctl.sh mfa reset       # Restablecer MFA (desde la consola local)
./mcpctl.sh revoke <id>     # Revocar sesiones activas de un cliente OAuth
./mcpctl.sh diagnose        # Diagnóstico de permisos y capacidades del entorno
./mcpctl.sh update-check    # Comprobar ahora si hay una versión nueva
./mcpctl.sh temporary       # Iniciar en primer plano
./mcpctl.sh persistent      # Instalar/iniciar servicio persistente
./mcpctl.sh start           # Iniciar servicio instalado
./mcpctl.sh stop            # Detenerlo ahora
./mcpctl.sh restart         # Reiniciarlo
./mcpctl.sh disable         # Detener y quitar inicio automático
./mcpctl.sh logs            # Actividad legible
./mcpctl.sh logs-follow     # Actividad en vivo
./mcpctl.sh logs-raw        # Diagnóstico técnico
./mcpctl.sh doctor          # Comprobación completa
```

## Actualización

```bash
git pull
bash start-mcp.sh
```

Las instalaciones anteriores se migran sin borrar su `.env`. Para no quitar capacidades de manera inesperada, una instalación 4.1 o anterior sin perfil explícito migra inicialmente a `full`; luego podés reducirla con `./mcpctl.sh permissions-set`. Si una instalación antigua estaba publicada sin autenticación, se conserva para evitar cortar el acceso, pero se muestra una advertencia. Para activar OAuth:

```bash
./mcpctl.sh configure
```

Si cambian definiciones de herramientas después de crear la app en ChatGPT, puede ser necesario volver a escanear o actualizar las acciones desde la configuración de Apps.

## Herramientas incluidas

El servidor expone hasta **86 herramientas**, según el perfil seleccionado:

- búsqueda, lectura, escritura, parcheo, árbol de directorios, copia, movimiento, borrado y hashes;
- creación y extracción segura de archivos TAR/ZIP;
- ejecución de comandos y procesos;
- estado del sistema, hardware, GPU, red, usuarios, servicios y journal;
- paquetes del sistema, firewall, montajes y energía con confirmaciones configurables y modo de simulación;
- Git y worktrees;
- sesiones tmux;
- solicitudes HTTP, comprobación de puertos y descargas atómicas;
- Docker/Podman Compose, cuando alguno está instalado;
- ventanas, teclado, mouse y capturas de pantalla;
- cámara y audio;
- diagnóstico del propio MCP, política de acceso y actividad legible.

Las operaciones especialmente sensibles exigen frases de confirmación dentro de la llamada mientras esa capa esté activa, y varias admiten `dryRun` para mostrar la orden sin ejecutarla. La extracción de archivos rechaza rutas que escapan del destino, enlaces y dispositivos; las rutas permitidas también se validan contra escapes por enlaces simbólicos.

No todas las capacidades existen en todos los equipos. `control_capabilities` indica qué programas, escritorio y privilegios están realmente disponibles. Las herramientas se ejecutan con los permisos del usuario del proceso MCP; usar `root` amplía drásticamente el impacto de una credencial comprometida, por lo que se recomienda un usuario dedicado y OAuth.

## Resolución de problemas

### El login queda cargando en el modal de ChatGPT

Si el log llega a `Inicio de autorización` pero la interfaz de ChatGPT queda con el botón de inicio de sesión girando y no muestra la página del MCP, revisá la versión. En 4.5.0 y anteriores la página OAuth enviaba `X-Frame-Options: DENY` y `frame-ancestors 'none'`, lo que puede bloquear la interfaz nueva cuando presenta el login dentro de su propia superficie. Desde 4.5.1 se permite framing exclusivamente desde `chatgpt.com`/subdominios y se mantiene CSP restrictivo para los demás orígenes.

### Acepta usuario y contraseña, pero ChatGPT no vuelve al chat

En 4.5.2 y anteriores, la CSP de la pantalla permitía el POST sólo hacia el
issuer. Chromium aplicaba `form-action` también al redirect posterior y podía
bloquear el callback cross-origin de ChatGPT después de que el servidor ya
hubiera emitido el código. El síntoma era una pantalla inmóvil, ausencia total
de `POST /oauth/token` y, al pulsar Conectar otra vez, una transacción vencida o
rechazada.

Desde 4.5.3, `form-action` admite únicamente el issuer y el origen del callback
registrado. El servidor continúa enviando el 302 al redirect URI exacto guardado
en la transacción. Si vuelve a ocurrir, no reenvíes el formulario: consultá
`./mcpctl.sh logs` y comprobá si aparece `Solicitud al token endpoint`.

### ngrok funciona manualmente pero el launcher falla

Cerrá cualquier proceso ngrok manual y ejecutá:

```bash
./mcpctl.sh configure
```

El asistente guarda el ejecutable, el authtoken privado y el endpoint correcto para que no haya configuraciones de cuentas distintas.

### Error 502 de ngrok

```bash
./mcpctl.sh status
./mcpctl.sh logs
./mcpctl.sh logs-raw
```

Un 502 suele indicar que el túnel existe pero no puede llegar al servidor local. El estado correcto muestra health local operativo y ngrok apuntando a `http://127.0.0.1:3000` o al puerto elegido.

### CIMD devuelve HTTP 404 y no aparece el login

Si el log contiene `No se pudo verificar el documento CIMD ... HTTP 404`, el
servidor rechazó correctamente una identidad que no pudo comprobar. No borres
`.env` ni `.private`: ejecutá `./mcpctl.sh configure`, mantené DCR predeterminado,
reiniciá y creá una conexión nueva en ChatGPT con **Mixtas**.

El modo firmado `private_key_jwt` puede activarse manualmente con `MCP_OAUTH_PRIVATE_KEY_JWT=1`, pero el valor predeterminado es `0` para evitar una segunda dependencia de red hacia el JWKS cuando el equipo ya tiene problemas para consultar `chatgpt.com`.

### “El cliente OAuth no está registrado”

Desde 2026 ChatGPT puede usar dos mecanismos de identificación OAuth: CIMD o DCR. En CIMD **no existe un POST de registro**: ChatGPT envía una URL HTTPS de metadatos como `client_id`. Las versiones anteriores a 4.3.0 sólo conocían los IDs DCR guardados localmente y rechazaban ese flujo.

Actualizá el servidor y reinicialo:

```bash
git pull --ff-only
bash start-mcp.sh
```

La versión actual acepta CIMD sólo cuando su documento remoto puede validarse y
conserva DCR como camino predeterminado. Si el mensaje continúa y el `client_id`
no es una URL CIMD sino un ID antiguo, ChatGPT probablemente está reutilizando
un cliente DCR que ya no existe en `.private/oauth-state.json`. En ese caso
eliminá la app/conector anterior de ChatGPT y crealo de nuevo para forzar una
identidad nueva.

Podés ver el estado local con:

```bash
./mcpctl.sh oauth-status
./mcpctl.sh logs
```

### Autoriza correctamente pero ChatGPT rechaza después

Si el log muestra `Credenciales OAuth aceptadas y código emitido` pero
`oauth-status` sigue con cero sesiones, revisá inmediatamente:

```bash
./mcpctl.sh logs
```

El siguiente paso queda registrado de forma segura como `Solicitud al token endpoint`. El registro muestra el tipo de grant, si ChatGPT utilizó `none` o `private_key_jwt`, si el `resource` coincide y si PKCE llegó con una longitud válida. Nunca imprime `code`, `code_verifier`, `client_assertion`, access tokens ni refresh tokens. Un fallo posterior aparece como `Falló el token exchange` con el código OAuth exacto.

### OAuth no abre o vuelve a pedir autorización

```bash
./mcpctl.sh oauth-status
./mcpctl.sh logs
```

Comprobá que:

- la URL pública no cambió;
- usa HTTPS;
- el servidor usa OAuth y ChatGPT fue creado con **Mixtas**;
- el servicio y ngrok están activos;
- no se revocaron las sesiones.

Para comenzar de nuevo:

```bash
./mcpctl.sh oauth-reset-all
```

Luego eliminá/recreá o reconectá la app en ChatGPT.

### Reconfigurar mientras está en modo temporal

Volvé a la terminal donde está corriendo, presioná `Ctrl+C` y después ejecutá:

```bash
./mcpctl.sh configure
```

## Pruebas

```bash
npm test          # Suite completa: comprobaciones estáticas + 17 suites de pruebas
npm run selftest  # Validación integral con entorno aislado
```

Comandos específicos de las nuevas suites de seguridad:
```bash
npm run test:ipc        # Protocolo IPC binario, framing, esquema, socket Unix y backpressure
npm run test:approvals  # Aprobaciones fuera de banda, hash canónico SHA-256 y anti-replay
npm run test:sandbox    # Path traversal, symlinks realpath, zip-slip y bloqueo SSRF
npm run test:mfa        # WebAuthn (FIDO2/passkeys), TOTP, códigos hasheados y rate limiting
npm run test:jobs       # Trabajos asíncronos, buffers acotados, árbol de procesos y pausa
```

Las pruebas cubren sintaxis, panel de inicio y caché de actualización, perfiles de acceso (incluyendo `observacion` y `trabajo_restringido`), modos usuario/root, confirmaciones activas o desactivadas, filtrado y rechazo directo de herramientas, las 86 herramientas, seguridad de rutas y archivos comprimidos, descargas/HTTP, operaciones administrativas en `dryRun`, modos de autenticación, flujo OAuth completo, CIMD de ChatGPT, DCR, `private_key_jwt` RS256/JWKS, logs seguros del token exchange, alertas de riesgo, PKCE, audiencia del recurso, rotación y detección de reutilización de refresh tokens, migración desde versiones anteriores, configuración inicial con ngrok simulado, unidad systemd, supervisor, propiedad de archivos privados y logs legibles.

## Licencia

MIT.

## Novedades y migracion a 4.6.0

La version 4.6.0 agrega diez herramientas (86 en total), permisos por cliente, ediciones con hash y restauracion protegida, seguimiento de trabajos y diagnostico sin afirmar protecciones no verificadas.

Consulte la [guia de herramientas, permisos y migracion](docs/TOOLS_V4_6.md) para ejemplos, limites y configuracion. Los modulos nuevos estan en `lib/tools/` y las pruebas en `tests/tools/`; los comandos de inicio existentes no cambian.
