#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { configureOAuthAdmin, OAuthStateStore, tokenHash } = require('../lib/oauth-provider');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`Timeout waiting for ${url}`);
}

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

function form(values) {
  return new URLSearchParams(values).toString();
}

function rawFormPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      method: 'POST',
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(body)
      }
    }, (response) => {
      response.resume();
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: { get: (name) => response.headers[String(name).toLowerCase()] || null }
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function json(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch (_) { throw new Error(`Expected JSON (${response.status}): ${text.slice(0, 500)}`); }
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-selftest-'));
  const allowed = path.join(temp, 'allowed');
  const runtime = path.join(temp, 'runtime');
  const privateDir = path.join(temp, 'private');
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(path.join(allowed, 'hello.txt'), 'hola oauth\n');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const storePath = path.join(privateDir, 'oauth-state.json');
  const humanLog = path.join(runtime, 'events.log');
  const password = 'Prueba-OAuth-2026-Muy-Segura';
  configureOAuthAdmin(storePath, 'tester', password);

  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server.js'), '--http'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      ALLOWED_PATHS: allowed,
      WORKING_DIR: allowed,
      MCP_FULL_ACCESS: '0',
      MCP_AUTH_MODE: 'oauth',
      MCP_AUTH_TOKEN: '',
      MCP_ACCESS_PROFILE: 'developer',
      MCP_CONFIG_SOURCE: 'env',
      MCP_RUN_AS_ROOT: '1',
      MCP_TEST_ALLOW_ROOT_FLAG: '1',
      MCP_CRITICAL_CONFIRMATIONS: '0',
      MCP_PUBLIC_BASE_URL: base,
      PUBLIC_BASE_URL: base,
      MCP_OAUTH_ALLOW_HTTP_LOCALHOST: '1',
      MCP_OAUTH_STORE: storePath,
      MCP_HUMAN_LOG: humanLog,
      ACTIVITY_LOG: path.join(runtime, 'activity.ndjson'),
      MCP_ERROR_LOG: path.join(runtime, 'errors.log'),
      MCP_DESKTOP_ENABLED: '0',
      MCP_INPUT_ENABLED: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.resume();

  try {
    const health = await waitFor(`${base}/health`);
    const healthBody = await json(health);
    assert.equal(healthBody.auth, 'oauth');
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.allowedRoots, undefined, 'public health must not expose allowed roots');

    const denied = await fetch(`${base}/mcp`);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') || '', /resource_metadata=/);
    assert.match(denied.headers.get('www-authenticate') || '', /scope="mcp:tools"/);
    assert.doesNotMatch(denied.headers.get('www-authenticate') || '', /error=/,
      'a missing HTTP credential challenge must not claim an invalid token was supplied');

    const resourceMetadata = await json(await fetch(`${base}/.well-known/oauth-protected-resource/mcp`));
    const rootResourceMetadata = await json(await fetch(`${base}/.well-known/oauth-protected-resource`));
    assert.equal(resourceMetadata.resource, `${base}/mcp`);
    assert.deepEqual(resourceMetadata.authorization_servers, [base]);
    assert.deepEqual(resourceMetadata.scopes_supported, ['mcp:tools'],
      'offline_access belongs to authorization-server metadata, not protected-resource requirements');
    assert.deepEqual(rootResourceMetadata, resourceMetadata);

    const discoveryInitialize = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'initialize', params: {} })
    });
    assert.equal(discoveryInitialize.status, 200);
    const discoveryInitializeBody = await json(discoveryInitialize);
    assert.equal(discoveryInitializeBody.result.serverInfo.name, 'mcp-local-control');

    const discoveryTools = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/list', params: {} })
    });
    assert.equal(discoveryTools.status, 200);
    const discoveryToolsBody = await json(discoveryTools);
    assert.ok(discoveryToolsBody.result.tools.length > 0);
    for (const tool of discoveryToolsBody.result.tools) {
      assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['mcp:tools'] }]);
      assert.deepEqual(tool._meta && tool._meta.securitySchemes, tool.securitySchemes);
    }

    const discoveryCall = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'tools/call', params: { name: 'tool_policy_status', arguments: {} } })
    });
    assert.equal(discoveryCall.status, 200);
    const discoveryCallBody = await json(discoveryCall);
    assert.equal(discoveryCallBody.result.isError, true);
    assert.ok(Array.isArray(discoveryCallBody.result._meta['mcp/www_authenticate']));
    assert.match(discoveryCallBody.result._meta['mcp/www_authenticate'][0], /resource_metadata=/);
    assert.match(discoveryCallBody.result._meta['mcp/www_authenticate'][0], /error="invalid_token"/);
    assert.match(discoveryCallBody.result._meta['mcp/www_authenticate'][0], /error_description=/);

    const authorizationMetadata = await json(await fetch(`${base}/.well-known/oauth-authorization-server`));
    assert.equal(authorizationMetadata.issuer, base);
    assert.equal(authorizationMetadata.authorization_endpoint, `${base}/oauth/authorize`);
    assert.equal(authorizationMetadata.token_endpoint, `${base}/oauth/token`);
    assert.equal(authorizationMetadata.revocation_endpoint, `${base}/oauth/revoke`);
    assert.deepEqual(authorizationMetadata.scopes_supported, ['mcp:tools', 'offline_access']);
    assert.deepEqual(authorizationMetadata.response_types_supported, ['code']);
    assert.deepEqual(authorizationMetadata.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(authorizationMetadata.code_challenge_methods_supported, ['S256']);
    assert.equal(authorizationMetadata.authorization_response_iss_parameter_supported, undefined);
    assert.equal(authorizationMetadata.resource_indicators_supported, true);
    assert.ok(authorizationMetadata.response_modes_supported.includes('query'));
    assert.equal(authorizationMetadata.client_id_metadata_document_supported, false);
    assert.ok(authorizationMetadata.token_endpoint_auth_methods_supported.includes('none'));
    assert.ok(authorizationMetadata.revocation_endpoint_auth_methods_supported.includes('none'));
    assert.equal(authorizationMetadata.registration_endpoint, `${base}/oauth/register`);

    const redirectUri = 'http://127.0.0.1:45891/callback';
    const registration = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Prueba ChatGPT',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
        scope: 'mcp:tools offline_access'
      })
    });
    assert.equal(registration.status, 201);
    const client = await json(registration);
    assert.ok(client.client_id);
    assert.equal(client.client_secret, undefined);
    assert.equal(client.application_type, 'native');
    assert.equal(client.scope, 'mcp:tools offline_access');
    assert.equal(registration.headers.get('access-control-allow-origin'), '*');
    assert.equal(registration.headers.get('strict-transport-security'), 'max-age=31536000');

    const { verifier, challenge } = pkce();
    const authUrl = new URL(`${base}/oauth/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', client.client_id);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'mcp:tools');
    authUrl.searchParams.set('state', 'estado-prueba');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('resource', `${base}/mcp`);

    const missingAuthorizationResource = new URL(authUrl);
    missingAuthorizationResource.searchParams.delete('resource');
    assert.equal((await fetch(missingAuthorizationResource)).status, 400);
    const invalidAuthorizationPkce = new URL(authUrl);
    invalidAuthorizationPkce.searchParams.set('code_challenge_method', 'plain');
    assert.equal((await fetch(invalidAuthorizationPkce)).status, 400);

    const authorizePage = await fetch(authUrl, {
      headers: {
        'sec-fetch-dest': 'iframe',
        'sec-fetch-site': 'cross-site',
        referer: 'https://chatgpt.com/'
      }
    });
    assert.equal(authorizePage.status, 200);
    assert.equal(authorizePage.headers.get('x-frame-options'), null, 'OAuth UI must not be blocked by X-Frame-Options');
    assert.equal(authorizePage.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.match(authorizePage.headers.get('content-security-policy') || '', /frame-ancestors[^;]*https:\/\/chatgpt\.com/);
    assert.match(authorizePage.headers.get('content-security-policy') || '', /https:\/\/\*\.chatgpt\.com/);
    assert.match(authorizePage.headers.get('content-security-policy') || '', /form-action[^;]*http:\/\/127\.0\.0\.1:\d+/,
      'form-action must allow the exact registered callback origin so Chromium can follow the form redirect');
    const page = await authorizePage.text();
    const transaction = page.match(/name="transaction" value="([^"]+)"/);
    assert.ok(transaction && transaction[1]);
    assert.ok(!page.includes(password));
    assert.ok(!page.includes('value="tester"'), 'the public authorization page must not disclose the OAuth username');
    assert.ok(page.includes('127.0.0.1:45891'), 'the consent page must show the exact callback destination');
    assert.ok(page.includes('Desarrollo'), 'the consent page must show the selected access profile');
    assert.ok(page.includes('56'), 'the consent page must show the published tool count');
    assert.ok(page.includes('Configuración de riesgo alto'), 'the consent page must warn about expert risk settings');
    assert.ok(page.includes('se ejecuta como root'), 'the consent page must disclose root execution');
    assert.ok(page.includes('confirmaciones adicionales'), 'the consent page must disclose disabled confirmations');

    const authorizationBody = form({
      transaction: transaction[1],
      username: 'tester',
      password,
      decision: 'allow'
    });
    const authorization = await rawFormPost(`${base}/oauth/authorize`, authorizationBody, {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'sec-fetch-user': '?1'
    });
    assert.equal(authorization.status, 302);
    const callback = new URL(authorization.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'estado-prueba');
    assert.equal(callback.searchParams.get('iss'), null);
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const tokenWithoutResource = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri
      })
    });
    assert.equal(tokenWithoutResource.status, 400);

    const tokenWithWrongResource = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code', client_id: client.client_id, code,
        code_verifier: verifier, redirect_uri: redirectUri, resource: `${base}/different-resource`
      })
    });
    assert.equal(tokenWithWrongResource.status, 400);
    assert.equal((await json(tokenWithWrongResource)).error, 'invalid_target');

    const tokenWithWrongVerifier = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code', client_id: client.client_id, code,
        code_verifier: `${verifier.slice(0, -1)}${verifier.endsWith('A') ? 'B' : 'A'}`,
        redirect_uri: redirectUri, resource: `${base}/mcp`
      })
    });
    assert.equal(tokenWithWrongVerifier.status, 400);
    assert.equal((await json(tokenWithWrongVerifier)).error, 'invalid_grant');

    const duplicateGrantBody = `${form({
      grant_type: 'authorization_code', client_id: client.client_id, code,
      code_verifier: verifier, redirect_uri: redirectUri, resource: `${base}/mcp`
    })}&grant_type=refresh_token`;
    const tokenWithDuplicateGrant = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: duplicateGrantBody
    });
    assert.equal(tokenWithDuplicateGrant.status, 400);
    assert.equal((await json(tokenWithDuplicateGrant)).error, 'invalid_request');

    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: `${base}/mcp`
      })
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await json(tokenResponse);
    assert.match(tokens.access_token, /^mcp_at_/);
    assert.match(tokens.refresh_token, /^mcp_rt_/);
    assert.equal(tokens.scope, 'mcp:tools');
    assert.equal(tokens.resource, `${base}/mcp`);

    const replayedCode = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: `${base}/mcp`
      })
    });
    assert.equal(replayedCode.status, 400, 'an authorization code must be consumable only once');

    const initialized = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(initialized.status, 200);
    const initializeBody = await json(initialized);
    assert.equal(initializeBody.result.serverInfo.name, 'mcp-local-control');

    const toolsResponse = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
    assert.equal(toolsResponse.status, 200);
    const tools = await json(toolsResponse);
    assert.ok(tools.result.tools.some((tool) => tool.name === 'mcp_runtime_logs'));

    const policyResponse = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'tool_policy_status', arguments: {} } })
    });
    assert.equal(policyResponse.status, 200);
    const policy = await json(policyResponse);
    assert.notEqual(policy.result.isError, true, 'the authenticated tool must execute instead of returning an auth challenge');
    assert.ok(Array.isArray(policy.result.content));

    const revokeAccess = await fetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: client.client_id, token: tokens.access_token, token_type_hint: 'access_token' })
    });
    assert.equal(revokeAccess.status, 200);
    const revokedAccess = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/list', params: {} })
    });
    assert.equal(revokedAccess.status, 401, 'a revoked access token must stop working immediately');

    const refreshWithoutResource = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token
      })
    });
    assert.equal(refreshWithoutResource.status, 400);

    const refreshedResponse = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
        resource: `${base}/mcp`,
        scope: 'mcp:tools'
      })
    });
    assert.equal(refreshedResponse.status, 200);
    const refreshed = await json(refreshedResponse);
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token, 'refresh tokens must rotate');
    assert.equal(refreshed.scope, 'mcp:tools');
    assert.match(refreshed.refresh_token, /^mcp_rt_/,
      'narrowing the access scope must still return the rotated refresh token');

    const refreshedPolicyResponse = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${refreshed.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'tool_policy_status', arguments: {} } })
    });
    assert.equal(refreshedPolicyResponse.status, 200);
    const refreshedPolicy = await json(refreshedPolicyResponse);
    assert.notEqual(refreshedPolicy.result.isError, true,
      'the real tool must keep working with the access token issued by refresh');

    const reusedRefresh = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
        resource: `${base}/mcp`
      })
    });
    assert.equal(reusedRefresh.status, 400);

    const revokedFamilyAccess = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${refreshed.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
    });
    assert.equal(revokedFamilyAccess.status, 401, 'refresh-token replay must revoke the whole token family');

    const revokedFamilyRefresh = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: refreshed.refresh_token,
        resource: `${base}/mcp`
      })
    });
    assert.equal(revokedFamilyRefresh.status, 400);

    const externalStore = new OAuthStateStore(storePath);
    const externalAccessToken = `mcp_at_${crypto.randomBytes(32).toString('base64url')}`;
    externalStore.state.accessTokens[tokenHash(externalAccessToken)] = {
      clientId: client.client_id,
      subject: 'tester',
      scope: 'mcp:tools offline_access',
      resource: `${base}/mcp`,
      familyId: 'external-test-family',
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 600
    };
    externalStore.save();
    const loadedExternally = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${externalAccessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
    });
    assert.equal(loadedExternally.status, 200, 'the running server must reload externally added OAuth state');
    delete externalStore.state.accessTokens[tokenHash(externalAccessToken)];
    externalStore.save();
    const revokedExternally = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${externalAccessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} })
    });
    assert.equal(revokedExternally.status, 401, 'externally revoked sessions must be reloaded without restarting the server');

    const stateText = fs.readFileSync(storePath, 'utf8');
    for (const secret of [password, transaction[1], tokens.access_token, tokens.refresh_token, code, verifier, 'estado-prueba', refreshed.access_token, refreshed.refresh_token, externalAccessToken]) {
      assert.ok(!stateText.includes(secret), 'OAuth state must not contain clear credentials or tokens');
    }
    const mode = fs.statSync(storePath).mode & 0o777;
    assert.equal(mode, 0o600);

    const logs = fs.readFileSync(humanLog, 'utf8');
    assert.match(logs, /CONEXION/);
    assert.match(logs, /descubrimiento sin sesión OAuth/,
      'an unauthenticated initialize must not be reported as a completed OAuth connection');
    assert.match(logs, /Credenciales OAuth aceptadas y código emitido/);
    assert.ok(!logs.includes(password));
    assert.ok(!logs.includes(tokens.access_token));
    assert.ok(!logs.includes(tokens.refresh_token));
    assert.ok(!logs.includes(code));
    assert.ok(!logs.includes(verifier));
    assert.ok(!logs.includes('estado-prueba'));
    assert.ok(!logs.includes(transaction[1]));
    assert.match(logs, /origin=opaco/);
    assert.match(logs, /entrada=POST \/oauth\/token/);
    assert.match(logs, /salida=200 \/oauth\/token/);
    assert.match(logs, /Token OAuth emitido correctamente/);

    process.stdout.write('oauth_end_to_end=OK\n');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode === null) child.kill('SIGKILL');
    if (process.env.KEEP_MCP_TEST_TMP !== '1') fs.rmSync(temp, { recursive: true, force: true });
  }

  if (child.exitCode && child.exitCode !== 0 && !/SIGTERM/.test(String(child.signalCode || ''))) {
    throw new Error(`MCP test server exited unexpectedly (${child.exitCode}): ${stderr.slice(-1200)}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
