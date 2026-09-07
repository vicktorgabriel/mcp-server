'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { MessageFramer, DEFAULT_TIMEOUT_MS, SOCK_PATH, TOKEN_PATH } = require('./ipc-protocol');
const { spawn } = require('child_process');

class IpcGatewayClient {
  constructor(options = {}) {
    this.sockPath = options.sockPath || SOCK_PATH;
    this.tokenPath = options.tokenPath || TOKEN_PATH;
    this.socket = null;
    this.framer = new MessageFramer();
    this.connected = false;
    this.authenticated = false;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer, started }
    this.connectPromise = null;
    this.requestIdCounter = 1;
    this.autoSpawn = options.autoSpawn !== false;
  }

  async ensureConnected() {
    if (this.connected && this.authenticated && this.socket && !this.socket.destroyed) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this._connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async _connect() {
    // If socket file does not exist and autoSpawn is true, spawn separate executor process
    if (!fs.existsSync(this.sockPath) && this.autoSpawn) {
      const executorScript = path.join(__dirname, 'ipc-executor.js');
      const child = spawn(process.execPath, [executorScript], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          MCP_IPC_SOCK: this.sockPath,
          MCP_IPC_SOCKET: this.sockPath,
          MCP_IPC_TOKEN: this.tokenPath
        }
      });
      child.unref();

      // Wait for socket up to 2.5s
      let attempts = 0;
      while (!fs.existsSync(this.sockPath) && attempts < 50) {
        await new Promise(r => setTimeout(r, 50));
        attempts++;
      }
    }

    if (!fs.existsSync(this.tokenPath)) {
      throw new Error(`Token de autenticación IPC no encontrado en ${this.tokenPath}`);
    }
    const token = fs.readFileSync(this.tokenPath, 'utf8').trim();

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.sockPath);
      this.socket = socket;
      this.framer = new MessageFramer();
      let handshakeDone = false;

      const connectTimeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Timeout conectando al socket IPC del ejecutor.'));
      }, 5000);

      socket.on('connect', () => {
        this.connected = true;
        // Send handshake
        const handshake = {
          type: 'handshake',
          token,
          pid: process.pid,
          clientVersion: '4.5.3'
        };
        socket.write(MessageFramer.frame(handshake));
      });

      socket.on('data', (chunk) => {
        let messages = [];
        try {
          messages = this.framer.feed(chunk);
        } catch (err) {
          socket.destroy();
          return;
        }

        for (const msg of messages) {
          if (msg.type === 'handshake_ack') {
            clearTimeout(connectTimeout);
            if (msg.ok) {
              this.authenticated = true;
              handshakeDone = true;
              resolve();
            } else {
              socket.destroy();
              reject(new Error(`Rechazo en handshake IPC: ${msg.error || 'Token inválido'}`));
            }
            continue;
          }

          if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
            const pending = this.pendingRequests.get(msg.id);
            this.pendingRequests.delete(msg.id);
            clearTimeout(pending.timer);
            const totalDuration = Date.now() - pending.started;

            if (msg.error) {
              const err = new Error(msg.error.message || 'Error en ejecutor');
              err.code = msg.error.code;
              err.data = msg.error.data;
              if (msg.error.code === -32001 || (msg.error.data && msg.error.data.approvalId)) {
                err.isApprovalRequired = true;
                err.approvalId = msg.error.data && msg.error.data.approvalId;
                err.argsSummary = msg.error.data && msg.error.data.argsSummary;
              }
              pending.reject(err);
            } else {
              const res = msg.result;
              if (res && typeof res === 'object') {
                res._timings = {
                  ...(msg.timings || {}),
                  t_gateway_total_ms: totalDuration
                };
              }
              pending.resolve(res);
            }
          }
        }
      });

      socket.on('error', (err) => {
        this.connected = false;
        this.authenticated = false;
        if (!handshakeDone) {
          clearTimeout(connectTimeout);
          reject(err);
        }
      });

      socket.on('close', () => {
        this.connected = false;
        this.authenticated = false;
        // Fail all pending
        for (const [id, pending] of this.pendingRequests.entries()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Conexión IPC cerrada inesperadamente.'));
        }
        this.pendingRequests.clear();
      });
    });
  }

  async sendRequest(method, params = {}, context = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.ensureConnected();

    const id = this.requestIdCounter++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
      auth: context.auth || {
        authenticated: Boolean(context.principal && context.principal.clientId !== 'anonymous'),
        clientId: context.principal ? context.principal.clientId : 'local',
        clientName: context.principal ? context.principal.clientName : 'local',
        principal: context.principal
      },
      clientInfo: context.clientInfo || {}
    };

    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Timeout de solicitud IPC (${timeoutMs} ms) para método ${method}`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer, started });

      try {
        const frame = MessageFramer.frame(request);
        const canWrite = this.socket.write(frame);
        if (!canWrite) {
          // Socket buffer full; backpressure
          this.socket.once('drain', () => {});
        }
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  async getPublishedTools(context = {}) {
    const res = await this.sendRequest('tools/list', {}, context);
    return res && res.tools ? res.tools : [];
  }

  async callTool(name, args = {}, context = {}) {
    const approvalId = context.approvalId || (args && (args.approvalId || args._approvalId || args.approval_id));
    return this.sendRequest('tools/call', { name, arguments: args, approvalId }, { ...context, approvalId });
  }

  async getPolicySummary(context = {}) {
    return this.sendRequest('policy/summary', {}, context);
  }

  disconnect() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
    this.connected = false;
    this.authenticated = false;
  }
}

module.exports = {
  IpcGatewayClient
};
