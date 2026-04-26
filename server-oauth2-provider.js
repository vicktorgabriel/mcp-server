#!/usr/bin/env node

/**
 * MCP Server - OAuth2 Provider
 * 
 * Implementa RFC 6749 (OAuth 2.0 Authorization Framework)
 * Compatible con: Claude Web, GPT Web, Blender, etc.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';
const ALLOWED_PATHS = process.env.ALLOWED_PATHS || '/mnt/4tb-hdd/repo';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Store para tokens de autorización temporales
const authorizationCodes = new Map();
const refreshTokens = new Map();
const registeredClients = new Map();

// Clientes conocidos (applications)
const KNOWN_CLIENTS = {
  'claude-web': {
    name: 'Claude Web',
    secret: 'claude-secret-key',
    redirectUris: ['https://claude.ai/callback', 'http://localhost:3001/callback']
  },
  'gpt-web': {
    name: 'ChatGPT Web',
    secret: 'gpt-secret-key',
    redirectUris: ['https://chat.openai.com/callback', 'http://localhost:3002/callback']
  },
  'blender': {
    name: 'Blender',
    secret: 'blender-secret-key',
    redirectUris: ['http://localhost:9000/callback', 'blender://callback']
  },
  'local-dev': {
    name: 'Local Development',
    secret: 'local-dev-secret',
    redirectUris: ['http://localhost:3000/callback', 'http://localhost:8000/callback']
  }
};

// Archivos de configuración
const USERS_FILE = path.join(__dirname, '.users.json');
const CREDENTIALS_FILE = path.join(__dirname, '.credentials');

// Colors para consola
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
};

const log = (type, msg) => {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
  const icons = {
    info: `${colors.blue}ℹ${colors.reset}`,
    success: `${colors.green}✓${colors.reset}`,
    error: `${colors.red}✗${colors.reset}`,
    auth: `${colors.cyan}🔐${colors.reset}`,
    oauth: `${colors.cyan}🔑${colors.reset}`
  };
  console.log(`[${timestamp}] ${icons[type] || type} ${msg}`);
};

// ============================================================================
// UTILIDADES OAuth2
// ============================================================================

function generateAuthorizationCode() {
  return crypto.randomBytes(32).toString('hex');
}

function generateAccessToken(userId, clientId, scope) {
  return jwt.sign(
    { userId, clientId, scope, type: 'access_token' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

function validateRedirectUri(clientId, redirectUri) {
  const client = KNOWN_CLIENTS[clientId];
  if (!client) return false;
  return client.redirectUris.some(uri => 
    uri === redirectUri || uri.includes('localhost')
  );
}

// ============================================================================
// USUARIO Y AUTENTICACIÓN
// ============================================================================

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  }
  return {};
}

function loadCredentials() {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    const content = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    const creds = {};
    content.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key) creds[key.trim()] = value.trim();
    });
    return creds;
  }
  return {};
}

function authenticateUser(username, password) {
  const users = loadUsers();
  const user = users[username];
  
  if (!user) return null;
  
  // En desarrollo, comparar contraseña
  if (bcrypt.compareSync(password, user.passwordHash)) {
    return { username, email: user.email };
  }
  
  return null;
}

// ============================================================================
// RUTAS - OAuth2 Standard Flow (RFC 6749)
// ============================================================================

/**
 * GET /oauth/authorize
 * 
 * Authorization Endpoint
 * Redirige al usuario a login si no está autenticado
 * Muestra pantalla de consentimiento
 */
app.get('/oauth/authorize', (req, res) => {
  const {
    client_id,
    redirect_uri,
    response_type,
    scope,
    state,
    username,
    password
  } = req.query;

  log('oauth', `AUTHORIZE request from client_id=${client_id}`);

  // Validaciones
  if (!client_id || !KNOWN_CLIENTS[client_id]) {
    return res.status(400).json({ error: 'invalid_client' });
  }

  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type' });
  }

  if (!redirect_uri || !validateRedirectUri(client_id, redirect_uri)) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }

  // Si el usuario no está autenticado, mostrar formulario de login
  if (!username || !password) {
    const loginHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>MCP Server - OAuth2 Login</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial; background: #f5f5f5; }
          .container { max-width: 400px; margin: 100px auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #333; margin: 0 0 10px 0; font-size: 24px; }
          .app { color: #666; font-size: 14px; margin-bottom: 20px; }
          .input-group { margin: 15px 0; }
          label { display: block; color: #333; font-weight: 500; margin-bottom: 5px; }
          input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
          button { width: 100%; padding: 10px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; margin-top: 20px; }
          button:hover { background: #0052a3; }
          .warning { background: #fff3cd; border: 1px solid #ffc107; color: #856404; padding: 10px; border-radius: 4px; margin-bottom: 20px; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Iniciar Sesión</h1>
          <div class="app">
            <strong>${KNOWN_CLIENTS[client_id].name}</strong> solicita acceso
          </div>
          
          <div class="warning">
            <strong>Alcance solicitado:</strong> ${scope || 'basic'}
          </div>

          <form method="GET" action="/oauth/authorize">
            <div class="input-group">
              <label>Usuario:</label>
              <input type="text" name="username" required autofocus>
            </div>
            
            <div class="input-group">
              <label>Contraseña:</label>
              <input type="password" name="password" required>
            </div>

            <input type="hidden" name="client_id" value="${client_id}">
            <input type="hidden" name="redirect_uri" value="${redirect_uri}">
            <input type="hidden" name="response_type" value="code">
            <input type="hidden" name="scope" value="${scope || 'basic'}">
            <input type="hidden" name="state" value="${state || ''}">

            <button type="submit">Continuar</button>
          </form>
        </div>
      </body>
      </html>
    `;
    return res.send(loginHtml);
  }

  // Autenticar usuario
  const user = authenticateUser(username, password);
  if (!user) {
    log('error', `Failed login attempt for user ${username}`);
    return res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid username or password' });
  }

  log('success', `User ${username} authenticated`);

  // Mostrar pantalla de consentimiento
  const consentHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>MCP Server - Autorizar Acceso</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial; background: #f5f5f5; }
        .container { max-width: 500px; margin: 100px auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; margin: 0 0 10px 0; font-size: 24px; }
        .app { color: #666; margin-bottom: 20px; }
        .permissions { background: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0; }
        .permission { padding: 10px 0; color: #666; font-size: 14px; }
        .permission:before { content: "✓ "; color: #28a745; font-weight: bold; }
        .buttons { display: flex; gap: 10px; margin-top: 30px; }
        button { flex: 1; padding: 10px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
        .authorize { background: #28a745; color: white; }
        .authorize:hover { background: #218838; }
        .deny { background: #e9ecef; color: #333; }
        .deny:hover { background: #dee2e6; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Autorizar Acceso</h1>
        <div class="app">
          <strong>${KNOWN_CLIENTS[client_id].name}</strong> solicita acceso a tu MCP Server
        </div>

        <div class="permissions">
          <div class="permission">Acceder a archivos en ${ALLOWED_PATHS}</div>
          <div class="permission">Leer archivos</div>
          <div class="permission">Escribir archivos</div>
          <div class="permission">Ejecutar comandos permitidos</div>
        </div>

        <form style="display: inline;">
          <input type="hidden" name="client_id" value="${client_id}">
          <input type="hidden" name="redirect_uri" value="${redirect_uri}">
          <input type="hidden" name="response_type" value="code">
          <input type="hidden" name="scope" value="${scope || 'basic'}">
          <input type="hidden" name="state" value="${state || ''}">
          <input type="hidden" name="username" value="${username}">
          <input type="hidden" name="password" value="${password}">
          <input type="hidden" name="consent" value="true">

          <div class="buttons">
            <button type="submit" class="authorize">Autorizar</button>
            <button type="button" class="deny" onclick="window.location.href='${redirect_uri}?error=access_denied&state=${state || ''}'">Cancelar</button>
          </div>
        </form>
      </div>
    </body>
    </html>
  `;

  if (req.query.consent === 'true') {
    // Generar authorization code
    const code = generateAuthorizationCode();
    const codeData = {
      userId: user.username,
      clientId: client_id,
      redirectUri: redirect_uri,
      scope: scope || 'basic',
      expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutos
    };

    authorizationCodes.set(code, codeData);
    log('auth', `Authorization code generated for ${user.username} -> ${client_id}`);

    // Redirigir de vuelta con el código
    const params = new URLSearchParams({ code, state: state || '' });
    return res.redirect(`${redirect_uri}?${params.toString()}`);
  }

  res.send(consentHtml);
});

/**
 * POST /oauth/token
 * 
 * Token Endpoint
 * Intercambia authorization code por access token
 */
app.post('/oauth/token', (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret, username, password } = req.body;

  log('oauth', `TOKEN request - grant_type=${grant_type}`);

  // Validar cliente
  if (!client_id || !KNOWN_CLIENTS[client_id]) {
    return res.status(400).json({ error: 'invalid_client' });
  }

  // Validar secret
  if (KNOWN_CLIENTS[client_id].secret !== client_secret) {
    log('error', `Invalid client secret for ${client_id}`);
    return res.status(401).json({ error: 'invalid_client' });
  }

  // Authorization Code Flow
  if (grant_type === 'authorization_code') {
    if (!code || !code.match(/^[a-f0-9]{64}$/)) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const codeData = authorizationCodes.get(code);
    if (!codeData) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    // Validar que no haya expirado
    if (codeData.expiresAt < Date.now()) {
      authorizationCodes.delete(code);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
    }

    // Validar redirect_uri
    if (codeData.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    // Generar tokens
    const accessToken = generateAccessToken(codeData.userId, client_id, codeData.scope);
    const refreshToken = generateRefreshToken();

    refreshTokens.set(refreshToken, {
      userId: codeData.userId,
      clientId: client_id,
      scope: codeData.scope
    });

    authorizationCodes.delete(code);

    log('success', `Token issued for ${codeData.userId} -> ${client_id}`);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 86400,
      refresh_token: refreshToken,
      scope: codeData.scope
    });
  }

  // Refresh Token Flow
  if (grant_type === 'refresh_token') {
    const { refresh_token } = req.body;
    const tokenData = refreshTokens.get(refresh_token);

    if (!tokenData) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const accessToken = generateAccessToken(tokenData.userId, client_id, tokenData.scope);

    log('success', `Token refreshed for ${tokenData.userId} -> ${client_id}`);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 86400
    });
  }

  // Password Grant (para desarrollo)
  if (grant_type === 'password') {
    const user = authenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'invalid_grant' });
    }

    const accessToken = generateAccessToken(user.username, client_id, 'full');
    const refreshToken = generateRefreshToken();

    refreshTokens.set(refreshToken, {
      userId: user.username,
      clientId: client_id,
      scope: 'full'
    });

    log('success', `Token issued (password flow) for ${user.username} -> ${client_id}`);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 86400,
      refresh_token: refreshToken
    });
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
});

/**
 * GET /oauth/userinfo
 * 
 * Endpoint para obtener información del usuario
 */
app.get('/oauth/userinfo', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.json({
      sub: decoded.userId,
      username: decoded.userId,
      email: decoded.userId + '@mcp.local',
      scope: decoded.scope
    });
  } catch (error) {
    return res.status(401).json({ error: 'invalid_token' });
  }
});

// ============================================================================
// RUTAS - Información OAuth2
// ============================================================================

app.get('/oauth/clients', (req, res) => {
  const clients = Object.entries(KNOWN_CLIENTS).map(([id, data]) => ({
    client_id: id,
    name: data.name,
    redirect_uris: data.redirectUris
  }));
  res.json(clients);
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: `http://localhost:${PORT}`,
    authorization_endpoint: `http://localhost:${PORT}/oauth/authorize`,
    token_endpoint: `http://localhost:${PORT}/oauth/token`,
    userinfo_endpoint: `http://localhost:${PORT}/oauth/userinfo`,
    revocation_endpoint: `http://localhost:${PORT}/oauth/revoke`,
    scopes_supported: ['basic', 'files', 'execute', 'full'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'password'],
    response_types_supported: ['code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post']
  });
});

// ============================================================================
// RUTAS - API protegida
// ============================================================================

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    res.status(401).json({ error: 'invalid_token' });
  }
}

app.get('/api/files', verifyToken, (req, res) => {
  res.json({ message: 'API protegida', user: req.user });
});

// ============================================================================
// INICIO
// ============================================================================

app.listen(PORT, () => {
  log('info', `MCP OAuth2 Provider iniciado`);
  log('info', `Escuchando en http://localhost:${PORT}`);
  log('info', `Authorization Endpoint: http://localhost:${PORT}/oauth/authorize`);
  log('info', `Token Endpoint: http://localhost:${PORT}/oauth/token`);
  log('info', `.well-known: http://localhost:${PORT}/.well-known/oauth-authorization-server`);
});
