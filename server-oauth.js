/**
 * MCP Server Local - Con OAuth2 y JWT
 * 
 * Soporta:
 * - Autenticación por API Key (legacy)
 * - OAuth2 con JWT
 * - Múltiples métodos de autenticación
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { exec } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// CONFIGURACIÓN
// ============================================

const API_KEY = process.env.API_KEY || 'dev-key-change-me';
const ALLOWED_PATHS = (process.env.ALLOWED_PATHS || process.env.HOME || '/tmp')
  .split(',')
  .map(p => path.normalize(p));

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';
const ALLOWED_COMMANDS = ['ls', 'cat', 'pwd', 'find', 'head', 'tail', 'grep', 'wc', 'file', 'stat'];

// Usuarios OAuth (en memoria - usar BD en producción)
const users = {
  'admin': { 
    id: 'admin-001',
    email: 'admin@example.com',
    passwordHash: bcrypt.hashSync('admin123', 10),
    oauth_providers: [] 
  }
};

const tokens = new Map(); // Tokens revocados

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - Auth: ${req.headers['x-api-key'] ? 'API Key' : req.headers['authorization'] ? 'JWT' : 'None'}`);
  next();
});

// ============================================
// AUTENTICACIÓN
// ============================================

// Middleware: Validar API Key (legacy)
const authenticateApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'];

  if (!key) {
    return res.status(401).json({ error: 'API Key o Authorization requerida' });
  }

  if (key !== API_KEY) {
    return res.status(403).json({ error: 'API Key inválida' });
  }

  req.user = { id: 'api-key-user', method: 'api-key' };
  next();
};

// Middleware: Validar JWT
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return authenticateApiKey(req, res, next);
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    if (tokens.has(token)) {
      return res.status(401).json({ error: 'Token revocado' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { ...decoded, method: 'jwt' };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    return res.status(403).json({ error: 'Token inválido' });
  }
};

// Middleware: Validar ruta
const validatePath = (filePath) => {
  const normalizedPath = path.normalize(filePath);

  for (const allowedPath of ALLOWED_PATHS) {
    if (normalizedPath.startsWith(path.normalize(allowedPath))) {
      return true;
    }
  }

  return false;
};

// ============================================
// ENDPOINTS PÚBLICOS
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    allowedPaths: ALLOWED_PATHS,
    version: '2.0.0',
    auth_methods: ['api-key', 'oauth2-jwt']
  });
});

// ============================================
// ENDPOINTS OAUTH
// ============================================

// Registrar usuario
app.post('/auth/register', express.json(), (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, password requeridos' });
  }

  if (users[username]) {
    return res.status(409).json({ error: 'Usuario ya existe' });
  }

  users[username] = {
    id: `user-${Date.now()}`,
    email,
    passwordHash: bcrypt.hashSync(password, 10),
    oauth_providers: []
  };

  res.status(201).json({
    success: true,
    message: 'Usuario registrado',
    user: { id: users[username].id, username, email }
  });
});

// Login con credenciales
app.post('/auth/login', express.json(), (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username y password requeridos' });
  }

  const user = users[username];

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Usuario o contraseña inválidos' });
  }

  const token = jwt.sign(
    { id: user.id, username, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

  res.json({
    success: true,
    token,
    user: { id: user.id, username, email: user.email },
    expiresIn: JWT_EXPIRY
  });
});

// Refresh token
app.post('/auth/refresh', authenticateJWT, (req, res) => {
  const newToken = jwt.sign(
    { id: req.user.id, username: req.user.username, email: req.user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

  res.json({
    success: true,
    token: newToken,
    expiresIn: JWT_EXPIRY
  });
});

// Logout (revocar token)
app.post('/auth/logout', authenticateJWT, (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader.split(' ')[1];

  tokens.add(token);

  res.json({ success: true, message: 'Sesión cerrada' });
});

// OAuth: Validar token externo (Google, GitHub, etc)
app.post('/auth/oauth-verify', express.json(), (req, res) => {
  const { provider, token, username } = req.body;

  if (!provider || !token) {
    return res.status(400).json({ error: 'provider y token requeridos' });
  }

  // En producción: verificar con el proveedor OAuth (Google, GitHub, etc)
  // Aquí solo validamos que el token no sea vacío
  if (token.length < 20) {
    return res.status(400).json({ error: 'Token inválido' });
  }

  const userId = `oauth-${provider}-${Date.now()}`;

  if (username && !users[username]) {
    users[username] = {
      id: userId,
      email: `${username}@${provider}.local`,
      passwordHash: null,
      oauth_providers: [provider]
    };
  }

  const jwtToken = jwt.sign(
    { id: userId, username: username || provider, provider },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

  res.json({
    success: true,
    token: jwtToken,
    user: { id: userId, username: username || provider, provider },
    expiresIn: JWT_EXPIRY
  });
});

// ============================================
// ENDPOINTS PROTEGIDOS - ARCHIVOS
// ============================================

// Leer archivo
app.get('/api/read', authenticateJWT, (req, res) => {
  const { path: filePath, encoding = 'utf8' } = req.query;

  if (!filePath) {
    return res.status(400).json({ error: 'Parámetro "path" requerido' });
  }

  if (!validatePath(filePath)) {
    return res.status(403).json({
      error: 'Ruta no permitida',
      allowedPaths: ALLOWED_PATHS
    });
  }

  try {
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'La ruta es un directorio. Usa /api/list para listar.' });
    }

    const content = fs.readFileSync(filePath, encoding);
    res.json({
      success: true,
      path: filePath,
      size: stats.size,
      modified: stats.mtime,
      content: content
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Escribir archivo
app.post('/api/write', authenticateJWT, (req, res) => {
  const { path: filePath, content, encoding = 'utf8' } = req.body;

  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'Campos "path" y "content" requeridos' });
  }

  if (!validatePath(filePath)) {
    return res.status(403).json({
      error: 'Ruta no permitida',
      allowedPaths: ALLOWED_PATHS
    });
  }

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, encoding);

    res.json({
      success: true,
      path: filePath,
      bytesWritten: Buffer.byteLength(content, encoding),
      user: req.user.id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar directorio
app.get('/api/list', authenticateJWT, (req, res) => {
  const { path: dirPath = process.env.HOME || '/tmp', recursive = 'false' } = req.query;

  if (!validatePath(dirPath)) {
    return res.status(403).json({
      error: 'Ruta no permitida',
      allowedPaths: ALLOWED_PATHS
    });
  }

  try {
    const recursiveMode = recursive === 'true';

    const listDirectory = (dir, depth = 0) => {
      if (depth > 5) return [];

      const items = fs.readdirSync(dir);
      return items.map(item => {
        const fullPath = path.join(dir, item);
        try {
          const stats = fs.statSync(fullPath);
          const result = {
            name: item,
            path: fullPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            modified: stats.mtime
          };

          if (stats.isDirectory() && recursiveMode) {
            result.children = listDirectory(fullPath, depth + 1);
          }

          return result;
        } catch {
          return {
            name: item,
            path: fullPath,
            type: 'unknown',
            error: 'No se pudo acceder'
          };
        }
      });
    };

    res.json({
      success: true,
      path: dirPath,
      items: listDirectory(dirPath)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ejecutar comando
app.post('/api/execute', authenticateJWT, (req, res) => {
  const { command, args = [] } = req.body;

  if (!command) {
    return res.status(400).json({ error: 'Campo "command" requerido' });
  }

  if (!ALLOWED_COMMANDS.includes(command)) {
    return res.status(403).json({
      error: 'Comando no permitido',
      allowedCommands: ALLOWED_COMMANDS
    });
  }

  const safeArgs = args.map(arg => {
    return arg.replace(/[;&|`$()]/g, '');
  });

  const fullCommand = `${command} ${safeArgs.join(' ')}`;

  exec(fullCommand, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    res.json({
      command: fullCommand,
      success: !error,
      exitCode: error ? error.code : 0,
      stdout: stdout,
      stderr: stderr,
      error: error ? error.message : null,
      user: req.user.id
    });
  });
});

// Información del servidor
app.get('/api/info', authenticateJWT, (req, res) => {
  res.json({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    workingDirectory: process.cwd(),
    allowedPaths: ALLOWED_PATHS,
    allowedCommands: ALLOWED_COMMANDS,
    currentUser: req.user
  });
});

// ============================================
// INICIO DEL SERVIDOR
// ============================================

app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║     MCP Server Local v2 - OAuth2 + JWT    ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  🚀 Corriendo en: http://localhost:${PORT}      ║`);
  console.log('╠════════════════════════════════════════════╣');
  console.log('║  Métodos de autenticación:                ║');
  console.log('║  - API Key (X-API-Key header)            ║');
  console.log('║  - OAuth2 + JWT (Authorization header)   ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log('║  Endpoints:                               ║');
  console.log('║  - GET  /health                          ║');
  console.log('║  - POST /auth/register                   ║');
  console.log('║  - POST /auth/login                      ║');
  console.log('║  - POST /auth/refresh                    ║');
  console.log('║  - POST /auth/oauth-verify               ║');
  console.log('║  - GET  /api/read                        ║');
  console.log('║  - POST /api/write                       ║');
  console.log('║  - GET  /api/list                        ║');
  console.log('║  - POST /api/execute                     ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
  console.log('💡 Probar: curl http://localhost:' + PORT + '/health');
  console.log('🔐 JWT Secret: ' + JWT_SECRET.substring(0, 20) + '...');
  console.log('');
});

process.on('uncaughtException', (err) => {
  console.error('Error no manejado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada:', reason);
});
