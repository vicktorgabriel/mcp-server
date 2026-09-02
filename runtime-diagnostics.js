#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DEFAULT_SERVICE = 'mcp-local.service';

function parseDotEnv(filePath = path.join(ROOT, '.env')) {
  const values = {};
  if (!fs.existsSync(filePath)) return values;

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function configValue(fileEnv, key, fallback = '') {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  if (fileEnv[key] !== undefined && fileEnv[key] !== '') return fileEnv[key];
  return fallback;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeLocalHost(host) {
  const value = String(host || '').trim();
  if (!value || value === '0.0.0.0' || value === '::' || value === '[::]') return '127.0.0.1';
  return value.replace(/^\[|\]$/g, '');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function processExists(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function sanitizeObject(value, key = '') {
  if (/token|password|passwd|secret|authorization|api[_-]?key/i.test(key)) {
    return value ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeObject(item));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = sanitizeObject(childValue, childKey);
    }
    return output;
  }
  return value;
}

function redactText(text) {
  return String(text || '')
    .replace(/(ngrok\s+config\s+add-authtoken\s+)\S+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|passwd|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
}

function requestJson(host, port, requestPath, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const request = http.request({
      host,
      port,
      path: requestPath,
      method: 'GET',
      timeout: timeoutMs,
      headers: { Accept: 'application/json' }
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total <= 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = body ? JSON.parse(body) : null; } catch (_) {}
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          statusCode: response.statusCode,
          data,
          body: data === null ? body.slice(0, 4096) : undefined
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    request.on('error', (error) => resolve({ ok: false, error: error.message }));
    request.end();
  });
}

function execResult(command, args = [], options = {}) {
  const timeoutMs = clampInt(options.timeoutMs, 5000, 500, 60000);
  const outputLimit = clampInt(options.outputLimit, 1024 * 1024, 4096, 4 * 1024 * 1024);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let completed = false;
    let timedOut = false;
    let child;

    try {
      child = spawn(command, args.map(String), {
        cwd: options.cwd || ROOT,
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ ok: false, command, args, error: error.message });
      return;
    }

    const finish = (payload) => {
      if (completed) return;
      completed = true;
      resolve(payload);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) {}
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (Buffer.byteLength(stdout, 'utf8') < outputLimit) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (Buffer.byteLength(stderr, 'utf8') < outputLimit) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, command, args, error: error.message, stdout, stderr, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({ ok: code === 0 && !timedOut, command, args, exitCode: code, signal, timedOut, stdout, stderr });
    });
  });
}

function parseKeyValue(text) {
  const output = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) output[line.slice(0, index)] = line.slice(index + 1);
  }
  return output;
}

function tailTextFile(filePath, lines) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return '';
    const bytes = Math.min(stats.size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(bytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, bytes, stats.size - bytes);
    } finally {
      fs.closeSync(fd);
    }
    return redactText(buffer.toString('utf8').split(/\r?\n/).slice(-lines).join('\n'));
  } catch (_) {
    return '';
  }
}

async function collectRuntimeStatus() {
  const fileEnv = parseDotEnv();
  const host = configValue(fileEnv, 'HOST', '127.0.0.1');
  const localHost = normalizeLocalHost(host);
  const port = clampInt(configValue(fileEnv, 'PORT', '3000'), 3000, 1, 65535);
  const mode = String(configValue(fileEnv, 'MCP_EXPOSURE_MODE', 'ngrok')).toLowerCase();
  const publicBaseUrl = String(configValue(fileEnv, 'PUBLIC_BASE_URL', '')).replace(/\/+$/, '');
  const serviceName = configValue(fileEnv, 'MCP_SERVICE_NAME', process.env.MCP_SERVICE_NAME || DEFAULT_SERVICE);
  const runtimeDir = path.resolve(configValue(fileEnv, 'MCP_RUNTIME_DIR', path.join(ROOT, '.runtime')));
  const runtimePath = path.join(runtimeDir, 'status.json');
  const runtimeRaw = readJsonFile(runtimePath);
  const runtime = sanitizeObject(runtimeRaw || {});
  const runtimeUpdated = runtimeRaw && runtimeRaw.updatedAt ? Date.parse(runtimeRaw.updatedAt) : NaN;
  const runtimeAgeSeconds = Number.isFinite(runtimeUpdated) ? Math.max(0, Math.round((Date.now() - runtimeUpdated) / 1000)) : null;
  const runtimeFresh = runtimeAgeSeconds !== null && runtimeAgeSeconds <= 20;

  const serviceResultPromise = process.platform === 'linux'
    ? execResult('systemctl', [
        'show', serviceName, '--no-pager',
        '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus,ExecMainStartTimestamp,FragmentPath'
      ], { timeoutMs: 6000 })
    : Promise.resolve({ ok: false, error: `systemctl is unavailable on ${process.platform}` });

  const socketResultPromise = process.platform === 'linux'
    ? execResult('ss', ['-lntp'], { timeoutMs: 5000 })
    : Promise.resolve({ ok: false, error: `ss is unavailable on ${process.platform}` });

  const healthPromise = requestJson(localHost, port, '/health', 2500);
  const ngrokPromise = mode === 'ngrok'
    ? requestJson('127.0.0.1', 4040, '/api/tunnels', 2500)
    : Promise.resolve({ ok: false, skipped: true });

  const [serviceResult, socketResult, health, ngrokApi] = await Promise.all([
    serviceResultPromise,
    socketResultPromise,
    healthPromise,
    ngrokPromise
  ]);

  const serviceProperties = serviceResult.stdout ? parseKeyValue(serviceResult.stdout) : {};
  const service = {
    name: serviceName,
    installed: serviceProperties.LoadState === 'loaded',
    active: serviceProperties.ActiveState === 'active',
    state: serviceProperties.ActiveState || 'unknown',
    subState: serviceProperties.SubState || 'unknown',
    enabled: serviceProperties.UnitFileState || 'unknown',
    mainPid: Number(serviceProperties.MainPID || 0),
    mainPidAlive: processExists(serviceProperties.MainPID),
    exitStatus: serviceProperties.ExecMainStatus === undefined ? null : Number(serviceProperties.ExecMainStatus),
    startedAt: serviceProperties.ExecMainStartTimestamp || '',
    unitPath: serviceProperties.FragmentPath || '',
    error: serviceResult.ok ? '' : redactText(serviceResult.stderr || serviceResult.error || '')
  };

  let liveTunnel = null;
  const expectedTunnelTarget = `http://${localHost}:${port}`;
  if (ngrokApi.ok && ngrokApi.data && Array.isArray(ngrokApi.data.tunnels)) {
    const matching = ngrokApi.data.tunnels.filter((item) => String(item.config && item.config.addr || '').replace(/\/+$/, '') === expectedTunnelTarget);
    const selected = matching.find((item) => String(item.public_url || '').startsWith('https://')) || matching[0];
    if (selected) {
      liveTunnel = {
        name: selected.name || '',
        protocol: selected.proto || '',
        publicUrl: String(selected.public_url || '').replace(/\/+$/, ''),
        target: selected.config && selected.config.addr ? selected.config.addr : ''
      };
    }
  }

  let publicUrl = '';
  if (mode === 'ngrok') {
    publicUrl = (liveTunnel && liveTunnel.publicUrl)
      || (runtimeFresh && runtimeRaw && runtimeRaw.publicUrl ? String(runtimeRaw.publicUrl).replace(/\/+$/, '') : '');
  } else if (mode === 'direct') {
    publicUrl = publicBaseUrl;
  }
  const chatgptUrl = publicUrl ? `${publicUrl}/mcp` : '';

  const socketLines = String(socketResult.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.includes(`:${port}`) || line.includes(':4040'))
    .slice(0, 20);

  const warnings = [];
  if (!health.ok) warnings.push(`MCP local no responde en http://${localHost}:${port}/health: ${health.error || health.statusCode || 'sin respuesta'}`);
  if (mode === 'ngrok' && !liveTunnel) warnings.push('ngrok no expone actualmente un tunel HTTPS en la API local 127.0.0.1:4040.');
  if (!service.installed) warnings.push(`El servicio ${serviceName} no esta instalado.`);
  else if (!service.active) warnings.push(`El servicio ${serviceName} no esta activo (${service.state}/${service.subState}).`);
  if (runtimeRaw && !runtimeFresh) warnings.push(`El estado persistido tiene ${runtimeAgeSeconds} segundos y puede estar obsoleto.`);

  const serviceHealthy = process.platform !== 'linux' || (service.installed && service.active);
  const exposureHealthy = mode === 'ngrok' ? Boolean(liveTunnel) : mode === 'direct' ? Boolean(publicUrl) : mode === 'local';

  return {
    ok: Boolean(health.ok && exposureHealthy && serviceHealthy),
    checkedAt: new Date().toISOString(),
    repository: ROOT,
    config: {
      host,
      port,
      exposureMode: mode,
      fullAccess: String(configValue(fileEnv, 'MCP_FULL_ACCESS', '0')) === '1',
      authConfigured: Boolean(configValue(fileEnv, 'MCP_AUTH_TOKEN', '')),
      allowedPathsConfigured: Boolean(configValue(fileEnv, 'ALLOWED_PATHS', '')),
      runtimeDir
    },
    service,
    local: {
      healthUrl: `http://${localHost}:${port}/health`,
      health,
      listeningSockets: socketLines,
      socketProbeError: socketResult.ok ? '' : redactText(socketResult.stderr || socketResult.error || '')
    },
    tunnel: {
      mode,
      apiReachable: Boolean(ngrokApi.ok),
      publicUrl,
      chatgptUrl,
      expectedTarget: expectedTunnelTarget,
      live: liveTunnel,
      apiError: ngrokApi.ok || ngrokApi.skipped ? '' : (ngrokApi.error || `HTTP ${ngrokApi.statusCode || 'unknown'}`)
    },
    runtime: {
      fresh: runtimeFresh,
      ageSeconds: runtimeAgeSeconds,
      status: runtime
    },
    warnings
  };
}

async function collectRuntimeLogs(lines = 200) {
  const amount = clampInt(lines, 200, 1, 5000);
  const fileEnv = parseDotEnv();
  const serviceName = configValue(fileEnv, 'MCP_SERVICE_NAME', process.env.MCP_SERVICE_NAME || DEFAULT_SERVICE);
  const runtimeDir = path.resolve(configValue(fileEnv, 'MCP_RUNTIME_DIR', path.join(ROOT, '.runtime')));
  const journal = process.platform === 'linux'
    ? await execResult('journalctl', ['-u', serviceName, '--no-pager', '-n', String(amount), '-o', 'short-iso'], {
        timeoutMs: 15000,
        outputLimit: 4 * 1024 * 1024
      })
    : { ok: false, error: `journalctl is unavailable on ${process.platform}` };

  return {
    checkedAt: new Date().toISOString(),
    service: serviceName,
    lines: amount,
    journal: {
      ok: journal.ok,
      output: redactText(journal.stdout || ''),
      error: redactText(journal.stderr || journal.error || '')
    },
    files: {
      mcpServer: tailTextFile(path.join(runtimeDir, 'mcp-server.log'), amount),
      ngrok: tailTextFile(path.join(runtimeDir, 'ngrok.log'), amount)
    }
  };
}

async function cli() {
  const command = process.argv[2] || 'status';
  if (command === 'logs') {
    const result = await collectRuntimeLogs(process.argv[3]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const result = await collectRuntimeStatus();
  if (command === 'url') {
    if (!result.ok || !result.tunnel.chatgptUrl) {
      process.stderr.write('No hay una URL publica sana y activa para ChatGPT.\n');
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${result.tunnel.chatgptUrl}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (command === 'doctor' && !result.ok) process.exitCode = 1;
}

if (require.main === module) {
  cli().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  collectRuntimeLogs,
  collectRuntimeStatus,
  parseDotEnv,
  redactText
};
