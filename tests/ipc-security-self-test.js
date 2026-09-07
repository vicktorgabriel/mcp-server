#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { MessageFramer, validateIpcRequest, MAX_MESSAGE_SIZE } = require('../lib/ipc-protocol');
const { IpcExecutor } = require('../lib/ipc-executor');
const { IpcGatewayClient } = require('../lib/ipc-gateway');
const { createAccessPolicy, TOOL_REQUIREMENTS } = require('../lib/access-policy');
process.env.MCP_TEST_ALLOW_ROOT_FLAG = '1';
process.env.MCP_RUN_AS_ROOT = '0';
const { MCPFileServer } = require('../mcp-server');

async function testFramingBasics() {
  const framer = new MessageFramer();
  const obj1 = { id: 1, method: 'ping' };
  const obj2 = { id: 2, method: 'pong', data: 'hello'.repeat(10) };

  const buf1 = MessageFramer.frame(obj1);
  const buf2 = MessageFramer.frame(obj2);
  const combined = Buffer.concat([buf1, buf2]);

  // Feed in single chunk
  const messages = framer.feed(combined);
  assert.equal(messages.length, 2);
  assert.deepStrictEqual(messages[0], obj1);
  assert.deepStrictEqual(messages[1], obj2);

  // Feed in small byte chunks
  const framer2 = new MessageFramer();
  const chunkedMsgs = [];
  for (let i = 0; i < combined.length; i++) {
    const chunk = combined.subarray(i, i + 1);
    chunkedMsgs.push(...framer2.feed(chunk));
  }
  assert.equal(chunkedMsgs.length, 2);
  assert.deepStrictEqual(chunkedMsgs[0], obj1);
  assert.deepStrictEqual(chunkedMsgs[1], obj2);
}

async function testOversizedMessageRejection() {
  const framer = new MessageFramer();
  // Create a fake frame header declaring a length exceeding MAX_MESSAGE_SIZE
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_MESSAGE_SIZE + 1024, 0);

  assert.throws(() => {
    framer.feed(header);
  }, /exceeds max allowed size/i);
}

async function testMalformedJsonHandling() {
  const framer = new MessageFramer();
  const badBody = Buffer.from('NOT_VALID_JSON{{{');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(badBody.length, 0);

  assert.throws(() => {
    framer.feed(Buffer.concat([header, badBody]));
  }, /Failed to parse IPC message JSON/i);
}

async function testIpcRequestValidation() {
  // Missing jsonrpc
  assert.equal(validateIpcRequest({ id: 1, method: 'tools/list' }).ok, false);
  // Missing id
  assert.equal(validateIpcRequest({ jsonrpc: '2.0', method: 'tools/list' }).ok, false);
  // Missing method
  assert.equal(validateIpcRequest({ jsonrpc: '2.0', id: 1 }).ok, false);
  // Invalid params
  assert.equal(validateIpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: 'not_an_object' }).ok, false);

  // Valid request
  const valid = validateIpcRequest({
    jsonrpc: '2.0',
    id: 'req-42',
    method: 'tools/call',
    params: { name: 'list_files', arguments: { path: '.' } }
  });
  assert.equal(valid.ok, true);
}

async function testIpcExecutorAuthenticationAndRejection() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ipc-sec-'));
  const sockPath = path.join(tempDir, 'test.sock');
  const tokenPath = path.join(tempDir, 'auth-token');
  const policy = createAccessPolicy({ MCP_ACCESS_PROFILE: 'developer' }, Object.keys(TOOL_REQUIREMENTS));

  const executor = new IpcExecutor({
    sockPath,
    tokenPath,
    accessPolicy: policy,
    allowedRoots: [tempDir]
  });

  try {
    await executor.start();
    assert.ok(fs.existsSync(sockPath), 'Socket must exist');
    assert.ok(fs.existsSync(tokenPath), 'Token file must exist');

    // Test 1: Connect and send invalid token in handshake
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(sockPath);
      const framer = new MessageFramer();
      socket.on('connect', () => {
        const badHandshake = {
          type: 'handshake',
          token: 'WRONG_TOKEN_12345678901234567890123456789012',
          pid: process.pid
        };
        socket.write(MessageFramer.frame(badHandshake));
      });
      socket.on('data', (chunk) => {
        const msgs = framer.feed(chunk);
        for (const msg of msgs) {
          if (msg.type === 'handshake_ack') {
            assert.equal(msg.ok, false);
            assert.ok(msg.error);
            socket.destroy();
            resolve();
          }
        }
      });
      socket.on('error', reject);
    });

    // Test 2: Connect and attempt request without handshake
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(sockPath);
      const framer = new MessageFramer();
      socket.on('connect', () => {
        const unauthReq = {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list'
        };
        socket.write(MessageFramer.frame(unauthReq));
      });
      socket.on('data', (chunk) => {
        const msgs = framer.feed(chunk);
        for (const msg of msgs) {
          if (msg.error) {
            assert.equal(msg.error.code, -32001);
            socket.destroy();
            resolve();
          }
        }
      });
      socket.on('error', reject);
    });

    // Test 3: Gateway Client with correct token succeeds
    const client = new IpcGatewayClient({
      sockPath,
      tokenPath,
      autoSpawn: false
    });

    await client.ensureConnected();
    assert.ok(client.connected);
    assert.ok(client.authenticated);

    const tools = await client.getPublishedTools({ auth: { clientId: 'chatgpt', authenticated: true } });
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length > 0);

    // Call tool via IPC client
    const statusResult = await client.callTool('tool_policy_status', {}, {
      auth: { clientId: 'chatgpt', authenticated: true }
    });
    assert.ok(statusResult.content);

    // Test 4: Denied or approval-required tool via IPC throws
    await assert.rejects(async () => {
      await client.callTool('power_action', { action: 'reboot' }, {
        auth: { clientId: 'chatgpt', authenticated: true }
      });
    }, /no está permitida|bloqueada|denegad|Aprobación requerida/i);

    // Test 5: Cross-client isolation verification
    // Client A starts a job
    const jobRes = await client.callTool('job_start', { command: 'echo', args: ['hello-ipc'] }, {
      auth: { clientId: 'client-A', authenticated: true }
    });
    assert.ok(jobRes.content);
    const parsedJob = JSON.parse(jobRes.content[0].text);
    const jobId = parsedJob.jobId;

    // Client B tries to read job output -> must fail with ownership error
    await assert.rejects(async () => {
      await client.callTool('job_output', { jobId }, {
        auth: { clientId: 'client-B', authenticated: true }
      });
    }, /pertenece a otro cliente/i);

    // Client A can read it
    const outputRes = await client.callTool('job_output', { jobId }, {
      auth: { clientId: 'client-A', authenticated: true }
    });
    assert.ok(outputRes.content);

    // Test 6: Per-client permission enforcement over IPC (Finding G)
    // Client with specific allowedTools can call tool_policy_status
    const allowedClientRes = await client.callTool('tool_policy_status', {}, {
      auth: { clientId: 'client-allowed-only', authenticated: true, allowedTools: ['tool_policy_status'] }
    });
    assert.ok(allowedClientRes.content);

    // Client with specific allowedTools CANNOT call tools outside its allowed list
    await assert.rejects(async () => {
      await client.callTool('job_start', { command: 'echo', args: ['hi'] }, {
        auth: { clientId: 'client-allowed-only', authenticated: true, allowedTools: ['tool_policy_status'] }
      });
    }, /bloqueada.*para el cliente|no está permitida/i);

    // Client with deniedTools cannot call specifically denied tools
    await assert.rejects(async () => {
      await client.callTool('job_start', { command: 'echo', args: ['hi'] }, {
        auth: { clientId: 'client-denied', authenticated: true, deniedTools: ['job_start'] }
      });
    }, /bloqueada.*para el cliente|no está permitida/i);

    client.socket.destroy();
  } finally {
    executor.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testDynamicPolicyVersion() {
  const policy1 = createAccessPolicy({ MCP_ACCESS_PROFILE: 'developer' });
  const policy2 = createAccessPolicy({ MCP_ACCESS_PROFILE: 'developer', MCP_TOOL_DENYLIST: 'write_file' });
  assert.ok(policy1.version, 'Policy must have a dynamic version');
  assert.ok(policy2.version, 'Policy must have a dynamic version');
  assert.notEqual(policy1.version, policy2.version, 'Policy version must change when configuration changes');
}

async function testMcpServerFailClosedWhenIpcRequired() {
  const origReq = process.env.MCP_REQUIRE_IPC;
  process.env.MCP_REQUIRE_IPC = '1';
  try {
    const srv = new MCPFileServer();
    srv.ipcGateway = null; // simulate missing or failing IPC gateway
    await assert.rejects(async () => {
      await srv.callTool('tool_policy_status', {});
    }, /requiere un ejecutor IPC aislado activo|Fallo cerrado/i);
  } finally {
    if (origReq !== undefined) process.env.MCP_REQUIRE_IPC = origReq;
    else delete process.env.MCP_REQUIRE_IPC;
  }
}

async function testAdministrativePauseBlocksExecution() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pause-test-'));
  const pauseFile = path.join(tempDir, 'server-paused');
  const origPause = process.env.MCP_PAUSE_FILE;
  process.env.MCP_PAUSE_FILE = pauseFile;

  try {
    fs.writeFileSync(pauseFile, JSON.stringify({ pausedAt: Date.now(), reason: 'Test Pause' }));
    const srv = new MCPFileServer();
    await assert.rejects(async () => {
      await srv.callTool('read_file', { path: 'test.txt' });
    }, /pausa administrativa/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (origPause !== undefined) process.env.MCP_PAUSE_FILE = origPause;
    else delete process.env.MCP_PAUSE_FILE;
  }
}

async function run() {
  await testFramingBasics();
  await testOversizedMessageRejection();
  await testMalformedJsonHandling();
  await testIpcRequestValidation();
  await testIpcExecutorAuthenticationAndRejection();
  await testDynamicPolicyVersion();
  await testMcpServerFailClosedWhenIpcRequired();
  await testAdministrativePauseBlocksExecution();
  process.stdout.write('ipc_security=OK\n');
}

run().catch((err) => {
  console.error('IPC security test failed:', err);
  process.exit(1);
});
