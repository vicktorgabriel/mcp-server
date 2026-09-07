#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { JobManager } = require('../lib/job-manager');

async function testJobLifecycleAndOutput() {
  const manager = new JobManager();

  // 1. Start short-lived job
  const jobInfo = manager.startJob({
    clientId: 'client-1',
    command: 'node',
    args: ['-e', 'console.log("LINE1"); console.log("LINE2"); console.log("LINE3");']
  });

  assert.ok(jobInfo.jobId);
  assert.equal(jobInfo.status, 'running');
  assert.ok(jobInfo.pid > 0);

  // Wait for it to complete
  let finished = false;
  for (let i = 0; i < 40; i++) {
    const status = manager.getJob(jobInfo.jobId, 'client-1');
    if (status.status === 'completed') {
      finished = true;
      assert.equal(status.exitCode, 0);
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(finished, 'Job should complete successfully');

  // 2. Read full output
  const fullOutput = manager.getJobOutput(jobInfo.jobId, 'client-1');
  assert.ok(fullOutput.output.includes('LINE1'));
  assert.ok(fullOutput.output.includes('LINE2'));
  assert.ok(fullOutput.output.includes('LINE3'));
  assert.equal(fullOutput.status, 'completed');

  // 3. Paginated output (offset and limit)
  const pagedOutput = manager.getJobOutput(jobInfo.jobId, 'client-1', 0, 5);
  assert.equal(pagedOutput.offset, 0);
  assert.equal(pagedOutput.limit, 5);
  assert.equal(pagedOutput.bytesRead, 5);
}

async function testClientOwnershipIsolation() {
  const manager = new JobManager();

  // Client A starts a job
  const jobInfo = manager.startJob({
    clientId: 'client-A',
    command: 'node',
    args: ['-e', 'setTimeout(() => {}, 2000)']
  });

  try {
    // Client B attempts to get status
    assert.throws(() => {
      manager.getJob(jobInfo.jobId, 'client-B');
    }, /Acceso denegado.*pertenece a otro cliente/i);

    // Client B attempts to read output
    assert.throws(() => {
      manager.getJobOutput(jobInfo.jobId, 'client-B');
    }, /Acceso denegado.*pertenece a otro cliente/i);

    // Client B attempts to cancel job
    assert.throws(() => {
      manager.cancelJob(jobInfo.jobId, 'client-B');
    }, /Acceso denegado.*pertenece a otro cliente/i);

    // Client B listJobs should NOT list Client A's job
    const listB = manager.listJobs('client-B');
    assert.equal(listB.some(j => j.jobId === jobInfo.jobId), false);

    // Client A listJobs DOES list it
    const listA = manager.listJobs('client-A');
    assert.equal(listA.some(j => j.jobId === jobInfo.jobId), true);

  } finally {
    manager.cancelJob(jobInfo.jobId, 'client-A');
  }
}

async function testJobCancellation() {
  const manager = new JobManager();

  // Start long running job
  const jobInfo = manager.startJob({
    clientId: 'client-cancel',
    command: 'sleep',
    args: ['30']
  });

  assert.equal(jobInfo.status, 'running');

  // Cancel job
  const cancelRes = manager.cancelJob(jobInfo.jobId, 'client-cancel');
  assert.equal(cancelRes.status, 'canceled');
  assert.ok(cancelRes.finishedAt > 0);

  // Status must be canceled
  const status = manager.getJob(jobInfo.jobId, 'client-cancel');
  assert.equal(status.status, 'canceled');
}

async function testOutputTruncationLimit() {
  const manager = new JobManager();

  // Start job with small output buffer limit (50 bytes)
  const jobInfo = manager.startJob({
    clientId: 'client-limit',
    command: 'node',
    args: ['-e', 'console.log("X".repeat(500))'],
    maxOutputBytes: 50
  });

  // Wait for finish
  for (let i = 0; i < 40; i++) {
    const s = manager.getJob(jobInfo.jobId, 'client-limit');
    if (s.status === 'completed') break;
    await new Promise(r => setTimeout(r, 50));
  }

  const out = manager.getJobOutput(jobInfo.jobId, 'client-limit');
  assert.ok(out.output.includes('Salida truncada') || out.totalBytes <= 200, 'Output should be bounded');
}

async function testPauseResumeAndStopAll() {
  const manager = new JobManager();

  // Pause
  manager.pauseNewJobs();
  assert.equal(manager.isPaused(), true);

  // Attempt to start new job while paused must fail
  assert.throws(() => {
    manager.startJob({ clientId: 'test', command: 'echo', args: ['hi'] });
  }, /pausa administrativa/i);

  // Resume
  manager.resumeJobs();
  assert.equal(manager.isPaused(), false);

  // Start two jobs
  const j1 = manager.startJob({ clientId: 't1', command: 'sleep', args: ['10'] });
  const j2 = manager.startJob({ clientId: 't2', command: 'sleep', args: ['10'] });

  assert.equal(manager.getJob(j1.jobId, 't1').status, 'running');
  assert.equal(manager.getJob(j2.jobId, 't2').status, 'running');

  // Stop all jobs
  const stopped = manager.stopAllJobs();
  assert.equal(stopped.length, 2);

  assert.equal(manager.getJob(j1.jobId, 't1').status, 'canceled');
  assert.equal(manager.getJob(j2.jobId, 't2').status, 'canceled');
}

async function run() {
  await testJobLifecycleAndOutput();
  await testClientOwnershipIsolation();
  await testJobCancellation();
  await testOutputTruncationLimit();
  await testPauseResumeAndStopAll();
  process.stdout.write('jobs_management=OK\n');
}

run().catch((err) => {
  console.error('Jobs management test failed:', err);
  process.exit(1);
});
