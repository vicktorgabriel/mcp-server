#!/usr/bin/env node
/**
 * MCP Client - Cliente para conectarse al servidor MCP
 * 
 * Uso:
 *   node client.js list /
 *   node client.js read /archivo.txt
 *   node client.js write /archivo.txt "contenido"
 */

const http = require('http');
const https = require('https');
const url = require('url');

// Configuración desde env o CLI
const MCP_HOST = process.env.MCP_HOST || 'http://localhost:3000';
const MCP_API_KEY = process.env.MCP_API_KEY || process.argv[3] || 'dev-key-change-me';

class MCPClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async request(method, endpoint, data = null) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(endpoint, this.baseUrl);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const options = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey
        }
      };

      const req = client.request(urlObj, options, (res) => {
        let responseData = '';

        res.on('data', chunk => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            if (res.statusCode >= 400) {
              reject(new Error(`${res.statusCode}: ${parsed.error || 'Unknown error'}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${responseData}`));
          }
        });
      });

      req.on('error', reject);

      if (data) {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }

  async list(dirPath = '/') {
    const endpoint = `/api/list?path=${encodeURIComponent(dirPath)}`;
    return this.request('GET', endpoint);
  }

  async read(filePath) {
    const endpoint = `/api/read?path=${encodeURIComponent(filePath)}`;
    return this.request('GET', endpoint);
  }

  async write(filePath, content) {
    return this.request('POST', '/api/write', { path: filePath, content });
  }

  async delete(targetPath, recursive = false) {
    const endpoint = `/api/delete?path=${encodeURIComponent(targetPath)}&recursive=${recursive}`;
    return this.request('DELETE', endpoint);
  }

  async stat(targetPath) {
    const endpoint = `/api/stat?path=${encodeURIComponent(targetPath)}`;
    return this.request('GET', endpoint);
  }

  async info() {
    return this.request('GET', '/api/info');
  }

  async health() {
    return this.request('GET', '/health');
  }
}

// Main
async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  if (!command) {
    console.log(`
MCP Client v1.0.0

Uso: node client.js <comando> [argumentos]

Comandos:
  health              Verificar conexión al servidor
  info                Información del servidor
  list <ruta>         Listar directorio
  read <ruta>         Leer archivo
  write <ruta> <texto> Escribir archivo
  delete <ruta>       Eliminar archivo/directorio
  stat <ruta>         Información del archivo

Ejemplos:
  node client.js health
  node client.js list /
  node client.js read /archivo.txt
  node client.js write /nuevo.txt "Hola mundo"

Variables de entorno:
  MCP_HOST            Host del servidor (default: http://localhost:3000)
  MCP_API_KEY         API Key para autenticación

    `);
    process.exit(0);
  }

  const client = new MCPClient(MCP_HOST, MCP_API_KEY);

  try {
    let result;

    switch (command) {
      case 'health':
        result = await client.health();
        break;
      case 'info':
        result = await client.info();
        break;
      case 'list':
        result = await client.list(args[0] || '/');
        break;
      case 'read':
        result = await client.read(args[0]);
        break;
      case 'write':
        result = await client.write(args[0], args[1]);
        break;
      case 'delete':
        result = await client.delete(args[0], args[1] === 'true');
        break;
      case 'stat':
        result = await client.stat(args[0]);
        break;
      default:
        console.error(`Comando desconocido: ${command}`);
        process.exit(1);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = MCPClient;
