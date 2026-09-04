#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createAccessPolicy, TOOL_REQUIREMENTS } = require('./lib/access-policy');
const { parseDotEnv } = require('./lib/runtime-diagnostics');
const { applyPrivateOwnership, ensurePrivateDirectory } = require('./lib/private-owner');

const ROOT = __dirname;
const PACKAGE = require('./package.json');
const FILE_ENV = parseDotEnv();
const FILE_CONFIG_PRIORITY = String(process.env.MCP_CONFIG_SOURCE || '').toLowerCase() === 'file';
const EFFECTIVE_ENV = FILE_CONFIG_PRIORITY
  ? { ...process.env, ...FILE_ENV }
  : { ...FILE_ENV, ...process.env };
const RUNTIME_DIR = path.resolve(ROOT, EFFECTIVE_ENV.MCP_RUNTIME_DIR || '.runtime');
const CACHE_PATH = path.join(RUNTIME_DIR, 'update-status.json');
const LOCK_PATH = path.join(RUNTIME_DIR, 'update-check.lock');
const DEFAULT_TTL_SECONDS = 15 * 60;
const DEFAULT_TIMEOUT_MS = 5000;

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function numberValue(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

const COLOR_ENABLED = !process.env.NO_COLOR && (
  boolValue(process.env.MCP_FORCE_COLOR, false)
  || (Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb')
);
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m'
};

function color(name, text) {
  if (!COLOR_ENABLED || !ANSI[name]) return String(text);
  return `${ANSI[name]}${text}${ANSI.reset}`;
}

function visibleLength(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function boxLine(content = '', width = 72) {
  const text = String(content);
  const padding = Math.max(0, width - 4 - visibleLength(text));
  return `| ${text}${' '.repeat(padding)} |`;
}

function safeErrorText(value) {
  return String(value || '')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[OCULTO]@')
    .replace(/((?:token|password|passwd|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[OCULTO]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function safeJsonRead(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

function writePrivateJson(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  applyPrivateOwnership(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  applyPrivateOwnership(filePath, 0o600);
}

function runGit(args, timeoutMs = 3000) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    signal: result.signal,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error ? result.error.message : ''
  };
}

function localRepositoryInfo() {
  const inside = runGit(['rev-parse', '--is-inside-work-tree'], 1000);
  if (!inside.ok || inside.stdout !== 'true') return { repository: false };
  const head = runGit(['rev-parse', 'HEAD'], 1000);
  const branch = runGit(['branch', '--show-current'], 1000);
  const dirty = runGit(['status', '--porcelain', '--untracked-files=normal'], 1500);
  return {
    repository: true,
    commit: head.ok ? head.stdout : '',
    branch: branch.ok && branch.stdout ? branch.stdout : 'detached',
    dirty: dirty.ok ? Boolean(dirty.stdout) : false
  };
}

function readRemoteVersion(commit) {
  if (!commit) return '';
  const result = runGit(['show', `${commit}:package.json`], 1500);
  if (!result.ok) return '';
  try { return String(JSON.parse(result.stdout).version || ''); }
  catch (_) { return ''; }
}

function updateStatusMessage(status, { compact = false } = {}) {
  if (!status) return color('dim', 'Actualización: todavía no comprobada.');
  const localVersion = status.localVersion ? `v${status.localVersion}` : `v${PACKAGE.version}`;
  const remoteVersion = status.remoteVersion ? `v${status.remoteVersion}` : 'una revisión nueva';
  const age = status.checkedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(status.checkedAt)) / 1000)) : null;
  const suffix = !compact && age !== null ? color('dim', ` (comprobado hace ${age}s)`) : '';

  switch (status.state) {
    case 'current':
      return status.dirty
        ? `${color('magenta', '[i]')} La revisión Git coincide con origin/main, pero hay cambios locales sin commit.${suffix}`
        : `${color('green', '[OK]')} Repositorio actualizado (${localVersion}).${suffix}`;
    case 'update_available':
      return `${color('yellow', color('bold', '[!] ACTUALIZACIÓN DISPONIBLE'))}: ${remoteVersion}; instalada ${localVersion}. Ejecutá git pull.${suffix}`;
    case 'ahead':
      return `${color('blue', '[i]')} La copia local contiene commits todavía no publicados (${localVersion}).${suffix}`;
    case 'diverged':
      return `${color('red', color('bold', '[!] HISTORIAL DIVERGENTE'))}: revisá Git antes de actualizar.${suffix}`;
    case 'not_repository':
      return `${color('dim', '[i]')} No es un clon Git; la comprobación automática no está disponible.`;
    case 'no_remote':
      return `${color('dim', '[i]')} El repositorio no tiene un remoto origin/main verificable.`;
    case 'checking':
      return `${color('cyan', '[...]')} Comprobando actualizaciones en segundo plano...`;
    case 'disabled':
      return `${color('dim', '[i]')} Comprobación de actualizaciones desactivada.`;
    default:
      return `${color('yellow', '[!]')} No se pudo comprobar si hay una actualización${status.error ? `: ${status.error}` : '.'}${suffix}`;
  }
}

function cachedUpdateStatus() {
  if (!boolValue(EFFECTIVE_ENV.MCP_UPDATE_CHECK, true)) return { state: 'disabled' };
  const cached = safeJsonRead(CACHE_PATH);
  const ttl = numberValue(EFFECTIVE_ENV.MCP_UPDATE_CHECK_TTL_SECONDS, DEFAULT_TTL_SECONDS, 30, 86400);
  if (!cached || !cached.checkedAt || !Number.isFinite(Date.parse(cached.checkedAt))) return { state: 'checking', stale: true };
  const stale = Date.now() - Date.parse(cached.checkedAt) > ttl * 1000
    || (cached.localVersion && cached.localVersion !== PACKAGE.version);
  return { ...cached, stale };
}

function acquireLock() {
  ensurePrivateDirectory(RUNTIME_DIR, 0o700);
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    applyPrivateOwnership(LOCK_PATH, 0o600);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') return false;
    try {
      const stats = fs.statSync(LOCK_PATH);
      if (Date.now() - stats.mtimeMs > 60000) {
        fs.unlinkSync(LOCK_PATH);
        return acquireLock();
      }
    } catch (_) {}
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
}

function performUpdateCheck({ force = false } = {}) {
  if (!boolValue(EFFECTIVE_ENV.MCP_UPDATE_CHECK, true)) return { state: 'disabled', checkedAt: new Date().toISOString() };
  const cached = cachedUpdateStatus();
  if (!force && cached && !cached.stale && cached.state !== 'checking') return cached;
  if (!acquireLock()) return { state: 'checking', checkedAt: new Date().toISOString() };

  try {
    const local = localRepositoryInfo();
    const base = {
      checkedAt: new Date().toISOString(),
      localVersion: PACKAGE.version,
      localCommit: local.commit || '',
      branch: local.branch || '',
      dirty: Boolean(local.dirty)
    };
    if (!local.repository) {
      const result = { ...base, state: 'not_repository' };
      writePrivateJson(CACHE_PATH, result);
      return result;
    }

    const remote = runGit(['remote', 'get-url', 'origin'], 1000);
    if (!remote.ok || !remote.stdout) {
      const result = { ...base, state: 'no_remote' };
      writePrivateJson(CACHE_PATH, result);
      return result;
    }

    const timeoutMs = numberValue(EFFECTIVE_ENV.MCP_UPDATE_CHECK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 30000);
    const fetchResult = runGit(['fetch', '--quiet', '--no-tags', 'origin', 'refs/heads/main'], timeoutMs);
    if (!fetchResult.ok) {
      const detail = fetchResult.timedOut
        ? `tiempo de espera agotado después de ${timeoutMs} ms`
        : (fetchResult.stderr || fetchResult.error || 'git fetch falló');
      const result = { ...base, state: 'error', error: safeErrorText(detail) };
      writePrivateJson(CACHE_PATH, result);
      return result;
    }

    const fetched = runGit(['rev-parse', 'FETCH_HEAD'], 1000);
    if (!fetched.ok || !fetched.stdout) {
      const result = { ...base, state: 'error', error: 'Git no devolvió la revisión remota.' };
      writePrivateJson(CACHE_PATH, result);
      return result;
    }

    const remoteCommit = fetched.stdout;
    const remoteVersion = readRemoteVersion(remoteCommit);
    let state = 'diverged';
    if (remoteCommit === local.commit) state = 'current';
    else if (runGit(['merge-base', '--is-ancestor', local.commit, remoteCommit], 1500).ok) state = 'update_available';
    else if (runGit(['merge-base', '--is-ancestor', remoteCommit, local.commit], 1500).ok) state = 'ahead';

    const result = { ...base, state, remoteCommit, remoteVersion };
    writePrivateJson(CACHE_PATH, result);
    return result;
  } finally {
    releaseLock();
  }
}

function startupData() {
  const env = EFFECTIVE_ENV;
  let policy;
  try { policy = createAccessPolicy(env, Object.keys(TOOL_REQUIREMENTS)).summary(); }
  catch (error) {
    policy = {
      profile: env.MCP_ACCESS_PROFILE || 'invalid',
      label: 'Configuración inválida',
      allowedToolCount: 0,
      blockedToolCount: Object.keys(TOOL_REQUIREMENTS).length,
      warnings: [error.message]
    };
  }
  const runAsRoot = boolValue(env.MCP_RUN_AS_ROOT, false);
  const confirmationsRequired = !['0', 'false', 'no', 'off'].includes(String(env.MCP_CRITICAL_CONFIRMATIONS || '1').toLowerCase());
  const actualUid = typeof process.getuid === 'function' ? process.getuid() : null;
  let actualUser = process.env.USER || process.env.LOGNAME || '';
  try { actualUser = require('os').userInfo().username; } catch (_) {}
  return {
    env,
    policy,
    runAsRoot,
    confirmationsRequired,
    actualUid,
    actualUser,
    fullAccess: boolValue(env.MCP_FULL_ACCESS, false),
    authMode: String(env.MCP_AUTH_MODE || (env.MCP_AUTH_TOKEN ? 'bearer' : 'none')).toLowerCase(),
    exposureMode: String(env.MCP_EXPOSURE_MODE || 'local').toLowerCase(),
    update: cachedUpdateStatus()
  };
}

function printLogo() {
  const width = 72;
  const border = `+${'-'.repeat(width - 2)}+`;
  const logo = [
    ' __  __  ____ ____        ____',
    '|  \\/  |/ ___|  _ \\      / ___|  ___ _ ____   _____ _ __',
    '| |\\/| | |   | |_) |_____|___ \\ / _ \\ \'__\\ \\ / / _ \\ \'__|',
    '| |  | | |___|  __/_____|___) |  __/ |   \\ V /  __/ |',
    '|_|  |_|\\____|_|        |____/ \\___|_|    \\_/ \\___|_|'
  ];
  process.stdout.write(`${color('cyan', border)}\n`);
  for (const line of logo) process.stdout.write(`${color('cyan', boxLine(line, width))}\n`);
  const title = color('bold', `MCP-Server v${PACKAGE.version}`);
  const left = Math.max(0, Math.floor((width - 4 - visibleLength(title)) / 2));
  const centered = `${' '.repeat(left)}${title}`;
  process.stdout.write(`${color('cyan', boxLine(centered, width))}\n`);
  process.stdout.write(`${color('cyan', border)}\n`);
}

function printSummary() {
  const data = startupData();
  const runtimeLabel = data.runAsRoot
    ? color('red', color('bold', data.actualUid === 0 ? 'ROOT activo (uid 0)' : 'ROOT solicitado; se elevará al iniciar'))
    : `${data.actualUser || 'usuario actual'}${data.actualUid !== null ? ` (uid ${data.actualUid})` : ''}`;
  const confirmationLabel = data.confirmationsRequired
    ? color('green', 'activadas')
    : color('red', color('bold', 'DESACTIVADAS'));
  const scopeLabel = data.fullAccess
    ? color('yellow', 'FULL ACCESS (/)')
    : color('green', 'carpetas restringidas');

  process.stdout.write(`${color('bold', 'Versión:')}          ${PACKAGE.version}\n`);
  process.stdout.write(`${color('bold', 'Motor:')}            Node.js ${process.versions.node} (código fuente)\n`);
  process.stdout.write(`${color('bold', 'Herramientas:')}     ${data.policy.allowedToolCount} expuestas de ${Object.keys(TOOL_REQUIREMENTS).length}\n`);
  process.stdout.write(`${color('bold', 'Perfil:')}           ${data.policy.label} (${data.policy.profile})\n`);
  process.stdout.write(`${color('bold', 'Archivos:')}         ${scopeLabel}\n`);
  process.stdout.write(`${color('bold', 'Ejecución:')}        ${runtimeLabel}\n`);
  process.stdout.write(`${color('bold', 'Confirmaciones:')}   ${confirmationLabel}\n`);
  process.stdout.write(`${color('bold', 'Autenticación:')}    ${data.authMode}\n`);
  process.stdout.write(`${color('bold', 'Publicación:')}      ${data.exposureMode}\n`);
  process.stdout.write(`${updateStatusMessage(data.update)}\n`);
  if (data.update && data.update.dirty) {
    process.stdout.write(`${color('magenta', '[!]')} Hay cambios locales sin commit; revisalos antes de ejecutar git pull.\n`);
  }
  for (const warning of data.policy.warnings || []) {
    if (/root|confirm|full access/i.test(warning)) continue;
    process.stdout.write(`${color('yellow', '[!]')} ${warning}\n`);
  }
  if (data.runAsRoot) {
    process.stdout.write(`${color('red', color('bold', '[RIESGO]'))} El MCP podrá actuar con privilegios root cuando se inicie en ese modo.\n`);
  }
  if (!data.confirmationsRequired) {
    process.stdout.write(`${color('red', color('bold', '[RIESGO]'))} Las herramientas críticas no exigirán frases de confirmación.\n`);
  }
}

function printBanner() {
  printLogo();
  printSummary();
  process.stdout.write('\n');
}

function usage() {
  process.stdout.write(`Uso:\n  node startup-banner.js --logo\n  node startup-banner.js --summary\n  node startup-banner.js --banner\n  node startup-banner.js --check-update [--force] [--notify] [--json]\n  node startup-banner.js --needs-update-check\n`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--logo')) printLogo();
  else if (args.has('--summary')) printSummary();
  else if (args.has('--banner') || args.size === 0) printBanner();
  else if (args.has('--needs-update-check')) {
    const status = cachedUpdateStatus();
    process.exitCode = status.state !== 'disabled' && Boolean(status.stale) ? 0 : 1;
  } else if (args.has('--check-update')) {
    const result = performUpdateCheck({ force: args.has('--force') });
    if (args.has('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (args.has('--notify')) {
      process.stdout.write(`${updateStatusMessage(result, { compact: true })}\n`);
      if (result.dirty) process.stdout.write(`${color('magenta', '[!]')} Hay cambios locales sin commit.\n`);
    }
  } else if (args.has('--help') || args.has('-h')) usage();
  else usage();
}

try { main(); }
catch (error) {
  process.stderr.write(`${color('yellow', '[!]')} No se pudo preparar el inicio: ${error.message}\n`);
  process.exitCode = 1;
}
