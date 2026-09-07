#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ApprovalManager, hashArguments } = require('../lib/approvals');

async function testHashArguments() {
  const hash1 = hashArguments({ b: 2, a: 1 });
  const hash2 = hashArguments({ a: 1, b: 2 });
  assert.equal(hash1, hash2, 'Argument hash must be deterministic across key ordering');

  const hash3 = hashArguments({ a: 1, b: 3 });
  assert.notEqual(hash1, hash3, 'Different arguments must produce different hashes');
}

async function testFakeConfirmationStringRejection() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-appr-test-'));
  const approvalsFile = path.join(tempDir, 'approvals.json');
  const mgr = new ApprovalManager({ storePath: approvalsFile, defaultTtlMs: 60000 });

  try {
    // A client sending confirm: 'DELETE' or confirm: 'APPLY' directly in args
    // must NOT bypass approval check
    const tool = 'file_delete';
    const argsWithFakeConfirm = { path: 'test.txt', confirm: 'DELETE' };
    const env = { MCP_CRITICAL_CONFIRMATIONS: '1' };

    assert.ok(mgr.isCriticalTool(tool, argsWithFakeConfirm, env), 'Critical tool check must not be cleared by confirm argument');

    // Attempting to consume without a real approval registered must throw
    assert.throws(() => {
      mgr.consumeApproval('fake-id', {
        clientId: 'test-client',
        action: tool,
        args: argsWithFakeConfirm,
        policyVersion: '1.0'
      });
    }, /no encontrada|inexistente/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testApprovalLifecycleAndAtomicConsumption() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-appr-test-'));
  const approvalsFile = path.join(tempDir, 'approvals.json');
  const mgr = new ApprovalManager({ storePath: approvalsFile, defaultTtlMs: 60000 });

  try {
    const action = 'write_file';
    const args = { path: 'important.js', content: 'hello' };
    const clientId = 'client-123';
    const policyVersion = 'v1';

    // 1. Create pending approval
    const item = mgr.requestApproval({
      clientId,
      action,
      args,
      policyVersion,
      scope: 'project',
      description: 'Writing important file'
    });

    assert.ok(item.approvalId);
    assert.equal(item.status, 'pending');
    assert.equal(item.clientId, clientId);
    assert.equal(item.action, action);
    assert.equal(item.policyVersion, policyVersion);

    // Cannot consume while pending
    assert.throws(() => {
      mgr.consumeApproval(item.approvalId, { clientId, action, args, policyVersion });
    }, /no ha sido aprobada|estado: pending/i);

    // 2. Approve via local operator
    const approved = mgr.approve(item.approvalId, { approvedBy: 'local-admin' });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedBy, 'local-admin');

    // 3. First consumption succeeds
    const consumed = mgr.consumeApproval(item.approvalId, { clientId, action, args, policyVersion });
    assert.ok(consumed);
    assert.equal(consumed.status, 'consumed');

    // 4. Replay attack: second consumption MUST fail
    assert.throws(() => {
      mgr.consumeApproval(item.approvalId, { clientId, action, args, policyVersion });
    }, /ya fue utilizada|consumida/i);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testArgumentTamperingRejection() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-appr-test-'));
  const approvalsFile = path.join(tempDir, 'approvals.json');
  const mgr = new ApprovalManager({ storePath: approvalsFile, defaultTtlMs: 60000 });

  try {
    const action = 'run_command';
    const approvedArgs = { command: 'echo', args: ['safe'] };
    const tamperedArgs = { command: 'rm', args: ['-rf', '/'] };
    const clientId = 'client-tamper';
    const policyVersion = 'v1';

    const item = mgr.requestApproval({ clientId, action, args: approvedArgs, policyVersion });
    mgr.approve(item.approvalId, { approvedBy: 'operator' });

    // Attempting to consume with tampered arguments MUST fail
    assert.throws(() => {
      mgr.consumeApproval(item.approvalId, { clientId, action, args: tamperedArgs, policyVersion });
    }, /alterados|no coinciden|hash/i);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testPolicyVersionMismatchRejection() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-appr-test-'));
  const approvalsFile = path.join(tempDir, 'approvals.json');
  const mgr = new ApprovalManager({ storePath: approvalsFile, defaultTtlMs: 60000 });

  try {
    const action = 'service_action';
    const args = { service: 'mcp.service', action: 'restart' };
    const clientId = 'client-ver';

    const item = mgr.requestApproval({ clientId, action, args, policyVersion: 'v1' });
    mgr.approve(item.approvalId, { approvedBy: 'operator' });

    // Calling under a changed policy version (e.g. v2) MUST fail
    assert.throws(() => {
      mgr.consumeApproval(item.approvalId, { clientId, action, args, policyVersion: 'v2' });
    }, /versión de política no coincide|política/i);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testExpirationRejection() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-appr-test-'));
  const approvalsFile = path.join(tempDir, 'approvals.json');
  // 10ms TTL
  const mgr = new ApprovalManager({ storePath: approvalsFile, defaultTtlMs: 10 });

  try {
    const action = 'write_file';
    const args = { path: 'exp.txt', content: 'test' };
    const clientId = 'client-exp';
    const policyVersion = 'v1';

    const item = mgr.requestApproval({ clientId, action, args, policyVersion, ttlMs: 10 });
    mgr.approve(item.approvalId, { approvedBy: 'operator' });

    // Wait 25ms for expiration
    await new Promise(r => setTimeout(r, 25));

    assert.throws(() => {
      mgr.consumeApproval(item.approvalId, { clientId, action, args, policyVersion });
    }, /ha expirado|vencida/i);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testRejectionAction() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-appr-test-'));
  const approvalsFile = path.join(tempDir, 'approvals.json');
  const mgr = new ApprovalManager({ storePath: approvalsFile, defaultTtlMs: 60000 });

  try {
    const item = mgr.requestApproval({
      clientId: 'client-rej',
      action: 'power_action',
      args: { action: 'poweroff' },
      policyVersion: 'v1'
    });

    const rejected = mgr.reject(item.approvalId, 'Rechazado por operador de seguridad');
    assert.equal(rejected.status, 'rejected');

    assert.throws(() => {
      mgr.consumeApproval(item.approvalId, {
        clientId: 'client-rej',
        action: 'power_action',
        args: { action: 'poweroff' },
        policyVersion: 'v1'
      });
    }, /rechazada|estado: rejected/i);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testMcpctlAdminCli() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-appr-cli-'));
  const approvalsFile = path.join(tempDir, 'approvals.json');
  const mgr = new ApprovalManager({ storePath: approvalsFile, defaultTtlMs: 60000 });

  try {
    const item = mgr.requestApproval({
      clientId: 'chatgpt-test',
      action: 'write_file',
      args: { path: 'cli-test.txt', content: 'data' },
      policyVersion: 'v1'
    });

    const rootDir = path.resolve(__dirname, '..');
    const adminScript = path.join(rootDir, 'mcpctl-admin.js');

    // List pending
    const listRes = spawnSync(process.execPath, [adminScript, 'pending'], {
      env: { ...process.env, MCP_APPROVALS_STORE: approvalsFile },
      encoding: 'utf8'
    });
    assert.equal(listRes.status, 0, listRes.stderr);
    assert.ok(listRes.stdout.includes(item.approvalId));

    // Approve via CLI
    const approveRes = spawnSync(process.execPath, [adminScript, 'approve', item.approvalId], {
      env: { ...process.env, MCP_APPROVALS_STORE: approvalsFile },
      encoding: 'utf8'
    });
    assert.equal(approveRes.status, 0, approveRes.stderr);
    assert.ok(/aprobada/i.test(approveRes.stdout));

    // Check status in store
    const reloaded = mgr.getApproval(item.approvalId);
    assert.equal(reloaded.status, 'approved');

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await testHashArguments();
  await testFakeConfirmationStringRejection();
  await testApprovalLifecycleAndAtomicConsumption();
  await testArgumentTamperingRejection();
  await testPolicyVersionMismatchRejection();
  await testExpirationRejection();
  await testRejectionAction();
  await testMcpctlAdminCli();
  process.stdout.write('approvals=OK\n');
}

run().catch((err) => {
  console.error('Approvals test failed:', err);
  process.exit(1);
});
