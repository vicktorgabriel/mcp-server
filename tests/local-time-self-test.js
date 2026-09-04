#!/usr/bin/env node
'use strict';
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { redactText } = require('../lib/human-log');

const ROOT = path.resolve(__dirname, '..');
const script = `const { localIsoTimestamp } = require('./lib/human-log'); process.stdout.write(localIsoTimestamp(new Date('2026-09-03T23:00:00.123Z')));`;
const result = spawnSync(process.execPath, ['-e', script], {
  cwd: ROOT,
  env: { ...process.env, TZ: 'America/Argentina/Catamarca' },
  encoding: 'utf8'
});
assert.equal(result.status, 0, result.stderr);
assert.equal(result.stdout, '2026-09-03T20:00:00.123-03:00');
const secrets = [
  'mcp_at_ACCESS_VALUE',
  'mcp_rt_REFRESH_VALUE',
  'mcp_ac_CODE_VALUE',
  'mcp_cs_CLIENT_VALUE',
  'tx_TRANSACTION_VALUE',
  'STATE_VALUE',
  'VERIFIER_VALUE',
  'CHALLENGE_VALUE',
  'ASSERTION_VALUE',
  'HASH_VALUE',
  'COOKIE_VALUE'
];
const redacted = redactText(`access_token=${secrets[0]} refresh_token=${secrets[1]} code=${secrets[2]} client_secret=${secrets[3]} transaction=${secrets[4]} state=${secrets[5]} code_verifier=${secrets[6]} code_challenge=${secrets[7]} client_assertion=${secrets[8]} passwordHash=${secrets[9]} Cookie: ${secrets[10]}`);
for (const secret of secrets) assert.ok(!redacted.includes(secret), `secret was not redacted: ${secret}`);
process.stdout.write('local_time_log=OK\n');
