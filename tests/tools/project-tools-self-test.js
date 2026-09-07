#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-project-test-'));
const originalCwd = process.cwd();
process.chdir(temp);
process.env.MCP_CLIENT_POLICIES_STORE = path.join(temp, 'private', 'policies.json');
process.env.MCP_BACKUPS_DIR = path.join(temp, 'private', 'backups');
process.env.MCP_PAUSE_FILE = path.join(temp, 'paused');
process.env.MCP_TEST_ALLOW_ROOT_FLAG = '1';
process.env.MCP_RUN_AS_ROOT = '0';
process.env.MCP_TOOL_APPROVALS = '';
process.env.MCP_DIAGNOSTIC_PORTS = '';
process.env.MCP_DIAGNOSTIC_SERVICES = '';
const { createExtendedTools } = require('../../lib/extended-tools');
const { JobManager } = require('../../lib/job-manager');
const { createAccessPolicy, BlockHistoryRecorder, TOOL_REQUIREMENTS } = require('../../lib/access-policy');
const { validatePathWithinRoots } = require('../../lib/sandbox');
const root = path.join(temp, 'project');
fs.mkdirSync(root);
const jobs = new JobManager();
const policy = createAccessPolicy({ MCP_ACCESS_PROFILE: 'developer', MCP_CLIENT_POLICIES_STORE: process.env.MCP_CLIENT_POLICIES_STORE });
const tools = createExtendedTools({
  allowedRoots: [root], accessPolicy: policy, jobManager: jobs,
  resolvePath: (p, options = {}) => ({ fullPath: validatePathWithinRoots(path.resolve(root, p), [root], options), displayPath: p }),
  buildToolMetadata: title => ({ title }), textResult: data => data
});
const a = { clientId: 'client-a', isRestrictedExecution: false };
const b = { clientId: 'client-b', isRestrictedExecution: false };
const call = (name, args, context = a) => tools.callTool(name, args, context);
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
async function waitJob(id) {
  for (let i = 0; i < 100; i++) {
    const state = jobs.getJob(id, a.clientId);
    if (state.status !== 'running') return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Job did not finish');
}
async function main() {
  fs.writeFileSync(path.join(root, 'code.js'), 'function hello() { return 1; }\n', { mode: 0o640 });
  const patches = [{ search: 'return 1', replace: 'return 2' }];
  await assert.rejects(call('patch_apply', { path: 'code.js', patches }), /expectedHash/);
  const before = fs.readFileSync(path.join(root, 'code.js'), 'utf8');
  const preview = await call('patch_preview', { path: 'code.js', patches });
  assert.equal(preview.originalHash, hash(before));
  assert.equal(fs.readFileSync(path.join(root, 'code.js'), 'utf8'), before);
  await assert.rejects(call('patch_apply', { path: 'code.js', patches, expectedHash: '0'.repeat(64) }), /conflict|Conflicto/);
  const edited = await call('patch_apply', { path: 'code.js', patches, expectedHash: preview.originalHash });
  assert.equal(edited.newHash, preview.modifiedHash);
  assert.equal(fs.statSync(path.join(root, 'code.js')).mode & 0o777, 0o640);
  await assert.rejects(call('file_restore_safe', { path: 'code.js', backupId: edited.backupId }, b));
  fs.writeFileSync(path.join(root, 'another.js'), 'unrelated');
  await assert.rejects(call('file_restore_safe', { path: 'another.js', backupId: edited.backupId }));
  const after = fs.readFileSync(path.join(root, 'code.js'), 'utf8');
  fs.writeFileSync(path.join(root, 'code.js'), 'user edit');
  await assert.rejects(call('file_restore_safe', { path: 'code.js', backupId: edited.backupId, force: true }));
  await assert.rejects(call('file_restore_safe', { path: 'code.js', backupId: edited.backupId }), /conflict|Conflicto/);
  assert.equal(fs.readFileSync(path.join(root, 'code.js'), 'utf8'), 'user edit');
  fs.writeFileSync(path.join(root, 'code.js'), after);
  assert.equal((await call('file_restore_safe', { path: 'code.js', backupId: edited.backupId })).restored, true);
  assert.equal(fs.readFileSync(path.join(root, 'code.js'), 'utf8'), before);
  await assert.rejects(call('patch_preview', { path: 'code.js', patches: [{ search: '', replace: 'x' }] }));
  await assert.rejects(call('code_search_symbols', { path: '.', query: '(a+)+', isRegex: true }));
  const symbols = await call('code_search_symbols', { query: 'hello', limit: 1 });
  assert.equal(symbols.symbols[0].symbol, 'hello');
  fs.writeFileSync(path.join(temp, 'outside.json'), '{"dependencies":{"private-name":"secret"}}');
  fs.symlinkSync(path.join(temp, 'outside.json'), path.join(root, 'package.json'));
  await assert.rejects(call('project_dependency_map', { path: '.' }));
  fs.unlinkSync(path.join(root, 'package.json'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { alpha: '1' }, devDependencies: { beta: '2' }, scripts: { test: 'node -e "process.stdout.write(\'ok\')"' } }));
  const deps = await call('project_dependency_map', { includeDev: false });
  assert.equal(deps.directDependencies.alpha, '1');
  assert.deepEqual(deps.devDependencies, {});
  await assert.rejects(call('service_diagnostics', { checkPorts: [3000] }), /permit|allow/i);
  await assert.rejects(call('service_diagnostics', { checkServices: ['--help'] }));
  await assert.rejects(call('security_block_history', { clientId: 'client-b' }));
  const recorder = new BlockHistoryRecorder();
  recorder.record({ clientId: 'client-a', tool: 'x' });
  recorder.record({ clientId: 'admin', tool: 'y' });
  assert.equal(recorder.getHistory({ clientId: 'admin' }).totalCount, 1);
  assert.equal(recorder.getHistory({}).totalCount, 0);

  const args = { clientId: a.clientId, command: process.execPath, args: ['-e', 'console.log("job fixture")'], cwd: root, env: { PATH: process.env.PATH }, idempotencyKey: 'once' };
  const job = jobs.startJob(args);
  assert.equal(jobs.startJob(args).jobId, job.jobId);
  assert.throws(() => jobs.startJob({ ...args, args: ['-e', 'console.log("different")'] }), /idempotenc/i);
  assert.equal((await waitJob(job.jobId)).exitCode, 0);
  assert.equal(jobs.startJob(args).jobId, job.jobId, 'completed key must not execute again');
  assert.equal((await call('job_list_mine', { limit: 1 })).jobs[0].jobId, job.jobId);
  assert.equal((await call('job_list_mine', {}, b)).jobs.length, 0);
  await assert.rejects(call('job_tail_output', { jobId: job.jobId }, b));
  const owned = jobs.jobs.get(job.jobId);
  owned.outputChunks = [Buffer.from('a\u00e9\nsecond\n')];
  const tail1 = await call('job_tail_output', { jobId: job.jobId, lineLimit: 1, limit: 4 });
  const tail2 = await call('job_tail_output', { jobId: job.jobId, fromOffset: tail1.nextOffset });
  assert.equal(tail1.output + tail2.output, 'a\u00e9\nsecond\n');
  assert.equal(tail1.nextOffset, 4);
  const check = await call('project_test_runner', { runner: 'npm_test', cwd: '.' });
  assert.equal(check.success, true, JSON.stringify(check));
  assert.match(check.stdout, /ok/);
  assert.equal(policy.isAllowed('patch_apply', { clientId: 'client-a' }), true);
  policy.clientPolicyStore.setClientPolicy('client-a', { deniedTools: ['patch_apply'] });
  await assert.rejects(call('patch_apply', { path: 'code.js', patches, expectedHash: hash(before) }), /bloqueada/);
  const cli = spawnSync(process.execPath, [path.join(repo, 'access-policy-cli.js'), '--client', 'fixture', '--deny-tool', 'patch_apply'], { cwd: temp, env: process.env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const catalog = spawnSync(process.execPath, [path.join(repo, 'access-policy-cli.js'), '--catalog', '--json', '--client', 'fixture'], { cwd: temp, env: process.env, encoding: 'utf8' });
  assert.equal(catalog.status, 0, catalog.stderr);
  const data = JSON.parse(catalog.stdout);
  assert.equal(data.totalTools, Object.keys(TOOL_REQUIREMENTS).length);
  assert.equal(data.tools.find(t => t.name === 'patch_apply').status, 'BLOQUEADA');
  assert.equal(/\x1b\[/.test(catalog.stdout), false);
  console.log('project_tools_v4.6=OK');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  jobs.stopAllJobs(); process.chdir(originalCwd); fs.rmSync(temp, { recursive: true, force: true });
});
