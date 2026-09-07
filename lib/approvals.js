'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensurePrivateDirectory, applyPrivateOwnership } = require('./private-owner');

function defaultApprovalsPath() {
  return process.env.MCP_APPROVALS_STORE
    ? path.resolve(process.env.MCP_APPROVALS_STORE)
    : path.resolve('.runtime/approvals.json');
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(key => JSON.stringify(key) + ':' + canonicalJson(obj[key]));
  return '{' + pairs.join(',') + '}';
}

function cleanArgsForHash(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return args;
  }
  const cleaned = {};
  for (const [k, v] of Object.entries(args)) {
    if (['approvalId', '_approvalId', 'approval_id', 'confirm', '_confirm'].includes(k)) {
      continue;
    }
    cleaned[k] = v;
  }
  return cleaned;
}

function buildArgsSummary(tool, rawArgs) {
  const args = cleanArgsForHash(rawArgs) || {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return `${tool}(${JSON.stringify(args)})`;
  }
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return `${tool}()`;
  }
  const parts = [];
  const priorityKeys = ['action', 'path', 'command', 'cmd', 'file', 'target', 'name', 'service', 'package', 'rule'];
  const added = new Set();

  for (const key of priorityKeys) {
    if (key in args) {
      const val = args[key];
      const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
      const truncated = strVal.length > 80 ? strVal.slice(0, 77) + '...' : strVal;
      parts.push(`${key}=${JSON.stringify(truncated)}`);
      added.add(key);
    }
  }

  for (const [k, v] of entries) {
    if (added.has(k)) continue;
    let strVal;
    if (/(password|secret|token|credential|apiKey|private)/i.test(k)) {
      strVal = '***';
    } else if (typeof v === 'object') {
      strVal = JSON.stringify(v);
    } else {
      strVal = String(v);
    }
    const truncated = strVal.length > 50 ? strVal.slice(0, 47) + '...' : strVal;
    parts.push(`${k}=${truncated}`);
    if (parts.length >= 6) break;
  }

  return `${tool}(${parts.join(', ')})`;
}

function hashArgs(args) {
  const cleaned = cleanArgsForHash(args || {});
  const canonical = canonicalJson(cleaned);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

class ApprovalsManager {
  constructor(filePathOrOptions) {
    let filePath;
    if (typeof filePathOrOptions === 'object' && filePathOrOptions !== null) {
      filePath = filePathOrOptions.storePath || filePathOrOptions.filePath || defaultApprovalsPath();
    } else if (typeof filePathOrOptions === 'string') {
      filePath = filePathOrOptions;
    } else {
      filePath = defaultApprovalsPath();
    }
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this._ensureStore();
  }

  _ensureStore() {
    ensurePrivateDirectory(path.dirname(this.filePath), 0o700);
    if (!fs.existsSync(this.filePath)) {
      this._writeState({ version: 1, pending: {}, history: [] });
    }
  }

  _readState() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return { version: 1, pending: {}, history: [] };
      }
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (_) {
      return { version: 1, pending: {}, history: [] };
    }
  }

  _writeState(state) {
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    applyPrivateOwnership(this.filePath, 0o600);
  }

  /**
   * Atomic mutation helper using a file lock
   */
  _mutate(fn) {
    const start = Date.now();
    while (true) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          const state = this._readState();
          const result = fn(state);
          this._writeState(state);
          return result;
        } finally {
          fs.closeSync(fd);
          try { fs.unlinkSync(this.lockPath); } catch (_) {}
        }
      } catch (err) {
        if (err.code === 'EEXIST') {
          if (Date.now() - start > 5000) {
            // Break stale lock if older than 10s
            try {
              const stat = fs.statSync(this.lockPath);
              if (Date.now() - stat.mtimeMs > 10000) {
                fs.unlinkSync(this.lockPath);
              }
            } catch (_) {}
          }
          // spin wait
          const waitEnd = Date.now() + 10;
          while (Date.now() < waitEnd) {}
          continue;
        }
        throw err;
      }
    }
  }

  createPendingApproval({ clientId, tool, args, scope = 'tool_execution', policyVersion = '1', ttlMs = DEFAULT_TTL_MS }) {
    const id = `appr_${crypto.randomBytes(12).toString('hex')}`;
    const now = Date.now();
    const cleanArgs = cleanArgsForHash(args || {});
    const argsHash = hashArgs(cleanArgs);
    const summary = buildArgsSummary(tool, cleanArgs);

    const record = {
      id,
      approvalId: id,
      createdAt: now,
      expiresAt: now + ttlMs,
      clientId: String(clientId || 'unknown'),
      tool: String(tool || 'unknown'),
      action: String(tool || 'unknown'),
      args: cleanArgs,
      argsHash,
      argsSummary: summary,
      scope,
      policyVersion: String(policyVersion),
      status: 'pending',
      approvedAt: null,
      consumedAt: null
    };

    this._mutate(state => {
      // Clean expired pending
      for (const [key, item] of Object.entries(state.pending)) {
        if (item.expiresAt < now) {
          delete state.pending[key];
        }
      }
      state.pending[id] = record;
    });

    return record;
  }

  requestApproval(params = {}) {
    return this.createPendingApproval({
      clientId: params.clientId,
      tool: params.tool || params.action,
      args: params.args,
      scope: params.scope,
      policyVersion: params.policyVersion,
      ttlMs: params.ttlMs
    });
  }

  listPending() {
    const state = this._readState();
    const now = Date.now();
    return Object.values(state.pending || {}).filter(item => item.status === 'pending' && item.expiresAt > now);
  }

  getApproval(id) {
    const state = this._readState();
    return state.pending[id] || null;
  }

  approve(id, options = {}) {
    return this._mutate(state => {
      const item = state.pending[id];
      if (!item) throw new Error(`Aprobación no encontrada: ${id}`);
      if (item.expiresAt < Date.now()) {
        delete state.pending[id];
        throw new Error(`La solicitud de aprobación ${id} ha expirado.`);
      }
      if (item.status !== 'pending') {
        throw new Error(`La solicitud ${id} ya no está pendiente (estado actual: ${item.status}).`);
      }
      item.status = 'approved';
      item.approvedAt = Date.now();
      item.approvedBy = (options && options.approvedBy) || 'local-operator';
      return item;
    });
  }

  reject(id, reason = 'Rechazada por el operador local') {
    return this._mutate(state => {
      const item = state.pending[id];
      if (!item) throw new Error(`Aprobación no encontrada: ${id}`);
      item.status = 'rejected';
      item.rejectedAt = Date.now();
      item.rejectReason = reason;
      delete state.pending[id];
      state.history = state.history || [];
      state.history.push(item);
      if (state.history.length > 100) state.history.shift();
      return item;
    });
  }

  /**
   * Atomically checks and consumes an approved request for single-use execution.
   */
  consumeApproval(idOrOpts, options = {}) {
    const opts = typeof idOrOpts === 'object' && idOrOpts !== null ? idOrOpts : options;
    const id = typeof idOrOpts === 'string' ? idOrOpts : (idOrOpts.approvalId || idOrOpts.id);
    const clientId = opts.clientId;
    const tool = opts.tool || opts.action;
    const args = opts.args;
    const policyVersion = opts.policyVersion;

    if (!id) {
      throw new Error('Se requiere approvalId para ejecutar esta operación.');
    }

    return this._mutate(state => {
      const item = state.pending[id];
      if (!item) {
        // Check if in history as consumed or rejected
        const inHistory = (state.history || []).find(h => h.id === id);
        if (inHistory && inHistory.status === 'consumed') {
          throw new Error(`Ataque de replay detectado: la aprobación ${id} ya fue consumida.`);
        }
        if (inHistory && inHistory.status === 'rejected') {
          throw new Error(`La aprobación ${id} fue rechazada por el operador local (estado: rejected).`);
        }
        throw new Error(`Aprobación no encontrada o expirada: ${id}`);
      }

      if (item.expiresAt < Date.now()) {
        delete state.pending[id];
        throw new Error(`La aprobación ${id} ha expirado.`);
      }

      if (item.status === 'consumed') {
        throw new Error(`Ataque de replay detectado: la aprobación ${id} ya fue consumida.`);
      }

      if (item.status !== 'approved') {
        throw new Error(`La solicitud ${id} aún no ha sido aprobada por un operador humano local (estado: ${item.status}).`);
      }

      if (item.clientId && item.clientId !== String(clientId || 'unknown')) {
        throw new Error(`Cruce de clientes detectado: la aprobación ${id} fue solicitada por otro cliente.`);
      }

      if (tool && item.tool !== String(tool)) {
        throw new Error(`Herramienta no coincide: la aprobación ${id} era para ${item.tool}, no para ${tool}.`);
      }

      const incomingHash = hashArgs(args);
      if (item.argsHash !== incomingHash) {
        throw new Error(`Los argumentos de la solicitud no coinciden con los argumentos aprobados por el operador (hash alterado).`);
      }

      if (policyVersion && item.policyVersion && item.policyVersion !== String(policyVersion)) {
        throw new Error(`La versión de la política cambió desde que se solicitó la aprobación (versión de política no coincide).`);
      }

      // Mark consumed and archive
      item.status = 'consumed';
      item.consumedAt = Date.now();
      delete state.pending[id];

      state.history = state.history || [];
      state.history.push(item);
      if (state.history.length > 200) state.history.shift();

      return item;
    });
  }

  isApprovalRequired(toolName, args = {}, env = process.env, clientPolicy = null) {
    // 1. Check client-specific approval requirements first
    if (clientPolicy && Array.isArray(clientPolicy.approvalTools) && clientPolicy.approvalTools.includes(toolName)) {
      return true;
    }

    // 2. Check environment-configured approval tools (CSV or wildcard)
    if (env.MCP_TOOL_APPROVALS) {
      const val = String(env.MCP_TOOL_APPROVALS).trim();
      const lower = val.toLowerCase();
      if (lower === 'all' || val === '*') {
        // Honest semantics: 'all' genuinely requires approval for all operations except policy status introspection
        return toolName !== 'tool_policy_status';
      }
      if (val === '1' || lower === 'critical') {
        return this.isCriticalTool(toolName, args, env, clientPolicy);
      }
      const configured = val.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (configured.includes(toolName.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  isCriticalTool(toolName, args = {}, env = process.env, clientPolicy = null) {
    const criticalConfirmations = env.criticalConfirmations !== undefined
      ? Boolean(env.criticalConfirmations)
      : !['0', 'false', 'no', 'off'].includes(String(env.MCP_CRITICAL_CONFIRMATIONS || '1').trim().toLowerCase());
    if (!criticalConfirmations) {
      return false;
    }

    const CRITICAL_TOOLS = new Set([
      'file_delete',
      'package_action',
      'firewall_action',
      'mount_action',
      'power_action'
    ]);

    if (CRITICAL_TOOLS.has(toolName)) return true;

    if (toolName === 'container_compose') {
      const action = String(args.action || '');
      const mutating = ['up', 'down', 'restart', 'build', 'pull', 'start', 'stop'].includes(action);
      return mutating;
    }

    return false;
  }
}

module.exports = {
  ApprovalsManager,
  ApprovalManager: ApprovalsManager,
  hashArgs,
  hashArguments: hashArgs,
  canonicalJson,
  cleanArgsForHash,
  buildArgsSummary
};
