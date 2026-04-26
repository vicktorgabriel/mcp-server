/**
 * MCP Server Local
 *
 * Servidor que permite acceso remoto a archivos del sistema local
 * a través de endpoints REST con autenticación.
 *
 * Uso: node server.js
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de seguridad
const API_KEY = process.env.API_KEY || 'dev-key-change-me';
const ALLOWED_PATHS = (process.env.ALLOWED_PATHS || process.env.HOME || '/tmp')
  .split(',')
  .map(p => path.normalize(p));

// Comandos permitidos (whitelist)
const ALLOWED_COMMANDS = ['ls', 'cat', 'pwd', 'echo', 'mkdir', 'cp', 'mv', 'rm', 'head', 'tail', 'grep'];

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Logging de requests
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Autenticación
const authenticate = (req, res, next) => {
  const key = req.headers['x-api-key'];

  if (!key) {
    return res.status(401).json({ error: 'API Key requerida' });
  }

  if (key !== API_KEY) {
    return res.status(403).json({ error: 'API Key inválida' });
  }

  next();
};

// Validar ruta permitida
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

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    allowedPaths: ALLOWED_PATHS,
    version: '1.0.0'
  });
});

// ============================================
// ENDPOINTS PROTEGIDOS
// ============================================

// Información del servidor
app.get('/api/info', authenticate, (req, res) => {
  res.json({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    workingDirectory: process.cwd(),
    allowedPaths: ALLOWED_PATHS,
    allowedCommands: ALLOWED_COMMANDS
  });
});

// Leer archivo
app.get('/api/read', authenticate, (req, res) => {
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
app.post('/api/write', authenticate, (req, res) => {
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
    // Crear directorio si no existe
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, encoding);

    res.json({
      success: true,
      path: filePath,
      bytesWritten: Buffer.byteLength(content, encoding)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar directorio
app.get('/api/list', authenticate, (req, res) => {
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
      if (depth > 5) return []; // Límite de profundidad

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

// Ejecutar comando (limitado)
app.post('/api/execute', authenticate, (req, res) => {
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

  // Sanitizar argumentos
  const safeArgs = args.map(arg => {
    // Eliminar caracteres peligrosos
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
      error: error ? error.message : null
    });
  });
});

// Crear directorio
app.post('/api/mkdir', authenticate, (req, res) => {
  const { path: dirPath, recursive = true } = req.body;

  if (!dirPath) {
    return res.status(400).json({ error: 'Campo "path" requerido' });
  }

  if (!validatePath(dirPath)) {
    return res.status(403).json({
      error: 'Ruta no permitida',
      allowedPaths: ALLOWED_PATHS
    });
  }

  try {
    fs.mkdirSync(dirPath, { recursive });
    res.json({ success: true, path: dirPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar archivo
app.delete('/api/delete', authenticate, (req, res) => {
  const { path: targetPath, recursive = false } = req.query;

  if (!targetPath) {
    return res.status(400).json({ error: 'Parámetro "path" requerido' });
  }

  if (!validatePath(targetPath)) {
    return res.status(403).json({
      error: 'Ruta no permitida',
      allowedPaths: ALLOWED_PATHS
    });
  }

  try {
    const stats = fs.statSync(targetPath);

    if (stats.isDirectory()) {
      if (recursive) {
        fs.rmSync(targetPath, { recursive: true });
      } else {
        fs.rmdirSync(targetPath);
      }
    } else {
      fs.unlinkSync(targetPath);
    }

    res.json({ success: true, path: targetPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Copiar archivo
app.post('/api/copy', authenticate, (req, res) => {
  const { source, destination } = req.body;

  if (!source || !destination) {
    return res.status(400).json({ error: 'Campos "source" y "destination" requeridos' });
  }

  if (!validatePath(source) || !validatePath(destination)) {
    return res.status(403).json({
      error: 'Ruta no permitida',
      allowedPaths: ALLOWED_PATHS
    });
  }

  try {
    fs.copyFileSync(source, destination);
    res.json({ success: true, source, destination });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mover archivo
app.post('/api/move', authenticate, (req, res) => {
  const { source, destination } = req.body;

  if (!source || !destination) {
    return res.status(400).json({ error: 'Campos "source" y "destination" requeridos' });
  }

  if (!validatePath(source) || !validatePath(destination)) {
    return res.status(403).json({
      error: 'Ruta no permitida',
      allowedPaths: ALLOWED_PATHS
    });
  }

  try {
    fs.renameSync(source, destination);
    res.json({ success: true, source, destination });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Información de archivo
app.get('/api/stat', authenticate, (req, res) => {
  const { path: targetPath } = req.query;

  if (!targetPath) {
    return res.status(400).json({ error: 'Parámetro "path" requerido' });
  }

  if (!validatePath(targetPath)) {
    return res.status(403).json({
      error: 'Ruta no permitida',
      allowedPaths: ALLOWED_PATHS
    });
  }

  try {
    const stats = fs.statSync(targetPath);
    res.json({
      success: true,
      path: targetPath,
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ============================================
// INICIO DEL SERVIDOR
// ============================================

app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║     MCP Server Local                      ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  🚀 Corriendo en: http://localhost:${PORT}      ║`);
  console.log('╠════════════════════════════════════════════╣');
  console.log('║  Endpoints:                               ║');
  console.log('║  - GET  /health                          ║');
  console.log('║  - GET  /api/info                        ║');
  console.log('║  - GET  /api/read?path=...               ║');
  console.log('║  - POST /api/write                       ║');
  console.log('║  - GET  /api/list?path=...               ║');
  console.log('║  - POST /api/execute                     ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  📁 Acceso permitido a:                   ║`);
  ALLOWED_PATHS.forEach(p => console.log(`║     - ${p.padEnd(40)}║`));
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  🔑 API Key: ${API_KEY.substring(0, 20)}...         ║`);
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
  console.log('💡 Para probar: curl http://localhost:' + PORT + '/health');
  console.log('');
});

// Manejo de errores
process.on('uncaughtException', (err) => {
  console.error('Error no manejado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada:', reason);
});
