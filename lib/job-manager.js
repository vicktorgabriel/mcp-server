'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB

class JobManager {
  constructor(options = {}) {
    this.jobs = new Map();
    this.paused = false;
    this.pauseFilePath = (options && options.pauseFilePath)
      || process.env.MCP_PAUSE_FILE
      || path.resolve('.runtime/server-paused');
  }

  isPaused() {
    if (this.paused) return true;
    try {
      return fs.existsSync(this.pauseFilePath);
    } catch (_) {
      return false;
    }
  }

  setPaused(paused, reason = 'Pausa administrativa') {
    this.paused = Boolean(paused);
    try {
      if (this.paused) {
        fs.mkdirSync(path.dirname(this.pauseFilePath), { recursive: true });
        fs.writeFileSync(this.pauseFilePath, JSON.stringify({
          pausedAt: Date.now(),
          reason
        }, null, 2), 'utf8');
        this.stopAllJobs('Servidor MCP puesto en pausa administrativa.');
      } else {
        if (fs.existsSync(this.pauseFilePath)) {
          fs.unlinkSync(this.pauseFilePath);
        }
      }
    } catch (_) {}
  }

  pauseNewJobs(reason) {
    this.setPaused(true, reason);
  }

  resumeJobs() {
    this.setPaused(false);
  }

  startJob({ clientId, command, args = [], cwd = process.cwd(), env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES }) {
    if (this.paused) {
      throw new Error('El servidor MCP se encuentra en pausa administrativa. No se aceptan nuevos trabajos.');
    }

    if (!command || typeof command !== 'string') {
      throw new Error('El comando debe ser un string no vacío.');
    }

    const jobId = `job_${crypto.randomBytes(8).toString('hex')}`;
    const timeout = Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), 600000);
    const maxOutput = Math.min(Math.max(16, Number(maxOutputBytes) || MAX_OUTPUT_BYTES), 10 * 1024 * 1024);

    let child;
    try {
      // Detached allows process tree kill on POSIX
      child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      throw new Error(`No se pudo iniciar el proceso ${command}: ${err.message}`);
    }

    const job = {
      jobId,
      clientId: String(clientId || 'unknown'),
      command,
      args,
      cwd,
      pid: child.pid,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      signal: null,
      outputChunks: [],
      outputBytes: 0,
      maxOutputBytes: maxOutput,
      timeoutMs: timeout,
      timeoutHandle: null
    };

    const appendOutput = (data) => {
      if (job.outputBytes >= job.maxOutputBytes) return;
      const remaining = job.maxOutputBytes - job.outputBytes;
      const chunk = data.length > remaining ? data.subarray(0, remaining) : data;
      job.outputChunks.push(chunk);
      job.outputBytes += chunk.length;
      if (job.outputBytes >= job.maxOutputBytes) {
        job.outputChunks.push(Buffer.from('\n[Salida truncada: límite de tamaño alcanzado]\n', 'utf8'));
      }
    };

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);

    // Timeout killer
    job.timeoutHandle = setTimeout(() => {
      if (job.status === 'running') {
        job.status = 'timed_out';
        this._killProcessGroup(child.pid, 'SIGKILL');
      }
    }, timeout);

    child.on('close', (code, sig) => {
      clearTimeout(job.timeoutHandle);
      job.finishedAt = Date.now();
      if (job.status === 'running') {
        job.status = code === 0 ? 'completed' : 'failed';
      }
      job.exitCode = code;
      job.signal = sig;
    });

    child.on('error', (err) => {
      clearTimeout(job.timeoutHandle);
      job.finishedAt = Date.now();
      job.status = 'failed';
      job.error = err.message;
    });

    this.jobs.set(jobId, job);
    return {
      jobId,
      pid: child.pid,
      status: job.status,
      startedAt: job.startedAt
    };
  }

  _killProcessGroup(pid, signal = 'SIGTERM') {
    if (!pid) return;
    try {
      if (process.platform !== 'win32') {
        // Kill whole process group
        process.kill(-pid, signal);
      } else {
        process.kill(pid, signal);
      }
    } catch (_) {
      try { process.kill(pid, signal); } catch (_) {}
    }
  }

  _assertOwnership(job, clientId) {
    if (!job) throw new Error('Trabajo no encontrado.');
    const expected = String(clientId || 'unknown');
    if (job.clientId !== expected) {
      throw new Error('Acceso denegado: este trabajo pertenece a otro cliente MCP.');
    }
  }

  getJob(jobId, clientId) {
    const job = this.jobs.get(jobId);
    this._assertOwnership(job, clientId);
    const durationMs = (job.finishedAt || Date.now()) - job.startedAt;
    return {
      jobId: job.jobId,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs,
      exitCode: job.exitCode,
      signal: job.signal,
      outputBytes: job.outputBytes,
      command: job.command
    };
  }

  getJobOutput(jobId, clientId, offset = 0, limit = 65536) {
    const job = this.jobs.get(jobId);
    this._assertOwnership(job, clientId);

    const fullBuffer = Buffer.concat(job.outputChunks);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 65536, 1024 * 1024));

    const slice = fullBuffer.subarray(safeOffset, safeOffset + safeLimit);
    const text = slice.toString('utf8');

    return {
      jobId: job.jobId,
      status: job.status,
      offset: safeOffset,
      limit: safeLimit,
      length: slice.length,
      bytesRead: slice.length,
      totalBytes: fullBuffer.length,
      hasMore: safeOffset + slice.length < fullBuffer.length,
      output: text
    };
  }

  cancelJob(jobId, clientId) {
    const job = this.jobs.get(jobId);
    this._assertOwnership(job, clientId);

    if (job.status !== 'running') {
      return { ok: false, message: `El trabajo ya no está en ejecución (estado: ${job.status}).` };
    }

    job.status = 'canceled';
    job.finishedAt = Date.now();
    clearTimeout(job.timeoutHandle);
    this._killProcessGroup(job.pid, 'SIGTERM');

    setTimeout(() => {
      this._killProcessGroup(job.pid, 'SIGKILL');
    }, 2000).unref();

    return {
      ok: true,
      jobId,
      status: 'canceled',
      finishedAt: job.finishedAt,
      message: 'Señal de cancelación enviada al árbol de procesos.'
    };
  }

  listJobs(clientId) {
    const expected = String(clientId || 'unknown');
    const list = [];
    for (const job of this.jobs.values()) {
      if (job.clientId === expected) {
        list.push({
          jobId: job.jobId,
          command: job.command,
          status: job.status,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          exitCode: job.exitCode
        });
      }
    }
    return list;
  }

  stopAllJobs(reason = 'Parada de emergencia') {
    const stopped = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        job.status = 'canceled';
        job.finishedAt = Date.now();
        job.cancelReason = reason;
        clearTimeout(job.timeoutHandle);
        this._killProcessGroup(job.pid, 'SIGKILL');
        stopped.push(job.jobId);
      }
    }
    return stopped;
  }
}

module.exports = {
  JobManager,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES
};
