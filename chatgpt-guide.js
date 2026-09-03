#!/usr/bin/env node
'use strict';

const { collectRuntimeStatus, parseDotEnv } = require('./runtime-diagnostics');

function normalizeBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { return new URL(withScheme).origin; } catch (_) { return raw; }
}

function authInstructions(mode) {
  if (mode === 'oauth') {
    return [
      'Autenticación: elegí OAuth.',
      'El servidor publica registro dinámico de clientes. En interfaces compatibles, ChatGPT se registra automáticamente.',
      'Si la interfaz muestra campos de Client ID/Secret en lugar de iniciar el registro automático, revisá la compatibilidad de tu versión de ChatGPT antes de continuar.',
      'Al escanear las herramientas se abrirá la página de autorización del MCP.',
      'Ingresá el usuario y la contraseña OAuth que configuraste en el primer inicio, revisá el destino y autorizá.'
    ];
  }
  if (mode === 'bearer') {
    return [
      'Autenticación: elegí Bearer/API token si esa opción aparece.',
      'El token local está en .private/bearer-token.txt y nunca debe publicarse ni pegarse en un chat.'
    ];
  }
  return [
    'Autenticación: elegí Sin autenticación / No authentication.',
    'Este modo no es recomendable para dejar el MCP publicado permanentemente.'
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

  process.stdout.write(`
========================================================================
 CÓMO AGREGAR ESTE MCP A CHATGPT
========================================================================

URL del servidor:
  ${endpoint}

Perfil de herramientas:
  ${accessProfile}

Pasos en ChatGPT Web:

  Ruta actual oficial:
  1. Abrí Configuración → Apps → Configuración avanzada / Advanced settings.
  2. Activá Modo desarrollador / Developer mode.
  3. Volvé a Configuración → Apps y pulsá Crear / Create.

  Ruta de interfaces anteriores:
  1. Abrí Configuración → Complementos.
  2. Entrá en Configuración avanzada y activá Modo desarrollador.
  3. Volvé a Complementos → Explorar complementos → Agregar.

  Después, en ambas interfaces:
  4. Escribí un nombre que identifique al equipo, por ejemplo MCP Mi PC.
  5. Pegá exactamente esta URL como endpoint MCP:

       ${endpoint}

  6. ${authInstructions(authMode).join('\n     ')}
  7. Pulsá Escanear herramientas / Scan tools y esperá que termine.
  8. Revisá las acciones detectadas y pulsá Crear / Create.
  9. En un chat nuevo, seleccioná la app desde el menú de herramientas, + → Más
     o mediante una mención con @, según la interfaz disponible.

Prueba sugerida:
  Ejecutá tool_policy_status para revisar los permisos publicados y luego
  control_capabilities para comprobar qué backends existen realmente.

Administración local:
  Ver actividad:          ./mcpctl.sh logs
  Seguir actividad:       ./mcpctl.sh logs-follow
  Estado y URL:           ./mcpctl.sh status
  Perfil y herramientas:  ./mcpctl.sh permissions --tools
  Cambiar sólo el perfil: ./mcpctl.sh permissions-set
  Modo persistente:       ./start-mcp.sh --persistent
  Reconfigurar/OAuth:     ./mcpctl.sh configure

Disponibilidad actual:
  - Business y Enterprise/Edu: MCP completo según permisos del workspace.
  - Pro: conexión de MCP personalizados limitada actualmente a lectura/obtención.
  - La creación se realiza en ChatGPT Web y exige modo desarrollador.

Documentación oficial:
  https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt
========================================================================
`);
}

main().catch((error) => {
  process.stderr.write(`No se pudo preparar la guía: ${error.message}\n`);
  process.exitCode = 1;
});
