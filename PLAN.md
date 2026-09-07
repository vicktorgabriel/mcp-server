# Implementation Plan: MCP Server Architecture & Security Upgrades

## Fase 1: Arquitectura IPC y Separacion (Gateway/Executor)
- Crear `lib/ipc-gateway.js` y `lib/ipc-executor.js`
- Modificar `mcp-server.js` para que solo inicie el Gateway (con privilegios de red mínimos) y exponga HTTP/Stdio.
- El Gateway generará un socket UNIX en un directorio protegido (`.runtime/ipc.sock`) con permisos 0600.
- El Executor se iniciará como un proceso separado que se conecta al socket y ejecuta las herramientas.

## Fase 2: Perfiles de Acceso (Español)
- Actualizar `lib/access-policy.js` para usar las nuevas etiquetas en español (Observación, Trabajo restringido, Administración, Control total, Personalizado).
- Mover validación de herramientas al Executor.

## Fase 3: Sandbox / Trabajo Restringido
- Implementar en `lib/sandbox.js` una barrera con `bwrap` (bubblewrap) o `firejail` (o en su defecto un entorno Node.js estricto con `--experimental-permission`) para confinar el executor.
- Deshabilitar red/sudo/sockets Docker.

## Fase 4: Aprobaciones Humanas Reales y CLI/Panel
- Crear `lib/approvals.js`
- Implementar CLI local `mcpctl.sh approve <req_id>` o un panel web local (en puerto separado) autenticado para aprobar llamadas sensitivas.
- Eliminar la lógica de `confirm=DELETE` desde el modelo LLM.

## Fase 5: MFA (WebAuthn/FIDO2)
- Instalar `@simplewebauthn/server` y `@simplewebauthn/browser`.
- Integrar MFA en `lib/oauth-provider.js` y `mcp-server.js` para operaciones críticas.

## Fase 6: Cloudflare Tunnel
- Actualizar `configure-mcp.sh` y crear `configure-cloudflared.sh`.
- Añadir opciones para `cloudflared` en `start-mcp.sh`.

## Fase 7: Mejoras CLI y Observabilidad
- Actualizar menú interactivo (TUI) con checkboxes y búsquedas, respetando variables NO_COLOR.
- Logs estructurados con rotación e IDs.
