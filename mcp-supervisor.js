#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { parseDotEnv, redactText } = require('./runtime-diagnostics');

const ROOT = __dirname;
const fileEnv = parseDotEnv(path.join(ROOT, '.env'));
for (const [key, value] of Object.entries(fileEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

hydrateDesktopEnvironment();

const HOST = process.env.HOST || '127.0.0.1';
const LOCAL_HOST = (!HOST || HOST === '0.0.0.0' || HOST === '::' || HOST === '[::]')
  ? '127.0.0.1'
  : HOST.replace(/^\[|\]$/g, '');
const PORT = validPort(process.env.PORT, 3000);
const MODE = String(process.env.MCP_EXPOSURE_MODE || 'ngrok').trim().toLowerCase();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const RUNTIME_DIR = path.resolve(process.env.MCP_RUNTIME_DIR || path.join(ROOT, '.runtime'));
const STATUS_PATH = path.join(RUNTIME_DIR, 'status.json');
const PUBLIC_URL_PATH = path.join(RUNTIME_DIR, 'public-url.txt');
const CHATGPT_URL_PATH = path.join(RUNTIME_DIR, 'chatgpt-url.txt');
const PID_PATH = path.join(RUNTIME_DIR, 'supervisor.pid');
const SERVER_LOG_PATH = path.join(RUNTIME_DIR, 'mcp-server.log');
const NGROK_LOG_PATH = path.join(RUNTIME_DIR, 'ngrok.log');
const MAX_LOG_BYTES = positiveInt(process.env.MCP_RUNTIME_LOG_MAX_BYTES, 10 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024);
const HEALTH_START_TIMEOUT_MS = positiveInt(process.env.MCP_HEALTH_START_TIMEOUT_MS, 30000, 5000, 300000);
const NGROK_BIN = process.env.NGROK_BIN || 'ngrok';

fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(RUNTIME_DIR, 0o700); } catch (_) {}
rotateLog(SERVER_LOG_PATH);
rotateLog(NGROK_LOG_PATH);
removeFile(PUBLIC_URL_PATH);
removeFile(CHATGPT_URL_PATH);
writeAtomic(PID_PATH, `${process.pid}\n`);

const serverLog = fs.createWriteStream(SERVER_LOG_PATH, { flags: 'a', mode: 0o600 });
const ngrokLog = fs.createWriteStream(NGROK_LOG_PATH, { flags: 'a', mode: 0o600 });

const status = {
  state: 'starting',
  mode: MODE,
  host: HOST,
  port: PORT,
  supervisorPid: process.pid,
  serverPid: null,
  serverRunning: false,
  serverHealthy: false,
  ngrokPid: null,
  ngrokRunning: false,
  ngrokApiReachable: false,
  publicUrl: '',
  chatgptUrl: '',
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastHealthAt: '',
  lastTunnelAt: '',
  lastServerExit: null,
  lastNgrokExit: null,
  ngrokLastOutput: '',
  lastError: ''
};

let serverChild = null;
let ngrokChild = null;
let stopping = false;
let exitCode = 0;
let healthTimer = null;
let tunnelTimer = null;
let heartbeatTimer = null;
let ngrokRestartTimer = null;
let ngrokRestartDelayMs = 3000;
let ngrokOutputTail = '';
let shutdownTimer = null;
const startupDeadline = Date.now() + HEALTH_START_TIMEOUT_MS;

function hydrateDesktopEnvironment() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const home = process.env.HOME || '';
  if (!process.env.DISPLAY) process.env.DISPLAY = ':0';
  if (!process.env.XDG_RUNTIME_DIR && uid !== null) {
    const candidate = `/run/user/${uid}`;
    if (fs.existsSync(candidate)) process.env.XDG_RUNTIME_DIR = candidate;
  }
  if (!process.env.DBUS_SESSION_BUS_ADDRESS && process.env.XDG_RUNTIME_DIR) {
    const bus = path.join(process.env.XDG_RUNTIME_DIR, 'bus');
    if (fs.existsSync(bus)) process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  }
  if (!process.env.XAUTHORITY) {
    const candidates = [
      home ? path.join(home, '.Xauthority') : '',
      process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'gdm', 'Xauthority') : ''
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) process.env.XAUTHORITY = found;
  }
}

function validPort(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return parsed;
}

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function removeFile(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

function rotateLog(filePath) {
  try {
    if (fs.statSync(filePath).size <= MAX_LOG_BYTES) return;
    const previous = `${filePath}.1`;
    removeFile(previous);
    fs.renameSync(filePath, previous);
  } catch (_) {}
}

function writeAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function updateState() {
  if (stopping) status.state = 'stopping';
  else if (!status.serverHealthy) status.state = 'starting';
  else if (!['ngrok', 'direct', 'local'].includes(MODE)) status.state = 'degraded';
  else if ((MODE === 'ngrok' || MODE === 'direct') && !status.publicUrl) status.state = 'degraded';
  else status.state = 'ready';
}

function persistStatus() {
  updateState();
  status.updatedAt = new Date().toISOString();
  try {
    writeAtomic(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`[SUPERVISOR] No pude guardar estado: ${error.message}\n`);
  }
}

function log(message, level = 'INFO') {
  const line = `[SUPERVISOR ${level}] ${new Date().toISOString()} ${redactText(message)}`;
  process.stderr.write(`${line}\n`);
}

function attachLogs(child, fileStream, label, onChunk = null) {
  const forward = (stream, destination) => {
    stream.on('data', (chunk) => {
      try { fileStream.write(chunk); } catch (_) {}
      try { destination.write(`[${label}] ${chunk.toString('utf8')}`); } catch (_) {}
      if (onChunk) {
        try { onChunk(chunk.toString('utf8')); } catch (_) {}
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
}

function requestJson(host, port, requestPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const request = http.request({ host, port, path: requestPath, method: 'GET', timeout: timeoutMs }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = body ? JSON.parse(body) : null; } catch (_) {}
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, statusCode: response.statusCode, data });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    request.on('error', (error) => resolve({ ok: false, error: error.message }));
    request.end();
  });
}

function setPublicUrl(url) {
  const normalized = String(url || '').replace(/\/+$/, '');
  const changed = normalized !== status.publicUrl;
  status.publicUrl = normalized;
  status.chatgptUrl = normalized ? `${normalized}/mcp` : '';
  if (normalized) {
    writeAtomic(PUBLIC_URL_PATH, `${normalized}\n`);
    writeAtomic(CHATGPT_URL_PATH, `${status.chatgptUrl}\n`);
    status.lastTunnelAt = new Date().toISOString();
    if (changed) {
      log(`Tunel listo. URL PARA CHATGPT: ${status.chatgptUrl}`);
    }
  } else {
    removeFile(PUBLIC_URL_PATH);
    removeFile(CHATGPT_URL_PATH);
  }
  persistStatus();
}

function childExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function spawnServer() {
  log(`Iniciando MCP HTTP en http://${HOST}:${PORT}`);
  serverChild = spawn(process.execPath, [path.join(ROOT, 'mcp-server.js'), '--http'], {
    cwd: ROOT,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  status.serverPid = serverChild.pid || null;
  status.serverRunning = Boolean(serverChild.pid);
  persistStatus();
  attachLogs(serverChild, serverLog, 'mcp');

  let handled = false;
  const handleFailure = (payload) => {
    if (handled) return;
    handled = true;
    status.serverRunning = false;
    status.serverHealthy = false;
    status.serverPid = null;
    status.lastServerExit = payload;
    if (!stopping) status.lastError = `El proceso MCP termino: ${payload.error || payload.signal || payload.code}`;
    serverChild = null;
    persistStatus();
    if (!stopping) shutdown(payload.code === 0 ? 1 : (payload.code || 1), status.lastError);
  };

  serverChild.on('error', (error) => handleFailure({ at: new Date().toISOString(), error: error.message }));
  serverChild.on('exit', (code, signal) => handleFailure({ at: new Date().toISOString(), code, signal }));
}

function normalizeNgrokUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function ngrokArgs() {
  const args = ['http', `http://${LOCAL_HOST}:${PORT}`, '--log=stdout'];
  if (process.env.NGROK_CONFIG) args.push('--config', process.env.NGROK_CONFIG);
  const endpointUrl = normalizeNgrokUrl(process.env.NGROK_URL || process.env.NGROK_DOMAIN);
  if (endpointUrl) args.push('--url', endpointUrl);
  return args;
}

function scheduleNgrokRestart(reason) {
  if (stopping || MODE !== 'ngrok' || ngrokRestartTimer) return;
  const delay = ngrokRestartDelayMs;
  ngrokRestartDelayMs = Math.min(60000, ngrokRestartDelayMs * 2);
  status.lastError = reason;
  log(`${reason}. Reintentando ngrok en ${Math.round(delay / 1000)} s`, 'WARN');
  persistStatus();
  ngrokRestartTimer = setTimeout(() => {
    ngrokRestartTimer = null;
    if (!stopping && status.serverHealthy && !ngrokChild) spawnNgrok();
  }, delay);
}

function spawnNgrok() {
  if (stopping || MODE !== 'ngrok' || ngrokChild) return;
  setPublicUrl('');
  log(`Iniciando ngrok hacia http://${LOCAL_HOST}:${PORT}`);
  ngrokChild = spawn(NGROK_BIN, ngrokArgs(), {
    cwd: ROOT,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  status.ngrokPid = ngrokChild.pid || null;
  status.ngrokRunning = Boolean(ngrokChild.pid);
  ngrokOutputTail = '';
  status.ngrokLastOutput = '';
  persistStatus();
  attachLogs(ngrokChild, ngrokLog, 'ngrok', (text) => {
    ngrokOutputTail = redactText(`${ngrokOutputTail}${text}`).slice(-8192);
    status.ngrokLastOutput = ngrokOutputTail.split(/\r?\n/).slice(-20).join('\n').trim();
  });

  let handled = false;
  const handleFailure = (payload) => {
    if (handled) return;
    handled = true;
    status.ngrokRunning = false;
    status.ngrokApiReachable = false;
    status.ngrokPid = null;
    status.lastNgrokExit = { ...payload, output: status.ngrokLastOutput };
    ngrokChild = null;
    setPublicUrl('');
    if (!stopping) scheduleNgrokRestart(`ngrok termino: ${payload.error || payload.signal || payload.code}`);
  };

  ngrokChild.on('error', (error) => handleFailure({ at: new Date().toISOString(), error: error.message }));
  ngrokChild.on('exit', (code, signal) => handleFailure({ at: new Date().toISOString(), code, signal }));
}

async function checkHealth() {
  if (stopping) return;
  const result = await requestJson(LOCAL_HOST, PORT, '/health', 2000);
  status.lastHealthAt = new Date().toISOString();
  status.serverHealthy = Boolean(result.ok && result.data && result.data.ok !== false);
  status.serverRunning = Boolean(serverChild && !childExited(serverChild));

  if (status.serverHealthy) {
    if (MODE === 'ngrok' && !ngrokChild && !ngrokRestartTimer) spawnNgrok();
  } else if (Date.now() >= startupDeadline) {
    status.lastError = `El MCP no supero el health check en ${HEALTH_START_TIMEOUT_MS} ms: ${result.error || result.statusCode || 'sin respuesta'}`;
    persistStatus();
    shutdown(1, status.lastError);
    return;
  }
  persistStatus();
}

async function checkTunnel() {
  if (stopping || MODE !== 'ngrok') return;
  const result = await requestJson('127.0.0.1', 4040, '/api/tunnels', 2000);
  status.ngrokApiReachable = Boolean(result.ok);
  if (result.ok && result.data && Array.isArray(result.data.tunnels)) {
    const expectedTarget = `http://${LOCAL_HOST}:${PORT}`;
    const matching = result.data.tunnels.filter((item) => String(item.config && item.config.addr || '').replace(/\/+$/, '') === expectedTarget);
    const tunnel = matching.find((item) => String(item.public_url || '').startsWith('https://')) || matching[0];
    if (tunnel && tunnel.public_url) {
      ngrokRestartDelayMs = 3000;
      status.lastError = '';
      setPublicUrl(tunnel.public_url);
      return;
    }
  }
  persistStatus();
}

function configureExposure() {
  if (MODE === 'direct') {
    if (!PUBLIC_BASE_URL) {
      status.lastError = 'MCP_EXPOSURE_MODE=direct requiere PUBLIC_BASE_URL.';
      log(status.lastError, 'WARN');
    } else {
      setPublicUrl(PUBLIC_BASE_URL);
    }
  } else if (MODE === 'local') {
    setPublicUrl('');
  } else if (MODE !== 'ngrok') {
    status.lastError = `Modo de exposicion desconocido: ${MODE}`;
    log(status.lastError, 'WARN');
  }
}

function finishShutdown() {
  clearTimeout(shutdownTimer);
  status.state = 'stopped';
  status.serverRunning = false;
  status.serverHealthy = false;
  status.ngrokRunning = false;
  status.ngrokApiReachable = false;
  status.updatedAt = new Date().toISOString();
  try { writeAtomic(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`); } catch (_) {}
  removeFile(PID_PATH);
  try { serverLog.end(); } catch (_) {}
  try { ngrokLog.end(); } catch (_) {}
  process.exit(exitCode);
}

function shutdown(code = 0, reason = 'solicitud de detencion') {
  if (stopping) return;
  stopping = true;
  exitCode = Number.isInteger(code) ? code : 1;
  if (exitCode === 0) status.lastError = '';
  log(`Deteniendo supervisor: ${reason}`, exitCode === 0 ? 'INFO' : 'ERROR');
  if (healthTimer) clearInterval(healthTimer);
  if (tunnelTimer) clearInterval(tunnelTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (ngrokRestartTimer) clearTimeout(ngrokRestartTimer);
  persistStatus();

  for (const child of [ngrokChild, serverChild]) {
    if (child && !childExited(child)) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
  }

  const waitTimer = setInterval(() => {
    if (childExited(ngrokChild) && childExited(serverChild)) {
      clearInterval(waitTimer);
      finishShutdown();
    }
  }, 100);

  shutdownTimer = setTimeout(() => {
    clearInterval(waitTimer);
    for (const child of [ngrokChild, serverChild]) {
      if (child && !childExited(child)) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    }
    finishShutdown();
  }, 6000);
}

process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGINT', () => shutdown(0, 'SIGINT'));
process.on('SIGHUP', () => shutdown(0, 'SIGHUP'));
process.on('uncaughtException', (error) => shutdown(1, `uncaughtException: ${error.stack || error.message}`));
process.on('unhandledRejection', (error) => shutdown(1, `unhandledRejection: ${error && (error.stack || error.message) || error}`));

log(`Supervisor iniciado (pid=${process.pid}, mode=${MODE})`);
spawnServer();
configureExposure();
healthTimer = setInterval(() => { checkHealth().catch((error) => log(`health check: ${error.message}`, 'WARN')); }, 2000);
tunnelTimer = setInterval(() => { checkTunnel().catch((error) => log(`tunnel check: ${error.message}`, 'WARN')); }, 2000);
heartbeatTimer = setInterval(persistStatus, 5000);
setTimeout(() => { checkHealth().catch((error) => log(`health inicial: ${error.message}`, 'WARN')); }, 300);
persistStatus();
