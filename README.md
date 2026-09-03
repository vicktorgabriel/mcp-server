# MCP Local Full Control

Servidor MCP para administrar un equipo propio desde ChatGPT y otros clientes compatibles. Expone herramientas de archivos, comandos, procesos, servicios, Git, tmux, escritorio, captura de pantalla, cámara, audio y diagnóstico del sistema.

La versión 4 agrega:

- configuración inicial completa en **una sola terminal**;
- guardado automático del endpoint de ngrok;
- OAuth 2.1 integrado para ChatGPT;
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
2. si se publicará mediante ngrok, una URL/IP propia o solamente en local;
3. el authtoken y el endpoint de ngrok, cuando corresponda;
4. si usará OAuth, token Bearer o ninguna autenticación;
5. si se iniciará en modo temporal o persistente.

La configuración se conserva para los próximos inicios.

## Dónde se guardan la configuración y los secretos

| Archivo/directorio | Contenido | Git |
|---|---|---|
| `.env` | URL, puerto, rutas y modo seleccionado | Ignorado |
| `.private/ngrok.yml` | Authtoken de ngrok | Ignorado, modo `0600` |
| `.private/oauth-state.json` | Hash de contraseña, clientes y hashes de tokens OAuth | Ignorado, modo `0600` |
| `.private/bearer-token.txt` | Token Bearer, sólo si se eligió ese modo | Ignorado, modo `0600` |
| `.runtime/` | estado, actividad y diagnóstico local | Ignorado |

No copies secretos dentro del README, scripts, commits, capturas públicas ni mensajes de soporte.

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

## Autenticación

### OAuth 2.1 — recomendada

El servidor incluye un proveedor OAuth para la cuenta administradora local. Implementa:

- autorización por código;
- PKCE con `S256`;
- Protected Resource Metadata;
- Authorization Server Metadata;
- registro dinámico de clientes;
- tokens de acceso de corta duración;
- refresh tokens rotativos y detección de reutilización, con revocación de toda la familia de sesión;
- validación estricta del recurso `/mcp`;
- revocación de sesiones;
- límites de intentos;
- hashes scrypt para la contraseña;
- almacenamiento de códigos y tokens únicamente como hashes.

En el asistente elegí OAuth, definí un usuario y una contraseña distinta de la contraseña del sistema. Cuando ChatGPT escanee las herramientas, se abrirá la página de autorización del propio MCP. Revisá el nombre y el destino antes de autorizar.

El proveedor integrado está orientado a una instalación privada y de un solo administrador. Para publicar un servicio multiusuario, empresarial o de terceros, conviene usar un proveedor de identidad establecido y auditar su configuración por separado. El modo integrado anuncia DCR para que ChatGPT pueda registrar la conexión; no anuncia CIMD ni `private_key_jwt`.

Comandos de administración:

```bash
./mcpctl.sh oauth-status
./mcpctl.sh oauth-reset
./mcpctl.sh oauth-reset-all
```

`oauth-reset` revoca las sesiones. `oauth-reset-all` también elimina los clientes registrados, por lo que ChatGPT deberá registrarse y autorizarse nuevamente.

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
02/09/2026 18:42:10   ACCION       Revisando el estado Git del proyecto. Solicitud de usuario OAuth admin mediante ChatGPT.
02/09/2026 18:42:10   RESULTADO    Operación Git finalizada correctamente. Duración: 84 ms.
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
   - **OAuth:** completá la pantalla de autorización del MCP.
   - **Bearer:** ingresá el token privado si la interfaz ofrece ese método.
   - **Sin autenticación:** elegí `No authentication`.
7. Pulsá **Escanear herramientas / Scan tools**, esperá que termine y revisá las acciones detectadas.
8. Pulsá **Crear / Create**.
9. En un chat nuevo, seleccioná la app desde el menú de herramientas, `+` → **Más** o mediante una mención con `@`, según la interfaz disponible.

En interfaces anteriores, el recorrido equivalente puede aparecer como **Configuración → Complementos → Configuración avanzada → Modo desarrollador**, seguido de **Complementos → Explorar complementos → Agregar**.

Actualmente, el MCP completo con acciones de escritura/modificación está disponible para Business y Enterprise/Edu según la política del workspace. En Pro, los MCP personalizados continúan limitados a lectura/obtención. La creación se realiza en ChatGPT Web y requiere modo desarrollador. Consultá la documentación oficial: `https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt`.

Sólo agregues servidores que controles y revisá las herramientas antes de habilitarlas para otros usuarios.

## Comandos principales

```bash
./mcpctl.sh status          # Estado resumido
./mcpctl.sh url             # URL exacta para ChatGPT
./mcpctl.sh chatgpt         # Guía de conexión
./mcpctl.sh configure       # Reconfigurar acceso, ngrok y autenticación
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

Las instalaciones anteriores se migran sin borrar su `.env`. Si una instalación antigua estaba publicada sin autenticación, se conserva para evitar cortar el acceso, pero se muestra una advertencia. Para activar OAuth:

```bash
./mcpctl.sh configure
```

Si cambian definiciones de herramientas después de crear la app en ChatGPT, puede ser necesario volver a escanear o actualizar las acciones desde la configuración de Apps.

## Herramientas incluidas

El servidor expone 51 herramientas agrupadas en:

- búsqueda, lectura, escritura y parcheo de archivos;
- ejecución de comandos;
- procesos, servicios, journal y diagnóstico de hardware/red/GPU;
- Git y worktrees;
- sesiones tmux;
- ventanas, teclado, mouse y capturas de pantalla;
- cámara y audio;
- diagnóstico del propio MCP y actividad legible.

Todas se ejecutan con los permisos del usuario del proceso MCP. Ejecutar el servicio como `root` amplía drásticamente el impacto de una credencial comprometida; utilizá un usuario dedicado siempre que sea posible.

## Resolución de problemas

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

### OAuth no abre o vuelve a pedir autorización

```bash
./mcpctl.sh oauth-status
./mcpctl.sh logs
```

Comprobá que:

- la URL pública no cambió;
- usa HTTPS;
- ChatGPT está configurado con OAuth;
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
npm test
npm run selftest
```

Las pruebas incluyen sintaxis, modos de autenticación, flujo OAuth completo, PKCE, audiencia del recurso, rotación y detección de reutilización de refresh tokens, revocación, almacenamiento sin secretos en texto claro, asistente inicial con ngrok simulado, migración de instalaciones anteriores, bloqueo de configuraciones HTTP inseguras, unidad systemd, supervisor, logs legibles y herramientas básicas.

## Licencia

MIT.
