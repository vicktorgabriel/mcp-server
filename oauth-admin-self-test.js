#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { configureOAuthAdmin } = require('./oauth-provider');

const CLI = path.join(__dirname, 'oauth-admin.js');

function run(args, storePath, extra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, MCP_OAUTH_STORE: storePath, ...extra }
  });
}

function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-admin-'));
  try {
    const storePath = path.join(temp, 'oauth-state.json');
    const password = `Regression-${crypto.randomBytes(18).toString('hex')}`;
    configureOAuthAdmin(storePath, 'regression-user', password);

    const configured = run(['is-configured'], storePath);
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(configured.stdout, '');

    const missing = run(['is-configured'], path.join(temp, 'missing.json'));
    assert.equal(missing.status, 1, 'an absent OAuth account must return status 1');
    assert.equal(missing.stdout, '');

    const jsonStatus = run(['status', '--json'], storePath);
    assert.equal(jsonStatus.status, 0, jsonStatus.stderr);
    const snapshot = JSON.parse(jsonStatus.stdout);
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.username, 'regression-user');
    assert.equal(snapshot.storePath, storePath);
    assert.equal(Object.hasOwn(snapshot, 'passwordHash'), false);

    const exactPipeline = spawnSync('bash', [
      '-o', 'pipefail', '-c',
      'MCP_OAUTH_STORE="$1" "$2" "$3" status | grep -q "Configurado: sí"',
      '_', storePath, process.execPath, CLI
    ], { cwd: __dirname, encoding: 'utf8' });
    assert.equal(exactPipeline.status, 0, `${exactPipeline.stdout}${exactPipeline.stderr}`);
    assert.ok(!/EPIPE|Unhandled 'error' event/.test(`${exactPipeline.stdout}${exactPipeline.stderr}`));

    const immediateClose = spawnSync('bash', [
      '-o', 'pipefail', '-c',
      'MCP_OAUTH_STORE="$1" "$2" "$3" status | head -n 0',
      '_', storePath, process.execPath, CLI
    ], { cwd: __dirname, encoding: 'utf8' });
    assert.equal(immediateClose.status, 0, `${immediateClose.stdout}${immediateClose.stderr}`);
    assert.ok(!/EPIPE|Unhandled 'error' event/.test(`${immediateClose.stdout}${immediateClose.stderr}`));

    process.stdout.write('oauth_admin_cli=OK\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main();
