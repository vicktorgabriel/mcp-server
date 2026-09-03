#!/usr/bin/env node
'use strict';

const path = require('path');
const { configureOAuthAdmin, OAuthStateStore } = require('./oauth-provider');
const { parseDotEnv } = require('./runtime-diagnostics');

const ROOT = __dirname;
const env = parseDotEnv();
const storePath = path.resolve(process.env.MCP_OAUTH_STORE || env.MCP_OAUTH_STORE || path.join(ROOT, '.private', 'oauth-state.json'));

function ignoreBrokenPipe(stream) {
  stream.on('error', (error) => {
    if (error && error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

ignoreBrokenPipe(process.stdout);

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function readAllStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '')));
    process.stdin.on('error', reject);
  });
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      readAllStdin().then(resolve);
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (character === '\r' || character === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(wasRaw);
          stdin.pause();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    stdin.on('data', onData);
  });
}

function statusSnapshot() {
  const store = new OAuthStateStore(storePath);
  const admin = store.state.admin;
  const now = Math.floor(Date.now() / 1000);
  const active = (collection) => Object.values(collection).filter((record) => Number(record.expiresAt || 0) > now).length;
  return {
    configured: Boolean(admin && admin.username && admin.passwordHash),
    username: admin ? admin.username : '',
    registeredClients: Object.keys(store.state.clients).length,
    activeSessions: active(store.state.accessTokens),
    activeRefreshTokens: active(store.state.refreshTokens),
    storePath: store.filePath
  };
}

function printStatus({ json = false } = {}) {
  const status = statusSnapshot();
  if (json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${[
    `Configurado: ${status.configured ? 'sí' : 'no'}`,
    `Usuario: ${status.username || '-'}`,
    `Clientes registrados: ${status.registeredClients}`,
    `Sesiones activas: ${status.activeSessions}`,
    `Renovaciones activas: ${status.activeRefreshTokens}`,
    `Archivo privado: ${status.storePath}`
  ].join('\n')}\n`);
}

function checkConfigured() {
  process.exitCode = statusSnapshot().configured ? 0 : 1;
}

function resetSessions({ clients = false } = {}) {
  const store = new OAuthStateStore(storePath);
  store.state.authorizationTransactions = {};
  store.state.authorizationCodes = {};
  store.state.accessTokens = {};
  store.state.refreshTokens = {};
  store.state.usedRefreshTokens = {};
  if (clients) store.state.clients = {};
  store.save();
  process.stdout.write(clients
    ? 'Sesiones y clientes OAuth eliminados. ChatGPT deberá registrar y autorizar de nuevo.\n'
    : 'Sesiones OAuth revocadas. ChatGPT deberá autorizar de nuevo.\n');
}

async function configure() {
  const username = argument('--username', process.env.MCP_OAUTH_USERNAME || 'admin');
  let password;
  if (process.argv.includes('--password-stdin')) password = await readAllStdin();
  else password = await readHidden('Nueva contraseña OAuth: ');
  if (!password) throw new Error('La contraseña OAuth no puede quedar vacía.');
  const result = configureOAuthAdmin(storePath, username, password);
  process.stdout.write(`OAuth configurado para el usuario ${result.username}. Las sesiones anteriores fueron revocadas.\n`);
}

async function main() {
  const command = process.argv[2] || 'status';
  switch (command) {
    case 'configure':
      await configure();
      break;
    case 'status':
      printStatus({ json: process.argv.includes('--json') });
      break;
    case 'is-configured':
    case 'check-configured':
      checkConfigured();
      break;
    case 'reset-sessions':
      resetSessions({ clients: false });
      break;
    case 'reset-all':
      resetSessions({ clients: true });
      break;
    default:
      process.stderr.write('Uso: node oauth-admin.js configure|status [--json]|is-configured|reset-sessions|reset-all\n');
      process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`No se pudo administrar OAuth: ${error.message}\n`);
  process.exitCode = 1;
});
