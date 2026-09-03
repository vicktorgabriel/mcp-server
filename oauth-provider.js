#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { URL, URLSearchParams } = require('url');
const { humanEvent, redactText } = require('./human-log');
const { applyPrivateOwnership, ensurePrivateDirectory } = require('./private-owner');

const DEFAULT_SCOPE = 'mcp:tools';
const OFFLINE_SCOPE = 'offline_access';
const SUPPORTED_SCOPES = new Set([DEFAULT_SCOPE, OFFLINE_SCOPE]);
const STORE_VERSION = 1;
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function randomValue(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function tokenHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('base64url');
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createPasswordHash(password) {
  const raw = String(password || '');
  if (raw.length < 12) throw new Error('La contraseña OAuth debe tener al menos 12 caracteres.');
  const salt = crypto.randomBytes(16);
  const N = 32768;
  const r = 8;
  const p = 1;
  const derived = crypto.scryptSync(raw, salt, 32, { N, r, p, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyPassword(password, encoded) {
  try {
    const [algorithm, nText, rText, pText, saltText, expectedText] = String(encoded || '').split('$');
    if (algorithm !== 'scrypt') return false;
    const N = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (![N, r, p].every(Number.isInteger) || N < 16384 || N > 131072 || r < 1 || r > 32 || p < 1 || p > 8) {
      return false;
    }
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(expectedText, 'base64url');
    const actual = crypto.scryptSync(String(password || ''), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

function emptyState() {
  return {
    version: STORE_VERSION,
    admin: null,
    clients: {},
    authorizationTransactions: {},
    authorizationCodes: {},
    accessTokens: {},
    refreshTokens: {},
    usedRefreshTokens: {}
  };
}

function normalizeState(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    ...emptyState(),
    ...source,
    version: STORE_VERSION,
    clients: source.clients && typeof source.clients === 'object' ? source.clients : {},
    authorizationTransactions: source.authorizationTransactions && typeof source.authorizationTransactions === 'object'
      ? source.authorizationTransactions : {},
    authorizationCodes: source.authorizationCodes && typeof source.authorizationCodes === 'object'
      ? source.authorizationCodes : {},
    accessTokens: source.accessTokens && typeof source.accessTokens === 'object' ? source.accessTokens : {},
    refreshTokens: source.refreshTokens && typeof source.refreshTokens === 'object' ? source.refreshTokens : {},
    usedRefreshTokens: source.usedRefreshTokens && typeof source.usedRefreshTokens === 'object' ? source.usedRefreshTokens : {}
  };
}

class OAuthStateStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.state = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return normalizeState(parsed);
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw new Error(`No se pudo leer el estado OAuth: ${error.message}`);
    }
  }

  reload() {
    this.state = this.load();
    return this.state;
  }

  save() {
    const directory = path.dirname(this.filePath);
    ensurePrivateDirectory(directory, 0o700);
    const temporary = `${this.filePath}.${process.pid}.${randomValue(5)}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    applyPrivateOwnership(temporary, 0o600);
    fs.renameSync(temporary, this.filePath);
    applyPrivateOwnership(this.filePath, 0o600);
  }

  cleanup() {
    const now = nowSeconds();
    let changed = false;
    for (const collectionName of ['authorizationTransactions', 'authorizationCodes', 'accessTokens', 'refreshTokens', 'usedRefreshTokens']) {
      const collection = this.state[collectionName];
      for (const [key, record] of Object.entries(collection)) {
        if (!record || Number(record.expiresAt || 0) <= now) {
          delete collection[key];
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }
}

function configureOAuthAdmin(storePath, username, password) {
  const user = String(username || '').trim();
  if (!/^[A-Za-z0-9._@-]{2,80}$/.test(user)) {
    throw new Error('El usuario OAuth debe tener entre 2 y 80 caracteres y usar letras, números, punto, guion, guion bajo o @.');
  }

  const store = new OAuthStateStore(storePath);
  store.state.admin = {
    username: user,
    passwordHash: createPasswordHash(password),
    updatedAt: new Date().toISOString()
  };
  store.state.authorizationTransactions = {};
  store.state.authorizationCodes = {};
  store.state.accessTokens = {};
  store.state.refreshTokens = {};
  store.state.usedRefreshTokens = {};
  store.save();
  return { username: user, storePath: store.filePath };
}

function normalizeBaseUrl(value) {
  const parsed = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('La URL pública debe usar HTTP o HTTPS.');
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (parsed.pathname !== '/') throw new Error('La URL pública OAuth no debe incluir una ruta.');
  return parsed.origin;
}

function normalizeResource(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/mcp`;
}

function parseScopes(scopeText, { defaultOffline = true } = {}) {
  const supplied = String(scopeText || '').trim();
  const scopes = supplied ? supplied.split(/\s+/).filter(Boolean) : [DEFAULT_SCOPE, ...(defaultOffline ? [OFFLINE_SCOPE] : [])];
  const unique = [...new Set(scopes)];
  if (!unique.includes(DEFAULT_SCOPE)) unique.unshift(DEFAULT_SCOPE);
  const unsupported = unique.filter((scope) => !SUPPORTED_SCOPES.has(scope));
  if (unsupported.length > 0) throw new OAuthError('invalid_scope', `Scope no soportado: ${unsupported.join(', ')}`);
  return unique;
}

function isSafeRedirectUri(raw) {
  try {
    const parsed = new URL(String(raw || ''));
    if (parsed.hash) return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch (_) {
    return false;
  }
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function parseCimdHosts(value) {
  const raw = String(value || 'chatgpt.com').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return new Set(raw.length ? raw : ['chatgpt.com']);
}

function validateCimdClientId(raw, allowedHosts) {
  let parsed;
  try { parsed = new URL(String(raw || '')); }
  catch (_) { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.hash || parsed.search) return null;
  const hostname = parsed.hostname.toLowerCase();
  if (net.isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return null;
  if (!allowedHosts.has(hostname)) return null;
  if (!parsed.pathname || parsed.pathname === '/' || parsed.pathname.includes('/../') || parsed.pathname.includes('/./')) return null;
  return parsed.toString();
}

function officialChatGptCimdFallback(rawClientId) {
  let parsed;
  try { parsed = new URL(String(rawClientId || '')); }
  catch (_) { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'chatgpt.com' || parsed.search || parsed.hash) return null;

  let redirectUri = '';
  if (parsed.pathname === '/oauth/client.json') {
    redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  } else {
    const match = parsed.pathname.match(/^\/oauth\/([A-Za-z0-9_-]{6,256})\/client\.json$/);
    if (!match) return null;
    redirectUri = `https://chatgpt.com/connector/oauth/${match[1]}`;
  }

  return {
    client_id: parsed.toString(),
    client_uri: 'https://chatgpt.com/',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'ChatGPT',
    token_endpoint_auth_signing_alg: 'RS256',
    jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
    _mcpFallback: true
  };
}

async function defaultCimdFetcher(url, { timeoutMs = 5000, maxBytes = 32768 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'MCP-Server OAuth client metadata fetcher' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('documento demasiado grande');
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    let raw = '';
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error('documento demasiado grande');
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } else {
      raw = await response.text();
      if (Buffer.byteLength(raw) > maxBytes) throw new Error('documento demasiado grande');
    }
    return JSON.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}

function validateSameOriginHttpsUrl(raw, expectedOrigin) {
  try {
    const parsed = new URL(String(raw || ''));
    if (parsed.protocol !== 'https:' || parsed.origin !== expectedOrigin) return '';
    if (parsed.username || parsed.password || parsed.hash || parsed.search) return '';
    if (!parsed.pathname || parsed.pathname === '/' || parsed.pathname.includes('/../') || parsed.pathname.includes('/./')) return '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function decodeJwtPart(value, label) {
  try {
    return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
  } catch (_) {
    throw new OAuthError('invalid_client', `La aserción private_key_jwt contiene ${label} inválido.`, 401);
  }
}

function jwtAudienceMatches(audience, expectedValues) {
  const values = Array.isArray(audience) ? audience.map(String) : [String(audience || '')];
  return values.some((value) => expectedValues.some((expected) => timingSafeTextEqual(value, expected)));
}

function detectTokenAuthMethod(req, form) {
  const authorization = String(req.headers.authorization || '');
  if (form.get('client_assertion')) return 'private_key_jwt';
  if (/^Basic\s+/i.test(authorization)) return 'client_secret_basic';
  if (form.get('client_secret')) return 'client_secret_post';
  return 'none';
}

function safeTokenRequestSummary(req, form, issuer) {
  const clientId = String(form.get('client_id') || '');
  const redirectUri = String(form.get('redirect_uri') || '');
  let redirect = '';
  try {
    const parsed = new URL(redirectUri);
    redirect = `${parsed.origin}${parsed.pathname}`.slice(0, 256);
  } catch (_) {}
  const resources = form.getAll('resource');
  const expectedResource = normalizeResource(issuer);
  return {
    grantType: String(form.get('grant_type') || '').slice(0, 64),
    client: clientId === 'https://chatgpt.com/oauth/client.json'
      ? 'ChatGPT CIMD'
      : clientId.startsWith('https://chatgpt.com/oauth/')
        ? 'ChatGPT CIMD con callback específico'
        : clientId ? 'cliente OAuth registrado' : 'client_id ausente',
    authMethod: detectTokenAuthMethod(req, form),
    redirectUri: redirect || 'ausente/inválida',
    resourceCount: resources.length,
    resourceMatches: resources.length === 1 && timingSafeTextEqual(String(resources[0]).replace(/\/+$/, ''), expectedResource),
    codePresent: Boolean(form.get('code')),
    codeVerifierPresent: Boolean(form.get('code_verifier')),
    codeVerifierLength: String(form.get('code_verifier') || '').length,
    assertionPresent: Boolean(form.get('client_assertion')),
    assertionTypePresent: Boolean(form.get('client_assertion_type'))
  };
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isLoopbackAddress(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/^::ffff:/, '');
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function remoteAddress(req) {
  const peer = String(req.socket.remoteAddress || '').trim();
  if (isLoopbackAddress(peer)) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(-1)[0];
    if (forwarded) return forwarded.slice(0, 128);
  }
  return (peer || 'desconocido').slice(0, 128);
}

function securityHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-resource-policy': 'same-origin',
    'strict-transport-security': 'max-age=31536000',
    ...extra
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'access-control-allow-origin': '*',
    vary: 'Origin',
    ...extraHeaders
  }));
  res.end(body);
}

function sendHtml(res, statusCode, body) {
  const headers = securityHeaders({
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'cross-origin-resource-policy': 'cross-origin',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com https://chat.openai.com; base-uri 'none'"
  });
  // ChatGPT's current plugin-linking UI may render the OAuth document inside its
  // own browser surface. X-Frame-Options: DENY would block that even though the
  // request successfully reached /oauth/authorize. CSP above restricts framing
  // to ChatGPT origins instead of allowing arbitrary embedding.
  delete headers['x-frame-options'];
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendRedirect(res, location) {
  res.writeHead(302, securityHeaders({ location, 'cache-control': 'no-store', pragma: 'no-cache' }));
  res.end();
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new OAuthError('invalid_request', 'La solicitud supera el tamaño permitido.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readForm(req, limit) {
  return new URLSearchParams(await readBody(req, limit));
}

async function readJson(req, limit) {
  try {
    const raw = await readBody(req, limit);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError('invalid_client_metadata', `JSON inválido: ${error.message}`);
  }
}

function appendRedirectParams(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

class OAuthError extends Error {
  constructor(code, description, statusCode = 400) {
    super(description || code);
    this.name = 'OAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class SlidingWindowLimiter {
  constructor(maxAttempts, windowSeconds, blockSeconds = windowSeconds, maxEntries = 4096) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowSeconds * 1000;
    this.blockMs = blockSeconds * 1000;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      const latest = Math.max(Number(entry.lastSeen || 0), Number(entry.blockedUntil || 0), ...(entry.timestamps || [0]));
      if (!latest || now - latest > Math.max(this.windowMs, this.blockMs) * 2) this.entries.delete(key);
    }
    if (this.entries.size <= this.maxEntries) return;
    const oldest = [...this.entries.entries()]
      .sort((left, right) => Number(left[1].lastSeen || 0) - Number(right[1].lastSeen || 0))
      .slice(0, this.entries.size - this.maxEntries);
    for (const [key] of oldest) this.entries.delete(key);
  }

  status(key) {
    const now = Date.now();
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true, remaining: this.maxAttempts };
    if (entry.blockedUntil && entry.blockedUntil > now) {
      return { allowed: false, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000), remaining: 0 };
    }
    entry.timestamps = entry.timestamps.filter((timestamp) => now - timestamp < this.windowMs);
    entry.lastSeen = now;
    if (entry.timestamps.length >= this.maxAttempts) {
      entry.blockedUntil = now + this.blockMs;
      return { allowed: false, retryAfter: Math.ceil(this.blockMs / 1000), remaining: 0 };
    }
    return { allowed: true, remaining: this.maxAttempts - entry.timestamps.length };
  }

  recordAttempt(key) {
    const now = Date.now();
    this.prune(now);
    const entry = this.entries.get(key) || { timestamps: [], blockedUntil: 0, lastSeen: now };
    entry.timestamps = entry.timestamps.filter((timestamp) => now - timestamp < this.windowMs);
    entry.timestamps.push(now);
    entry.lastSeen = now;
    if (entry.timestamps.length >= this.maxAttempts) entry.blockedUntil = now + this.blockMs;
    this.entries.set(key, entry);
  }

  recordFailure(key) {
    this.recordAttempt(key);
  }

  clear(key) {
    this.entries.delete(key);
  }
}

class OAuthProvider {
  constructor(options = {}) {
    this.store = new OAuthStateStore(options.storePath || path.join(__dirname, '.private', 'oauth-state.json'));
    this.accessTokenTtl = Number(options.accessTokenTtl || process.env.MCP_OAUTH_ACCESS_TOKEN_TTL || 3600);
    this.refreshTokenTtl = Number(options.refreshTokenTtl || process.env.MCP_OAUTH_REFRESH_TOKEN_TTL || 30 * 24 * 3600);
    this.codeTtl = Number(options.codeTtl || process.env.MCP_OAUTH_CODE_TTL || 300);
    this.transactionTtl = Number(options.transactionTtl || 600);
    this.dynamicRegistration = options.dynamicRegistration !== undefined
      ? Boolean(options.dynamicRegistration)
      : String(process.env.MCP_OAUTH_DYNAMIC_REGISTRATION || '1') !== '0';
    this.responseIssEnabled = options.responseIssEnabled !== undefined
      ? Boolean(options.responseIssEnabled)
      : String(process.env.MCP_OAUTH_RESPONSE_ISS || '0') === '1';
    this.cimdEnabled = options.cimdEnabled !== undefined
      ? Boolean(options.cimdEnabled)
      : String(process.env.MCP_OAUTH_CIMD || '0') !== '0';
    this.cimdHosts = options.cimdHosts instanceof Set
      ? options.cimdHosts
      : parseCimdHosts(options.cimdHosts || process.env.MCP_OAUTH_CIMD_HOSTS || 'chatgpt.com');
    this.cimdFetcher = typeof options.cimdFetcher === 'function' ? options.cimdFetcher : defaultCimdFetcher;
    this.cimdTimeoutMs = boundedNumber(options.cimdTimeoutMs || process.env.MCP_OAUTH_CIMD_TIMEOUT_MS, 5000, 1000, 15000);
    this.cimdMaxBytes = boundedNumber(options.cimdMaxBytes || process.env.MCP_OAUTH_CIMD_MAX_BYTES, 32768, 4096, 262144);
    this.cimdCacheTtl = boundedNumber(options.cimdCacheTtl || process.env.MCP_OAUTH_CIMD_CACHE_TTL, 21600, 60, 86400);
    this.privateKeyJwtEnabled = options.privateKeyJwtEnabled !== undefined
      ? Boolean(options.privateKeyJwtEnabled)
      : String(process.env.MCP_OAUTH_PRIVATE_KEY_JWT || '0') === '1';
    this.jwksFetcher = typeof options.jwksFetcher === 'function' ? options.jwksFetcher : this.cimdFetcher;
    this.jwksCacheTtl = boundedNumber(options.jwksCacheTtl || process.env.MCP_OAUTH_JWKS_CACHE_TTL, 3600, 60, 21600);
    this.jwksCache = new Map();
    this.clientAssertionReplay = new Map();
    this.loginLimiter = new SlidingWindowLimiter(5, 600, 900);
    this.registrationLimiter = new SlidingWindowLimiter(20, 3600, 3600);
    this.authorizationLimiter = new SlidingWindowLimiter(60, 600, 600);
    this.tokenLimiter = new SlidingWindowLimiter(60, 600, 600);
    this.maxClients = Number(options.maxClients || 200);
    this.maxTransactions = Number(options.maxTransactions || 1000);
    this.accessSummary = options.accessSummary && typeof options.accessSummary === 'object'
      ? options.accessSummary
      : { profile: 'unknown', label: 'No informado', allowedToolCount: 0, warnings: [] };
    this.store.cleanup();
  }

  refreshStore() {
    this.store.reload();
    this.store.cleanup();
  }

  isConfigured() {
    const admin = this.store.state.admin;
    return Boolean(admin && admin.username && admin.passwordHash);
  }

  assertConfigured() {
    if (!this.isConfigured()) {
      throw new Error('OAuth está seleccionado, pero no hay una cuenta administradora. Ejecutá ./mcpctl.sh configure.');
    }
  }

  metadata(baseUrl) {
    const issuer = normalizeBaseUrl(baseUrl);
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      client_id_metadata_document_supported: this.cimdEnabled,
      registration_endpoint: this.dynamicRegistration ? `${issuer}/oauth/register` : undefined,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      ...(this.responseIssEnabled ? { authorization_response_iss_parameter_supported: true } : {}),
      token_endpoint_auth_methods_supported: [
        'none',
        ...(this.privateKeyJwtEnabled ? ['private_key_jwt'] : []),
        'client_secret_basic',
        'client_secret_post'
      ],
      revocation_endpoint_auth_methods_supported: [
        'none',
        ...(this.privateKeyJwtEnabled ? ['private_key_jwt'] : []),
        'client_secret_basic',
        'client_secret_post'
      ],
      code_challenge_methods_supported: ['S256'],
      resource_indicators_supported: true,
      scopes_supported: [DEFAULT_SCOPE, OFFLINE_SCOPE],
      service_documentation: `${issuer}/oauth/help`
    };
  }

  protectedResourceMetadata(baseUrl) {
    const issuer = normalizeBaseUrl(baseUrl);
    return {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [DEFAULT_SCOPE, OFFLINE_SCOPE],
      resource_documentation: `${issuer}/oauth/help`
    };
  }

  authSummary() {
    this.refreshStore();
    const admin = this.store.state.admin;
    return {
      configured: this.isConfigured(),
      username: admin ? admin.username : '',
      clients: Object.keys(this.store.state.clients).length,
      activeAccessTokens: Object.keys(this.store.state.accessTokens).length,
      activeRefreshTokens: Object.keys(this.store.state.refreshTokens).length,
      dynamicRegistration: this.dynamicRegistration,
      clientIdMetadataDocuments: this.cimdEnabled,
      privateKeyJwt: this.privateKeyJwtEnabled,
      authorizationResponseIssuer: this.responseIssEnabled
    };
  }

  authenticateRequest(req, baseUrl) {
    const header = String(req.headers.authorization || '');
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return { ok: false, reason: 'missing_token' };

    this.refreshStore();
    const record = this.store.state.accessTokens[tokenHash(match[1])];
    if (!record) return { ok: false, reason: 'invalid_token' };
    if (Number(record.expiresAt || 0) <= nowSeconds()) return { ok: false, reason: 'expired_token' };

    const expectedResource = normalizeResource(baseUrl);
    if (!timingSafeTextEqual(record.resource, expectedResource)) {
      return { ok: false, reason: 'wrong_audience' };
    }
    if (!String(record.scope || '').split(/\s+/).includes(DEFAULT_SCOPE)) {
      return { ok: false, reason: 'insufficient_scope' };
    }

    const client = this.store.state.clients[record.clientId] || {};
    return {
      ok: true,
      principal: {
        subject: record.subject,
        clientId: record.clientId,
        clientName: client.clientName || record.clientId,
        scope: record.scope,
        resource: record.resource,
        label: `usuario OAuth ${record.subject} mediante ${client.clientName || 'cliente MCP'}`
      }
    };
  }

  protectedResourceChallenge(baseUrl, reason = 'invalid_token') {
    const issuer = normalizeBaseUrl(baseUrl);
    const metadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;
    const error = reason === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token';
    const description = reason === 'missing_token'
      ? 'Se requiere autorización OAuth.'
      : reason === 'wrong_audience'
        ? 'El token no fue emitido para este servidor MCP.'
        : reason === 'expired_token'
          ? 'El token OAuth venció.'
          : reason === 'insufficient_scope'
            ? 'El token no posee el permiso requerido.'
            : 'El token OAuth no es válido.';
    return `Bearer resource_metadata="${metadataUrl}", scope="${DEFAULT_SCOPE}", error="${error}", error_description="${description}"`;
  }

  sendProtectedResourceError(req, res, baseUrl, reason = 'invalid_token') {
    const challenge = this.protectedResourceChallenge(baseUrl, reason);
    const error = reason === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token';
    const description = reason === 'missing_token'
      ? 'Se requiere autorización OAuth.'
      : reason === 'wrong_audience'
        ? 'El token no fue emitido para este servidor MCP.'
        : reason === 'expired_token'
          ? 'El token OAuth venció.'
          : reason === 'insufficient_scope'
            ? 'El token no posee el permiso requerido.'
            : 'El token OAuth no es válido.';
    const statusCode = reason === 'insufficient_scope' ? 403 : 401;
    humanEvent('SEGURIDAD', `Acceso rechazado desde ${remoteAddress(req)}: ${description}`);
    sendJson(res, statusCode, { error, error_description: description }, { 'www-authenticate': challenge });
  }

  async handle(req, res, url, baseUrl) {
    const pathname = url.pathname;
    const issuer = normalizeBaseUrl(baseUrl);

    if ((pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp') && req.method === 'GET') {
      sendJson(res, 200, this.protectedResourceMetadata(issuer));
      return true;
    }

    if (pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      sendJson(res, 200, this.metadata(issuer));
      return true;
    }

    if (pathname === '/oauth/help' && req.method === 'GET') {
      sendHtml(res, 200, this.renderHelp(issuer));
      return true;
    }

    if (pathname === '/oauth/register' && req.method === 'POST') {
      await this.handleRegistration(req, res, issuer);
      return true;
    }

    if (pathname === '/oauth/authorize' && req.method === 'GET') {
      await this.handleAuthorizationGet(req, res, url, issuer);
      return true;
    }

    if (pathname === '/oauth/authorize' && req.method === 'POST') {
      await this.handleAuthorizationPost(req, res, issuer);
      return true;
    }

    if (pathname === '/oauth/token' && req.method === 'POST') {
      await this.handleToken(req, res, issuer);
      return true;
    }

    if (pathname === '/oauth/revoke' && req.method === 'POST') {
      await this.handleRevoke(req, res, issuer);
      return true;
    }

    return false;
  }

  accessRiskNotice() {
    const risks = [];
    if (this.accessSummary.runAsRoot) {
      risks.push('Este MCP se ejecuta como root y puede modificar todo el sistema.');
    }
    if (this.accessSummary.criticalConfirmations === false) {
      risks.push('Las confirmaciones adicionales para borrado, paquetes, firewall, montajes, contenedores y energía están desactivadas.');
    }
    if (risks.length === 0) return '';
    return `<div class="risk"><strong>Configuración de riesgo alto:</strong><ul>${risks.map((risk) => `<li>${htmlEscape(risk)}</li>`).join('')}</ul></div>`;
  }

  renderHelp(issuer) {
    return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP OAuth</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:4rem auto;padding:0 1.2rem;color:#18212b}code{background:#eef2f6;padding:.15rem .35rem;border-radius:.3rem}h1{font-size:1.7rem}.risk{background:#fff1f1;border:1px solid #e4a1a1;color:#821515;padding:12px 16px;border-radius:10px;margin:16px 0}.risk ul{margin-bottom:0}</style></head>
<body><h1>Autenticación OAuth del servidor MCP</h1><p>Este servidor usa OAuth 2.1 con autorización por código, PKCE S256 y refresh tokens.</p>
<p>Endpoint MCP: <code>${htmlEscape(`${issuer}/mcp`)}</code></p>
<p>Perfil publicado: <strong>${htmlEscape(this.accessSummary.label || this.accessSummary.profile)}</strong> (${Number(this.accessSummary.allowedToolCount || 0)} herramientas).</p>
${this.accessRiskNotice()}
<p>Agregalo desde ChatGPT en modo desarrollador y elegí OAuth. ChatGPT descubrirá automáticamente estos endpoints.</p></body></html>`;
  }

  pruneUnusedClients(targetCount = this.maxClients - 1) {
    const activeClientIds = new Set();
    for (const collectionName of ['authorizationTransactions', 'authorizationCodes', 'accessTokens', 'refreshTokens']) {
      for (const record of Object.values(this.store.state[collectionName] || {})) {
        if (record && record.clientId) activeClientIds.add(record.clientId);
      }
    }
    const clients = Object.values(this.store.state.clients)
      .sort((left, right) => Number(left.issuedAt || 0) - Number(right.issuedAt || 0));
    for (const client of clients) {
      if (Object.keys(this.store.state.clients).length <= targetCount) break;
      if (!activeClientIds.has(client.clientId)) delete this.store.state.clients[client.clientId];
    }
  }

  async handleRegistration(req, res) {
    if (!this.dynamicRegistration) throw new OAuthError('invalid_client_metadata', 'El registro dinámico está deshabilitado.', 403);
    const ip = remoteAddress(req);
    const limit = this.registrationLimiter.status(ip);
    if (!limit.allowed) {
      sendJson(res, 429, { error: 'temporarily_unavailable', error_description: 'Demasiados registros recientes.' }, { 'retry-after': String(limit.retryAfter) });
      return;
    }
    this.registrationLimiter.recordAttempt(ip);

    let input;
    try {
      input = await readJson(req, 64 * 1024);
      const redirectUris = Array.isArray(input.redirect_uris) ? [...new Set(input.redirect_uris.map(String))] : [];
      if (redirectUris.length < 1 || redirectUris.length > 10 || redirectUris.some((uri) => uri.length > 2048 || !isSafeRedirectUri(uri))) {
        throw new OAuthError('invalid_redirect_uri', 'redirect_uris debe contener entre 1 y 10 direcciones HTTPS o localhost válidas.');
      }

      const grantTypes = Array.isArray(input.grant_types) ? [...new Set(input.grant_types.map(String))] : ['authorization_code', 'refresh_token'];
      const responseTypes = Array.isArray(input.response_types) ? [...new Set(input.response_types.map(String))] : ['code'];
      if (!grantTypes.includes('authorization_code') || grantTypes.some((value) => !['authorization_code', 'refresh_token'].includes(value))) {
        throw new OAuthError('invalid_client_metadata', 'grant_types no es compatible.');
      }
      if (!grantTypes.includes('refresh_token')) grantTypes.push('refresh_token');
      if (!responseTypes.includes('code') || responseTypes.some((value) => value !== 'code')) {
        throw new OAuthError('invalid_client_metadata', 'response_types no es compatible.');
      }

      const authMethod = String(input.token_endpoint_auth_method || 'none');
      if (!['none', 'client_secret_basic', 'client_secret_post'].includes(authMethod)) {
        throw new OAuthError('invalid_client_metadata', 'token_endpoint_auth_method no es compatible.');
      }
      const inferredApplicationType = redirectUris.every((uri) => /^http:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::|\/|$)/i.test(uri))
        ? 'native'
        : 'web';
      const applicationType = String(input.application_type || inferredApplicationType);
      if (!['native', 'web'].includes(applicationType)) {
        throw new OAuthError('invalid_client_metadata', 'application_type debe ser native o web.');
      }
      const registeredScopes = parseScopes(input.scope);

      this.refreshStore();
      const clientName = String(input.client_name || 'Cliente MCP').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) || 'Cliente MCP';
      const signature = tokenHash(JSON.stringify({
        redirectUris: [...redirectUris].sort(),
        authMethod,
        applicationType,
        scope: registeredScopes.join(' '),
        clientName
      }));
      const existing = authMethod === 'none'
        ? Object.values(this.store.state.clients).find((client) => client.signature === signature)
        : null;
      if (existing) {
        sendJson(res, 201, this.clientRegistrationResponse(existing));
        return;
      }

      if (Object.keys(this.store.state.clients).length >= this.maxClients) {
        this.pruneUnusedClients();
      }
      if (Object.keys(this.store.state.clients).length >= this.maxClients) {
        throw new OAuthError('invalid_client_metadata', 'Se alcanzó el máximo de clientes OAuth activos. Revocá sesiones o eliminá clientes antiguos.', 503);
      }

      const clientId = `mcp_${randomValue(24)}`;
      const rawSecret = authMethod === 'none' ? '' : `mcp_cs_${randomValue(32)}`;
      const record = {
        clientId,
        clientName,
        redirectUris,
        grantTypes,
        responseTypes,
        tokenEndpointAuthMethod: authMethod,
        clientSecretHash: rawSecret ? tokenHash(rawSecret) : '',
        applicationType,
        scope: registeredScopes.join(' '),
        clientUri: typeof input.client_uri === 'string' && isSafeRedirectUri(input.client_uri) ? input.client_uri : '',
        signature,
        issuedAt: nowSeconds(),
        createdAt: new Date().toISOString()
      };
      this.store.state.clients[clientId] = record;
      this.store.save();
      humanEvent('OAUTH', `Se registró el cliente ${clientName} para iniciar la autorización.`);
      sendJson(res, 201, this.clientRegistrationResponse(record, rawSecret));
    } catch (error) {
      humanEvent('SEGURIDAD', `Falló el registro dinámico OAuth desde ${ip}: ${redactText(error.message)}`);
      this.sendOAuthError(res, error);
    }
  }

  clientRegistrationResponse(record, rawSecret = '') {
    const response = {
      client_id: record.clientId,
      client_id_issued_at: record.issuedAt,
      client_name: record.clientName,
      redirect_uris: record.redirectUris,
      grant_types: record.grantTypes,
      response_types: record.responseTypes,
      token_endpoint_auth_method: record.tokenEndpointAuthMethod,
      application_type: record.applicationType || 'web',
      scope: record.scope || `${DEFAULT_SCOPE} ${OFFLINE_SCOPE}`
    };
    if (rawSecret) {
      response.client_secret = rawSecret;
      response.client_secret_expires_at = 0;
    }
    return response;
  }

  async resolveClient(clientId, { redirectUri = '' } = {}) {
    const rawId = String(clientId || '');
    if (!rawId) return null;
    const existing = this.store.state.clients[rawId];
    if (existing && existing.registrationType !== 'cimd') return existing;

    const cimdUrl = this.cimdEnabled ? validateCimdClientId(rawId, this.cimdHosts) : null;
    if (!cimdUrl) return existing || null;

    const now = nowSeconds();
    const cacheHasCurrentAuthMetadata = existing
      && Array.isArray(existing.tokenEndpointAuthMethods)
      && existing.tokenEndpointAuthMethods.length > 0
      && (!existing.tokenEndpointAuthMethods.includes('private_key_jwt') || Boolean(existing.jwksUri));
    if (cacheHasCurrentAuthMetadata && Number(existing.cimdValidatedAt || 0) + this.cimdCacheTtl > now) {
      if (!redirectUri || existing.redirectUris.includes(redirectUri)) return existing;
    }

    let metadata;
    try {
      metadata = await this.cimdFetcher(cimdUrl, { timeoutMs: this.cimdTimeoutMs, maxBytes: this.cimdMaxBytes });
    } catch (error) {
      metadata = officialChatGptCimdFallback(cimdUrl);
      if (!metadata) {
        humanEvent('SEGURIDAD', `No se pudo verificar el documento CIMD ${cimdUrl}: ${redactText(error.message)}`);
        throw new OAuthError('unauthorized_client', 'No se pudo verificar la identidad OAuth del cliente. Reintentá la conexión.', 400);
      }
      humanEvent('OAUTH', `El documento CIMD de ChatGPT no respondió (${redactText(error.message)}). Se usará el perfil oficial integrado para este client_id y se mantendrán PKCE, redirect_uri y resource obligatorios.`);
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new OAuthError('unauthorized_client', 'El documento CIMD no contiene metadatos OAuth válidos.');
    }
    if (!timingSafeTextEqual(String(metadata.client_id || ''), cimdUrl)) {
      throw new OAuthError('unauthorized_client', 'El client_id del documento CIMD no coincide con su URL.');
    }
    const clientName = String(metadata.client_name || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
    if (!clientName) throw new OAuthError('unauthorized_client', 'El documento CIMD no declara client_name.');
    const redirectUris = Array.isArray(metadata.redirect_uris)
      ? [...new Set(metadata.redirect_uris.map(String))]
      : [];
    if (redirectUris.length < 1 || redirectUris.length > 10 || redirectUris.some((uri) => uri.length > 2048 || !isSafeRedirectUri(uri))) {
      throw new OAuthError('unauthorized_client', 'El documento CIMD contiene redirect_uris no válidas.');
    }
    if (redirectUri && !redirectUris.includes(redirectUri)) {
      throw new OAuthError('invalid_request', 'redirect_uri no coincide con el documento CIMD del cliente.');
    }
    const grantTypes = Array.isArray(metadata.grant_types) ? [...new Set(metadata.grant_types.map(String))] : ['authorization_code'];
    if (!grantTypes.includes('authorization_code') || grantTypes.some((value) => !['authorization_code', 'refresh_token'].includes(value))) {
      throw new OAuthError('unauthorized_client', 'El documento CIMD declara grant_types no compatibles.');
    }
    const responseTypes = Array.isArray(metadata.response_types) ? [...new Set(metadata.response_types.map(String))] : ['code'];
    if (!responseTypes.includes('code') || responseTypes.some((value) => value !== 'code')) {
      throw new OAuthError('unauthorized_client', 'El documento CIMD declara response_types no compatibles.');
    }
    const clientMethods = Array.isArray(metadata.token_endpoint_auth_methods_supported)
      ? [...new Set(metadata.token_endpoint_auth_methods_supported.map(String))]
      : [String(metadata.token_endpoint_auth_method || 'none')];
    const serverCimdMethods = new Set(['none', ...(this.privateKeyJwtEnabled ? ['private_key_jwt'] : [])]);
    const supportedClientMethods = clientMethods.filter((method) => serverCimdMethods.has(method));
    if (supportedClientMethods.length === 0) {
      throw new OAuthError('unauthorized_client', 'El cliente CIMD no comparte un método de autenticación de token compatible.');
    }
    const clientOrigin = new URL(cimdUrl).origin;
    const jwksUri = supportedClientMethods.includes('private_key_jwt')
      ? validateSameOriginHttpsUrl(metadata.jwks_uri, clientOrigin)
      : '';
    if (supportedClientMethods.includes('private_key_jwt') && !jwksUri) {
      throw new OAuthError('unauthorized_client', 'El cliente CIMD anuncia private_key_jwt pero no publica un jwks_uri HTTPS válido en su mismo origen.');
    }
    const signingAlg = String(metadata.token_endpoint_auth_signing_alg || 'RS256');
    if (supportedClientMethods.includes('private_key_jwt') && signingAlg !== 'RS256') {
      throw new OAuthError('unauthorized_client', 'El servidor sólo admite RS256 para private_key_jwt.');
    }

    if (!existing && Object.keys(this.store.state.clients).length >= this.maxClients) {
      this.pruneUnusedClients();
      if (Object.keys(this.store.state.clients).length >= this.maxClients) {
        throw new OAuthError('unauthorized_client', 'Se alcanzó el máximo de clientes OAuth activos. Revocá conexiones antiguas.');
      }
    }

    const record = {
      clientId: cimdUrl,
      clientName,
      redirectUris,
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod: supportedClientMethods.includes(String(metadata.token_endpoint_auth_method || ''))
        ? String(metadata.token_endpoint_auth_method)
        : supportedClientMethods.includes('none') ? 'none' : supportedClientMethods[0],
      tokenEndpointAuthMethods: supportedClientMethods,
      tokenEndpointAuthSigningAlg: signingAlg,
      jwksUri,
      clientSecretHash: '',
      applicationType: 'web',
      scope: `${DEFAULT_SCOPE} ${OFFLINE_SCOPE}`,
      clientUri: typeof metadata.client_uri === 'string' ? metadata.client_uri.slice(0, 2048) : '',
      registrationType: 'cimd',
      cimdMetadataUrl: cimdUrl,
      cimdMetadataSource: metadata._mcpFallback ? 'official-chatgpt-fallback' : 'remote',
      cimdValidatedAt: now,
      issuedAt: existing && existing.issuedAt ? existing.issuedAt : now,
      createdAt: existing && existing.createdAt ? existing.createdAt : new Date().toISOString()
    };
    this.store.state.clients[cimdUrl] = record;
    this.store.save();
    humanEvent('OAUTH', `Se verificó el cliente CIMD ${clientName} mediante ${cimdUrl}.`);
    return record;
  }

  pruneAuthorizationTransactions(targetCount = this.maxTransactions - 1) {
    const transactions = Object.entries(this.store.state.authorizationTransactions || {})
      .sort((left, right) => Number(left[1].issuedAt || 0) - Number(right[1].issuedAt || 0));
    for (const [key] of transactions) {
      if (Object.keys(this.store.state.authorizationTransactions).length <= targetCount) break;
      delete this.store.state.authorizationTransactions[key];
    }
  }

  async validateAuthorizationRequest(url, issuer) {
    const clientId = String(url.searchParams.get('client_id') || '');
    const redirectUri = String(url.searchParams.get('redirect_uri') || '');
    const client = await this.resolveClient(clientId, { redirectUri });
    if (!client) {
      humanEvent('SEGURIDAD', `ChatGPT intentó autorizar un client_id no registrado (${clientId.startsWith('https://') ? 'URL CIMD no admitida' : 'posible cliente DCR obsoleto'}).`);
      throw new OAuthError('unauthorized_client', 'El cliente OAuth no está registrado. Si este conector ya existía, eliminá la app anterior de ChatGPT y creala nuevamente.');
    }
    if (!client.redirectUris.includes(redirectUri)) throw new OAuthError('invalid_request', 'redirect_uri no coincide con el registro del cliente.');
    if (String(url.searchParams.get('response_type') || '') !== 'code') throw new OAuthError('unsupported_response_type', 'Sólo se admite response_type=code.');
    const challenge = String(url.searchParams.get('code_challenge') || '');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || String(url.searchParams.get('code_challenge_method') || '') !== 'S256') {
      throw new OAuthError('invalid_request', 'Se requiere PKCE S256 con un code_challenge válido.');
    }
    const scopes = parseScopes(url.searchParams.get('scope'));
    const registeredScopes = new Set(String(client.scope || `${DEFAULT_SCOPE} ${OFFLINE_SCOPE}`).split(/\s+/).filter(Boolean));
    if (scopes.some((scope) => !registeredScopes.has(scope))) {
      throw new OAuthError('invalid_scope', 'El cliente solicitó permisos que no registró.');
    }
    const resources = url.searchParams.getAll('resource');
    if (resources.length !== 1) throw new OAuthError('invalid_target', 'La solicitud OAuth debe indicar exactamente un recurso MCP.');
    const rawResource = String(resources[0] || '').trim();
    if (!rawResource) throw new OAuthError('invalid_target', 'La solicitud OAuth debe indicar el recurso MCP.');
    const resource = rawResource.replace(/\/+$/, '');
    if (!timingSafeTextEqual(resource, normalizeResource(issuer))) {
      throw new OAuthError('invalid_target', 'El recurso solicitado no corresponde a este servidor MCP.');
    }
    return {
      client,
      clientId,
      redirectUri,
      state: String(url.searchParams.get('state') || ''),
      codeChallenge: challenge,
      scopes,
      resource
    };
  }

  async handleAuthorizationGet(req, res, url, issuer) {
    const ip = remoteAddress(req);
    const limit = this.authorizationLimiter.status(ip);
    if (!limit.allowed) {
      sendHtml(res, 429, `<h1>Demasiadas autorizaciones</h1><p>Esperá ${limit.retryAfter} segundos antes de volver a iniciar la conexión.</p>`);
      return;
    }
    this.authorizationLimiter.recordAttempt(ip);

    try {
      this.refreshStore();
      this.assertConfigured();
      const requestedClientId = String(url.searchParams.get('client_id') || '');
      const requestedRedirect = String(url.searchParams.get('redirect_uri') || '');
      const requestedResources = url.searchParams.getAll('resource');
      let redirectDisplay = 'ausente/inválida';
      try { const parsed = new URL(requestedRedirect); redirectDisplay = `${parsed.origin}${parsed.pathname}`.slice(0, 256); } catch (_) {}
      const fetchDest = String(req.headers['sec-fetch-dest'] || 'no informado').slice(0, 32);
      const fetchSite = String(req.headers['sec-fetch-site'] || 'no informado').slice(0, 32);
      let refererHost = 'no informado';
      try { if (req.headers.referer) refererHost = new URL(String(req.headers.referer)).host.slice(0, 128); } catch (_) {}
      humanEvent('OAUTH', `Inicio de autorización desde ${ip}: cliente=${requestedClientId.startsWith('https://chatgpt.com/oauth/') ? 'ChatGPT CIMD' : requestedClientId ? 'cliente DCR/predefinido' : 'ausente'}, redirect=${redirectDisplay}, state=${url.searchParams.has('state') ? 'presente' : 'ausente'}, PKCE=${String(url.searchParams.get('code_challenge_method') || '')}/${String(url.searchParams.get('code_challenge') || '').length}, resource=${requestedResources.length === 1 && timingSafeTextEqual(String(requestedResources[0]).replace(/\/+$/, ''), normalizeResource(issuer)) ? 'correcto' : `no coincide (${requestedResources.length})`}, presentación=${fetchDest}, origen=${fetchSite}, referencia=${refererHost}.`);
      const request = await this.validateAuthorizationRequest(url, issuer);
      if (Object.keys(this.store.state.authorizationTransactions).length >= this.maxTransactions) {
        this.pruneAuthorizationTransactions();
      }
      const transactionId = `tx_${randomValue(32)}`;
      this.store.state.authorizationTransactions[tokenHash(transactionId)] = {
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        state: request.state,
        codeChallenge: request.codeChallenge,
        scope: request.scopes.join(' '),
        resource: request.resource,
        issuedAt: nowSeconds(),
        expiresAt: nowSeconds() + this.transactionTtl,
        remoteAddress: remoteAddress(req)
      };
      this.store.save();
      sendHtml(res, 200, this.renderAuthorizationPage(transactionId, request.client, request.redirectUri));
    } catch (error) {
      humanEvent('SEGURIDAD', `No se pudo iniciar la autorización OAuth desde ${ip}: ${redactText(error.message)}`);
      this.sendOAuthError(res, error, true);
    }
  }

  renderAuthorizationPage(transactionId, client, redirectUri, errorMessage = '') {
    const redirectHost = (() => {
      try { return new URL(redirectUri).host; } catch (_) { return 'destino desconocido'; }
    })();
    return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorizar MCP</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f7fb;margin:0;color:#15202b}.card{max-width:520px;margin:7vh auto;background:white;border-radius:16px;padding:28px;box-shadow:0 12px 40px #10243a22}h1{font-size:1.45rem;margin-top:0}.muted{color:#5d6975;font-size:.94rem}.notice{background:#eef6ff;border:1px solid #bddbff;padding:12px;border-radius:10px;margin:16px 0}.risk{background:#fff1f1;border:1px solid #e5a8a8;color:#8b1c1c;padding:10px 14px;border-radius:8px;margin:16px 0}.risk ul{margin-bottom:0}.error{background:#fff1f1;border:1px solid #e5a8a8;color:#8b1c1c;padding:10px;border-radius:8px}label{display:block;margin-top:14px;font-weight:600}input{box-sizing:border-box;width:100%;padding:11px;margin-top:5px;border:1px solid #bac5d0;border-radius:8px;font-size:1rem}.actions{display:flex;gap:10px;margin-top:22px}.primary,.deny{border:0;border-radius:8px;padding:11px 15px;font-size:1rem;cursor:pointer}.primary{background:#1769e0;color:white;flex:1}.deny{background:#e9edf2;color:#26323d}</style></head>
<body><main class="card"><h1>Autorizar acceso al servidor MCP</h1>
<p><strong>${htmlEscape(client.clientName)}</strong> solicita usar las herramientas configuradas en este equipo.</p>
<div class="notice"><strong>Destino de retorno:</strong> ${htmlEscape(redirectHost)}<br><strong>Perfil autorizado:</strong> ${htmlEscape(this.accessSummary.label || this.accessSummary.profile)}<br><strong>Herramientas publicadas:</strong> ${Number(this.accessSummary.allowedToolCount || 0)}</div>
${this.accessRiskNotice()}
<p class="muted">Autorizá únicamente si vos acabás de agregar este servidor en ChatGPT y reconocés el destino mostrado.</p>
${errorMessage ? `<p class="error">${htmlEscape(errorMessage)}</p>` : ''}
<form method="post" action="/oauth/authorize"><input type="hidden" name="transaction" value="${htmlEscape(transactionId)}">
<label for="username">Usuario OAuth</label><input id="username" name="username" autocomplete="username" required>
<label for="password">Contraseña OAuth</label><input id="password" type="password" name="password" autocomplete="current-password" required>
<div class="actions"><button class="deny" type="submit" name="decision" value="deny">Cancelar</button><button class="primary" type="submit" name="decision" value="allow">Autorizar ChatGPT</button></div>
</form></main></body></html>`;
  }

  async handleAuthorizationPost(req, res, issuer) {
    const ip = remoteAddress(req);
    const limit = this.loginLimiter.status(ip);
    if (!limit.allowed) {
      sendHtml(res, 429, `<h1>Acceso temporalmente bloqueado</h1><p>Esperá ${limit.retryAfter} segundos antes de volver a intentar.</p>`);
      return;
    }

    try {
      const form = await readForm(req, 64 * 1024);
      this.refreshStore();
      const transactionId = String(form.get('transaction') || '');
      const key = tokenHash(transactionId);
      const transaction = this.store.state.authorizationTransactions[key];
      if (!transaction || transaction.expiresAt <= nowSeconds()) {
        delete this.store.state.authorizationTransactions[key];
        this.store.save();
        throw new OAuthError('invalid_request', 'La autorización venció. Volvé a iniciar la conexión desde ChatGPT.');
      }
      const client = this.store.state.clients[transaction.clientId];
      if (!client) throw new OAuthError('unauthorized_client', 'El cliente ya no está registrado.');

      if (form.get('decision') === 'deny') {
        delete this.store.state.authorizationTransactions[key];
        this.store.save();
        sendRedirect(res, appendRedirectParams(transaction.redirectUri, {
          error: 'access_denied',
          error_description: 'El usuario canceló la autorización.',
          state: transaction.state,
          ...(this.responseIssEnabled ? { iss: normalizeBaseUrl(issuer) } : {})
        }));
        return;
      }

      const admin = this.store.state.admin;
      const usernameOk = admin && timingSafeTextEqual(String(form.get('username') || ''), admin.username);
      const passwordOk = admin && verifyPassword(String(form.get('password') || ''), admin.passwordHash);
      if (!usernameOk || !passwordOk) {
        this.loginLimiter.recordFailure(ip);
        humanEvent('SEGURIDAD', `Intento OAuth rechazado desde ${ip}: credenciales incorrectas.`);
        sendHtml(res, 401, this.renderAuthorizationPage(transactionId, client, transaction.redirectUri, 'Usuario o contraseña incorrectos.'));
        return;
      }

      this.loginLimiter.clear(ip);
      const rawCode = `mcp_ac_${randomValue(32)}`;
      this.store.state.authorizationCodes[tokenHash(rawCode)] = {
        clientId: transaction.clientId,
        redirectUri: transaction.redirectUri,
        codeChallenge: transaction.codeChallenge,
        scope: transaction.scope,
        resource: transaction.resource,
        subject: admin.username,
        expiresAt: nowSeconds() + this.codeTtl
      };
      delete this.store.state.authorizationTransactions[key];
      this.store.save();
      humanEvent('OAUTH', `El usuario ${admin.username} autorizó a ${client.clientName}.`);
      sendRedirect(res, appendRedirectParams(transaction.redirectUri, {
        code: rawCode,
        state: transaction.state,
        ...(this.responseIssEnabled ? { iss: normalizeBaseUrl(issuer) } : {})
      }));
    } catch (error) {
      this.sendOAuthError(res, error, true);
    }
  }

  pruneAssertionReplay(now = nowSeconds()) {
    for (const [key, expiresAt] of this.clientAssertionReplay) {
      if (Number(expiresAt || 0) <= now) this.clientAssertionReplay.delete(key);
    }
    if (this.clientAssertionReplay.size > 4096) {
      const overflow = [...this.clientAssertionReplay.entries()]
        .sort((left, right) => Number(left[1]) - Number(right[1]))
        .slice(0, this.clientAssertionReplay.size - 4096);
      for (const [key] of overflow) this.clientAssertionReplay.delete(key);
    }
  }

  async loadClientJwks(client, { force = false } = {}) {
    if (!client.jwksUri) throw new OAuthError('invalid_client', 'El cliente no publica JWKS para private_key_jwt.', 401);
    const now = nowSeconds();
    const cached = this.jwksCache.get(client.jwksUri);
    if (!force && cached && Number(cached.expiresAt || 0) > now) return cached.jwks;
    let jwks;
    try {
      jwks = await this.jwksFetcher(client.jwksUri, { timeoutMs: this.cimdTimeoutMs, maxBytes: this.cimdMaxBytes });
    } catch (error) {
      humanEvent('SEGURIDAD', `No se pudo obtener el JWKS del cliente OAuth: ${redactText(error.message)}`);
      throw new OAuthError('invalid_client', 'No se pudo verificar la firma del cliente OAuth.', 401);
    }
    if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 50) {
      throw new OAuthError('invalid_client', 'El JWKS del cliente OAuth no es válido.', 401);
    }
    this.jwksCache.set(client.jwksUri, { jwks, expiresAt: now + this.jwksCacheTtl });
    return jwks;
  }

  async verifyPrivateKeyJwt(client, assertion, issuer) {
    const raw = String(assertion || '');
    if (raw.length < 100 || raw.length > 16384) throw new OAuthError('invalid_client', 'La aserción private_key_jwt no tiene un tamaño válido.', 401);
    const parts = raw.split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) throw new OAuthError('invalid_client', 'La aserción private_key_jwt no tiene formato JWT.', 401);
    const header = decodeJwtPart(parts[0], 'encabezado');
    const claims = decodeJwtPart(parts[1], 'payload');
    if (header.alg !== 'RS256' || !header.kid || typeof header.kid !== 'string' || header.kid.length > 256) {
      throw new OAuthError('invalid_client', 'La aserción private_key_jwt debe usar RS256 y un kid válido.', 401);
    }
    if (!timingSafeTextEqual(String(claims.iss || ''), client.clientId)
        || !timingSafeTextEqual(String(claims.sub || ''), client.clientId)) {
      throw new OAuthError('invalid_client', 'La identidad de la aserción private_key_jwt no coincide con client_id.', 401);
    }
    const tokenEndpoint = `${normalizeBaseUrl(issuer)}/oauth/token`;
    if (!jwtAudienceMatches(claims.aud, [tokenEndpoint, normalizeBaseUrl(issuer)])) {
      throw new OAuthError('invalid_client', 'La audiencia de private_key_jwt no corresponde a este token endpoint.', 401);
    }
    const now = nowSeconds();
    const exp = Number(claims.exp || 0);
    const iat = Number(claims.iat || 0);
    const nbf = claims.nbf === undefined ? 0 : Number(claims.nbf);
    if (!Number.isFinite(exp) || exp <= now - 30 || exp > now + 600) {
      throw new OAuthError('invalid_client', 'La aserción private_key_jwt está vencida o tiene una expiración inválida.', 401);
    }
    if (iat && (!Number.isFinite(iat) || iat > now + 60 || iat < now - 600)) {
      throw new OAuthError('invalid_client', 'La fecha de emisión de private_key_jwt no es válida.', 401);
    }
    if (nbf && (!Number.isFinite(nbf) || nbf > now + 60)) {
      throw new OAuthError('invalid_client', 'La aserción private_key_jwt todavía no es válida.', 401);
    }
    let jwks = await this.loadClientJwks(client);
    const matchingKeys = (document) => document.keys.filter((jwk) => jwk && jwk.kid === header.kid && jwk.kty === 'RSA'
      && (!jwk.use || jwk.use === 'sig') && (!jwk.alg || jwk.alg === 'RS256'));
    let candidates = matchingKeys(jwks);
    if (candidates.length === 0) {
      jwks = await this.loadClientJwks(client, { force: true });
      candidates = matchingKeys(jwks);
    }
    if (candidates.length !== 1) throw new OAuthError('invalid_client', 'No se encontró una clave pública única para private_key_jwt.', 401);
    let publicKey;
    try { publicKey = crypto.createPublicKey({ key: candidates[0], format: 'jwk' }); }
    catch (_) { throw new OAuthError('invalid_client', 'La clave pública private_key_jwt no es válida.', 401); }
    let signature;
    try { signature = Buffer.from(parts[2], 'base64url'); }
    catch (_) { throw new OAuthError('invalid_client', 'La firma private_key_jwt no es válida.', 401); }
    const verified = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), publicKey, signature);
    if (!verified) throw new OAuthError('invalid_client', 'La firma private_key_jwt no pudo verificarse.', 401);

    this.pruneAssertionReplay(now);
    const replayKey = tokenHash(claims.jti ? `${client.clientId}:${claims.jti}` : raw);
    if (this.clientAssertionReplay.has(replayKey)) throw new OAuthError('invalid_client', 'La aserción private_key_jwt ya fue utilizada.', 401);
    this.clientAssertionReplay.set(replayKey, exp);
    return true;
  }

  async authenticateClient(req, form, issuer) {
    let clientId = String(form.get('client_id') || '');
    let secret = String(form.get('client_secret') || '');
    if (!clientId && form.get('client_assertion')) {
      const parts = String(form.get('client_assertion')).split('.');
      if (parts.length === 3) {
        try {
          const claims = decodeJwtPart(parts[1], 'payload');
          const assertedClientId = String(claims.iss || '');
          if (validateCimdClientId(assertedClientId, this.cimdHosts)) clientId = assertedClientId;
        } catch (_) {}
      }
    }
    const authorization = String(req.headers.authorization || '');
    if (authorization.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        const index = decoded.indexOf(':');
        clientId = decodeURIComponent(index >= 0 ? decoded.slice(0, index) : decoded);
        secret = decodeURIComponent(index >= 0 ? decoded.slice(index + 1) : '');
      } catch (_) {
        throw new OAuthError('invalid_client', 'La autenticación del cliente no es válida.', 401);
      }
    }

    const client = await this.resolveClient(clientId, { redirectUri: String(form.get('redirect_uri') || '') });
    if (!client) throw new OAuthError('invalid_client', 'Cliente OAuth desconocido. Si ChatGPT reutiliza un client_id DCR anterior, eliminá y recreá la app.', 401);
    const actualMethod = detectTokenAuthMethod(req, form);
    if (client.registrationType === 'cimd') {
      const declaredMethods = Array.isArray(client.tokenEndpointAuthMethods) && client.tokenEndpointAuthMethods.length
        ? client.tokenEndpointAuthMethods
        : [client.tokenEndpointAuthMethod || 'none'];
      const serverMethods = new Set(['none', ...(this.privateKeyJwtEnabled ? ['private_key_jwt'] : [])]);
      const allowedMethods = declaredMethods.filter((method) => serverMethods.has(method));
      if (!allowedMethods.includes(actualMethod)) {
        throw new OAuthError('invalid_client', `El método ${actualMethod} no está permitido por el documento CIMD.`, 401);
      }
      if (actualMethod === 'private_key_jwt') {
        if (String(form.get('client_assertion_type') || '') !== CLIENT_ASSERTION_TYPE) {
          throw new OAuthError('invalid_client', 'client_assertion_type no corresponde a private_key_jwt.', 401);
        }
        await this.verifyPrivateKeyJwt(client, String(form.get('client_assertion') || ''), issuer);
      } else if (actualMethod !== 'none') {
        throw new OAuthError('invalid_client', 'El cliente CIMD no usa secretos compartidos.', 401);
      }
      return { ...client, authenticatedWith: actualMethod };
    }
    if (client.tokenEndpointAuthMethod === 'none') {
      if (actualMethod !== 'none') throw new OAuthError('invalid_client', 'Este cliente OAuth está registrado como público.', 401);
    } else {
      if (!secret || !timingSafeTextEqual(tokenHash(secret), client.clientSecretHash)) {
        throw new OAuthError('invalid_client', 'El secreto del cliente no es válido.', 401);
      }
      if (actualMethod !== client.tokenEndpointAuthMethod) {
        throw new OAuthError('invalid_client', 'El método de autenticación del cliente no coincide con su registro.', 401);
      }
    }
    return { ...client, authenticatedWith: actualMethod };
  }

  async handleToken(req, res, issuer) {
    const ip = remoteAddress(req);
    const limit = this.tokenLimiter.status(ip);
    if (!limit.allowed) {
      sendJson(res, 429, { error: 'temporarily_unavailable', error_description: 'Demasiadas solicitudes de token.' }, { 'retry-after': String(limit.retryAfter) });
      return;
    }

    let summary = { grantType: 'desconocido', client: 'desconocido', authMethod: 'desconocido' };
    try {
      const form = await readForm(req, 64 * 1024);
      summary = safeTokenRequestSummary(req, form, issuer);
      humanEvent('OAUTH', `Solicitud al token endpoint desde ${ip}: grant=${summary.grantType || 'ausente'}, cliente=${summary.client}, autenticación=${summary.authMethod}, resource=${summary.resourceMatches ? 'correcto' : `no coincide (${summary.resourceCount})`}, PKCE=${summary.codeVerifierPresent ? `${summary.codeVerifierLength} caracteres` : 'ausente'}.`);
      this.refreshStore();
      const client = await this.authenticateClient(req, form, issuer);
      const grantType = String(form.get('grant_type') || '');
      let response;
      if (grantType === 'authorization_code') {
        response = this.exchangeAuthorizationCode(form, client, issuer);
      } else if (grantType === 'refresh_token') {
        response = this.exchangeRefreshToken(form, client, issuer);
      } else {
        throw new OAuthError('unsupported_grant_type', 'Sólo se admiten authorization_code y refresh_token.');
      }
      this.tokenLimiter.clear(ip);
      humanEvent('OAUTH', `Token OAuth emitido correctamente para ${client.clientName} mediante ${client.authenticatedWith || client.tokenEndpointAuthMethod || 'método registrado'}.`);
      sendJson(res, 200, response);
    } catch (error) {
      this.tokenLimiter.recordFailure(ip);
      const code = error instanceof OAuthError ? error.code : 'server_error';
      humanEvent('SEGURIDAD', `Falló el token exchange desde ${ip}: ${code} - ${redactText(error.message || error)}. grant=${summary.grantType}, cliente=${summary.client}, autenticación=${summary.authMethod}, resource=${summary.resourceMatches ? 'correcto' : 'incorrecto/ausente'}, PKCE=${summary.codeVerifierPresent ? `${summary.codeVerifierLength} caracteres` : 'ausente'}.`);
      this.sendOAuthError(res, error, false, { authMethod: summary.authMethod });
    }
  }

  exchangeAuthorizationCode(form, client, issuer) {
    const rawCode = String(form.get('code') || '');
    const codeKey = tokenHash(rawCode);
    const record = this.store.state.authorizationCodes[codeKey];
    if (!record || record.expiresAt <= nowSeconds()) throw new OAuthError('invalid_grant', 'Código de autorización inválido o vencido.');
    if (!timingSafeTextEqual(record.clientId, client.clientId)) throw new OAuthError('invalid_grant', 'El código pertenece a otro cliente.');
    if (!timingSafeTextEqual(record.redirectUri, String(form.get('redirect_uri') || ''))) throw new OAuthError('invalid_grant', 'redirect_uri no coincide.');

    const verifier = String(form.get('code_verifier') || '');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant', 'code_verifier inválido.');
    const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
    if (!timingSafeTextEqual(challenge, record.codeChallenge)) throw new OAuthError('invalid_grant', 'PKCE no pudo verificarse.');

    const resources = form.getAll('resource');
    if (resources.length !== 1) throw new OAuthError('invalid_target', 'La solicitud de token debe indicar exactamente un recurso MCP.');
    const rawResource = String(resources[0] || '').trim();
    if (!rawResource) throw new OAuthError('invalid_target', 'La solicitud de token debe indicar el recurso MCP.');
    const requestedResource = rawResource.replace(/\/+$/, '');
    if (!timingSafeTextEqual(requestedResource, record.resource) || !timingSafeTextEqual(record.resource, normalizeResource(issuer))) {
      throw new OAuthError('invalid_target', 'El recurso solicitado no corresponde al código emitido.');
    }

    delete this.store.state.authorizationCodes[codeKey];
    const tokens = this.issueTokens({
      clientId: client.clientId,
      subject: record.subject,
      scope: record.scope,
      resource: record.resource
    });
    this.store.save();
    humanEvent('OAUTH', `Se emitió una sesión OAuth para ${client.clientName}.`);
    return tokens;
  }

  exchangeRefreshToken(form, client, issuer) {
    const rawRefresh = String(form.get('refresh_token') || '');
    const refreshKey = tokenHash(rawRefresh);
    const record = this.store.state.refreshTokens[refreshKey];
    if (!record || record.expiresAt <= nowSeconds()) {
      const replay = this.store.state.usedRefreshTokens[refreshKey];
      if (replay && replay.expiresAt > nowSeconds() && replay.familyId) {
        this.revokeTokenFamily(replay.familyId);
        this.store.save();
        humanEvent('SEGURIDAD', `Se detectó la reutilización de un refresh token OAuth de ${client.clientName}; se revocó toda esa sesión.`);
      }
      throw new OAuthError('invalid_grant', 'Refresh token inválido, vencido o ya utilizado.');
    }
    if (!timingSafeTextEqual(record.clientId, client.clientId)) throw new OAuthError('invalid_grant', 'El refresh token pertenece a otro cliente.');
    const resources = form.getAll('resource');
    if (resources.length !== 1) throw new OAuthError('invalid_target', 'La renovación debe indicar exactamente un recurso MCP.');
    const rawResource = String(resources[0] || '').trim();
    if (!rawResource) throw new OAuthError('invalid_target', 'La renovación debe indicar el recurso MCP.');
    if (!timingSafeTextEqual(rawResource.replace(/\/+$/, ''), record.resource) || !timingSafeTextEqual(record.resource, normalizeResource(issuer))) {
      throw new OAuthError('invalid_target', 'El refresh token pertenece a otro recurso.');
    }

    const requestedScope = String(form.get('scope') || '').trim();
    let scope = record.scope;
    if (requestedScope) {
      const requested = parseScopes(requestedScope, { defaultOffline: false });
      const original = new Set(String(record.scope || '').split(/\s+/));
      if (requested.some((value) => !original.has(value))) throw new OAuthError('invalid_scope', 'No se pueden ampliar permisos durante la renovación.');
      scope = requested.join(' ');
    }

    delete this.store.state.refreshTokens[refreshKey];
    this.store.state.usedRefreshTokens[refreshKey] = {
      clientId: client.clientId,
      familyId: record.familyId,
      expiresAt: record.expiresAt
    };
    const tokens = this.issueTokens({
      clientId: client.clientId,
      subject: record.subject,
      scope,
      resource: record.resource,
      familyId: record.familyId
    });
    this.store.save();
    humanEvent('OAUTH', `Se renovó la sesión OAuth de ${client.clientName}.`);
    return tokens;
  }

  issueTokens({ clientId, subject, scope, resource, familyId = randomValue(24) }) {
    const accessToken = `mcp_at_${randomValue(32)}`;
    const refreshAllowed = String(scope || '').split(/\s+/).includes(OFFLINE_SCOPE);
    const refreshToken = refreshAllowed ? `mcp_rt_${randomValue(40)}` : '';
    const now = nowSeconds();
    this.store.state.accessTokens[tokenHash(accessToken)] = {
      clientId,
      subject,
      scope,
      resource,
      familyId,
      issuedAt: now,
      expiresAt: now + this.accessTokenTtl
    };
    if (refreshToken) {
      this.store.state.refreshTokens[tokenHash(refreshToken)] = {
        clientId,
        subject,
        scope,
        resource,
        familyId,
        issuedAt: now,
        expiresAt: now + this.refreshTokenTtl
      };
    }
    const response = {
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: this.accessTokenTtl,
      scope,
      resource
    };
    if (refreshToken) response.refresh_token = refreshToken;
    return response;
  }

  revokeTokenFamily(familyId) {
    if (!familyId) return;
    for (const collectionName of ['accessTokens', 'refreshTokens']) {
      const collection = this.store.state[collectionName];
      for (const [key, record] of Object.entries(collection)) {
        if (record && timingSafeTextEqual(record.familyId || '', familyId)) delete collection[key];
      }
    }
  }

  async handleRevoke(req, res, issuer) {
    try {
      const form = await readForm(req, 64 * 1024);
      this.refreshStore();
      const client = await this.authenticateClient(req, form, issuer);
      const key = tokenHash(String(form.get('token') || ''));
      const access = this.store.state.accessTokens[key];
      const refresh = this.store.state.refreshTokens[key];
      if (access && access.clientId === client.clientId) delete this.store.state.accessTokens[key];
      if (refresh && refresh.clientId === client.clientId) {
        this.revokeTokenFamily(refresh.familyId);
        this.store.state.usedRefreshTokens[key] = {
          clientId: client.clientId,
          familyId: refresh.familyId,
          expiresAt: refresh.expiresAt
        };
      }
      this.store.save();
      sendJson(res, 200, {});
    } catch (error) {
      this.sendOAuthError(res, error);
    }
  }

  sendOAuthError(res, error, html = false, options = {}) {
    const oauthError = error instanceof OAuthError
      ? error
      : new OAuthError('server_error', 'No se pudo completar la autorización.', 500);
    if (!(error instanceof OAuthError)) {
      humanEvent('ERROR', `Error OAuth interno: ${redactText(error && (error.message || error))}`);
    }
    if (html) {
      sendHtml(res, oauthError.statusCode, `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Error OAuth</title></head><body><h1>No se pudo autorizar</h1><p>${htmlEscape(oauthError.message)}</p><p>Volvé a ChatGPT e intentá conectar el servidor nuevamente.</p></body></html>`);
    } else {
      const headers = oauthError.code === 'invalid_client' && options.authMethod === 'client_secret_basic'
        ? { 'www-authenticate': 'Basic realm="MCP OAuth token endpoint"' }
        : {};
      sendJson(res, oauthError.statusCode, { error: oauthError.code, error_description: oauthError.message }, headers);
    }
  }
}

module.exports = {
  DEFAULT_SCOPE,
  OFFLINE_SCOPE,
  OAuthError,
  OAuthProvider,
  OAuthStateStore,
  configureOAuthAdmin,
  createPasswordHash,
  normalizeBaseUrl,
  normalizeResource,
  tokenHash,
  verifyPassword
};
