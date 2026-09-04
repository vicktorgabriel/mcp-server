#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { GROUPS, TOOL_REQUIREMENTS, createAccessPolicy } = require('../lib/access-policy');

const ROOT = path.resolve(__dirname, '..');

function namesFor(profile, extra = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-policy-list-'));
  try {
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const result = spawnSync(process.execPath, [path.join(ROOT, 'mcp-server.js'), '--stdio'], {
      cwd: ROOT,
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
      env: {
        ...process.env,
        MCP_ACCESS_PROFILE: profile,
        MCP_ACCESS_GROUPS: '',
        MCP_TOOL_ALLOWLIST: '',
        MCP_TOOL_DENYLIST: '',
        MCP_EXPOSURE_MODE: 'local',
        MCP_AUTH_MODE: 'none',
        MCP_FULL_ACCESS: '0',
        MCP_CONFIG_SOURCE: 'env',
        MCP_RUN_AS_ROOT: '0',
        ALLOWED_PATHS: temp,
        WORKING_DIR: temp,
        MCP_HUMAN_LOG: path.join(temp, 'events.log'),
        ACTIVITY_LOG: path.join(temp, 'activity.ndjson'),
        MCP_ERROR_LOG: path.join(temp, 'errors.log'),
        MCP_DESKTOP_ENABLED: '0',
        MCP_INPUT_ENABLED: '0',
        ...extra
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim());
    return response.result.tools.map((tool) => tool.name);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function callBlocked(profile, toolName) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-policy-call-'));
  try {
    const request = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: {} } };
    const result = spawnSync(process.execPath, [path.join(ROOT, 'mcp-server.js'), '--stdio'], {
      cwd: ROOT,
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
      env: {
        ...process.env,
        MCP_ACCESS_PROFILE: profile,
        MCP_EXPOSURE_MODE: 'local',
        MCP_AUTH_MODE: 'none',
        MCP_FULL_ACCESS: '0',
        MCP_CONFIG_SOURCE: 'env',
        MCP_RUN_AS_ROOT: '0',
        ALLOWED_PATHS: temp,
        WORKING_DIR: temp,
        MCP_HUMAN_LOG: path.join(temp, 'events.log'),
        ACTIVITY_LOG: path.join(temp, 'activity.ndjson'),
        MCP_ERROR_LOG: path.join(temp, 'errors.log')
      }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function includesAll(collection, expected) {
  for (const item of expected) assert.ok(collection.includes(item), `expected ${item}`);
}

function excludesAll(collection, expected) {
  for (const item of expected) assert.ok(!collection.includes(item), `did not expect ${item}`);
}

function main() {
  const toolNames = Object.keys(TOOL_REQUIREMENTS);

  const readOnly = createAccessPolicy({ MCP_ACCESS_PROFILE: 'read_only' }, toolNames);
  includesAll(readOnly.summary().allowedTools, ['tool_policy_status', 'read_file', 'system_snapshot', 'git_status', 'screen_capture', 'http_request']);
  excludesAll(readOnly.summary().allowedTools, ['write_file', 'run_command', 'service_action', 'keyboard_type', 'camera_snapshot', 'package_action', 'power_action']);

  const developer = createAccessPolicy({ MCP_ACCESS_PROFILE: 'developer' }, toolNames);
  includesAll(developer.summary().allowedTools, ['write_file', 'run_command', 'git_command', 'tmux_send', 'container_compose']);
  excludesAll(developer.summary().allowedTools, ['service_action', 'keyboard_type', 'camera_snapshot', 'package_action', 'power_action']);

  const administrator = createAccessPolicy({ MCP_ACCESS_PROFILE: 'administrator' }, toolNames);
  includesAll(administrator.summary().allowedTools, ['service_action', 'keyboard_type', 'camera_snapshot', 'package_action', 'firewall_action', 'mount_action']);
  assert.equal(administrator.isAllowed('power_action'), false);

  const full = createAccessPolicy({ MCP_ACCESS_PROFILE: 'full' }, toolNames);
  assert.equal(full.isAllowed('power_action'), true);
  assert.equal(full.summary().blockedToolCount, 0);
  assert.equal(full.summary().runAsRoot, false);
  assert.equal(full.summary().criticalConfirmations, true);

  const expert = createAccessPolicy({
    MCP_ACCESS_PROFILE: 'full',
    MCP_RUN_AS_ROOT: '1',
    MCP_CRITICAL_CONFIRMATIONS: '0',
    MCP_FULL_ACCESS: '1'
  }, toolNames);
  const expertSummary = expert.summary();
  assert.equal(expertSummary.runAsRoot, true);
  assert.equal(expertSummary.executionMode, 'root');
  assert.equal(expertSummary.criticalConfirmations, false);
  assert.ok(expertSummary.warnings.some((warning) => /root/i.test(warning)));
  assert.ok(expertSummary.warnings.some((warning) => /confirmaciones.*desactivadas/i.test(warning)));

  const custom = createAccessPolicy({
    MCP_ACCESS_PROFILE: 'custom',
    MCP_ACCESS_GROUPS: 'diagnostics,files_read,files_write',
    MCP_TOOL_DENYLIST: 'write_file'
  }, toolNames);
  assert.equal(custom.isAllowed('read_file'), true);
  assert.equal(custom.isAllowed('patch_file'), true);
  assert.equal(custom.isAllowed('write_file'), false);
  assert.equal(custom.isAllowed('run_command'), false);

  const noCommandEscalation = createAccessPolicy({
    MCP_ACCESS_PROFILE: 'custom',
    MCP_ACCESS_GROUPS: 'git_write,tmux_write,containers'
  }, toolNames);
  assert.equal(noCommandEscalation.isAllowed('git_command'), false);
  assert.equal(noCommandEscalation.isAllowed('tmux_create'), false);
  assert.equal(noCommandEscalation.isAllowed('tmux_send'), false);
  assert.equal(noCommandEscalation.isAllowed('container_compose'), false);
  assert.equal(noCommandEscalation.isAllowed('tmux_kill'), true);

  const allowlist = createAccessPolicy({
    MCP_ACCESS_PROFILE: 'full',
    MCP_TOOL_ALLOWLIST: 'read_file,file_hash',
    MCP_TOOL_DENYLIST: 'file_hash'
  }, toolNames);
  assert.equal(allowlist.isAllowed('tool_policy_status'), true);
  assert.equal(allowlist.isAllowed('read_file'), true);
  assert.equal(allowlist.isAllowed('file_hash'), false);
  assert.equal(allowlist.isAllowed('run_command'), false);

  const typoFilter = createAccessPolicy({ MCP_ACCESS_PROFILE: 'developer', MCP_TOOL_DENYLIST: 'not_a_tool' }, toolNames);
  assert.ok(typoFilter.summary().warnings.some((warning) => warning.includes('not_a_tool')));

  assert.throws(() => createAccessPolicy({ MCP_ACCESS_PROFILE: 'custom', MCP_ACCESS_GROUPS: 'not_a_group' }), /grupos desconocidos/i);
  assert.equal(Object.keys(GROUPS).length >= 20, true);

  const readOnlyNames = namesFor('read_only');
  includesAll(readOnlyNames, ['tool_policy_status', 'read_file', 'directory_tree', 'file_hash', 'screen_capture']);
  excludesAll(readOnlyNames, ['write_file', 'file_delete', 'run_command', 'service_action', 'keyboard_type', 'power_action']);

  const developerNames = namesFor('developer');
  includesAll(developerNames, ['write_file', 'run_command', 'archive_create', 'download_file', 'container_compose']);
  excludesAll(developerNames, ['package_action', 'firewall_action', 'mount_action', 'power_action']);

  const administratorNames = namesFor('administrator');
  includesAll(administratorNames, ['package_action', 'firewall_action', 'mount_action', 'keyboard_type']);
  excludesAll(administratorNames, ['power_action']);

  const fullNames = namesFor('full');
  assert.equal(fullNames.length, 72);
  assert.equal(new Set(fullNames).size, fullNames.length);

  const blocked = callBlocked('read_only', 'run_command');
  assert.ok(blocked.error);
  assert.match(blocked.error.message, /bloqueada por el perfil/i);

  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-root-flag-'));
    try {
      const result = spawnSync(process.execPath, [path.join(ROOT, 'mcp-server.js'), '--stdio'], {
        cwd: ROOT,
        input: `${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} })}\n`,
        encoding: 'utf8',
        env: {
          ...process.env,
          MCP_ACCESS_PROFILE: 'full',
          MCP_CONFIG_SOURCE: 'env',
          MCP_RUN_AS_ROOT: '1',
          MCP_EXPOSURE_MODE: 'local',
          MCP_AUTH_MODE: 'none',
          MCP_FULL_ACCESS: '0',
          ALLOWED_PATHS: temp,
          WORKING_DIR: temp
        }
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, /no tiene uid 0/i);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  process.stdout.write('access_policy=OK\n');
}

main();
