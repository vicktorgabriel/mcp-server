'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB

function computeJobContentHash(command, args = [], cwd = '', env = {}, timeout = 60000, output = MAX_OUTPUT_BYTES) {
  const key = JSON.stringify([command, args, cwd, Object.entries(env).sort(([a], [b]) => a.localeCompare(b)), timeout, output]);
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

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

  startJob({ clientId, command, args = [], cwd = process.cwd(), env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES, idempotencyKey = null }) {
    if (this.isPaused()) {
      throw new Error('El servidor MCP se encuentra en pausa administrativa. No se aceptan nuevos trabajos.');
    }

    if (!command || typeof command !== 'string') {
      throw new Error('El comando debe ser un string no vacío.');
    }

    if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('Argumentos invalidos.');
    const cleanClientId = String(clientId || 'unknown');
    const timeout = Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), 600000);
    const maxOutput = Math.min(Math.max(16, Number(maxOutputBytes) || MAX_OUTPUT_BYTES), 10 * 1024 * 1024);
    const contentHash = computeJobContentHash(command, args, cwd, env, timeout, maxOutput);
    const cleanIdempotencyKey = idempotencyKey === null || idempotencyKey === undefined ? null : String(idempotencyKey).trim();
    if (cleanIdempotencyKey !== null && (!cleanIdempotencyKey || cleanIdempotencyKey.length > 200)) throw new Error('Clave de idempotencia invalida.');
    for (const [id, previous] of this.jobs) {
      if (previous.finishedAt && Date.now() - previous.finishedAt > 10 * 60 * 1000) { this.jobs.delete(id); continue; }
      if (cleanIdempotencyKey && previous.clientId === cleanClientId && previous.idempotencyKey === cleanIdempotencyKey) {
        if (previous.contentHash !== contentHash) throw new Error('Conflicto de idempotencia: la clave corresponde a otro contenido.');
        return { jobId: previous.jobId, pid: previous.pid, status: previous.status, startedAt: previous.startedAt, reconnected: true };
      }
    }
    if (this.jobs.size >= 256 || [...this.jobs.values()].filter(j => j.status === 'running').length >= 32) throw new Error('Limite de trabajos alcanzado; espere o cancele trabajos propios.');
    const jobId = 'job_' + crypto.randomBytes(8).toString('hex');

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

    const now = Date.now();
    const job = {
      jobId,
      clientId: cleanClientId,
      command,
      args,
      cwd,
      pid: child.pid,
      idempotencyKey: cleanIdempotencyKey,
      contentHash,
      startedAt: now,
      finishedAt: null,
      lastActivityAt: now,
      status: 'running',
      exitCode: null,
      signal: null,
      outputChunks: [],
      outputBytes: 0,
      outputTruncated: false,
      outputLinesCount: 0,
      maxOutputBytes: maxOutput,
      timeoutMs: timeout,
      timeoutHandle: null
    };

    const appendOutput = (data) => {
      job.lastActivityAt = Date.now();
      const text = data.toString('utf8');
      job.outputLinesCount += (text.match(/\n/g) || []).length;
      if (job.outputBytes >= job.maxOutputBytes) { job.outputTruncated = true; return; }
      const remaining = job.maxOutputBytes - job.outputBytes;
      const chunk = data.length > remaining ? data.subarray(0, remaining) : data;
      job.outputChunks.push(chunk);
      job.outputBytes += chunk.length;
      if (data.length > remaining) job.outputTruncated = true;
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

  _killProcessGroup(pid, signal = 'SIGKILL') {
    const value = Number(pid);
    if (!Number.isSafeInteger(value) || value <= 1) return;
    // Only the group created by our detached spawn; never enumerate/signal foreign PIDs.
    try { process.kill(process.platform === 'win32' ? value : -value, signal); } catch (_) {}
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
      outputTruncated: Boolean(job.outputTruncated),
      command: job.command,
      progress: {
        bytesRead: job.outputBytes,
        linesCount: job.outputLinesCount || 0,
        lastActivityAt: job.lastActivityAt || job.startedAt,
        durationMs
      }
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

  tailJobOutput(jobId, clientId, options = {}) {
    const job = this.jobs.get(jobId);
    this._assertOwnership(job, clientId);
    const buffer = Buffer.concat(job.outputChunks);
    const offset = Math.max(0, Math.trunc(Number(options.fromOffset) || 0));
    const limit = Math.max(4, Math.min(Math.trunc(Number(options.limit) || 65536), 1024 * 1024));
    if (!Number.isSafeInteger(offset) || offset > buffer.length) throw new Error('Cursor fuera de rango.');
    if (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) throw new Error('Cursor debe estar en un limite UTF-8.');
    let end = Math.min(buffer.length, offset + limit);
    while (end > offset && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
    if (options.lineLimit !== undefined) {
      const maxLines = Math.max(1, Math.min(5000, Math.trunc(Number(options.lineLimit) || 1)));
      let lines = 0;
      for (let i = offset; i < end; i++) if (buffer[i] === 10 && ++lines === maxLines) { end = i + 1; break; }
    }
    const slice = buffer.subarray(offset, end);
    return { jobId, status: job.status, output: slice.toString('utf8'), outputBase64: slice.toString('base64'), fromOffset: offset, nextOffset: end, bytesRead: slice.length, totalBytes: buffer.length, hasMore: end < buffer.length, truncated: Boolean(job.outputTruncated), linesRead: (slice.toString('utf8').match(/\n/g) || []).length };
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
    this._killProcessGroup(job.pid, 'SIGKILL');

    return {
      ok: true,
      jobId,
      status: 'canceled',
      finishedAt: job.finishedAt,
      message: 'Señal de cancelación enviada al árbol de procesos.'
    };
  }

  listJobs(clientId, options = {}) {
    const expected = String(clientId || 'unknown');
    const statusFilter = (options && options.status && options.status !== 'all') ? options.status : null;
    const limit = options && options.limit ? Math.max(1, Math.min(Number(options.limit), 200)) : 50;
    const offset = options && options.offset ? Math.max(0, Number(options.offset)) : 0;

    const list = [];
    for (const job of this.jobs.values()) {
      if (job.clientId === expected) {
        if (!statusFilter || job.status === statusFilter) {
          list.push({
            jobId: job.jobId,
            command: job.command,
            args: job.args,
            status: job.status,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            durationMs: (job.finishedAt || Date.now()) - job.startedAt,
            exitCode: job.exitCode,
            outputBytes: job.outputBytes
          });
        }
      }
    }
    list.sort((a, b) => b.startedAt - a.startedAt);
    const paginated = (options && (options.limit !== undefined || options.offset !== undefined))
      ? list.slice(offset, offset + limit)
      : list;

    return paginated;
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
