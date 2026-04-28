#!/usr/bin/env node

/*
 * MCP File Server
 *
 * - stdio transport for local MCP clients such as Claude Desktop.
 * - HTTP/SSE transport for remote web clients such as ChatGPT connectors
 *   and Claude web integrations when exposed through ngrok.
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { URL } = require('url');

loadDotEnv();

const JSONRPC_VERSION = '2.0';
const MCP_VERSION = process.env.MCP_PROTOCOL_VERSION || '2025-11-25';
const DEFAULT_ROOT = process.env.WORKING_DIR || '/mnt/4tb-hdd/repo';
const ALLOWED_ROOTS = parseAllowedRoots(process.env.ALLOWED_PATHS || DEFAULT_ROOT);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const ACTIVITY_LOG = process.env.ACTIVITY_LOG || '';

class Logger {
  static info(message) {
    console.error(`[INFO] ${message}`);
  }

  static error(message, error = null) {
    console.error(`[ERROR] ${message}`);
    if (error) console.error(error.stack || error);
  }

  static debug(message) {
    if (process.env.DEBUG) console.error(`[DEBUG] ${message}`);
  }

  static activity(event) {
    const entry = {
      ts: new Date().toISOString(),
      ...event
    };

    console.error(`[ACTIVITY] ${JSON.stringify(entry)}`);
    if (ACTIVITY_LOG) {
      fs.appendFileSync(ACTIVITY_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
    }
  }
}

function parseAllowedRoots(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function rootForDisplay() {
  return ALLOWED_ROOTS.join(', ');
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolvePath(userPath = '.') {
  const rawPath = String(userPath || '.');
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(ALLOWED_ROOTS[0], rawPath);

  const root = ALLOWED_ROOTS.find((allowedRoot) => isInside(allowedRoot, candidate));
  if (!root) {
    throw new Error(`Path is outside allowed roots: ${rawPath}`);
  }

  return { fullPath: candidate, displayPath: path.relative(root, candidate) || '.', root };
}

function textResult(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text', text }]
  };
}

function createResponse(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function createError(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

function countOccurrences(content, search) {
  let count = 0;
  let index = 0;

  while (true) {
    index = content.indexOf(search, index);
    if (index === -1) return count;
    count += 1;
    index += search.length;
  }
}

function summarizeToolArgs(tool, args) {
  switch (tool) {
    case 'search':
      return {
        query: args.query,
        path: args.path || '.',
        limit: args.limit
      };
    case 'fetch':
      return { id: args.id || args.path };
    case 'list_files':
      return { path: args.path || '.' };
    case 'read_file':
      return { path: args.path };
    case 'write_file':
      return {
        path: args.path,
        mode: args.mode || 'write',
        contentBytes: typeof args.content === 'string' ? Buffer.byteLength(args.content, 'utf8') : 0
      };
    case 'patch_file':
      return {
        path: args.path,
        patches: Array.isArray(args.patches) ? args.patches.length : 0
      };
    case 'run_command':
      return {
        command: args.command,
        args: Array.isArray(args.args) ? args.args : [],
        cwd: args.cwd || '.',
        timeoutMs: args.timeoutMs,
        shell: Boolean(args.shell)
      };
    default:
      return {};
  }
}

class MCPFileServer {
  getTools() {
    return [
      {
        name: 'search',
        description: 'Searches readable files by filename and text content under the allowed folders.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text or filename fragment.' },
            path: { type: 'string', description: 'Optional relative folder to search inside.' },
            limit: { type: 'number', description: 'Maximum result count. Default 20.' }
          },
          required: ['query']
        }
      },
      {
        name: 'fetch',
        description: 'Fetches a file returned by search, using its id or path.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'File id or path returned by search.' }
          },
          required: ['id']
        }
      },
      {
        name: 'list_files',
        description: 'Lists files and directories in a path under the allowed folders.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative or allowed absolute path. Default ".".' }
          },
          required: []
        }
      },
      {
        name: 'read_file',
        description: 'Reads a UTF-8 text file under the allowed folders.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative or allowed absolute file path.' }
          },
          required: ['path']
        }
      },
      {
        name: 'write_file',
        description: 'Writes a UTF-8 text file under the allowed folders. Creates parent directories when needed.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative or allowed absolute file path.' },
            content: { type: 'string', description: 'Content to write.' },
            mode: {
              type: 'string',
              enum: ['write', 'append'],
              description: 'write overwrites the file; append adds to the end.',
              default: 'write'
            }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'patch_file',
        description: 'Patches a UTF-8 text file with exact search/replace edits under the allowed folders.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative or allowed absolute file path.' },
            patches: {
              type: 'array',
              description: 'Exact replacements to apply in order.',
              items: {
                type: 'object',
                properties: {
                  search: { type: 'string', description: 'Exact text to find.' },
                  replace: { type: 'string', description: 'Replacement text.' },
                  replaceAll: { type: 'boolean', description: 'Replace all occurrences. Default false.' }
                },
                required: ['search', 'replace']
              }
            }
          },
          required: ['path', 'patches']
        }
      },
      {
        name: 'run_command',
        description: 'Runs a local command in an allowed folder. Uses argv execution by default, not a shell.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Executable name or path, for example npm, git, node, bash.' },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Command arguments. Default empty.'
            },
            cwd: { type: 'string', description: 'Working directory under ALLOWED_PATHS. Default ".".' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Default 30000, max 120000.' },
            shell: { type: 'boolean', description: 'Run through the system shell. Default false.' }
          },
          required: ['command']
        }
      }
    ];
  }

  initialize() {
    return {
      protocolVersion: MCP_VERSION,
      capabilities: { tools: {} },
      serverInfo: {
        name: 'mcp-local-files',
        version: '2.0.0'
      }
    };
  }

  async handle(request) {
    if (!request || request.jsonrpc !== JSONRPC_VERSION) {
      return createError(request && request.id, -32600, 'Invalid JSON-RPC request');
    }

    if (request.id === undefined) {
      Logger.debug(`Ignoring notification ${request.method}`);
      return null;
    }

    try {
      switch (request.method) {
        case 'initialize':
          return createResponse(request.id, this.initialize());
        case 'tools/list':
          return createResponse(request.id, { tools: this.getTools() });
        case 'tools/call': {
          const params = request.params || {};
          const started = Date.now();
          const result = await this.callTool(params.name, params.arguments || {});
          Logger.activity({
            method: 'tools/call',
            tool: params.name,
            args: summarizeToolArgs(params.name, params.arguments || {}),
            durationMs: Date.now() - started,
            ok: true
          });
          return createResponse(request.id, result);
        }
        case 'ping':
          return createResponse(request.id, {});
        default:
          return createError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      Logger.error(`Error handling ${request.method}`, error);
      if (request.method === 'tools/call') {
        const params = request.params || {};
        Logger.activity({
          method: 'tools/call',
          tool: params.name,
          args: summarizeToolArgs(params.name, params.arguments || {}),
          ok: false,
          error: error.message
        });
      }
      return createError(request.id, -32603, error.message);
    }
  }

  async callTool(name, args) {
    switch (name) {
      case 'search':
        return textResult(this.searchFiles(args));
      case 'fetch':
        return textResult(this.fetchFile(args.id || args.path));
      case 'list_files':
        return textResult(this.listFiles(args.path || '.'));
      case 'read_file':
        return textResult(this.readFile(args.path));
      case 'write_file':
        return textResult(this.writeFile(args.path, args.content, args.mode || 'write'));
      case 'patch_file':
        return textResult(this.patchFile(args.path, args.patches));
      case 'run_command':
        return textResult(await this.runCommand(args));
      default:
        throw new Error(`Tool not found: ${name}`);
    }
  }

  listFiles(dirPath = '.') {
    const { fullPath, displayPath } = resolvePath(dirPath);
    const stats = fs.statSync(fullPath);
    if (!stats.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

    const files = fs.readdirSync(fullPath, { withFileTypes: true }).map((item) => {
      const childPath = path.join(displayPath, item.name);
      return {
        name: item.name,
        type: item.isDirectory() ? 'directory' : 'file',
        path: childPath === '.' ? item.name : childPath
      };
    });

    return { path: displayPath, files };
  }

  readFile(filePath) {
    if (!filePath) throw new Error('path is required');
    const { fullPath, displayPath } = resolvePath(filePath);
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) throw new Error(`Not a file: ${filePath}`);

    return {
      path: displayPath,
      content: fs.readFileSync(fullPath, 'utf8'),
      size: stats.size,
      modified: stats.mtime.toISOString()
    };
  }

  writeFile(filePath, content, mode = 'write') {
    if (!filePath) throw new Error('path is required');
    if (typeof content !== 'string') throw new Error('content must be a string');
    if (!['write', 'append'].includes(mode)) throw new Error('mode must be "write" or "append"');

    const { fullPath, displayPath } = resolvePath(filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    if (mode === 'append') {
      fs.appendFileSync(fullPath, content, 'utf8');
    } else {
      fs.writeFileSync(fullPath, content, 'utf8');
    }

    const stats = fs.statSync(fullPath);
    return {
      path: displayPath,
      bytes_written: Buffer.byteLength(content, 'utf8'),
      mode,
      size: stats.size,
      modified: stats.mtime.toISOString()
    };
  }

  patchFile(filePath, patches) {
    if (!Array.isArray(patches) || patches.length === 0) {
      throw new Error('patches must be a non-empty array');
    }

    const { fullPath, displayPath } = resolvePath(filePath);
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) throw new Error(`Not a file: ${filePath}`);

    let content = fs.readFileSync(fullPath, 'utf8');
    const applied = [];

    for (const patch of patches) {
      const search = patch && patch.search;
      const replace = patch && patch.replace;
      if (typeof search !== 'string' || search.length === 0) {
        throw new Error('patch.search must be a non-empty string');
      }
      if (typeof replace !== 'string') {
        throw new Error('patch.replace must be a string');
      }

      const occurrences = countOccurrences(content, search);
      if (occurrences === 0) {
        throw new Error(`Search text not found in ${displayPath}`);
      }
      if (!patch.replaceAll && occurrences > 1) {
        throw new Error(`Search text appears ${occurrences} times in ${displayPath}; set replaceAll=true or use a more specific search`);
      }

      content = patch.replaceAll
        ? content.split(search).join(replace)
        : content.replace(search, replace);

      applied.push({
        searchBytes: Buffer.byteLength(search, 'utf8'),
        replaceBytes: Buffer.byteLength(replace, 'utf8'),
        occurrences: patch.replaceAll ? occurrences : 1
      });
    }

    fs.writeFileSync(fullPath, content, 'utf8');
    const nextStats = fs.statSync(fullPath);

    return {
      path: displayPath,
      patches_applied: applied.length,
      replacements: applied,
      size: nextStats.size,
      modified: nextStats.mtime.toISOString()
    };
  }

  runCommand(args) {
    const command = String(args.command || '').trim();
    if (!command) throw new Error('command is required');
    if (command.includes('/') || command.includes('\\')) {
      resolvePath(command);
    }

    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const cwd = resolvePath(args.cwd || '.').fullPath;
    const timeoutMs = Math.max(1000, Math.min(Number(args.timeoutMs || 30000), 120000));
    const shell = Boolean(args.shell);

    return new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        cwd,
        shell,
        env: process.env
      });

      let stdout = '';
      let stderr = '';
      let killedByTimeout = false;
      const limit = Number(process.env.COMMAND_OUTPUT_LIMIT_BYTES || 1024 * 1024);

      const timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        if (Buffer.byteLength(stdout, 'utf8') < limit) stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', (chunk) => {
        if (Buffer.byteLength(stderr, 'utf8') < limit) stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({
          command,
          args: commandArgs,
          cwd: this.relativeDisplayPath(cwd),
          shell,
          exit_code: code,
          signal,
          timed_out: killedByTimeout,
          stdout,
          stderr
        });
      });
    });
  }

  fetchFile(id) {
    if (!id) throw new Error('id is required');
    return this.readFile(id.replace(/^file:/, ''));
  }

  searchFiles(args) {
    const query = String(args.query || '').toLowerCase();
    if (!query) throw new Error('query is required');

    const limit = Math.max(1, Math.min(Number(args.limit || 20), 100));
    const start = resolvePath(args.path || '.').fullPath;
    const results = [];

    this.walkFiles(start, (filePath) => {
      if (results.length >= limit) return false;

      const rel = this.relativeDisplayPath(filePath);
      let matched = rel.toLowerCase().includes(query);
      let snippet = '';

      if (!matched && this.isProbablyText(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const index = content.toLowerCase().indexOf(query);
        if (index >= 0) {
          matched = true;
          snippet = content.slice(Math.max(0, index - 120), Math.min(content.length, index + query.length + 120));
        }
      }

      if (matched) {
        results.push({
          id: rel,
          title: rel,
          url: `file:${rel}`,
          text: snippet || rel
        });
      }

      return true;
    });

    return { results };
  }

  walkFiles(start, visit) {
    if (!fs.existsSync(start)) return;
    const stats = fs.statSync(start);

    if (stats.isFile()) {
      visit(start);
      return;
    }

    for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = path.join(start, entry.name);
      if (entry.isDirectory()) {
        this.walkFiles(child, visit);
      } else if (entry.isFile()) {
        const shouldContinue = visit(child);
        if (shouldContinue === false) return;
      }
    }
  }

  relativeDisplayPath(filePath) {
    const root = ALLOWED_ROOTS.find((allowedRoot) => isInside(allowedRoot, filePath)) || ALLOWED_ROOTS[0];
    return path.relative(root, filePath) || '.';
  }

  isProbablyText(filePath) {
    const allowed = new Set([
      '.c', '.cc', '.conf', '.cpp', '.css', '.csv', '.env', '.go', '.h', '.html',
      '.ini', '.java', '.js', '.json', '.jsx', '.log', '.md', '.mjs', '.py',
      '.rs', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
    ]);
    return allowed.has(path.extname(filePath).toLowerCase());
  }
}

function hasValidAuth(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${AUTH_TOKEN}`;
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': [
      'accept',
      'authorization',
      'content-type',
      'last-event-id',
      'mcp-protocol-version',
      'mcp-session-id',
      'anthropic-dangerous-direct-browser-access'
    ].join(', '),
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-expose-headers': 'mcp-session-id',
    'access-control-allow-private-network': 'true',
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendEmpty(res, statusCode = 202) {
  res.writeHead(statusCode, corsHeaders());
  res.end();
}

function sendAuthError(res) {
  sendJson(res, 401, { error: 'Missing or invalid bearer token' });
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function startHttp() {
  const mcp = new MCPFileServer();
  const sessions = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

      if (req.method === 'OPTIONS') {
        sendEmpty(res, 204);
        return;
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          transport: ['streamable-http', 'sse'],
          allowedRoots: ALLOWED_ROOTS,
          auth: AUTH_TOKEN ? 'bearer' : 'none'
        });
        return;
      }

      if (url.pathname === '/config' && req.method === 'GET') {
        sendJson(res, 200, buildClientConfig(publicBaseUrl(req)));
        return;
      }

      if (url.pathname === '/tools' && req.method === 'GET') {
        sendJson(res, 200, { tools: mcp.getTools() });
        return;
      }

      if (!hasValidAuth(req)) {
        sendAuthError(res);
        return;
      }

      if (url.pathname === '/mcp' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const requests = Array.isArray(body) ? body : [body];
        const responses = [];

        for (const request of requests) {
          const response = await mcp.handle(request);
          if (response) responses.push(response);
        }

        if (responses.length === 0) {
          sendEmpty(res, 202);
        } else {
          sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
        }
        return;
      }

      if ((url.pathname === '/mcp' || url.pathname === '/sse') && req.method === 'GET') {
        const sessionId = crypto.randomUUID();
        prepareSse(res);
        sessions.set(sessionId, res);
        writeSse(res, 'endpoint', `/messages?sessionId=${sessionId}`);
        req.on('close', () => sessions.delete(sessionId));
        return;
      }

      if (url.pathname === '/messages' && req.method === 'POST') {
        const sessionId = url.searchParams.get('sessionId');
        const stream = sessions.get(sessionId);
        if (!stream) {
          sendJson(res, 404, { error: 'Unknown SSE session' });
          return;
        }

        const response = await mcp.handle(await readJsonBody(req));
        if (response) writeSse(stream, 'message', response);
        sendEmpty(res, 202);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      Logger.error('HTTP request failed', error);
      sendJson(res, 500, { error: error.message });
    }
  });

  server.listen(PORT, HOST, () => {
    Logger.info(`MCP HTTP server listening at http://${HOST}:${PORT}`);
    Logger.info(`Allowed roots: ${rootForDisplay()}`);
    Logger.info(`Auth: ${AUTH_TOKEN ? 'Bearer token required' : 'none'}`);
    printConfig(`http://${HOST}:${PORT}`);
  });
}

function prepareSse(res) {
  res.writeHead(200, {
    ...corsHeaders(),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  res.write('\n');
}

function publicBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function readJsonBody(req) {
  const limit = Number(process.env.JSON_LIMIT_BYTES || 50 * 1024 * 1024);

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });

    req.on('error', reject);
  });
}

function buildClientConfig(baseUrl) {
  return {
    chatgpt: {
      name: 'Local Files MCP',
      url: `${baseUrl}/mcp`,
      transport: 'Streamable HTTP',
      auth: AUTH_TOKEN ? 'Bearer token' : 'No authentication',
      note: 'Enable ChatGPT Developer Mode to use write_file and other non search/fetch tools.'
    },
    claudeWeb: {
      name: 'Local Files MCP',
      url: `${baseUrl}/sse`,
      transport: 'SSE',
      auth: AUTH_TOKEN ? 'Bearer token' : 'No authentication'
    },
    claudeDesktop: {
      command: 'node',
      args: [path.join(__dirname, 'mcp-server.js'), '--stdio'],
      env: {
        ALLOWED_PATHS: rootForDisplay()
      }
    },
    allowedRoots: ALLOWED_ROOTS,
    tools: [
      'search',
      'fetch',
      'list_files',
      'read_file',
      'write_file',
      'patch_file',
      'run_command'
    ],
    bearerToken: AUTH_TOKEN || undefined
  };
}

function printConfig(baseUrl) {
  const config = buildClientConfig(baseUrl);
  console.error('');
  console.error('=== MCP CLIENT CONFIG ===');
  console.error(`ChatGPT Web URL: ${config.chatgpt.url}`);
  console.error(`Claude Web URL:  ${config.claudeWeb.url}`);
  console.error(`Claude Desktop:  node ${path.join(__dirname, 'mcp-server.js')} --stdio`);
  if (AUTH_TOKEN) console.error(`Bearer token:    ${AUTH_TOKEN}`);
  console.error(`Allowed roots:   ${rootForDisplay()}`);
  console.error('=========================');
  console.error('');
}

function startStdio() {
  const mcp = new MCPFileServer();
  Logger.info('MCP stdio server started');
  Logger.info(`Protocol version: ${MCP_VERSION}`);
  Logger.info(`Allowed roots: ${rootForDisplay()}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    try {
      const request = JSON.parse(line);
      const response = await mcp.handle(request);
      if (response) console.log(JSON.stringify(response));
    } catch (error) {
      Logger.error('Parse error', error);
      console.log(JSON.stringify(createError(null, -32700, 'Parse error')));
    }
  });
}

const mode = process.argv.includes('--http') ? 'http' : 'stdio';

if (mode === 'http') {
  startHttp();
} else {
  startStdio();
}
