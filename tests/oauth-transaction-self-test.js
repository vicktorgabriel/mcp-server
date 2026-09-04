#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { OAuthProvider, configureOAuthAdmin, tokenHash } = require('../lib/oauth-provider');

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
    const password = `Password-${crypto.randomBytes(12).toString('hex')}`;
    configureOAuthAdmin(storePath, 'tester', password);
    const provider = new OAuthProvider({ storePath, transactionTtl: 600, responseIssEnabled: true });
    const issuer = 'https://mcp.example.test';
    const redirectUri = 'https://chatgpt.com/connector/oauth/callback_test_123';
    assert.equal(provider.metadata(issuer).authorization_response_iss_parameter_supported, true);
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
    const authorizationCsp = pages[0].headers['content-security-policy'] || '';
    assert.match(authorizationCsp, /form-action https:\/\/mcp\.example\.test https:\/\/chatgpt\.com(?:;|\s)/,
      'the form CSP must allow both its POST target and the registered callback origin');
    assert.doesNotMatch(authorizationCsp, /attacker\.example/);
    provider.refreshStore();
    assert.equal(Object.keys(provider.store.state.authorizationTransactions).length, 12,
      'overlapping authorization starts must preserve every live transaction');

    const hidden = pages.map((res) => {
      const match = res.body.match(/name="transaction" value="([^"]+)"/);
      assert.ok(match && match[1]);
      return match[1];
    });
    const allowForm = pages[0].body.match(/<form id="allow-form"[^>]*>([\s\S]*?)<\/form>/);
    const denyForm = pages[0].body.match(/<form id="deny-form"[^>]*>([\s\S]*?)<\/form>/);
    assert.ok(allowForm && denyForm, 'allow and deny must be separate forms');
    assert.match(allowForm[1], /name="decision" value="allow"/);
    assert.match(allowForm[1], /name="username"/);
    assert.match(allowForm[1], /name="password"/);
    assert.match(allowForm[1], /autocomplete="username"/);
    assert.match(allowForm[1], /autocomplete="current-password"/);
    assert.doesNotMatch(allowForm[1], /value="deny"/);
    assert.equal((allowForm[1].match(/type="submit"/g) || []).length, 1,
      'the credential form must have exactly one submit outcome');
    assert.match(denyForm[1], /name="decision" value="deny"/);
    assert.doesNotMatch(denyForm[1], /name="(?:username|password|mcp_user|mcp_secret)"/);
    assert.equal((denyForm[1].match(/type="submit"/g) || []).length, 1);
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
    assert.match(postRes.headers['content-security-policy'] || '', /form-action https:\/\/mcp\.example\.test https:\/\/chatgpt\.com(?:;|\s)/,
      'a credential retry page must preserve the callback origin in form-action');
    provider.refreshStore();
    assert.ok(provider.store.state.authorizationTransactions[tokenHash(hidden[0])],
      'a failed login must not consume the transaction');

    const hostileOrigin = response();
    await provider.handleAuthorizationPost(request({
      body: new URLSearchParams({ transaction: hidden[1], username: 'tester', password, decision: 'allow' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://attacker.example' }
    }), hostileOrigin, issuer);
    assert.equal(hostileOrigin.statusCode, 400);
    provider.refreshStore();
    assert.ok(provider.store.state.authorizationTransactions[tokenHash(hidden[1])],
      'a hostile Origin must be rejected without consuming the transaction');

    const incompleteOpaqueOrigin = response();
    await provider.handleAuthorizationPost(request({
      body: new URLSearchParams({ transaction: hidden[2], username: 'tester', password, decision: 'allow' }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'document'
      }
    }), incompleteOpaqueOrigin, issuer);
    assert.equal(incompleteOpaqueOrigin.statusCode, 400);
    provider.refreshStore();
    assert.ok(provider.store.state.authorizationTransactions[tokenHash(hidden[2])],
      'an opaque Origin without navigation metadata must not consume the transaction');

    const enterSubmit = response();
    await provider.handleAuthorizationPost(request({
      body: new URLSearchParams({ transaction: hidden[3], decision: 'allow', username: 'tester', password }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: issuer,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document'
      }
    }), enterSubmit, issuer);
    assert.equal(enterSubmit.statusCode, 302, 'implicit credential-form submission must authorize, never deny');
    const enterCallback = new URL(enterSubmit.headers.location);
    assert.ok(enterCallback.searchParams.get('code'));
    assert.equal(enterCallback.searchParams.get('error'), null);
    assert.equal(enterCallback.searchParams.get('iss'), issuer);
    provider.refreshStore();
    assert.equal(provider.store.state.authorizationTransactions[tokenHash(hidden[3])], undefined);

    const opaqueOrigin = response();
    await provider.handleAuthorizationPost(request({
      body: new URLSearchParams({ transaction: hidden[4], decision: 'allow', username: 'tester', password }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document'
      }
    }), opaqueOrigin, issuer);
    assert.equal(opaqueOrigin.statusCode, 302);
    assert.ok(new URL(opaqueOrigin.headers.location).searchParams.get('code'));

    const cancel = response();
    await provider.handleAuthorizationPost(request({
      body: new URLSearchParams({ transaction: hidden[5], decision: 'deny' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: issuer }
    }), cancel, issuer);
    assert.equal(cancel.statusCode, 302);
    const cancelCallback = new URL(cancel.headers.location);
    assert.equal(cancelCallback.searchParams.get('error'), 'access_denied');
    assert.equal(cancelCallback.searchParams.get('code'), null);
    assert.equal(cancelCallback.searchParams.get('iss'), issuer);

    const contaminatedCancel = response();
    await provider.handleAuthorizationPost(request({
      body: new URLSearchParams({ transaction: hidden[6], decision: 'deny', username: 'tester', password }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: issuer }
    }), contaminatedCancel, issuer);
    assert.equal(contaminatedCancel.statusCode, 400);
    provider.refreshStore();
    assert.ok(provider.store.state.authorizationTransactions[tokenHash(hidden[6])],
      'a deny carrying credential controls must be rejected without consuming the transaction');

    provider.refreshStore();
    const codeCountBefore = Object.keys(provider.store.state.authorizationCodes).length;
    const duplicateBody = new URLSearchParams({
      transaction: hidden[7], decision: 'allow', username: 'tester', password
    }).toString();
    const duplicateResponses = [response(), response()];
    await Promise.all(duplicateResponses.map((duplicateResponse) => provider.handleAuthorizationPost(request({
      body: duplicateBody,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: issuer }
    }), duplicateResponse, issuer)));
    assert.deepEqual(duplicateResponses.map((entry) => entry.statusCode).sort(), [302, 400],
      'a duplicated submit must issue one code and reject the replay');
    provider.refreshStore();
    assert.equal(Object.keys(provider.store.state.authorizationCodes).length, codeCountBefore + 1);

    process.stdout.write('oauth_transactions=OK\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
