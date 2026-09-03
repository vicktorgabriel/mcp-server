#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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

function sourceServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/data') {
        const body = 'download-data-extended-tools';
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'set-cookie': 'secret-cookie=must-not-be-returned'
        });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitForHealth(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`MCP health timeout: ${base}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-extended-tools-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-extended-outside-'));
  const source = await sourceServer();
  const sourcePort = source.address().port;
  const mcpPort = await freePort();
  const base = `http://127.0.0.1:${mcpPort}`;

  fs.mkdirSync(path.join(root, 'source', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'source', 'hello.txt'), 'hello extended tools\n');
  fs.writeFileSync(path.join(root, 'source', 'nested', 'child.txt'), 'child\n');
  fs.writeFileSync(path.join(root, 'source', 'large.bin'), Buffer.alloc(2048, 7));
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'must stay outside\n');
  fs.symlinkSync(outside, path.join(root, 'escape-link'));

  const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js'), '--http'], {
    cwd: __dirname,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(mcpPort),
      MCP_EXPOSURE_MODE: 'local',
      MCP_AUTH_MODE: 'none',
      MCP_ACCESS_PROFILE: 'full',
      MCP_ACCESS_GROUPS: '',
      MCP_TOOL_ALLOWLIST: '',
      MCP_TOOL_DENYLIST: '',
      MCP_FULL_ACCESS: '0',
      ALLOWED_PATHS: root,
      WORKING_DIR: root,
      MCP_HUMAN_LOG: path.join(root, '.runtime', 'events.log'),
      ACTIVITY_LOG: path.join(root, '.runtime', 'activity.ndjson'),
      MCP_ERROR_LOG: path.join(root, '.runtime', 'errors.log'),
      MCP_DESKTOP_ENABLED: '0',
      MCP_INPUT_ENABLED: '0'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  async function request(method, params = {}) {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
    });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async function call(name, args = {}) {
    const response = await request('tools/call', { name, arguments: args });
    if (response.error) throw new Error(`${name}: ${response.error.message}`);
    return response.result.structuredContent;
  }

  try {
    await waitForHealth(base);

    const toolList = await request('tools/list');
    assert.equal(toolList.result.tools.length, 72);

    const policy = await call('tool_policy_status');
    assert.equal(policy.profile, 'full');
    assert.equal(policy.allowedToolCount, 72);
    assert.equal(policy.blockedToolCount, 0);

    const tree = await call('directory_tree', { path: 'source', depth: 3 });
    assert.ok(tree.entries.some((entry) => entry.path === 'hello.txt'));
    assert.ok(tree.entries.some((entry) => entry.path === path.join('nested', 'child.txt')));

    const hash = await call('file_hash', { path: 'source/hello.txt', algorithm: 'sha256' });
    assert.equal(hash.hash, crypto.createHash('sha256').update('hello extended tools\n').digest('hex'));

    await call('file_copy', { source: 'source/hello.txt', destination: 'copied.txt' });
    assert.equal(fs.readFileSync(path.join(root, 'copied.txt'), 'utf8'), 'hello extended tools\n');
    await call('file_move', { source: 'copied.txt', destination: 'moved.txt' });
    assert.equal(fs.existsSync(path.join(root, 'copied.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'moved.txt'), 'utf8'), 'hello extended tools\n');
    fs.writeFileSync(path.join(root, 'replacement.txt'), 'replacement\n');
    fs.writeFileSync(path.join(root, 'replace-target.txt'), 'old\n');
    await call('file_move', { source: 'replacement.txt', destination: 'replace-target.txt', overwrite: true });
    assert.equal(fs.existsSync(path.join(root, 'replacement.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'replace-target.txt'), 'utf8'), 'replacement\n');

    const archive = await call('archive_create', { source: 'source', destination: 'source.tar.gz' });
    assert.ok(archive.size > 0);
    const extracted = await call('archive_extract', { archive: 'source.tar.gz', destination: 'extracted' });
    assert.ok(extracted.entries >= 3);
    assert.equal(fs.readFileSync(path.join(root, 'extracted', 'source', 'hello.txt'), 'utf8'), 'hello extended tools\n');
    const oversizedArchive = await request('tools/call', {
      name: 'archive_extract',
      arguments: { archive: 'source.tar.gz', destination: 'too-small-limit', maxBytes: 1024 }
    });
    assert.ok(oversizedArchive.error);
    assert.match(oversizedArchive.error.message, /exceeds extraction limit/i);
    assert.equal(fs.existsSync(path.join(root, 'too-small-limit', 'source', 'hello.txt')), false);

    const httpResult = await call('http_request', { url: `http://127.0.0.1:${sourcePort}/data` });
    assert.equal(httpResult.status, 200);
    assert.equal(httpResult.body, 'download-data-extended-tools');
    assert.equal(httpResult.headers['set-cookie'], undefined);

    const port = await call('port_check', { host: '127.0.0.1', port: sourcePort });
    assert.equal(port.open, true);

    const download = await call('download_file', { url: `http://127.0.0.1:${sourcePort}/data`, destination: 'downloaded.txt' });
    assert.equal(download.bytes, Buffer.byteLength('download-data-extended-tools'));
    assert.equal(fs.readFileSync(path.join(root, 'downloaded.txt'), 'utf8'), 'download-data-extended-tools');

    const packageStatus = await call('package_status', { packages: ['bash'] });
    assert.equal(typeof packageStatus.available, 'boolean');
    const firewallStatus = await call('firewall_status');
    assert.ok(Object.hasOwn(firewallStatus, 'backend'));
    assert.equal(typeof firewallStatus.readable, 'boolean');
    const mountStatus = await call('mount_status');
    assert.ok(Object.hasOwn(mountStatus, 'mounts'));
    const users = await call('user_accounts');
    assert.ok(users.users.some((user) => user.uid === 0));
    const containers = await call('container_status');
    assert.ok(Array.isArray(containers.runtimes));

    if (packageStatus.available) {
      const packageDryRun = await call('package_action', { action: 'refresh', confirm: 'APPLY PACKAGES', dryRun: true });
      assert.equal(packageDryRun.dryRun, true);
    }
    const mountDryRun = await call('mount_action', { action: 'mount', source: '/dev/example', target: 'future-mount', confirm: 'APPLY MOUNT', dryRun: true });
    assert.equal(mountDryRun.dryRun, true);
    assert.equal(fs.existsSync(path.join(root, 'future-mount')), false, 'mount dry-run must not create the target');
    const powerDryRun = await call('power_action', { action: 'reboot', confirm: 'REBOOT', dryRun: true });
    assert.equal(powerDryRun.dryRun, true);

    const invalidPackage = await request('tools/call', {
      name: 'package_action',
      arguments: { action: 'install', packages: ['--dangerous-option'], confirm: 'APPLY PACKAGES', dryRun: true }
    });
    assert.ok(invalidPackage.error);
    assert.match(invalidPackage.error.message, /invalid package name/i);

    const invalidFirewall = await request('tools/call', {
      name: 'firewall_action',
      arguments: { action: 'allow', rule: '--delete-all', confirm: 'APPLY FIREWALL', dryRun: true }
    });
    assert.ok(invalidFirewall.error);
    assert.match(invalidFirewall.error.message, /invalid firewall rule/i);

    const embeddedCredentials = await request('tools/call', {
      name: 'http_request',
      arguments: { url: `http://user:password@127.0.0.1:${sourcePort}/data` }
    });
    assert.ok(embeddedCredentials.error);
    assert.match(embeddedCredentials.error.message, /credentials embedded/i);

    const noDeleteConfirmation = await request('tools/call', { name: 'file_delete', arguments: { path: 'moved.txt' } });
    assert.ok(noDeleteConfirmation.error);
    assert.match(noDeleteConfirmation.error.message, /confirm=\"DELETE\"/i);

    const escaped = await request('tools/call', { name: 'read_file', arguments: { path: 'escape-link/outside.txt' } });
    assert.ok(escaped.error);
    assert.match(escaped.error.message, /outside allowed roots|symbolic link/i);

    const malicious = path.join(root, 'malicious.tar');
    const createMalicious = spawnSync('python3', ['-c', [
      'import io, tarfile, sys',
      'with tarfile.open(sys.argv[1], "w") as tf:',
      '  data=b"escape"',
      '  info=tarfile.TarInfo("../escaped.txt")',
      '  info.size=len(data)',
      '  tf.addfile(info, io.BytesIO(data))'
    ].join('\n'), malicious], { encoding: 'utf8' });
    assert.equal(createMalicious.status, 0, createMalicious.stderr);
    const rejectedArchive = await request('tools/call', { name: 'archive_extract', arguments: { archive: 'malicious.tar', destination: 'malicious-output' } });
    assert.ok(rejectedArchive.error);
    assert.match(rejectedArchive.error.message, /unsafe archive entry|escapes destination/i);
    assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);

    await call('file_delete', { path: 'moved.txt', confirm: 'DELETE' });
    assert.equal(fs.existsSync(path.join(root, 'moved.txt')), false);

    process.stdout.write('extended_tools=OK\n');
  } finally {
    source.close();
    await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    if (child.exitCode && child.exitCode !== 0) process.stderr.write(stderr);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
