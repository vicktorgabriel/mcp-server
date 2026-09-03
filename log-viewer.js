#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { collectRuntimeStatus, parseDotEnv, redactText } = require('./runtime-diagnostics');

const ROOT = __dirname;

function parseArgs(argv) {
  const options = { lines: 80, follow: false, noHeader: false, summaryOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--follow' || value === '-f') options.follow = true;
    else if (value === '--no-header') options.noHeader = true;
    else if (value === '--summary-only') options.summaryOnly = true;
    else if (value === '--lines' || value === '-n') {
      options.lines = Math.max(1, Math.min(5000, Number(argv[index + 1] || 80)));
      index += 1;
    } else if (/^--lines=/.test(value)) {
      options.lines = Math.max(1, Math.min(5000, Number(value.split('=', 2)[1] || 80)));
    }
  }
  return options;
}

function eventPath() {
  const env = parseDotEnv();
  const configured = process.env.MCP_HUMAN_LOG || env.MCP_HUMAN_LOG || path.join('.runtime', 'events.log');
  return path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured);
}

function readSingleTail(filePath, lines) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return [];
    const bytes = Math.min(stats.size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(bytes);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buffer, 0, bytes, Math.max(0, stats.size - bytes)); }
    finally { fs.closeSync(fd); }
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch (_) {
    return [];
  }
}

function readTail(filePath, lines) {
  return [
    ...readSingleTail(`${filePath}.1`, lines),
    ...readSingleTail(filePath, lines)
  ].slice(-lines);
}

function authLabel(mode) {
  if (mode === 'oauth') return 'OAuth 2.1';
  if (mode === 'bearer') return 'token Bearer';
  return 'sin autenticación';
}

function launchLabel(launch = {}) {
  if (launch.persistent) return 'persistente';
  if (launch.temporary) return 'temporal';
  return launch.active ? launch.mode : 'detenido';
}

function stateLabel(status) {
  if (status.ok) return 'LISTO';
  if (status.launch && status.launch.active) return 'DEGRADADO';
  return 'DETENIDO';
}

async function printHeader(status, includeTable = true) {
  const url = status.tunnel && status.tunnel.chatgptUrl ? status.tunnel.chatgptUrl : 'sin URL pública activa';
  const auth = status.config && status.config.authMode
    ? status.config.authMode
    : status.local && status.local.health && status.local.health.data && status.local.health.data.auth || 'none';
  process.stdout.write('\n');
  process.stdout.write('========================================================================\n');
  process.stdout.write(' ACTIVIDAD DEL SERVIDOR MCP\n');
  process.stdout.write('========================================================================\n');
  process.stdout.write(`Estado:          ${stateLabel(status)}\n`);
  process.stdout.write(`Modo de inicio:  ${launchLabel(status.launch)}\n`);
  process.stdout.write(`Autenticación:   ${authLabel(auth)}\n`);
  const accessLabel = status.config && (status.config.accessProfileLabel || status.config.accessProfile) || 'no configurado';
  const accessCount = status.config && Number.isInteger(status.config.allowedToolCount)
    ? `, ${status.config.allowedToolCount} herramientas`
    : '';
  process.stdout.write(`Acceso:          ${accessLabel}${accessCount}\n`);
  process.stdout.write(`Conexión:        ${url}\n`);
  if (status.warnings && status.warnings.length) {
    process.stdout.write(`Aviso:           ${redactText(status.warnings[0])}\n`);
  }
  process.stdout.write('------------------------------------------------------------------------\n');
  if (includeTable) {
    process.stdout.write('Hora local                  Tipo        Qué está ocurriendo\n');
    process.stdout.write('------------------------------------------------------------------------\n');
  }
}

function displayLine(line) {
  const safe = redactText(line);
  const match = safe.match(/^(\d{4}-\d{2}-\d{2}T[^|]+)\s*\|\s*([^|]+)\|\s*(.*)$/);
  if (!match) {
    process.stdout.write(`${safe}\n`);
    return;
  }
  let when = match[1].trim();
  try {
    const date = new Date(when);
    if (!Number.isNaN(date.getTime())) when = date.toLocaleString();
  } catch (_) {}
  const category = match[2].trim().slice(0, 12);
  const message = match[3].trim();
  process.stdout.write(`${when.padEnd(27)} ${category.padEnd(12)} ${message}\n`);
}

function followFile(filePath, startOffset) {
  let offset = startOffset;
  let carry = '';
  process.stdout.write('\nSeguimiento activo. Ctrl+C cierra esta vista; no detiene el servicio MCP.\n\n');

  const poll = () => {
    let stats;
    try { stats = fs.statSync(filePath); } catch (_) { return; }
    if (stats.size < offset) offset = 0;
    if (stats.size === offset) return;
    const length = stats.size - offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buffer, 0, length, offset); }
    finally { fs.closeSync(fd); }
    offset = stats.size;
    const pieces = `${carry}${buffer.toString('utf8')}`.split(/\r?\n/);
    carry = pieces.pop() || '';
    for (const line of pieces) if (line) displayLine(line);
  };

  const timer = setInterval(poll, 500);
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.stdout.write('\nVista de actividad cerrada. El servidor continúa según su modo de inicio.\n');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const filePath = eventPath();
  const status = await collectRuntimeStatus();
  if (!options.noHeader) await printHeader(status, !options.summaryOnly);

  if (options.summaryOnly) return;

  const lines = readTail(filePath, options.lines);
  if (lines.length === 0) {
    process.stdout.write('Todavía no hay actividad registrada.\n');
  } else {
    for (const line of lines) displayLine(line);
  }

  if (options.follow) {
    let offset = 0;
    try { offset = fs.statSync(filePath).size; } catch (_) {}
    followFile(filePath, offset);
  }
}

main().catch((error) => {
  process.stderr.write(`No se pudo mostrar la actividad: ${redactText(error.message)}\n`);
  process.exitCode = 1;
});
