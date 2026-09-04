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
const { createFullControl } = require('./lib/full-control-tools');
const { createExtendedTools } = require('./lib/extended-tools');
const { createAccessPolicy, TOOL_REQUIREMENTS } = require('./lib/access-policy');
const { describeToolStart, describeToolSuccess, friendlyError, humanEvent, redactText } = require('./lib/human-log');
const { DEFAULT_SCOPE, OAuthProvider, normalizeBaseUrl } = require('./lib/oauth-provider');
const PACKAGE_VERSION = require('./package.json').version;

loadDotEnv();

const JSONRPC_VERSION = '2.0';
const MCP_VERSION = process.env.MCP_PROTOCOL_VERSION || '2025-11-25';
const FULL_ACCESS = parseBoolean(process.env.MCP_FULL_ACCESS, false);
const DEFAULT_ROOT = process.env.WORKING_DIR || inferDefaultRoot();
const ALLOWED_ROOTS = FULL_ACCESS
  ? [path.resolve('/')]
  : canonicalizeAllowedRoots(parseAllowedRoots(process.env.ALLOWED_PATHS || DEFAULT_ROOT));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_TOKEN_FILE = resolveRepoPath(process.env.MCP_AUTH_TOKEN_FILE || '.private/bearer-token.txt');
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || readSecretFile(AUTH_TOKEN_FILE);
const AUTH_MODE = normalizeAuthMode(process.env.MCP_AUTH_MODE, AUTH_TOKEN);
const EXPOSURE_MODE = String(process.env.MCP_EXPOSURE_MODE || 'local').trim().toLowerCase();
const CONFIGURED_PUBLIC_BASE_URL = configuredPublicBaseUrl();
const OAUTH_STORE_PATH = resolveRepoPath(process.env.MCP_OAUTH_STORE || '.private/oauth-state.json');
const ACCESS_POLICY = createAccessPolicy(process.env, Object.keys(TOOL_REQUIREMENTS));
const ACCESS_SUMMARY = ACCESS_POLICY.summary(Object.keys(TOOL_REQUIREMENTS));
const OAUTH_PROVIDER = AUTH_MODE === 'oauth'
  ? new OAuthProvider({ storePath: OAUTH_STORE_PATH, accessSummary: ACCESS_SUMMARY })
  : null;
const ACTIVITY_LOG = resolveRepoPath(process.env.ACTIVITY_LOG || '.runtime/activity.ndjson');
const ERROR_LOG = resolveRepoPath(process.env.MCP_ERROR_LOG || '.runtime/errors.log');
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
validateExecutionConfiguration();
validateAuthConfiguration();

class Logger {
  static info(message) {
    humanEvent('SISTEMA', translateSystemMessage(message));
  }

  static error(message, error = null) {
    const detail = error && (error.message || error)
      ? `${message}: ${redactText(error.message || error)}`
      : message;
    humanEvent('ERROR', detail);
    appendPrivateLog(ERROR_LOG, {
      ts: new Date().toISOString(),
      message: redactText(message),
      error: error ? redactText(error.stack || error.message || error) : ''
    });
  }

  static debug(message) {
    if (process.env.DEBUG) humanEvent('DEPURACION', message);
  }

  static activity(event) {
    appendPrivateLog(ACTIVITY_LOG, {
      ts: new Date().toISOString(),
      ...sanitizeActivity(event)
    });
  }

  static toolStart(tool, args, context = {}) {
    const actor = context.principal && context.principal.label
      ? ` Solicitud de ${context.principal.label}.`
      : '';
    humanEvent('ACCION', `${describeToolStart(tool, args)}${actor}`);
  }

  static toolSuccess(tool, result, durationMs) {
    humanEvent('RESULTADO', describeToolSuccess(tool, result, durationMs));
  }

  static toolFailure(tool, error, durationMs) {
    humanEvent('ERROR', `La herramienta ${tool || 'desconocida'} no pudo completar la tarea después de ${Math.max(0, Number(durationMs || 0))} ms: ${friendlyError(error)}`);
  }
}

function appendPrivateLog(filePath, payload) {
  try {
    appendPrivateLine(filePath, JSON.stringify(payload));
  } catch (_) {
    // A logging failure must not interrupt an MCP operation.
  }
}

function sanitizeActivity(value, key = '') {
  if (/token|password|passwd|secret|authorization|api[_-]?key/i.test(key)) {
    return value ? '[OCULTO]' : value;
  }
  if (key === 'args' && Array.isArray(value)) {
    return value.length ? [`${value.length} argumento(s) omitido(s) por seguridad`] : [];
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeActivity(item));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = sanitizeActivity(childValue, childKey);
    }
    return output;
  }
  return typeof value === 'string' ? redactText(value) : value;
}

function translateSystemMessage(message) {
  const text = String(message || '');
  const replacements = [
    [/^MCP HTTP server listening at /, 'Servidor MCP listo en '],
    [/^Allowed roots: /, 'Rutas permitidas: '],
    [/^Auth: OAuth$/, 'Autenticación OAuth activa.'],
    [/^Auth: Bearer token required$/, 'Autenticación mediante token Bearer activa.'],
    [/^Auth: none$/, 'Servidor sin autenticación de aplicación.'],
    [/^MCP stdio server started$/, 'Servidor MCP local iniciado mediante stdio.'],
    [/^Protocol version: /, 'Versión del protocolo MCP: ']
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}
function resolveRepoPath(value) {
  const configured = String(value || '').trim();
  if (!configured) return '';
  return path.isAbsolute(configured) ? configured : path.resolve(__dirname, configured);
}

function readSecretFile(filePath) {
  if (!filePath) return '';
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return '';
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error(`No se pudo leer el archivo privado ${filePath}: ${error.message}`);
  }
}

function normalizeAuthMode(value, legacyToken = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return legacyToken ? 'bearer' : 'none';
  if (['oauth', 'bearer', 'none'].includes(normalized)) return normalized;
  throw new Error(`MCP_AUTH_MODE no válido: ${value}. Usá oauth, bearer o none.`);
}

function configuredPublicBaseUrl() {
  const raw = String(
    process.env.MCP_PUBLIC_BASE_URL
      || process.env.PUBLIC_BASE_URL
      || process.env.NGROK_URL
      || process.env.NGROK_DOMAIN
      || ''
  ).trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return normalizeBaseUrl(withScheme);
  } catch (error) {
    throw new Error(`La URL pública configurada no es válida: ${error.message}`);
  }
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').trim().toLowerCase().replace(/^::ffff:/, '');
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function validateExecutionConfiguration() {
  if (!ACCESS_SUMMARY.runAsRoot || process.platform === 'win32') return;
  const actualUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (actualUid !== 0 && process.env.MCP_TEST_ALLOW_ROOT_FLAG !== '1') {
    throw new Error('MCP_RUN_AS_ROOT=1, pero el proceso no tiene uid 0. Iniciá mediante bash start-mcp.sh para que el launcher aplique sudo.');
  }
}

function validateAuthConfiguration() {
  if (!process.argv.includes('--http')) return;
  if (AUTH_MODE === 'none' && EXPOSURE_MODE !== 'local' && !parseBoolean(process.env.MCP_ALLOW_UNSAFE_NO_AUTH, false)) {
    throw new Error('Publicar sin autenticación requiere una confirmación explícita: MCP_ALLOW_UNSAFE_NO_AUTH=1.');
  }
  if (AUTH_MODE === 'bearer') {
    if (!AUTH_TOKEN) throw new Error('MCP_AUTH_MODE=bearer requiere un token en MCP_AUTH_TOKEN o MCP_AUTH_TOKEN_FILE.');
    if (AUTH_TOKEN.length < 32) throw new Error('El token Bearer debe tener al menos 32 caracteres. Reconfigurá el servidor para generar uno seguro.');
    if (EXPOSURE_MODE !== 'local' && CONFIGURED_PUBLIC_BASE_URL) {
      const publicUrl = new URL(CONFIGURED_PUBLIC_BASE_URL);
      if (publicUrl.protocol !== 'https:' && !parseBoolean(process.env.MCP_ALLOW_INSECURE_HTTP_AUTH, false)) {
        throw new Error('Bearer sobre una URL HTTP pública está bloqueado porque el token viajaría sin cifrado. Usá ngrok/HTTPS o confirmá el modo temporal inseguro desde el asistente.');
      }
    }
  }
  if (AUTH_MODE !== 'oauth') return;
  if (!CONFIGURED_PUBLIC_BASE_URL) {
    throw new Error('OAuth requiere una URL pública estable en NGROK_URL o PUBLIC_BASE_URL.');
  }
  const publicUrl = new URL(CONFIGURED_PUBLIC_BASE_URL);
  const localHttpAllowed = parseBoolean(process.env.MCP_OAUTH_ALLOW_HTTP_LOCALHOST, false) && isLoopbackHostname(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !localHttpAllowed) {
    throw new Error('OAuth requiere una URL pública HTTPS. Para una prueba local explícita puede usarse MCP_OAUTH_ALLOW_HTTP_LOCALHOST=1.');
  }
  OAUTH_PROVIDER.assertConfigured();
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

function canonicalizeAllowedRoots(roots) {
  return [...new Set(roots.map((root) => {
    try { return fs.realpathSync.native(root); }
    catch (error) { throw new Error(`Allowed root cannot be resolved: ${root}: ${error.message}`); }
  }))];
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

    const filePriority = String(process.env.MCP_CONFIG_SOURCE || '').toLowerCase() === 'file';
    if (filePriority || process.env[key] === undefined) process.env[key] = value;
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

function toolSecuritySchemes() {
  if (AUTH_MODE === 'oauth') return [{ type: 'oauth2', scopes: [DEFAULT_SCOPE] }];
  if (AUTH_MODE === 'none') return [{ type: 'noauth' }];
  return [];
}

function buildToolMetadata(title, annotations) {
  const securitySchemes = toolSecuritySchemes();
  return {
    title,
    ...(securitySchemes.length ? { securitySchemes, _meta: { securitySchemes } } : {}),
    annotations: {
      title,
      ...toolAnnotations(annotations)
    }
  };
}

function toolAnnotations(annotations = {}) {
  // Keep safety metadata honest in both restricted and full-access modes.
  // FULL_ACCESS changes filesystem scope; it must not relabel destructive
  // operations as read-only/idempotent.
  return { ...annotations };
}

function envValue(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? String(fallback) : String(value);
}

function recommendedStdioEnv() {
  return {
    MCP_FULL_ACCESS: envValue('MCP_FULL_ACCESS', 0),
    MCP_ACCESS_PROFILE: envValue('MCP_ACCESS_PROFILE', 'developer'),
    MCP_ACCESS_GROUPS: envValue('MCP_ACCESS_GROUPS', ''),
    MCP_TOOL_ALLOWLIST: envValue('MCP_TOOL_ALLOWLIST', ''),
    MCP_TOOL_DENYLIST: envValue('MCP_TOOL_DENYLIST', ''),
    MCP_CRITICAL_CONFIRMATIONS: envValue('MCP_CRITICAL_CONFIRMATIONS', 1),
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

function nearestExistingPath(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function containmentPath(candidate) {
  const existing = nearestExistingPath(candidate);
  const realExisting = fs.realpathSync.native(existing);
  const remainder = path.relative(existing, candidate);
  return path.resolve(realExisting, remainder);
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
  const effectiveCandidate = containmentPath(candidate);
  const root = ALLOWED_ROOTS.find((allowedRoot) => isInside(allowedRoot, effectiveCandidate));
  if (!root) {
    throw new Error(`Path is outside allowed roots or escapes through a symbolic link: ${rawPath}`);
  }

  return {
    fullPath: candidate,
    displayPath: path.relative(root, effectiveCandidate) || '.',
    root
  };
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
    this.extendedTools = createExtendedTools({ resolvePath, buildToolMetadata, textResult });
    this.accessPolicy = ACCESS_POLICY;
    this.allTools = Object.freeze(this.getAllTools());
    this.publishedTools = Object.freeze(this.accessPolicy.filterTools(this.allTools));
  }

  getAllTools() {
    if (this.allTools) return this.allTools;
    const baseTools = [
      {
        name: 'tool_policy_status',
        ...buildToolMetadata('Tool Access Policy', {
          readOnlyHint: true,
          openWorldHint: false
        }),
        description: 'Shows the active access profile, enabled groups, allowed tools and blocked tools without exposing secrets.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
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
    return [...baseTools, ...this.fullControl.tools, ...this.extendedTools.tools];
  }

  getTools() {
    return this.publishedTools || this.accessPolicy.filterTools(this.getAllTools());
  }

  policySummary() {
    return this.accessPolicy.summary(this.getAllTools().map((tool) => tool.name));
  }

  initialize() {
    return {
      protocolVersion: MCP_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: 'mcp-local-control',
        version: PACKAGE_VERSION
      }
    };
  }

  async handle(request, context = {}) {
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
          if (context.authDiscovery && !context.principal) {
            humanEvent('CONEXION', 'Cliente MCP en descubrimiento sin sesión OAuth; las herramientas protegidas siguen bloqueadas.');
          } else {
            humanEvent('CONEXION', `Cliente MCP conectado${context.principal && context.principal.label ? ` mediante ${context.principal.label}` : ''}.`);
          }
          return createResponse(request.id, this.initialize());
        case 'tools/list':
          return createResponse(request.id, { tools: this.getTools() });
        case 'tools/call': {
          const params = request.params || {};
          const toolArgs = params.arguments || {};
          const started = Date.now();
          Logger.toolStart(params.name, toolArgs, context);
          try {
            const result = await this.callTool(params.name, toolArgs);
            const durationMs = Date.now() - started;
            Logger.activity({
              method: 'tools/call',
              tool: params.name,
              args: summarizeToolArgs(params.name, toolArgs),
              actor: context.principal && context.principal.label || '',
              durationMs,
              ok: true
            });
            Logger.toolSuccess(params.name, result, durationMs);
            return createResponse(request.id, result);
          } catch (error) {
            const durationMs = Date.now() - started;
            Logger.activity({
              method: 'tools/call',
              tool: params.name,
              args: summarizeToolArgs(params.name, toolArgs),
              actor: context.principal && context.principal.label || '',
              durationMs,
              ok: false,
              error: error.message
            });
            Logger.toolFailure(params.name, error, durationMs);
            throw error;
          }
        }
        case 'ping':
          return createResponse(request.id, {});
        default:
          return createError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      Logger.error(`Error handling ${request.method}`, error);
      return createError(request.id, -32603, error.message);
    }
  }

  async callTool(name, args) {
    this.accessPolicy.assertAllowed(name);
    switch (name) {
      case 'tool_policy_status':
        return textResult(this.policySummary());
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
        const extended = await this.extendedTools.callTool(name, args);
        if (extended !== null) return extended;
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

function timingSafeHeaderEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicBaseUrl(req) {
  if (CONFIGURED_PUBLIC_BASE_URL) return CONFIGURED_PUBLIC_BASE_URL;
  const trustedProxy = isLoopbackAddress(req.socket.remoteAddress);
  const forwardedProto = trustedProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const forwardedHost = trustedProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = forwardedHost || req.headers.host || `${HOST}:${PORT}`;
  try {
    return normalizeBaseUrl(`${proto}://${host}`);
  } catch (_) {
    return `http://${HOST}:${PORT}`;
  }
}

function authenticateHttpRequest(req, baseUrl) {
  if (AUTH_MODE === 'none') {
    return {
      ok: true,
      principal: {
        subject: 'anonymous',
        clientId: 'anonymous',
        clientName: 'conexión sin autenticación',
        label: 'una conexión sin autenticación'
      }
    };
  }

  if (AUTH_MODE === 'oauth') {
    return OAUTH_PROVIDER.authenticateRequest(req, baseUrl);
  }

  const expected = `Bearer ${AUTH_TOKEN}`;
  const header = String(req.headers.authorization || '');
  if (!timingSafeHeaderEqual(header, expected)) return { ok: false, reason: header ? 'invalid_token' : 'missing_token' };
  return {
    ok: true,
    principal: {
      subject: 'bearer-user',
      clientId: 'static-bearer',
      clientName: 'cliente con token Bearer',
      label: 'un cliente autenticado con token Bearer'
    }
  };
}

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-resource-policy': 'same-origin',
    'strict-transport-security': 'max-age=31536000'
  };
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

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...securityHeaders(),
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function sendEmpty(res, statusCode = 202, extraHeaders = {}) {
  res.writeHead(statusCode, { ...securityHeaders(), ...corsHeaders(), ...extraHeaders });
  res.end();
}

function sendAuthError(req, res, baseUrl, authResult) {
  if (AUTH_MODE === 'oauth') {
    OAUTH_PROVIDER.sendProtectedResourceError(req, res, baseUrl, authResult && authResult.reason);
    return;
  }
  humanEvent('SEGURIDAD', 'Se rechazó una solicitud con token Bearer ausente o incorrecto.');
  sendJson(
    res,
    401,
    { error: 'invalid_token', error_description: 'Falta el token Bearer o no es válido.' },
    { 'www-authenticate': 'Bearer realm="MCP Local Full Control"' }
  );
}

function oauthToolAuthResult(baseUrl, reason = 'missing_token') {
  const challenge = OAUTH_PROVIDER.protectedResourceChallenge(baseUrl, reason);
  return {
    content: [{ type: 'text', text: 'Authentication required: connect this MCP app with OAuth to continue.' }],
    _meta: { 'mcp/www_authenticate': [challenge] },
    isError: true
  };
}

async function handleOauthDiscoveryRequest(mcp, request, baseUrl) {
  if (!request || request.jsonrpc !== JSONRPC_VERSION) return createError(request && request.id, -32600, 'Invalid JSON-RPC request');
  if (request.id === undefined) return null;
  if (request.method === 'initialize' || request.method === 'tools/list' || request.method === 'ping') {
    return mcp.handle(request, { principal: null, baseUrl, authDiscovery: true });
  }
  if (request.method === 'tools/call') {
    return createResponse(request.id, oauthToolAuthResult(baseUrl, 'missing_token'));
  }
  return createError(request.id, -32601, `Method not found: ${request.method}`);
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
      const baseUrl = publicBaseUrl(req);

      if (req.method === 'OPTIONS') {
        sendEmpty(res, 204);
        return;
      }

      if (AUTH_MODE === 'oauth' && await OAUTH_PROVIDER.handle(req, res, url, baseUrl)) {
        return;
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          version: PACKAGE_VERSION,
          launchMode: process.env.MCP_LAUNCH_MODE || 'direct',
          transport: ['streamable-http', 'sse'],
          auth: AUTH_MODE
        });
        return;
      }

      const authResult = authenticateHttpRequest(req, baseUrl);

      if (AUTH_MODE === 'oauth' && !authResult.ok && authResult.reason === 'missing_token' && url.pathname === '/mcp' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const requests = Array.isArray(body) ? body : [body];
        const responses = [];
        for (const request of requests) {
          const response = await handleOauthDiscoveryRequest(mcp, request, baseUrl);
          if (response) responses.push(response);
        }
        if (responses.length === 0) sendEmpty(res, 202);
        else sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
        return;
      }

      if (AUTH_MODE === 'oauth' && !authResult.ok && authResult.reason === 'missing_token' && url.pathname === '/tools' && req.method === 'GET') {
        sendJson(res, 200, { tools: mcp.getTools() });
        return;
      }

      if (!authResult.ok) {
        sendAuthError(req, res, baseUrl, authResult);
        return;
      }
      const requestContext = { principal: authResult.principal, baseUrl };

      if (url.pathname === '/config' && req.method === 'GET') {
        sendJson(res, 200, buildClientConfig(baseUrl, mcp));
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
          const response = await mcp.handle(request, requestContext);
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
        sessions.set(sessionId, { stream: res, context: requestContext });
        writeSse(res, 'endpoint', `/messages?sessionId=${sessionId}`);
        humanEvent('CONEXION', `Se abrió una sesión MCP por SSE para ${authResult.principal.label}.`);

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
        const session = sessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown SSE session' });
          return;
        }

        const response = await mcp.handle(await readJsonBody(req), session.context || requestContext);
        if (response) writeSse(session.stream, 'message', response);
        sendEmpty(res, 202);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      Logger.error('Falló una solicitud HTTP', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'No se pudo completar la solicitud.' });
      else if (!res.writableEnded) res.end();
    }
  });

  if (KEEP_ALIVE_TIMEOUT_MS > 0) {
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000;
  }

  server.on('error', (error) => {
    Logger.error(`El servidor HTTP no pudo escuchar en ${HOST}:${PORT}`, error);
    process.exitCode = 1;
  });

  server.listen(PORT, HOST, () => {
    Logger.info(`MCP HTTP server listening at http://${HOST}:${PORT}`);
    Logger.info(`Allowed roots: ${rootForDisplay()}`);
    Logger.info(`Auth: ${AUTH_MODE === 'oauth' ? 'OAuth' : AUTH_MODE === 'bearer' ? 'Bearer token required' : 'none'}`);
    if (AUTH_MODE === 'none' && EXPOSURE_MODE !== 'local') {
      humanEvent('SEGURIDAD', 'Advertencia: el MCP está publicado sin autenticación. Usá OAuth para una instalación permanente.');
    }
    printConfig(CONFIGURED_PUBLIC_BASE_URL || `http://${HOST}:${PORT}`, mcp);
  });
}

function prepareSse(res) {
  res.writeHead(200, {
    ...securityHeaders(),
    ...corsHeaders(),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  res.write('\n');
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

function authDisplayName() {
  if (AUTH_MODE === 'oauth') return 'OAuth 2.1 con PKCE';
  if (AUTH_MODE === 'bearer') return 'Token Bearer estático';
  return 'Sin autenticación';
}

function buildClientConfig(baseUrl, mcp = null) {
  const normalizedBase = (() => {
    try { return normalizeBaseUrl(baseUrl); } catch (_) { return String(baseUrl || '').replace(/\/+$/, ''); }
  })();
  const stdioConfig = {
    transport: 'stdio',
    startup: 'Bajo demanda: el cliente local inicia el servidor cuando necesita una herramienta.',
    command: 'node',
    args: [path.join(__dirname, 'mcp-server.js'), '--stdio'],
    env: recommendedStdioEnv(),
    note: 'Recomendado para clientes instalados en la misma computadora.'
  };

  const server = mcp || new MCPFileServer();
  return {
    chatgpt: {
      name: 'MCP Local Full Control',
      url: `${normalizedBase}/mcp`,
      transport: 'Streamable HTTP',
      auth: authDisplayName(),
      oauthDiscovery: AUTH_MODE === 'oauth' ? `${normalizedBase}/.well-known/oauth-protected-resource/mcp` : '',
      note: AUTH_MODE === 'oauth'
        ? 'En ChatGPT elegí Mixtas. Al invocar una herramienta protegida, Actualizar acceso abre la autorización OAuth de este servidor.'
        : AUTH_MODE === 'none'
          ? 'Elegí Sin autenticación. No se recomienda dejar este modo publicado permanentemente.'
          : 'Usá el token Bearer configurado localmente; el valor nunca se expone por este endpoint.'
    },
    claudeWeb: {
      name: 'MCP Local Full Control',
      url: `${normalizedBase}/sse`,
      transport: 'SSE',
      auth: authDisplayName()
    },
    claudeDesktop: stdioConfig,
    localRecommended: stdioConfig,
    allowedRoots: ALLOWED_ROOTS,
    tools: server.getTools().map((tool) => tool.name),
    fullAccess: FULL_ACCESS,
    accessPolicy: server.policySummary(),
    authMode: AUTH_MODE,
    bearerTokenConfigured: AUTH_MODE === 'bearer' && Boolean(AUTH_TOKEN),
    oauth: AUTH_MODE === 'oauth' ? OAUTH_PROVIDER.authSummary() : null
  };
}

function printConfig(baseUrl, mcp = null) {
  const config = buildClientConfig(baseUrl, mcp);
  humanEvent('CONFIGURACION', `URL para ChatGPT: ${config.chatgpt.url}`);
  humanEvent('CONFIGURACION', `Autenticación seleccionada: ${config.chatgpt.auth}.`);
  humanEvent('CONFIGURACION', `Rutas permitidas: ${rootForDisplay()}.`);
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
