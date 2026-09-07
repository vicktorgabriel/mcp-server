'use strict';

const crypto = require('crypto');
const path = require('path');

const SOCK_DIR = path.resolve('.runtime/ipc');
function getIpcPaths(env = process.env) {
  const sockPath = path.resolve(env.MCP_IPC_SOCKET || env.MCP_IPC_SOCK || path.join(SOCK_DIR, 'mcp.sock'));
  const tokenPath = path.resolve(env.MCP_IPC_TOKEN || path.join(SOCK_DIR, 'auth-token'));
  return { sockDir: SOCK_DIR, sockPath, tokenPath };
}

const SOCK_PATH = getIpcPaths().sockPath;
const TOKEN_PATH = getIpcPaths().tokenPath;

const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16 MB max message size
const DEFAULT_TIMEOUT_MS = 60000;

class MessageFramer {
  constructor(maxSize = MAX_MESSAGE_SIZE) {
    this.maxSize = maxSize;
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Frames a JavaScript object into a length-prefixed Buffer.
   * [4 bytes big-endian length][JSON payload]
   */
  static frame(payload) {
    const json = JSON.stringify(payload);
    const data = Buffer.from(json, 'utf8');
    if (data.length > MAX_MESSAGE_SIZE) {
      throw new Error(`Message size ${data.length} exceeds max allowed ${MAX_MESSAGE_SIZE} bytes.`);
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length, 0);
    return Buffer.concat([header, data]);
  }

  /**
   * Pushes incoming chunk into the framer buffer and extracts complete messages.
   * @param {Buffer} chunk
   * @returns {Array<object>} array of parsed messages
   */
  feed(chunk) {
    if (!chunk || chunk.length === 0) return [];
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];

    while (this.buffer.length >= 4) {
      const messageLength = this.buffer.readUInt32BE(0);
      if (messageLength > this.maxSize) {
        this.buffer = Buffer.alloc(0);
        throw new Error(`Incoming message length ${messageLength} exceeds max allowed size of ${this.maxSize} bytes.`);
      }

      if (this.buffer.length < 4 + messageLength) {
        // Need more data
        break;
      }

      const raw = this.buffer.subarray(4, 4 + messageLength);
      this.buffer = this.buffer.subarray(4 + messageLength);

      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        messages.push(parsed);
      } catch (err) {
        throw new Error(`Failed to parse IPC message JSON: ${err.message}`);
      }
    }

    return messages;
  }
}

/**
 * Validates request schema for tool execution over IPC
 */
function validateIpcRequest(msg) {
  if (!msg || typeof msg !== 'object') {
    return { ok: false, error: 'Request must be an object' };
  }

  if (msg.type === 'handshake') {
    if (typeof msg.token !== 'string' || !msg.token) {
      return { ok: false, error: 'Handshake token must be a non-empty string' };
    }
    return { ok: true, isHandshake: true };
  }

  if (msg.jsonrpc !== '2.0') {
    return { ok: false, error: 'Missing or invalid jsonrpc version, expected "2.0"' };
  }

  if (msg.id === undefined && msg.method !== '$/cancelRequest') {
    return { ok: false, error: 'Request id is required for calls' };
  }

  if (typeof msg.method !== 'string' || !msg.method) {
    return { ok: false, error: 'Method must be a non-empty string' };
  }

  if (msg.params !== undefined && (typeof msg.params !== 'object' || msg.params === null)) {
    return { ok: false, error: 'Params must be an object if provided' };
  }

  return { ok: true, isHandshake: false };
}

module.exports = {
  MAX_MESSAGE_SIZE,
  DEFAULT_TIMEOUT_MS,
  SOCK_DIR,
  SOCK_PATH,
  TOKEN_PATH,
  getIpcPaths,
  MessageFramer,
  validateIpcRequest
};
