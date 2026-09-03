#!/usr/bin/env node
'use strict';

const { createAccessPolicy, TOOL_REQUIREMENTS } = require('./access-policy');
const { parseDotEnv } = require('./runtime-diagnostics');

function main() {
  const fileEnv = parseDotEnv();
  const filePriority = String(process.env.MCP_CONFIG_SOURCE || '').toLowerCase() === 'file';
  const env = filePriority ? { ...process.env, ...fileEnv } : { ...fileEnv, ...process.env };
  const policy = createAccessPolicy(env, Object.keys(TOOL_REQUIREMENTS));
  const summary = policy.summary();
  const showTools = process.argv.includes('--tools') || process.argv.includes('--all');

  process.stdout.write('\n');
  process.stdout.write('========================================================================\n');
  process.stdout.write(' PERFIL DE ACCESO DEL SERVIDOR MCP\n');
  process.stdout.write('========================================================================\n');
  process.stdout.write(`Perfil:                ${summary.label} (${summary.profile})\n`);
  process.stdout.write(`Herramientas visibles: ${summary.allowedToolCount}\n`);
  process.stdout.write(`Herramientas bloqueadas: ${summary.blockedToolCount}\n`);
  process.stdout.write(`Grupos habilitados:    ${summary.groups.join(', ') || 'ninguno'}\n`);
  process.stdout.write(`Cuenta de ejecución:   ${summary.runAsRoot ? 'root' : 'usuario normal'}\n`);
  process.stdout.write(`Confirmaciones críticas: ${summary.criticalConfirmations ? 'activadas' : 'DESACTIVADAS'}\n`);
  if (summary.denylist.length) process.stdout.write(`Bloqueos individuales: ${summary.denylist.join(', ')}\n`);
  if (summary.allowlist.length) process.stdout.write(`Lista permitida:       ${summary.allowlist.join(', ')}\n`);
  for (const warning of summary.warnings) process.stdout.write(`Aviso:                 ${warning}\n`);
  process.stdout.write('------------------------------------------------------------------------\n');
  process.stdout.write('Cambiar acceso experto: ./mcpctl.sh permissions-set\n');
  process.stdout.write('Ver listas completas: ./mcpctl.sh permissions --tools\n');
  if (showTools) {
    process.stdout.write('\nHERRAMIENTAS VISIBLES\n');
    for (const name of summary.allowedTools) process.stdout.write(`  + ${name}\n`);
    process.stdout.write('\nHERRAMIENTAS BLOQUEADAS\n');
    for (const name of summary.blockedTools) process.stdout.write(`  - ${name}\n`);
  }
  process.stdout.write('========================================================================\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`No se pudo leer la política de acceso: ${error.message}\n`);
  process.exitCode = 1;
}
