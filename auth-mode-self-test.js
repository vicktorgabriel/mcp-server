#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function launch(env) {
  return spawn(process.execPath, [path.join(__dirname, 'mcp-server.js'), '--http'], {
    cwd: __dirname,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe']
  });
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit')), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function waitForHealth(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return response;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`health timeout for ${base}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-mode-'));
  const common = {
    HOST: '127.0.0.1',
    ALLOWED_PATHS: temp,
    WORKING_DIR: temp,
    MCP_FULL_ACCESS: '0',
    MCP_HUMAN_LOG: path.join(temp, 'events.log'),
    ACTIVITY_LOG: path.join(temp, 'activity.ndjson'),
    MCP_ERROR_LOG: path.join(temp, 'errors.log'),
    MCP_DESKTOP_ENABLED: '0',
    MCP_INPUT_ENABLED: '0',
    MCP_PUBLIC_BASE_URL: ''
  };

  try {
    let stderr = '';
    let child = launch({ ...common, PORT: String(await freePort()), MCP_EXPOSURE_MODE: 'ngrok', MCP_AUTH_MODE: 'none', MCP_ALLOW_UNSAFE_NO_AUTH: '0' });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const publicNoAuthExit = await waitForExit(child);
    assert.notEqual(publicNoAuthExit.code, 0);
    assert.match(stderr, /confirmación explícita/i);

    stderr = '';
    child = launch({ ...common, PORT: String(await freePort()), MCP_EXPOSURE_MODE: 'direct', MCP_AUTH_MODE: 'bearer', MCP_AUTH_TOKEN: 'demasiado-corto' });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const shortBearerExit = await waitForExit(child);
    assert.notEqual(shortBearerExit.code, 0);
    assert.match(stderr, /al menos 32 caracteres/i);

    const token = 'B'.repeat(64);
    const tokenFile = path.join(temp, 'bearer-token.txt');
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });

    stderr = '';
    child = launch({
      ...common,
      PORT: String(await freePort()),
      MCP_EXPOSURE_MODE: 'direct',
      MCP_AUTH_MODE: 'bearer',
      MCP_AUTH_TOKEN: '',
      MCP_AUTH_TOKEN_FILE: tokenFile,
      MCP_PUBLIC_BASE_URL: 'http://198.51.100.10:3000',
      MCP_ALLOW_INSECURE_HTTP_AUTH: '0'
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const insecureBearerExit = await waitForExit(child);
    assert.notEqual(insecureBearerExit.code, 0);
    assert.match(stderr, /HTTP pública está bloqueado|HTTP.*sin cifrado/i);

    const port = await freePort();
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    child = launch({ ...common, PORT: String(port), MCP_EXPOSURE_MODE: 'direct', MCP_AUTH_MODE: 'bearer', MCP_AUTH_TOKEN: '', MCP_AUTH_TOKEN_FILE: tokenFile, MCP_PUBLIC_BASE_URL: `https://bearer-test.example` });
    try {
      const base = `http://127.0.0.1:${port}`;
      const health = await waitForHealth(base);
      const healthJson = await health.json();
      assert.equal(healthJson.auth, 'bearer');
      assert.equal(healthJson.allowedRoots, undefined);
      const denied = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
      assert.equal(denied.status, 401);
      const accepted = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }) });
      assert.equal(accepted.status, 200);
      const body = await accepted.json();
      assert.equal(body.result.serverInfo.name, 'mcp-local-control');
    } finally {
      await stop(child);
    }

    process.stdout.write('auth_modes=OK\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
