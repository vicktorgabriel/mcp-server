#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.MCP_TEST_ALLOW_ROOT_FLAG = '1';
process.env.MCP_RUN_AS_ROOT = '0';

const {
  validatePathWithinRoots,
  isSubpathOrEqual,
  isServerControlPlaneFile,
  scanForMasking,
  wrapCommandInSandbox,
  detectOsIsolationCapabilities,
  detectResourceLimitsCapabilities,
  getResourceLimitsConfig,
  applyResourceLimits,
  assertRestrictedIsolationAllowed
} = require('../lib/sandbox');

const {
  resolveExecutionContext,
  ToolExecutorCore
} = require('../lib/ipc-executor');

const { createAccessPolicy } = require('../lib/access-policy');
const { MCPFileServer } = require('../mcp-server');
const { collectRuntimeStatus } = require('../lib/runtime-diagnostics');

function createTempDir(prefix = 'mcp-v5-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // ignore cleanup errors
  }
}

// -----------------------------------------------------------------------------
// Test 1: Perfil efectivo por cliente, una sola decisión
// -----------------------------------------------------------------------------
async function test1_EffectiveProfilePerClient() {
  console.log('-> Test 1: Perfil efectivo por cliente, una sola decisión');
  const tempDir = createTempDir('mcp-v5-test1-');

  try {
    const globalDevPolicy = createAccessPolicy({
      allowedRoots: [tempDir],
      profile: 'developer',
      allowedProfileTools: new Set(['run_command', 'process_start', 'git_command', 'git_status', 'git_log', 'tmux_new_session'])
    });

    // Case 1A: resolveExecutionContext calculations
    const clientRestricted = {
      clientId: 'client-restricted',
      clientPolicy: {
        profile: 'trabajo_restringido',
        allowedRoots: [tempDir],
        allowedTools: new Set(['run_command', 'git_command', 'git_status', 'git_log'])
      }
    };
    const ctxRestricted = resolveExecutionContext(globalDevPolicy, clientRestricted);
    assert.strictEqual(ctxRestricted.isRestrictedExecution, true, 'Client with trabajo_restringido must yield isRestrictedExecution=true');
    assert.strictEqual(ctxRestricted.effectiveProfile, 'trabajo_restringido');

    const clientDev = {
      clientId: 'client-dev',
      clientPolicy: {
        profile: 'developer',
        allowedRoots: [tempDir],
        allowedTools: new Set(['run_command'])
      }
    };
    const ctxDev = resolveExecutionContext(globalDevPolicy, clientDev);
    assert.strictEqual(ctxDev.isRestrictedExecution, false, 'Client with developer must yield isRestrictedExecution=false under developer global policy');

    const globalRestrictedPolicy = createAccessPolicy({
      allowedRoots: [tempDir],
      profile: 'trabajo_restringido',
      allowedProfileTools: new Set(['run_command'])
    });
    const ctxGlobalRestricted = resolveExecutionContext(globalRestrictedPolicy, clientDev);
    assert.strictEqual(ctxGlobalRestricted.isRestrictedExecution, true, 'Global trabajo_restringido must force isRestrictedExecution=true even if client is developer');

    // Case 1B: ToolExecutorCore enforces restricted execution for restricted client under global developer
    const executor = new ToolExecutorCore({
      allowedRoots: [tempDir],
      accessPolicy: globalDevPolicy
    });

    // Initialise git repo fixture for benign git read
    const repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir);
    spawnSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 'TestUser'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello git');
    spawnSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: repoDir, stdio: 'pipe' });

    // Git benign read in restricted client
    const gitRes = await executor.executeTool(
      'git_command',
      { repo: repoDir, args: ['status'] },
      clientRestricted
    );
    assert(gitRes && gitRes.content, 'Benign git_command must return content: ' + JSON.stringify(gitRes));

    // tmux_* blocked under restricted client
    await assert.rejects(async () => {
      await executor.executeTool(
        'tmux_new_session',
        { sessionName: 'restricted-session' },
        clientRestricted
      );
    }, /no est[aá] disponible en perfil restringido|perfil restringido|está bloqueada/i);

    // Case 1C: Background jobs under restricted client
    const jobStartRes = await executor.executeTool(
      'job_start',
      { command: 'echo "job-test-success"', cwd: tempDir },
      clientRestricted
    );
    const jobStartData = JSON.parse(jobStartRes.content[0].text);
    const jobId = jobStartData.jobId;
    assert(jobId, 'jobId should be returned');

    // Wait briefly for job to complete
    await new Promise(r => setTimeout(r, 300));

    const jobOutRes = await executor.executeTool(
      'job_output',
      { jobId },
      clientRestricted
    );
    const jobOutData = JSON.parse(jobOutRes.content[0].text);
    assert(jobOutData.output.includes('job-test-success'), 'output should contain job output: ' + JSON.stringify(jobOutData));

    // Case 1D: Direct MCPFileServer (HTTP/stdio) without IPC
    const server = new MCPFileServer();
    server.accessPolicy = globalDevPolicy;
    server.allowedRoots = [tempDir];

    // Directly calling tmux tool with clientRestricted should be blocked
    await assert.rejects(async () => {
      await server.callTool(
        'tmux_new_session',
        { sessionName: 'srv-tmux' },
        clientRestricted
      );
    }, /bloqueada por el perfil|no est[aá] disponible en perfil restringido|estrictamente denegada/i);

    // Direct run_command with shell: true must be rejected for restricted client
    await assert.rejects(async () => {
      await server.callTool(
        'run_command',
        { command: 'echo test', shell: true },
        clientRestricted
      );
    }, /shell(:true)? est[aá] estrictamente denegada/i);

    console.log('   [PASS] Effective profile per client verified cleanly');
  } finally {
    removeTempDir(tempDir);
  }
}

// -----------------------------------------------------------------------------
// Test 2: Control total con raíz `/` y coherencia de permisos
// -----------------------------------------------------------------------------
async function test2_RootSlashAndFullAccess() {
  console.log('-> Test 2: Control total con raíz `/` y coherencia de permisos');
  const tempDir = createTempDir('mcp-v5-test2-');

  try {
    const testFile = path.join(tempDir, 'sub', 'file.txt');
    fs.mkdirSync(path.join(tempDir, 'sub'), { recursive: true });
    fs.writeFileSync(testFile, 'root test content');

    // 2A: validatePathWithinRoots with root '/' must accept normal paths
    const validated = validatePathWithinRoots(testFile, ['/'], { allowSensitive: true });
    assert.strictEqual(validated, path.resolve(testFile), 'Root / must accept valid paths when allowSensitive=true');

    // Subdirectories and new non-existent target files under '/'
    const newFile = path.join(tempDir, 'sub', 'newfile.txt');
    const validatedNew = validatePathWithinRoots(newFile, ['/'], { allowSensitive: true });
    assert.strictEqual(validatedNew, path.resolve(newFile));

    // Symlinks pointing within root '/'
    const symlinkTarget = path.join(tempDir, 'symlink.txt');
    fs.symlinkSync(testFile, symlinkTarget);
    const validatedSymlink = validatePathWithinRoots(symlinkTarget, ['/'], { allowSensitive: true });
    assert.strictEqual(validatedSymlink, path.resolve(testFile));

    // 2B: Server control plane must remain protected even with root '/' and allowSensitive: true
    const serverRoot = path.resolve(__dirname, '..');
    const serverTokenPath = path.join(serverRoot, 'mcp.token');
    const serverApprovalsPath = path.join(serverRoot, '.runtime', 'approvals.json');
    const serverCodePath = path.join(serverRoot, 'lib', 'sandbox.js');

    assert(isServerControlPlaneFile(serverTokenPath), 'mcp.token is server control plane');
    assert(isServerControlPlaneFile(serverApprovalsPath), 'approvals.json is server control plane');
    assert(isServerControlPlaneFile(serverCodePath), 'lib/sandbox.js is server control plane');

    // Mutation of server control plane must fail even with root '/'
    assert.throws(() => {
      validatePathWithinRoots(serverTokenPath, ['/'], {
        allowSensitive: true,
        isWriteOperation: true
      });
    }, /archivo de control del servidor MCP/i);

    assert.throws(() => {
      validatePathWithinRoots(serverCodePath, ['/'], {
        allowSensitive: true,
        isWriteOperation: true
      });
    }, /archivo de control del servidor MCP/i);

    // 2C: ToolExecutorCore with isFullAccess
    const fullAccessPolicy = createAccessPolicy({
      allowedRoots: ['/'],
      profile: 'administrator'
    });
    const fullExecutor = new ToolExecutorCore({
      allowedRoots: ['/'],
      accessPolicy: fullAccessPolicy
    });

    // Reading a normal sensitive path (e.g. in tempDir) is permitted in full access
    const readRes = await fullExecutor.executeTool(
      'read_file',
      { path: testFile },
      { clientId: 'admin-client', isFullAccess: true }
    );
    const readData = JSON.parse(readRes.content[0].text);
    assert.strictEqual(readData.content, 'root test content');

    // Writing to server control plane file in full access is blocked
    await assert.rejects(async () => {
      await fullExecutor.executeTool(
        'write_file',
        { path: serverTokenPath, content: 'tampered-token' },
        { clientId: 'admin-client', isFullAccess: true }
      );
    }, /archivo de control del servidor MCP/i);

    // Direct MCPFileServer behaves identically
    const server = new MCPFileServer();
    server.accessPolicy = fullAccessPolicy;
    server.allowedRoots = ['/'];

    const srvReadRes = await server.callTool(
      'read_file',
      { path: testFile },
      { clientId: 'admin-client', isFullAccess: true }
    );
    assert(!srvReadRes.isError, 'Direct MCPFileServer read_file must succeed in full access');

    await assert.rejects(async () => {
      await server.callTool(
        'write_file',
        { path: serverTokenPath, content: 'tampered' },
        { clientId: 'admin-client', isFullAccess: true }
      );
    }, /archivo de control del servidor MCP/i);

    console.log('   [PASS] Root slash / and full access coherence verified');
  } finally {
    removeTempDir(tempDir);
  }
}

// -----------------------------------------------------------------------------
// Test 3: Protección de datos sensibles: fail-closed y robustez
// -----------------------------------------------------------------------------
async function test3_SensitiveDataFailClosed() {
  console.log('-> Test 3: Protección de datos sensibles: fail-closed y robustez');
  const tempDir = createTempDir('mcp-v5-test3-');

  try {
    // 3A: Directory tree with depth > 25 must throw error (fail-closed, no silent omit)
    let deepPath = path.join(tempDir, 'deep');
    fs.mkdirSync(deepPath);
    for (let i = 0; i < 28; i++) {
      deepPath = path.join(deepPath, `lvl${i}`);
      fs.mkdirSync(deepPath);
    }

    let depthErrorCaught = false;
    try {
      scanForMasking(tempDir);
    } catch (err) {
      depthErrorCaught = true;
      assert(/profundidad m[aá]xima analizable|depth limit exceeded|fallo cerrado/i.test(err.message),
        'Error should mention depth limit: ' + err.message);
    }
    assert.strictEqual(depthErrorCaught, true, 'scanForMasking must throw error when depth > 25');

    // 3B: Unreadable directory (EACCES) must throw error (fail-closed, no silent degradation)
    const unreadableDir = path.join(tempDir, 'unreadable_test');
    fs.mkdirSync(unreadableDir);
    const lockedSubdir = path.join(unreadableDir, 'locked');
    fs.mkdirSync(lockedSubdir);

    // Drop permissions
    fs.chmodSync(lockedSubdir, 0o000);

    let unreadableErrorCaught = false;
    try {
      scanForMasking(unreadableDir);
    } catch (err) {
      unreadableErrorCaught = true;
      assert(/no se pudo analizar el directorio|aislamiento de seguridad|fallo cerrado/i.test(err.message),
        'Error should explain masking verification failure: ' + err.message);
    } finally {
      // Restore permissions for cleanup
      fs.chmodSync(lockedSubdir, 0o700);
    }
    assert.strictEqual(unreadableErrorCaught, true, 'scanForMasking must throw error on unreadable directory');

    // 3C: Overlapping roots handling
    const parentDir = path.join(tempDir, 'overlap_parent');
    const childDir = path.join(parentDir, 'overlap_child');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(childDir, 'data.txt'), 'overlap data');

    // Verify isSubpathOrEqual handles overlapping roots properly
    assert.strictEqual(isSubpathOrEqual(childDir, parentDir), true);
    assert.strictEqual(isSubpathOrEqual(parentDir, childDir), false);
    assert.strictEqual(isSubpathOrEqual(parentDir, parentDir), true);

    console.log('   [PASS] Fail-closed masking and robustness verified');
  } finally {
    removeTempDir(tempDir);
  }
}

// -----------------------------------------------------------------------------
// Test 4: Desbloquear archivos normales de proyecto (package.json, lib/)
// -----------------------------------------------------------------------------
async function test4_UnblockNormalProjectFiles() {
  console.log('-> Test 4: Desbloquear archivos normales de proyecto (package.json, lib/)');
  const clientProjectDir = createTempDir('mcp-v5-client-project-');

  try {
    const pkgJson = path.join(clientProjectDir, 'package.json');
    const libDir = path.join(clientProjectDir, 'lib');
    const libFile = path.join(libDir, 'index.js');
    fs.mkdirSync(libDir);
    fs.writeFileSync(pkgJson, JSON.stringify({ name: 'client-app', version: '1.0.0' }));
    fs.writeFileSync(libFile, 'module.exports = "client-code";');

    // Generate bwrap sandbox command args
    const wrapped = wrapCommandInSandbox('cat', [pkgJson], {
      allowedRoots: [clientProjectDir]
    });

    const bwrapArgsStr = wrapped.args.join(' ');

    // 4A: Check that client's package.json and lib/ are NOT mounted --ro-bind
    assert(!bwrapArgsStr.includes(`--ro-bind ${pkgJson}`), 'Client package.json must NOT be mounted --ro-bind');
    assert(!bwrapArgsStr.includes(`--ro-bind ${libDir}`), 'Client lib directory must NOT be mounted --ro-bind');
    assert(!bwrapArgsStr.includes(`--ro-bind-try ${pkgJson}`), 'Client package.json must NOT be mounted --ro-bind-try');
    assert(!bwrapArgsStr.includes(`--ro-bind-try ${libDir}`), 'Client lib directory must NOT be mounted --ro-bind-try');

    // 4B: Check that client project dir is mounted --bind (RW)
    assert(bwrapArgsStr.includes(`--bind ${clientProjectDir} ${clientProjectDir}`),
      'Client project directory must be mounted RW --bind');

    // 4C: If bwrap is available, test executing a write to package.json and lib/ in client project
    const isoCaps = detectOsIsolationCapabilities();
    if (isoCaps.bubblewrap) {
      // Modify package.json inside bwrap
      const editWrapped = wrapCommandInSandbox('node', [
        '-e',
        `const fs = require('fs');
         const pkg = JSON.parse(fs.readFileSync('${pkgJson}', 'utf8'));
         pkg.version = '1.0.1';
         fs.writeFileSync('${pkgJson}', JSON.stringify(pkg, null, 2));
         fs.writeFileSync('${libFile}', 'module.exports = "updated-code";');`
      ], {
        allowedRoots: [clientProjectDir]
      });

      const res = spawnSync(editWrapped.command, editWrapped.args, { stdio: 'pipe' });
      assert.strictEqual(res.status, 0, 'Command modifying client package.json and lib/ in bwrap must exit 0. Stderr: ' + res.stderr.toString());

      // Verify files were modified
      const updatedPkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      assert.strictEqual(updatedPkg.version, '1.0.1', 'Client package.json should be successfully modified');
      const updatedLib = fs.readFileSync(libFile, 'utf8');
      assert.strictEqual(updatedLib, 'module.exports = "updated-code";', 'Client lib/index.js should be successfully modified');
    } else {
      console.log('   (Skipping live bwrap write test: bwrap not available on host)');
    }

    console.log('   [PASS] Client project normal files unlocked cleanly');
  } finally {
    removeTempDir(clientProjectDir);
  }
}

// -----------------------------------------------------------------------------
// Test 5: Límites de recursos (CPU, Memoria, Procesos)
// -----------------------------------------------------------------------------
async function test5_ResourceLimits() {
  console.log('-> Test 5: Límites de recursos (CPU, Memoria, Procesos)');

  // 5A: Detection
  const caps = detectResourceLimitsCapabilities();
  assert(typeof caps === 'object');
  assert(Array.isArray(caps.availableBackends));
  assert(typeof caps.systemdScope === 'boolean');
  assert(typeof caps.prlimit === 'boolean');
  console.log('   Resource limits capabilities detected:', caps);

  // 5B: Configuration parsing
  const mockEnv = {
    MCP_CPU_LIMIT: '50%',
    MCP_MEMORY_LIMIT: '512M',
    MCP_PROCESS_LIMIT: '100',
    MCP_RESOURCE_LIMITS_BACKEND: 'auto'
  };
  const config = getResourceLimitsConfig(mockEnv);
  assert.strictEqual(config.cpuLimit, '50%');
  assert.strictEqual(config.memoryLimit, '512M');
  assert.strictEqual(config.processLimit, '100');

  // 5C: Apply limits with systemd backend
  const systemdOptions = {
    ...mockEnv,
    MCP_RESOURCE_LIMITS_BACKEND: 'systemd'
  };
  if (caps.systemdScope) {
    const systemdWrapped = applyResourceLimits('echo', ['test-systemd'], systemdOptions, {});
    assert.strictEqual(systemdWrapped.command, 'systemd-run');
    const argsStr = systemdWrapped.args.join(' ');
    assert(argsStr.includes('--user'));
    assert(argsStr.includes('--scope'));
    assert(argsStr.includes('MemoryMax=536870912'));
    assert(argsStr.includes('CPUQuota=50%'));
    assert(argsStr.includes('TasksMax=100'));
  } else {
    assert.throws(() => applyResourceLimits('echo', [], systemdOptions, {}), /Fallo cerrado/);
  }

  // 5D: Apply limits with prlimit backend
  const prlimitOptions = {
    ...mockEnv,
    MCP_CPU_LIMIT: '60',
    MCP_RESOURCE_LIMITS_BACKEND: 'prlimit'
  };
  if (caps.prlimit) {
    const prlimitWrapped = applyResourceLimits('echo', ['test-prlimit'], prlimitOptions, {});
    assert(prlimitWrapped.command.includes('prlimit'));
    const prArgsStr = prlimitWrapped.args.join(' ');
    assert(prArgsStr.includes('--nproc=100'));
    assert(prArgsStr.includes('--as=536870912')); // 512M in bytes
    assert(prlimitWrapped.args.includes('--cpu=60'));
    const processOnly = applyResourceLimits('/bin/true', [], { MCP_PROCESS_LIMIT: '100' }, { MCP_RESOURCE_LIMITS_BACKEND: 'prlimit' });
    assert(processOnly.args.includes('--nproc=100'));
    const live = spawnSync(prlimitWrapped.command, prlimitWrapped.args, { encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(live.status, 0, live.stderr);
    assert(live.stdout.includes('test-prlimit'));
  } else {
    assert.throws(() => applyResourceLimits('echo', [], prlimitOptions, {}), /Fallo cerrado/);
  }

  for (const key of ['MCP_CPU_LIMIT', 'MCP_MEMORY_LIMIT', 'MCP_PROCESS_LIMIT']) {
    for (const value of ['invalid', '0', '-1', 'Infinity', '12garbage', '9007199254740992', 0]) {
      assert.throws(() => applyResourceLimits('/bin/true', [], {}, {
        MCP_RESOURCE_LIMITS_BACKEND: 'prlimit', MCP_REQUIRE_RESOURCE_LIMITS: '1', [key]: value
      }), /Invalid resource limit/, `${key}=${value} must be rejected`);
    }
  }
  for (const [backend, cpu] of [['prlimit', '50%'], ['systemd', '60']]) {
    assert.throws(() => applyResourceLimits('/bin/true', [], {}, {
      MCP_RESOURCE_LIMITS_BACKEND: backend, MCP_CPU_LIMIT: cpu
    }), /incompatible/);
  }
  assert.throws(() => getResourceLimitsConfig({ MCP_RESOURCE_LIMITS_BACKEND: 'typo' }), /Invalid resource limit/);
  assert.throws(() => applyResourceLimits('/bin/true', [], {}, {
    MCP_RESOURCE_LIMITS_BACKEND: 'none', MCP_MEMORY_LIMIT: '512M'
  }), /Fallo cerrado/);
  assert.strictEqual(getResourceLimitsConfig({ MCP_CPU_LIMIT: '50%' }).backend, caps.systemdScope ? 'systemd' : 'none');
  assert.strictEqual(getResourceLimitsConfig({ MCP_CPU_LIMIT: '60' }).backend, caps.prlimit ? 'prlimit' : 'none');
  assert.strictEqual(getResourceLimitsConfig({ MCP_MEMORY_LIMIT: '1.5G' }).memoryBytes, 1610612736);
  assert.strictEqual(applyResourceLimits('/bin/true', [], {}, {}).resourceLimitsApplied, false);

  // 5E: Fail-closed verification
  let failClosedCaught = false;
  try {
    applyResourceLimits('echo', ['fail-test'], {
      MCP_REQUIRE_RESOURCE_LIMITS: '1',
      MCP_RESOURCE_LIMITS_BACKEND: 'none'
    });
  } catch (err) {
    failClosedCaught = true;
    assert(/l[ií]mites de recursos obligatorios|no hay backend compatible activo|resource limits required/i.test(err.message),
      'Error message should explain missing backend: ' + err.message);
  }
  assert.strictEqual(failClosedCaught, true, 'MCP_REQUIRE_RESOURCE_LIMITS=1 with backend=none must fail closed');

  // 5F: Live benign execution with detected backend
  if (caps.preferredBackend !== 'none') {
    const liveWrapped = applyResourceLimits('echo', ['resource-limits-live-ok'], {
      MCP_CPU_LIMIT: caps.preferredBackend === 'systemd' ? '50%' : '60',
      MCP_MEMORY_LIMIT: '512M',
      MCP_PROCESS_LIMIT: '100'
    });
    const res = spawnSync(liveWrapped.command, liveWrapped.args, { stdio: 'pipe' });
    assert.strictEqual(res.status, 0, 'Live execution with resource limits must succeed. Stderr: ' + res.stderr.toString());
    assert(res.stdout.toString().includes('resource-limits-live-ok'), 'Stdout must contain expected text');
  }

  // 5G: Diagnostics reporting
  const diag = await collectRuntimeStatus();
  assert(diag.isolation.fileIsolation, 'Runtime diagnostics must report fileIsolation');
  assert(diag.isolation.networkIsolation, 'Runtime diagnostics must report networkIsolation');
  assert(diag.isolation.resourceLimits, 'Runtime diagnostics must report resourceLimits');
  assert(typeof diag.isolation.resourceLimits.backend === 'string');

  console.log('   [PASS] Resource limits dual-engine and fail-closed verified');
}

async function runAll() {
  console.log('====================================================');
  console.log('RUNNING REGRESSION TEST SUITE: CORRECCIONES V5');
  console.log('====================================================');

  await test1_EffectiveProfilePerClient();
  await test2_RootSlashAndFullAccess();
  await test3_SensitiveDataFailClosed();
  await test4_UnblockNormalProjectFiles();
  await test5_ResourceLimits();

  console.log('====================================================');
  console.log('ALL V5 REGRESSION TESTS PASSED CLEANLY');
  console.log('====================================================');
}

runAll().catch(err => {
  console.error('\n[FATAL TEST FAILURE]:', err);
  process.exit(1);
});
