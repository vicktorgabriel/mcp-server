#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pkg = require('../package.json');

const ROOT = path.resolve(__dirname, '..');

function run(args, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'startup-banner.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function writeCache(runtimeDir, value) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'update-status.json'), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function main() {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-startup-banner-'));
  try {
    const checkedAt = new Date().toISOString();
    writeCache(runtime, {
      checkedAt,
      localVersion: pkg.version,
      remoteVersion: '9.9.9',
      localCommit: 'a'.repeat(40),
      remoteCommit: 'b'.repeat(40),
      state: 'update_available',
      dirty: false
    });

    const common = {
      MCP_RUNTIME_DIR: runtime,
      MCP_ACCESS_PROFILE: 'read_only',
      MCP_ACCESS_GROUPS: '',
      MCP_TOOL_ALLOWLIST: '',
      MCP_TOOL_DENYLIST: '',
      MCP_FULL_ACCESS: '0',
      MCP_RUN_AS_ROOT: '1',
      MCP_CRITICAL_CONFIRMATIONS: '0',
      MCP_AUTH_MODE: 'oauth',
      MCP_EXPOSURE_MODE: 'ngrok',
      MCP_UPDATE_CHECK: '1',
      MCP_UPDATE_CHECK_TTL_SECONDS: '900',
      NO_COLOR: '1'
    };

    const banner = run(['--banner'], common);
    assert.equal(banner.status, 0, banner.stderr);
    assert.match(banner.stdout, new RegExp(`MCP-Server v${pkg.version.replaceAll('.', '\\.')}`));
    assert.match(banner.stdout, /Motor:\s+Node\.js .*\(código fuente\)/);
    assert.match(banner.stdout, /Herramientas:\s+40 expuestas de 72/);
    assert.match(banner.stdout, /Perfil:\s+Sólo lectura y observación/);
    assert.match(banner.stdout, /ROOT solicitado/);
    assert.match(banner.stdout, /Confirmaciones:\s+DESACTIVADAS/);
    assert.match(banner.stdout, /ACTUALIZACIÓN DISPONIBLE/);
    assert.match(banner.stdout, /v9\.9\.9/);
    assert.ok(!banner.stdout.includes('\u001b['), 'NO_COLOR must disable ANSI sequences');

    const colored = run(['--summary'], { ...common, NO_COLOR: '', MCP_FORCE_COLOR: '1' });
    assert.equal(colored.status, 0, colored.stderr);
    assert.ok(colored.stdout.includes('\u001b['), 'forced color must emit ANSI sequences');
    assert.match(colored.stdout, /ACTUALIZACIÓN DISPONIBLE/);

    const fresh = run(['--needs-update-check'], common);
    assert.equal(fresh.status, 1, 'fresh update cache must not request another check');

    writeCache(runtime, {
      checkedAt: new Date(Date.now() - 3600_000).toISOString(),
      localVersion: pkg.version,
      state: 'current',
      dirty: false
    });
    const stale = run(['--needs-update-check'], { ...common, MCP_UPDATE_CHECK_TTL_SECONDS: '30' });
    assert.equal(stale.status, 0, 'stale update cache must request a background check');

    const disabled = run(['--check-update', '--force', '--notify', '--json'], {
      ...common,
      MCP_UPDATE_CHECK: '0'
    });
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stdout, /"state": "disabled"/);
    assert.match(disabled.stdout, /Comprobación de actualizaciones desactivada/);

    process.stdout.write('startup_banner=OK\n');
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}

main();
