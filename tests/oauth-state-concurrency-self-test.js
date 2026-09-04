#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { OAuthStateStore } = require('../lib/oauth-provider');

if (process.argv[2] === '--writer') {
  const storePath = process.argv[3];
  const clientId = process.argv[4];
  const store = new OAuthStateStore(storePath);
  process.send('ready');
  process.once('message', (message) => {
    if (message !== 'write') process.exit(2);
    store.mutate((state) => {
      state.clients[clientId] = {
        clientId,
        clientName: 'Concurrent test client',
        issuedAt: Math.floor(Date.now() / 1000)
      };
    });
    process.exit(0);
  });
} else {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-state-lock-'));
  const storePath = path.join(temp, 'oauth-state.json');
  try {
    new OAuthStateStore(storePath).save();
    const children = Array.from({ length: 12 }, (_, index) => fork(
      __filename,
      ['--writer', storePath, `client-${index}`],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    ));
    let ready = 0;
    await Promise.all(children.map((child) => new Promise((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('message', (message) => {
        if (message !== 'ready') return;
        ready += 1;
        if (ready === children.length) children.forEach((entry) => entry.send('write'));
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`concurrent writer exited ${code}: ${stderr.slice(-500)}`));
      });
    })));

    const finalStore = new OAuthStateStore(storePath);
    assert.equal(Object.keys(finalStore.state.clients).length, 12,
      'cross-process updates must preserve all clients');

    const current = new OAuthStateStore(storePath);
    const stale = new OAuthStateStore(storePath);
    current.mutate((state) => {
      state.authorizationCodes.current = { expiresAt: Math.floor(Date.now() / 1000) + 60 };
    });
    stale.state.authorizationCodes.stale = { expiresAt: Math.floor(Date.now() / 1000) + 60 };
    assert.throws(() => stale.save(), /escritura obsoleta/,
      'a stale full-state save must fail instead of overwriting newer OAuth state');
    const afterConflict = new OAuthStateStore(storePath);
    assert.ok(afterConflict.state.authorizationCodes.current);
    assert.equal(afterConflict.state.authorizationCodes.stale, undefined);
    assert.equal(fs.existsSync(`${storePath}.lock`), false, 'the lock file must be released');
    assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);

    process.stdout.write('oauth_state_concurrency=OK\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
