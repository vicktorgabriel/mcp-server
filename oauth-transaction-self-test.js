#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { OAuthProvider, configureOAuthAdmin, tokenHash } = require('./oauth-provider');

function request({ body = '', headers = {}, address = '127.0.0.1' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.headers = headers;
  req.socket = { remoteAddress: address };
  return req;
}

function response() {
  return {
    statusCode: 0, headers: {}, body: '',
    writeHead(code, headers = {}) { this.statusCode = code; this.headers = headers; },
    end(body = '') { this.body += String(body || ''); }
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-transaction-'));
  const storePath = path.join(temp, 'oauth.json');
  try {
    configureOAuthAdmin(storePath, 'tester', `Password-${crypto.randomBytes(12).toString('hex')}`);
    const provider = new OAuthProvider({ storePath, transactionTtl: 600 });
    const issuer = 'https://mcp.example.test';
    const redirectUri = 'https://chatgpt.com/connector/oauth/callback_test_123';
    provider.store.state.clients['diagnostic-client'] = {
      clientId: 'diagnostic-client',
      clientName: 'ChatGPT',
      redirectUris: [redirectUri],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      clientSecretHash: '',
      applicationType: 'web',
      scope: 'mcp:tools offline_access',
      issuedAt: Math.floor(Date.now() / 1000),
      createdAt: new Date().toISOString()
    };
    provider.store.save();
    provider.validateAuthorizationRequest = async (url) => {
      const wait = Number(url.searchParams.get('wait') || 0);
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      return {
        client: { clientName: 'ChatGPT' },
        clientId: 'diagnostic-client',
        redirectUri,
        state: url.searchParams.get('state') || '',
        codeChallenge: 'A'.repeat(43),
        scopes: ['mcp:tools', 'offline_access'],
        resource: `${issuer}/mcp`
      };
    };

    const starts = [];
    for (let i = 0; i < 12; i += 1) {
      const url = new URL(`${issuer}/oauth/authorize?state=s${i}&wait=${(11 - i) * 2}`);
      const res = response();
      starts.push(provider.handleAuthorizationGet(request(), res, url, issuer).then(() => res));
    }
    const pages = await Promise.all(starts);
    assert.ok(pages.every((res) => res.statusCode === 200));
    provider.refreshStore();
    assert.equal(Object.keys(provider.store.state.authorizationTransactions).length, 12,
      'overlapping authorization starts must preserve every live transaction');

    const hidden = pages.map((res) => {
      const match = res.body.match(/name="transaction" value="([^"]+)"/);
      assert.ok(match && match[1]);
      return match[1];
    });
    for (const transactionId of hidden) {
      assert.ok(provider.store.state.authorizationTransactions[tokenHash(transactionId)],
        'every transaction rendered to the browser must still exist in the store');
    }

    const postBody = new URLSearchParams({
      transaction: hidden[0],
      username: 'wrong-user',
      password: 'wrong-password',
      decision: 'allow'
    }).toString();
    const postRes = response();
    await provider.handleAuthorizationPost(request({
      body: postBody,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }), postRes, issuer);
    assert.equal(postRes.statusCode, 401);
    assert.match(postRes.body, /Usuario o contraseña incorrectos/);
    provider.refreshStore();
    assert.ok(provider.store.state.authorizationTransactions[tokenHash(hidden[0])],
      'a failed login must not consume the transaction');

    process.stdout.write('oauth_transactions=OK\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
