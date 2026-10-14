#!/usr/bin/env node
'use strict';

const { collectRuntimeStatus, parseDotEnv } = require('./lib/runtime-diagnostics');

function normalizeBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { return new URL(withScheme).origin; } catch (_) { return raw; }
}

function authInstructions(mode) {
  if (mode === 'oauth') {
    return [
      'Autenticación del servidor: OAuth 2.1.',
      'Gemini Web detecta el recurso protegido automáticamente en /.well-known/oauth-protected-resource/mcp.',
      'Al agregar la app o invocar una herramienta, Gemini abrirá la ventana de inicio de sesión de este servidor.',
      'Ingresá el usuario y contraseña que definiste en el asistente y pulsá Autorizar una sola vez.',
      'El servidor redirige de forma segura a oauth-redirect.googleusercontent.com para completar la vinculación.'
    ];
  }
  if (mode === 'bearer') {
    return [
      'Autenticación: Token Bearer.',
      'Si Gemini solicita API Key o Token Bearer, usá el valor guardado en .private/bearer-token.txt.',
      'El token nunca debe publicarse ni compartirse en chats.'
    ];
  }
  return [
    'Autenticación: Sin autenticación / None.',
    'No se recomienda dejar este modo expuesto permanentemente en un endpoint público.'
  ];
}

async function main() {
  const env = parseDotEnv();
  const status = await collectRuntimeStatus();
  const base = normalizeBase(
    status.tunnel && status.tunnel.publicUrl
      || env.MCP_PUBLIC_BASE_URL
      || env.NGROK_URL
      || env.PUBLIC_BASE_URL
  );
  const endpoint = base ? `${base}/mcp` : 'INICIÁ EL MCP Y EJECUTÁ: ./mcpctl.sh url';
  const authMode = String(env.MCP_AUTH_MODE || (env.MCP_AUTH_TOKEN ? 'bearer' : 'none')).toLowerCase();
  const accessProfile = status.config && (status.config.accessProfileLabel || status.config.accessProfile)
    || env.MCP_ACCESS_PROFILE
    || 'developer';
  const toolCount = status.config && Number.isInteger(status.config.allowedToolCount)
    ? status.config.allowedToolCount
    : 'desconocida';
  const executionMode = status.config && status.config.runAsRoot ? 'root (riesgo alto)' : 'usuario normal';
  const confirmationMode = status.config && status.config.criticalConfirmations === false ? 'desactivadas (riesgo alto)' : 'activadas';

  process.stdout.write(`
========================================================================
 CÓMO AGREGAR ESTE MCP A GOOGLE GEMINI WEB
========================================================================

URL del servidor:
  ${endpoint}

Perfil de herramientas:
  ${accessProfile} (${toolCount} herramientas)
Cuenta del proceso:
  ${executionMode}
Confirmaciones críticas:
  ${confirmationMode}

Pasos en Gemini Web (gemini.google.com):

  1. Entrá a gemini.google.com con tu cuenta de Google.
  2. Abrí Configuración (ícono de engranaje) → Apps conectadas / Connected apps.
  3. Pulsá "Add custom app" / "Add MCP Server" (o el botón "+").
  4. Escribí un nombre para identificar al equipo, por ejemplo "MCP Mi PC".
  5. Pegá exactamente esta URL como endpoint:

       ${endpoint}

  6. ${authInstructions(authMode).join('\n     ')}
  7. Confirmá el escaneo de herramientas (el servidor expondrá sus herramientas registradas).
  8. Guardá la app. Al usar una herramienta o iniciar la vinculación, autorizá
     el acceso con tus credenciales OAuth locales.

Prueba sugerida:
  Pedile a Gemini que ejecute system_diagnostics o local_time para comprobar
  la comunicación bidireccional con tu equipo.

Administración local:
  Ver actividad:          ./mcpctl.sh logs
  Seguir actividad:       ./mcpctl.sh logs-follow
  Estado y URL:           ./mcpctl.sh status
  Perfil y herramientas:  ./mcpctl.sh permissions --tools
  Reiniciar servicio:     ./mcpctl.sh restart
========================================================================
`);
}

main().catch((error) => {
  process.stderr.write(`No se pudo preparar la guía: ${error.message}\n`);
  process.exitCode = 1;
});
