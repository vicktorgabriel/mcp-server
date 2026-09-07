#!/usr/bin/env node
'use strict';

process.env.MCP_RUN_AS_ROOT = "0";
process.env.MCP_CONFIG_SOURCE = "process";
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { MCPFileServer } = require('../mcp-server');
const { ToolExecutorCore, IpcExecutor } = require('../lib/ipc-executor');
const { IpcGatewayClient } = require('../lib/ipc-gateway');
const { createAccessPolicy, ClientPolicyStore, TOOL_REQUIREMENTS } = require('../lib/access-policy');
const { ApprovalsManager, hashArgs, cleanArgsForHash, buildArgsSummary } = require('../lib/approvals');
const { testBwrapSupport } = require('../lib/sandbox');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

// --------------------------------------------------------------------------
// TEST 1: Catalog consistency across 86 tools & schemas
// --------------------------------------------------------------------------
async function testCatalogAndSchemas() {
  process.stdout.write('[TEST 1] Verifying 86 tools catalog and schema compatibility...\n');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-catalog-'));

  try {
    const policy = createAccessPolicy({ MCP_ACCESS_PROFILE: 'full' }, Object.keys(TOOL_REQUIREMENTS));
    const server = new MCPFileServer();
    const executor = new ToolExecutorCore({ allowedRoots: [tempDir], accessPolicy: policy });

    const serverTools = server.getAllTools();
    const executorTools = executor.getAllTools();

    assert.equal(serverTools.length, 86, `Server must publish exactly 86 tools (got ${serverTools.length})`);
    assert.equal(executorTools.length, 86, `Executor must publish exactly 86 tools (got ${executorTools.length})`);

    const serverToolMap = new Map(serverTools.map(t => [t.name, t]));
    const executorToolMap = new Map(executorTools.map(t => [t.name, t]));
    assert.equal(serverToolMap.size, 86, 'Server tool names must be unique');
    assert.equal(executorToolMap.size, 86, 'Executor tool names must be unique');
    for (const name of ['code_search_symbols', 'project_dependency_map', 'patch_preview', 'patch_apply', 'file_restore_safe', 'project_test_runner', 'service_diagnostics', 'security_block_history', 'job_list_mine', 'job_tail_output']) {
      assert.ok(serverToolMap.has(name), `Missing new tool: ${name}`);
    }

    for (const [name, sTool] of serverToolMap) {
      const eTool = executorToolMap.get(name);
      assert.ok(eTool, `Executor missing tool: ${name}`);

      const sProps = Object.keys(sTool.inputSchema?.properties || {}).sort();
      const eProps = Object.keys(eTool.inputSchema?.properties || {}).sort();

      // Check key capabilities
      if (name === 'read_file') {
        assert.ok(sProps.includes('offset') && sProps.includes('limit'), 'read_file server schema must include offset and limit');
        assert.ok(eProps.includes('offset') && eProps.includes('limit'), 'read_file executor schema must include offset and limit');
      }
      if (name === 'write_file') {
        assert.ok(sProps.includes('preview'), 'write_file server schema must include preview');
        assert.ok(eProps.includes('preview'), 'write_file executor schema must include preview');
      }

      assert.deepStrictEqual(sProps, eProps, `Properties mismatch for tool '${name}': server=${JSON.stringify(sProps)} vs exec=${JSON.stringify(eProps)}`);
    }

    process.stdout.write('  -> 86 tools schemas match 100%.\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// TEST 2: Real tool contract execution with and without IPC
// --------------------------------------------------------------------------
async function testToolContractsWithAndWithoutIpc() {
  process.stdout.write('[TEST 2] Testing real tool operations (read_file old/new, write_file preview/append, patch, jobs) with and without IPC...\n');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-contracts-'));
  const sockPath = path.join(tempDir, 'ipc.sock');
  const tokenPath = path.join(tempDir, 'ipc.token');
  const approvalsPath = path.join(tempDir, 'approvals.json');
  fs.writeFileSync(tokenPath, 'test-ipc-token', { mode: 0o600 });

  const testFile = path.join(tempDir, 'data.txt');
  fs.writeFileSync(testFile, 'Alpha Beta Gamma Delta Epsilon\nLine 2 text\nLine 3 end\n', 'utf8');

  // We test both IPC mode and In-Process mode
  for (const useIpc of [false, true]) {
    const modeLabel = useIpc ? 'IPC (isolated socket)' : 'In-Process';
    process.stdout.write(`  Subtest: Running contracts in mode: ${modeLabel}...\n`);
    fs.writeFileSync(testFile, "Alpha Beta Gamma Delta Epsilon\nLine 2 text\nLine 3 end\n", "utf8");

    const policy = createAccessPolicy({
      MCP_ACCESS_PROFILE: 'developer',
      ALLOWED_PATHS: tempDir,
      MCP_CRITICAL_CONFIRMATIONS: '0'
    }, Object.keys(TOOL_REQUIREMENTS));

    let ipcServer = null;
    let gateway = null;

    if (useIpc) {
      ipcServer = new IpcExecutor({
        sockPath,
        tokenPath,
        allowedRoots: [tempDir],
        accessPolicy: policy,
        approvalsStore: approvalsPath
      });
      await ipcServer.start();
      gateway = new IpcGatewayClient({ sockPath, tokenPath, autoSpawn: false });
      await gateway.ensureConnected();
    }

    const mcp = new MCPFileServer();
    mcp.accessPolicy = policy;
    if (useIpc) {
      mcp.ipcGateway = gateway;
    } else {
      mcp.ipcGateway = null;
    }

    // 1. read_file (classic full read)
    const readFull = await mcp.callTool('read_file', { path: testFile });
    const fullText = readFull.content ? readFull.content[0].text : readFull.text;
    assert.ok(fullText.includes('Alpha Beta Gamma'), 'read_file full read must contain content');

    // 2. read_file with offset & limit
    const readPartial = await mcp.callTool('read_file', { path: testFile, offset: 6, limit: 10 });
    const partJson = JSON.parse(readPartial.content ? readPartial.content[0].text : readPartial.text);
    assert.equal(partJson.content, 'Beta Gamma', 'read_file offset=6 limit=10 must read "Beta Gamma"');
    assert.equal(partJson.offset, 6);
    assert.equal(partJson.bytesRead, 10);

    // 3. write_file with preview: true (must not modify file)
    const writePreview = await mcp.callTool('write_file', { path: testFile, content: 'MODIFIED', preview: true });
    const prevJson = JSON.parse(writePreview.content ? writePreview.content[0].text : writePreview.text);
    assert.equal(prevJson.preview, true);
    const contentAfterPreview = fs.readFileSync(testFile, 'utf8');
    assert.ok(contentAfterPreview.includes('Alpha Beta'), 'File must not be modified when preview: true');

    // 4. write_file with mode: 'append'
    await mcp.callTool('write_file', { path: testFile, content: 'Appended Line\n', mode: 'append' });
    const contentAfterAppend = fs.readFileSync(testFile, 'utf8');
    assert.ok(contentAfterAppend.endsWith('Appended Line\n'), 'write_file append must add to end');

    // 5. patch_file
    await mcp.callTool('patch_file', {
      path: testFile,
      patches: [{ search: 'Alpha Beta', replace: 'Omega Sigma' }]
    });
    const contentAfterPatch = fs.readFileSync(testFile, 'utf8');
    assert.ok(contentAfterPatch.includes('Omega Sigma Gamma'), 'patch_file must replace search target');

    // 6. search & fetch
    const searchRes = await mcp.callTool('search', { query: 'data.txt', path: tempDir });
    const searchText = searchRes.content ? searchRes.content[0].text : searchRes.text;
    assert.ok(searchText.includes('data.txt'), 'search must find data.txt');

    const fetchRes = await mcp.callTool('fetch', { id: testFile });
    const fetchText = fetchRes.content ? fetchRes.content[0].text : fetchRes.text;
    assert.ok(fetchText.includes('Omega Sigma'), 'fetch must return file content');

    // 7. run_command
    const cmdRes = await mcp.callTool('run_command', {
      command: 'node',
      args: ['-e', 'console.log("HELLO_MCP_CONTRACT")'],
      cwd: tempDir
    });
    const cmdText = cmdRes.content ? cmdRes.content[0].text : cmdRes.text;
    assert.ok(cmdText.includes('HELLO_MCP_CONTRACT'), 'run_command must execute and return output');

    // 8. jobs (job_start, job_status, job_output, job_cancel)
    const startRes = await mcp.callTool('job_start', {
      command: 'node',
      args: ['-e', 'console.log("JOB_OUTPUT_LINE"); setTimeout(() => {}, 2000);'],
      cwd: tempDir
    });
    const jobInfo = JSON.parse(startRes.content ? startRes.content[0].text : startRes.text);
    assert.ok(jobInfo.jobId, 'job_start must return jobId');

    // wait briefly for job to start
    await new Promise(r => setTimeout(r, 100));

    const statusRes = await mcp.callTool('job_status', { jobId: jobInfo.jobId });
    const statusJson = JSON.parse(statusRes.content ? statusRes.content[0].text : statusRes.text);
    assert.ok(['running', 'completed'].includes(statusJson.status));

    const cancelRes = await mcp.callTool('job_cancel', { jobId: jobInfo.jobId });
    const cancelJson = JSON.parse(cancelRes.content ? cancelRes.content[0].text : cancelRes.text);
    assert.ok(cancelJson.ok || cancelJson.status === 'canceled' || cancelJson.status === 'cancelled' || cancelJson.status === 'completed');

    if (gateway) gateway.disconnect();
    if (ipcServer) await ipcServer.stop();
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  process.stdout.write('  -> Real contracts verified with and without IPC.\n');
}

// --------------------------------------------------------------------------
// TEST 3: End-to-end Approvals Resumption, Hash Integrity & Negative Tests
// --------------------------------------------------------------------------
async function testApprovalsEndToEndFlow() {
  process.stdout.write('[TEST 3] Testing Approvals: HTTP call -> pending -> argsSummary details -> local approve -> execute once -> anti-replay / client mismatch...\n');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-appr-'));
  const approvalsPath = path.join(tempDir, 'approvals.json');
  const targetFile = path.join(tempDir, 'file-to-delete.txt');
  fs.writeFileSync(targetFile, 'content before delete', 'utf8');

  const appMgr = new ApprovalsManager(approvalsPath);

  const policy = createAccessPolicy({
    MCP_ACCESS_PROFILE: 'developer',
    ALLOWED_PATHS: tempDir,
    MCP_CRITICAL_CONFIRMATIONS: '1',
    MCP_TOOL_APPROVALS: 'file_delete'
  }, Object.keys(TOOL_REQUIREMENTS));

  const port = await freePort();
  const mcp = new MCPFileServer();
  mcp.accessPolicy = policy;
  mcp.approvals = appMgr;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const json = JSON.parse(body);
          // Context carries authenticated client
          const clientId = req.headers['x-client-id'] || 'client-primary';
          const resp = await mcp.handle(json, { principal: { clientId, clientName: 'Client Primary' } });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(resp));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    }
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));

  try {
    // 1. Client calls file_delete without approvalId -> Must return pending approval
    const call1 = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-primary' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'file_delete',
          arguments: { path: targetFile }
        }
      })
    });
    const resp1 = await call1.json();
    assert.ok(resp1.error, 'First call must fail requiring approval');
    assert.equal(resp1.error.code, -32001);
    assert.ok(resp1.error.data && resp1.error.data.approvalId, 'Must return approvalId in error data');
    const approvalId = resp1.error.data.approvalId;

    // Verify argsSummary has meaningful target details (not just 'file_delete(path)')
    assert.ok(resp1.error.data.argsSummary.includes(targetFile), `argsSummary must include actual file path: got ${resp1.error.data.argsSummary}`);

    // Verify file was NOT deleted
    assert.ok(fs.existsSync(targetFile), 'Target file must still exist while approval is pending');

    // 2. Client attempts to execute immediately with unapproved approvalId -> Must fail
    const prematureCall = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-primary' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
          name: 'file_delete',
          arguments: { path: targetFile, approvalId }
        }
      })
    });
    const prematureResp = await prematureCall.json();
    assert.ok(prematureResp.error, 'Premature call must fail');
    assert.ok(/no ha sido aprobada|estado: pending/i.test(prematureResp.error.message));

    // 3. Local operator approves the request
    const approved = appMgr.approve(approvalId, { approvedBy: 'local-operator' });
    assert.equal(approved.status, 'approved');

    // 4. Client B attempts to consume Client Primary's approval -> Must fail
    const clientBCall = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-attacker-b' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/call',
        params: {
          name: 'file_delete',
          arguments: { path: targetFile, approvalId }
        }
      })
    });
    const clientBResp = await clientBCall.json();
    assert.ok(clientBResp.error, 'Client B must be rejected');
    assert.ok(/Cruce de clientes detectado/i.test(clientBResp.error.message));

    // 5. Client Primary attempts with tampered arguments -> Must fail
    const tamperedCall = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-primary' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 104,
        method: 'tools/call',
        params: {
          name: 'file_delete',
          arguments: { path: '/tmp/other-file.txt', approvalId }
        }
      })
    });
    const tamperedResp = await tamperedCall.json();
    assert.ok(tamperedResp.error, 'Tampered arguments must be rejected');
    assert.ok(/hash alterado|no coinciden/i.test(tamperedResp.error.message));

    // 6. Client Primary resumes execution with exact arguments and approvalId -> Must SUCCEED!
    const validResumeCall = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-primary' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 105,
        method: 'tools/call',
        params: {
          name: 'file_delete',
          arguments: { path: targetFile, approvalId }
        }
      })
    });
    const validResumeResp = await validResumeCall.json();
    assert.ok(!validResumeResp.error, `Valid resumed call must succeed: ${JSON.stringify(validResumeResp.error)}`);
    assert.ok(validResumeResp.result, 'Must return execution result');

    // Verify file IS NOW deleted!
    assert.ok(!fs.existsSync(targetFile), 'Target file must be deleted upon successful execution');

    // 7. Replay Attack: Client Primary attempts to call again with the same consumed approvalId -> Must fail!
    const replayCall = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-primary' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 106,
        method: 'tools/call',
        params: {
          name: 'file_delete',
          arguments: { path: targetFile, approvalId }
        }
      })
    });
    const replayResp = await replayCall.json();
    assert.ok(replayResp.error, 'Replay attack must be blocked');
    assert.ok(/replay detectado|ya fue consumida/i.test(replayResp.error.message));

    process.stdout.write('  -> End-to-end approvals resumption and security checks verified.\n');
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// TEST 4: Per-Client Authoritative Policy Store & Dynamic Revocation on Open Connections
// --------------------------------------------------------------------------
async function testPerClientAuthoritativePolicyAndDynamicRevocation() {
  process.stdout.write('[TEST 4] Testing per-client authoritative policy store and dynamic revocation on open HTTP connections...\n');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-client-policy-'));
  const clientPoliciesFile = path.join(tempDir, 'client-policies.json');
  const testFile = path.join(tempDir, 'secret.txt');
  fs.writeFileSync(testFile, 'Client Policy Secret Data\n', 'utf8');

  const clientStore = new ClientPolicyStore(clientPoliciesFile);
  const policy = createAccessPolicy({
    MCP_ACCESS_PROFILE: 'developer',
    ALLOWED_PATHS: tempDir,
    MCP_CLIENT_POLICIES_STORE: clientPoliciesFile,
    MCP_CRITICAL_CONFIRMATIONS: '0'
  }, Object.keys(TOOL_REQUIREMENTS), clientStore);

  const port = await freePort();
  const mcp = new MCPFileServer();
  mcp.accessPolicy = policy;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const json = JSON.parse(body);
          const clientId = req.headers['x-client-id'] || 'anonymous';
          const resp = await mcp.handle(json, { principal: { clientId, clientName: `Client ${clientId}` } });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(resp));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    }
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));

  try {
    // 1. Client A and Client B both call read_file initially -> Both must succeed
    const reqA1 = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-alpha', 'Connection': 'keep-alive' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: testFile } } })
    });
    const resA1 = await reqA1.json();
    assert.ok(!resA1.error, 'Client Alpha must succeed initially');

    const reqB1 = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-beta', 'Connection': 'keep-alive' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: testFile } } })
    });
    const resB1 = await reqB1.json();
    assert.ok(!resB1.error, 'Client Beta must succeed initially');

    // 2. Admin revokes read_file ONLY for Client Alpha on disk
    clientStore.revokeClientTool('client-alpha', 'read_file');

    // 3. Client Alpha calls read_file again on open connection -> MUST BE BLOCKED IMMEDIATELY!
    const reqA2 = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-alpha', 'Connection': 'keep-alive' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: testFile } } })
    });
    const resA2 = await reqA2.json();
    assert.ok(resA2.error, 'Client Alpha must be blocked after revocation');
    assert.ok(/bloqueada|denegad/i.test(resA2.error.message));

    // 4. Client Beta calls read_file on open connection -> MUST STILL SUCCEED!
    const reqB2 = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-beta', 'Connection': 'keep-alive' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_file', arguments: { path: testFile } } })
    });
    const resB2 = await reqB2.json();
    assert.ok(!resB2.error, 'Client Beta must still succeed');

    // 5. Client Alpha calls tools/list -> read_file MUST BE OMITTED!
    const listA = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-alpha' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' })
    });
    const listAResp = await listA.json();
    const toolNamesA = listAResp.result.tools.map(t => t.name);
    assert.ok(!toolNamesA.includes('read_file'), 'Revoked tool read_file must not be listed for Client Alpha');

    // 6. Client Beta calls tools/list -> read_file MUST BE PRESENT!
    const listB = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-beta' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' })
    });
    const listBResp = await listB.json();
    const toolNamesB = listBResp.result.tools.map(t => t.name);
    assert.ok(toolNamesB.includes('read_file'), 'read_file must still be listed for Client Beta');

    // 7. Admin restores read_file for Client Alpha -> Client Alpha succeeds immediately
    clientStore.grantClientTool('client-alpha', 'read_file');
    const reqA3 = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'client-alpha' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_file', arguments: { path: testFile } } })
    });
    const resA3 = await reqA3.json();
    assert.ok(!resA3.error, 'Client Alpha must succeed after permissions restoration');

    process.stdout.write('  -> Per-client authoritative permissions and dynamic revocation verified.\n');
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// TEST 5: Restricted Sandbox Escape Resistance (Blockers 1, 2, 3)
// --------------------------------------------------------------------------
async function testRestrictedSandboxBoundary() {
  process.stdout.write('[TEST 5] Testing restricted sandbox boundary (process_start, masked files, git hooks, tmux denial, nested secrets, external executable rejection, control plane tampering)...\n');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-sandbox-'));
  const allowed = path.join(tempDir, 'allowed');
  const outside = path.join(tempDir, 'outside');
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const fakeEnvFile = path.join(allowed, '.env');
  fs.writeFileSync(fakeEnvFile, 'SECRET_KEY=12345\n', 'utf8');

  // Nested fixture for Blocker 2
  const nestedDir = path.join(allowed, 'project');
  fs.mkdirSync(nestedDir, { recursive: true });
  const nestedEnvFile = path.join(nestedDir, '.env');
  fs.writeFileSync(nestedEnvFile, 'NESTED_FIXTURE_ONLY=topsecret\n', 'utf8');

  // External executable and sibling secret for Blocker 1
  const outsideReader = path.join(outside, 'reader');
  fs.writeFileSync(outsideReader, '#!/bin/sh\ncat "$0.secret"\n', { mode: 0o755 });
  fs.writeFileSync(outsideReader + '.secret', 'OUTSIDE_FIXTURE_ONLY\n', 'utf8');

  try {
    const policy = createAccessPolicy({
      MCP_ACCESS_PROFILE: 'trabajo_restringido',
      ALLOWED_PATHS: allowed,
      MCP_CRITICAL_CONFIRMATIONS: '0'
    }, Object.keys(TOOL_REQUIREMENTS));

    const executor = new ToolExecutorCore({
      allowedRoots: [allowed],
      accessPolicy: policy
    });

    // 1. Test Codex reproduction: process_start writing to outside/marker
    const outsideMarker = path.join(outside, 'marker');
    try {
      await executor.executeTool('process_start', {
        command: process.execPath,
        args: ['-e', 'require("fs").writeFileSync(process.argv[1], "fixture")', outsideMarker],
        cwd: allowed,
        logPath: path.join(allowed, 'job.log')
      }, { auth: { authenticated: true, clientId: 'fixture' } });
    } catch (_) {}

    // Wait 250ms for process to execute
    await new Promise(r => setTimeout(r, 250));
    assert.ok(!fs.existsSync(outsideMarker), 'Restricted sandbox must NOT allow writing outside the allowed directory');

    // 2. Test reading top-level masked .env file
    const readEnvRes = await executor.executeTool('run_command', {
      command: 'cat',
      args: ['.env'],
      cwd: allowed
    }, { auth: { authenticated: true, clientId: 'fixture' } });
    const catText = readEnvRes.content ? readEnvRes.content[0].text : readEnvRes.text;
    assert.ok(!catText.includes('SECRET_KEY=12345'), 'Masked .env file must not leak secret content');

    // 3. Test reading NESTED masked .env file (Blocker 2)
    const readNestedRes = await executor.executeTool('run_command', {
      command: 'cat',
      args: ['project/.env'],
      cwd: allowed
    }, { auth: { authenticated: true, clientId: 'fixture' } });
    const nestedText = readNestedRes.content ? readNestedRes.content[0].text : readNestedRes.text;
    assert.ok(!nestedText.includes('NESTED_FIXTURE_ONLY'), 'Nested masked .env file must not leak secret content');

    // 4. Test external executable rejection and no sibling mount (Blocker 1)
    await assert.rejects(async () => {
      await executor.executeTool('run_command', {
        command: outsideReader,
        args: [],
        cwd: allowed
      }, { auth: { authenticated: true, clientId: 'fixture' } });
    }, /fuera de.*rutas permitidas/i, 'External command outside allowed roots must be rejected');

    // 5. Test control plane tampering rejection by filesystem tools (Blocker 3)
    // Attempt write_file to .runtime/approvals.json
    await assert.rejects(async () => {
      await executor.executeTool('write_file', {
        path: path.join(allowed, '.runtime', 'approvals.json'),
        content: 'FIXTURE_TAMPER'
      }, { auth: { authenticated: true, clientId: 'fixture' } });
    }, /protegid|restringid|bloquead|denegad/i, 'write_file to .runtime/approvals.json must be rejected');

    // Attempt patch_file to .runtime/client-policies.json
    await assert.rejects(async () => {
      await executor.executeTool('patch_file', {
        path: path.join(allowed, '.runtime', 'client-policies.json'),
        patches: [{ search: 'a', replace: 'b' }]
      }, { auth: { authenticated: true, clientId: 'fixture' } });
    }, /protegid|restringid|bloquead|denegad/i, 'patch_file to .runtime/client-policies.json must be rejected');

    // Attempt file_move targeting .runtime/approvals.json
    const dummyFile = path.join(allowed, 'dummy.txt');
    fs.writeFileSync(dummyFile, 'dummy');
    await assert.rejects(async () => {
      await executor.executeTool('file_move', {
        source: dummyFile,
        destination: path.join(allowed, '.runtime', 'approvals.json')
      }, { auth: { authenticated: true, clientId: 'fixture' } });
    }, /protegid|restringid|bloquead|denegad/i, 'file_move to .runtime/approvals.json must be rejected');

    // 6. Test tmux denial
    await assert.rejects(async () => {
      await executor.executeTool('tmux_list', {}, { auth: { authenticated: true, clientId: 'fixture' } });
    }, /bloqueada por el perfil de acceso trabajo_restringido/i, 'tmux must be deterministically blocked in restricted profile');

    process.stdout.write('  -> Restricted sandbox boundary and tampering protections successfully verified.\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// TEST 6: ClientPolicyStore Fail-Closed on Unlink or Corruption (Blocker 4)
// --------------------------------------------------------------------------
async function testClientPolicyStoreFailClosed() {
  process.stdout.write('[TEST 6] Testing ClientPolicyStore fail-closed on unlinked file or JSON corruption...\n');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-cpstore-'));
  const storePath = path.join(tempDir, 'client-policies.json');

  try {
    const store = new ClientPolicyStore(storePath);
    const policy = createAccessPolicy({ MCP_ACCESS_PROFILE: 'developer' }, Object.keys(TOOL_REQUIREMENTS), store);
    await store.setClientPolicy('client-test', { deniedTools: ['read_file'] });

    // Verify it is denied initially
    assert.strictEqual(policy.isAllowed('read_file', { clientId: 'client-test' }), false, 'read_file should be denied initially');

    // Unlink the store file (simulating deletion/tampering after configuration)
    fs.unlinkSync(storePath);
    assert.ok(!fs.existsSync(storePath));

    // Must fail closed (isAllowed returns false, not true / fallback default)
    assert.strictEqual(
      policy.isAllowed('read_file', { clientId: 'client-test' }),
      false,
      'isAllowed must fail-closed (return false) when store file is unlinked after configuration'
    );

    // assertAllowed must throw
    assert.throws(() => {
      policy.assertAllowed('read_file', { clientId: 'client-test' });
    }, /PolicyCorruptedStateError|restringid|bloquead|corrupt/i, 'assertAllowed must throw PolicyCorruptedStateError on unlinked store');

    // Corrupt store file with invalid JSON
    fs.writeFileSync(storePath, '{ invalid json content !!!');
    assert.strictEqual(
      policy.isAllowed('read_file', { clientId: 'client-test' }),
      false,
      'isAllowed must fail-closed (return false) on JSON corruption'
    );
    assert.throws(() => {
      policy.assertAllowed('read_file', { clientId: 'client-test' });
    }, /PolicyCorruptedStateError|restringid|bloquead|corrupt/i, 'assertAllowed must throw PolicyCorruptedStateError on corrupted store');

    process.stdout.write('  -> ClientPolicyStore fail-closed on tamper/loss verified.\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await testCatalogAndSchemas();
  await testToolContractsWithAndWithoutIpc();
  await testApprovalsEndToEndFlow();
  await testPerClientAuthoritativePolicyAndDynamicRevocation();
  await testRestrictedSandboxBoundary();
  await testClientPolicyStoreFailClosed();
  process.stdout.write('\nALL CONTRACT AND INTEGRATION TESTS PASSED (v4=OK)\n');
}

run().catch((err) => {
  console.error('\n[FATAL] Contract test failed:', err);
  process.exit(1);
});
