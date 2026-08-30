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
const { createFullControl } = require('./full-control-tools');

loadDotEnv();

const JSONRPC_VERSION = '2.0';
const MCP_VERSION = process.env.MCP_PROTOCOL_VERSION || '2025-11-25';
const FULL_ACCESS = parseBoolean(process.env.MCP_FULL_ACCESS, true);
const DEFAULT_ROOT = process.env.WORKING_DIR || inferDefaultRoot();
const ALLOWED_ROOTS = FULL_ACCESS ? [path.resolve('/')] : parseAllowedRoots(process.env.ALLOWED_PATHS || DEFAULT_ROOT);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const ACTIVITY_LOG = process.env.ACTIVITY_LOG || '';
const DEFAULT_SEARCH_SKIP_DIRS = 'node_modules,.git';
const FAST_MODE = parseBoolean(process.env.MCP_FAST_MODE, false);
const SEARCH_CACHE_TTL_MS = parseNumber(process.env.SEARCH_CACHE_TTL_MS, FAST_MODE ? 60_000 : 0, { min: 0 });
const SEARCH_MAX_FILE_BYTES = parseNumber(
  process.env.SEARCH_MAX_FILE_BYTES,
  FAST_MODE ? 512 * 1024 : Number.MAX_SAFE_INTEGER,
  { min: 1 }
);
const SEARCH_MAX_TOTAL_BYTES = parseNumber(
  process.env.SEARCH_MAX_TOTAL_BYTES,
  FAST_MODE ? 16 * 1024 * 1024 : Number.MAX_SAFE_INTEGER,
  { min: 1 }
);
const SEARCH_SKIP_DIRS = parseCsvSet(process.env.SEARCH_SKIP_DIRS || DEFAULT_SEARCH_SKIP_DIRS);
const READ_BATCH_LIMIT = parseNumber(
  process.env.READ_BATCH_LIMIT,
  FAST_MODE ? 25 : Number.MAX_SAFE_INTEGER,
  { min: 1 }
);
const SSE_HEARTBEAT_MS = parseNumber(process.env.SSE_HEARTBEAT_MS, 30_000, { min: 1_000 });
const KEEP_ALIVE_TIMEOUT_MS = parseNumber(process.env.KEEP_ALIVE_TIMEOUT_MS, 0, { min: 0 });
const searchCache = new Map();

if (!FULL_ACCESS) validateAllowedRoots(ALLOWED_ROOTS);

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

function inferDefaultRoot() {
  return path.resolve(__dirname, '..');
}

function validateAllowedRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('ALLOWED_PATHS resolved to no directories');
  }

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      throw new Error(`Allowed root does not exist: ${root}`);
    }
    if (!fs.statSync(root).isDirectory()) {
      throw new Error(`Allowed root is not a directory: ${root}`);
    }
  }
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
  if (FULL_ACCESS) return 'FULL_ACCESS (/)';
  return ALLOWED_ROOTS.join(', ');
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  switch (String(value).trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return fallback;
  }
}

function parseNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function parseCsvSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function buildToolMetadata(title, annotations) {
  return {
    title,
    annotations: {
      title,
      ...toolAnnotations(annotations)
    }
  };
}

function toolAnnotations(annotations = {}) {
  if (!FULL_ACCESS) return annotations;
  const next = { ...annotations };

  if (Object.prototype.hasOwnProperty.call(next, 'destructiveHint')) next.destructiveHint = false;
  if (Object.prototype.hasOwnProperty.call(next, 'idempotentHint')) next.idempotentHint = true;
  next.openWorldHint = true;

  return next;
}

function envValue(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? String(fallback) : String(value);
}

function recommendedStdioEnv() {
  return {
    MCP_FULL_ACCESS: envValue('MCP_FULL_ACCESS', 1),
    ALLOWED_PATHS: rootForDisplay(),
    WORKING_DIR: envValue('WORKING_DIR', DEFAULT_ROOT),
    MCP_FAST_MODE: envValue('MCP_FAST_MODE', 1),
    SEARCH_CACHE_TTL_MS: envValue('SEARCH_CACHE_TTL_MS', 60_000),
    SEARCH_MAX_FILE_BYTES: envValue('SEARCH_MAX_FILE_BYTES', 512 * 1024),
    SEARCH_MAX_TOTAL_BYTES: envValue('SEARCH_MAX_TOTAL_BYTES', 16 * 1024 * 1024),
    SEARCH_SKIP_DIRS: envValue(
      'SEARCH_SKIP_DIRS',
      'node_modules,.git,dist,build,.next,.nuxt,.cache,coverage,.venv,venv,__pycache__,target,out'
    ),
    READ_BATCH_LIMIT: envValue('READ_BATCH_LIMIT', 25),
    MCP_DESKTOP_ENABLED: envValue('MCP_DESKTOP_ENABLED', 1),
    MCP_INPUT_ENABLED: envValue('MCP_INPUT_ENABLED', 1),
    MCP_CONTROL_TIMEOUT_MS: envValue('MCP_CONTROL_TIMEOUT_MS', 120_000),
    MCP_IMAGE_LIMIT_BYTES: envValue('MCP_IMAGE_LIMIT_BYTES', 25 * 1024 * 1024),
    SSE_HEARTBEAT_MS: envValue('SSE_HEARTBEAT_MS', 15_000),
    KEEP_ALIVE_TIMEOUT_MS: envValue('KEEP_ALIVE_TIMEOUT_MS', 65_000)
  };
}

function getCachedSearchResult(cacheKey) {
  if (!cacheKey || SEARCH_CACHE_TTL_MS <= 0) return null;
  const cached = searchCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    searchCache.delete(cacheKey);
    return null;
  }
  return cached.result;
}

function setCachedSearchResult(cacheKey, result) {
  if (!cacheKey || SEARCH_CACHE_TTL_MS <= 0) return;
  searchCache.set(cacheKey, {
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    result
  });
}

function invalidateSearchCache() {
  searchCache.clear();
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolvePath(userPath = '.') {
  const rawPath = String(userPath || '.');

  if (FULL_ACCESS) {
    const base = path.resolve(process.env.WORKING_DIR || process.cwd());
    const candidate = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(base, rawPath);
    return { fullPath: candidate, displayPath: candidate, root: path.resolve('/') };
  }

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
  const structuredContent = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : { value: payload };
  const text = JSON.stringify(structuredContent, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent
  };
}

const TOOL_OUTPUT_SCHEMAS = {
  search: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string' },
            text: { type: 'string' }
          },
          required: ['id', 'title', 'url', 'text']
        }
      }
    },
    required: ['results']
  },
  fetch: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      size: { type: 'number' },
      modified: { type: 'string' }
    },
    required: ['path', 'content', 'size', 'modified']
  },
  list_files: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['file', 'directory'] },
            path: { type: 'string' }
          },
          required: ['name', 'type', 'path']
        }
      }
    },
    required: ['path', 'files']
  },
  read_file: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      size: { type: 'number' },
      modified: { type: 'string' }
    },
    required: ['path', 'content', 'size', 'modified']
  },
  write_file: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      bytes_written: { type: 'number' },
      mode: { type: 'string', enum: ['write', 'append'] },
      size: { type: 'number' },
      modified: { type: 'string' }
    },
    required: ['path', 'bytes_written', 'mode', 'size', 'modified']
  },
  patch_file: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      patches_applied: { type: 'number' },
      replacements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            searchBytes: { type: 'number' },
            replaceBytes: { type: 'number' },
            occurrences: { type: 'number' }
          },
          required: ['searchBytes', 'replaceBytes', 'occurrences']
        }
      },
      size: { type: 'number' },
      modified: { type: 'string' }
    },
    required: ['path', 'patches_applied', 'replacements', 'size', 'modified']
  },
  run_command: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string' },
      shell: { type: 'boolean' },
      exit_code: { type: ['number', 'null'] },
      signal: { type: ['string', 'null'] },
      timed_out: { type: 'boolean' },
      stdout: { type: 'string' },
      stderr: { type: 'string' }
    },
    required: ['command', 'args', 'cwd', 'shell', 'exit_code', 'signal', 'timed_out', 'stdout', 'stderr']
  }
};

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
    default: {
      const summary = {};
      for (const key of ['path', 'repo', 'target', 'session', 'service', 'action', 'pid', 'signal', 'mode', 'device', 'filter', 'command', 'cwd']) {
        if (args[key] !== undefined) summary[key] = args[key];
      }
      if (Array.isArray(args.args)) summary.args = args.args;
      if (Array.isArray(args.keys)) summary.keys = args.keys;
      if (typeof args.text === 'string') summary.textChars = args.text.length;
      return summary;
    }
  }
}

class MCPFileServer {
  constructor() {
    this.fullControl = createFullControl({ resolvePath, buildToolMetadata, textResult });
  }

  getTools() {
    const baseTools = [
      {
        name: 'search',
        ...buildToolMetadata('Search Files', {
          readOnlyHint: true,
          openWorldHint: false
        }),
        description: 'Searches readable files by filename and text content under the allowed folders.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text or filename fragment.' },
            path: { type: 'string', description: 'Optional relative folder to search inside.' },
            limit: { type: 'number', description: 'Maximum result count. Default 20.' }
          },
          required: ['query']
        },
        outputSchema: TOOL_OUTPUT_SCHEMAS.search
      },
      {
        name: 'fetch',
        ...buildToolMetadata('Fetch Search Result', {
          readOnlyHint: true,
          openWorldHint: false
        }),
        description: 'Fetches a file returned by search, using its id or path.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'File id or path returned by search.' }
          },
          required: ['id']
        },
        outputSchema: TOOL_OUTPUT_SCHEMAS.fetch
      },
      {
        name: 'list_files',
        ...buildToolMetadata('List Files', {
          readOnlyHint: true,
          openWorldHint: false
        }),
        description: 'Lists files and directories in a path under the allowed folders.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative or allowed absolute path. Default ".".' }
          },
          required: []
        },
        outputSchema: TOOL_OUTPUT_SCHEMAS.list_files
      },
      {
        name: 'read_file',
        ...buildToolMetadata('Read File', {
          readOnlyHint: true,
          openWorldHint: false
        }),
        description: 'Reads a UTF-8 text file under the allowed folders.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative or allowed absolute file path.' }
          },
          required: ['path']
        },
        outputSchema: TOOL_OUTPUT_SCHEMAS.read_file
      },
      {
        name: 'write_file',
        ...buildToolMetadata('Write File', {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        }),
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
        },
        outputSchema: TOOL_OUTPUT_SCHEMAS.write_file
      },
      {
        name: 'patch_file',
        ...buildToolMetadata('Patch File', {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        }),
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
        },
        outputSchema: TOOL_OUTPUT_SCHEMAS.patch_file
      },
      {
        name: 'run_command',
        ...buildToolMetadata('Run Command', {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true
        }),
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
        },
        outputSchema: TOOL_OUTPUT_SCHEMAS.run_command
      }
    ];
    return [...baseTools, ...this.fullControl.tools];
  }

  initialize() {
    return {
      protocolVersion: MCP_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: 'mcp-local-control',
        version: '3.0.0'
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
      default: {
        const extra = await this.fullControl.callTool(name, args);
        if (extra !== null) return extra;
        throw new Error(`Tool not found: ${name}`);
      }
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

    const maxBytes = Number(process.env.READ_LIMIT_BYTES || 10 * 1024 * 1024);
    if (stats.size > maxBytes) throw new Error(`File too large: ${stats.size} bytes (limit ${maxBytes})`);

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
      const tmp = `${fullPath}.tmp`;
      try {
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, fullPath);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw err;
      }
    }

    const stats = fs.statSync(fullPath);
    invalidateSearchCache();
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

    const tmp = `${fullPath}.tmp`;
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, fullPath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw err;
    }
    const nextStats = fs.statSync(fullPath);
    invalidateSearchCache();

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
      const { MCP_AUTH_TOKEN: _token, ...safeEnv } = process.env;
      const child = spawn(command, commandArgs, {
        cwd,
        shell,
        env: safeEnv
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
        invalidateSearchCache();
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
    const cacheKey = `${start}\u0000${query}\u0000${limit}`;
    const cached = getCachedSearchResult(cacheKey);
    if (cached) return cached;

    const results = [];
    let scannedContentFiles = 0;
    let scannedContentBytes = 0;

    this.walkFiles(start, (filePath) => {
      if (results.length >= limit) return false;

      const rel = this.relativeDisplayPath(filePath);
      let matched = rel.toLowerCase().includes(query);
      let snippet = '';

      if (!matched && this.isProbablyText(filePath) && scannedContentFiles < READ_BATCH_LIMIT) {
        const stats = fs.statSync(filePath);
        if (stats.size <= SEARCH_MAX_FILE_BYTES && (scannedContentBytes + stats.size) <= SEARCH_MAX_TOTAL_BYTES) {
          scannedContentFiles += 1;
          scannedContentBytes += stats.size;
          const content = fs.readFileSync(filePath, 'utf8');
          const index = content.toLowerCase().indexOf(query);
          if (index >= 0) {
            matched = true;
            snippet = content.slice(Math.max(0, index - 120), Math.min(content.length, index + query.length + 120));
          }
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

    const payload = { results };
    setCachedSearchResult(cacheKey, payload);
    return payload;
  }

  walkFiles(start, visit) {
    if (!fs.existsSync(start)) return false;
    const stats = fs.statSync(start);

    if (stats.isFile()) {
      return visit(start) === false;
    }

    for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
      if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(start, entry.name);
      if (entry.isDirectory()) {
        if (this.walkFiles(child, visit)) return true;
      } else if (entry.isFile()) {
        if (visit(child) === false) return true;
      }
    }

    return false;
  }

  relativeDisplayPath(filePath) {
    if (FULL_ACCESS) return path.resolve(filePath);
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
          auth: AUTH_TOKEN ? 'bearer' : 'none',
          fastMode: FAST_MODE,
          fullAccess: FULL_ACCESS
        });
        return;
      }

      // Health remains public for tunnel diagnostics. Everything else is
      // protected whenever MCP_AUTH_TOKEN is configured.
      if (!hasValidAuth(req)) {
        sendAuthError(res);
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

        const heartbeat = setInterval(() => {
          if (res.writableEnded) {
            sessions.delete(sessionId);
            clearInterval(heartbeat);
          } else {
            writeSse(res, 'ping', '');
          }
        }, SSE_HEARTBEAT_MS);

        req.on('close', () => {
          sessions.delete(sessionId);
          clearInterval(heartbeat);
        });
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

  if (KEEP_ALIVE_TIMEOUT_MS > 0) {
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000;
  }

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
  const stdioConfig = {
    transport: 'stdio',
    startup: 'On demand; the MCP client launches the server only when a tool is used.',
    command: 'node',
    args: [path.join(__dirname, 'mcp-server.js'), '--stdio'],
    env: recommendedStdioEnv(),
    note: 'Recommended for local clients to avoid a permanently running MCP HTTP process.'
  };

  return {
    chatgpt: {
      name: 'MCP Local Full Control',
      url: `${baseUrl}/mcp`,
      transport: 'Streamable HTTP',
      auth: AUTH_TOKEN ? 'Bearer token' : 'No authentication',
      note: 'Use HTTP only for remote/web clients. This mode keeps the server running while exposed.'
    },
    claudeWeb: {
      name: 'MCP Local Full Control',
      url: `${baseUrl}/sse`,
      transport: 'SSE',
      auth: AUTH_TOKEN ? 'Bearer token' : 'No authentication',
      note: 'Use SSE/HTTP only when you need a remote web connector.'
    },
    claudeDesktop: stdioConfig,
    localRecommended: stdioConfig,
    allowedRoots: ALLOWED_ROOTS,
    tools: new MCPFileServer().getTools().map((tool) => tool.name),
    fullAccess: FULL_ACCESS,
    bearerTokenConfigured: Boolean(AUTH_TOKEN)
  };
}

function printConfig(baseUrl) {
  const config = buildClientConfig(baseUrl);
  console.error('');
  console.error('=== MCP CLIENT CONFIG ===');
  console.error(`ChatGPT Web URL: ${config.chatgpt.url}`);
  console.error(`Claude Web URL:  ${config.claudeWeb.url}`);
  console.error(`Local stdio:     node ${path.join(__dirname, 'mcp-server.js')} --stdio`);
  console.error('Recommendation:  use stdio for local clients so MCP starts only on demand.');
  if (AUTH_TOKEN) console.error('Bearer token:    configured (value hidden)');
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
