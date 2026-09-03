#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { OAuthProvider, tokenHash } = require('./oauth-provider');

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signAssertion(privateKey, { clientId, audience, kid, expiresIn = 300, issuedOffset = 0, jti = crypto.randomUUID() }) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', kid, typ: 'JWT' });
  const payload = encode({
    iss: clientId,
    sub: clientId,
    aud: audience,
    iat: now + issuedOffset,
    exp: now + expiresIn,
    jti
  });
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function fakeRequest(body) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = String(body || '');
    }
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-pkjwt-'));
  const storePath = path.join(temp, 'oauth-state.json');
  const clientId = 'https://chatgpt.com/oauth/client.json';
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const issuer = 'https://mcp.example.test';
  const resource = `${issuer}/mcp`;
  const tokenEndpoint = `${issuer}/oauth/token`;
  const kid = 'chatgpt-test-key';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid, alg: 'RS256', use: 'sig' });
  let jwksFetches = 0;
  const document = {
    client_id: clientId,
    client_uri: 'https://chatgpt.com/',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'ChatGPT',
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    token_endpoint_auth_signing_alg: 'RS256',
    jwks_uri: 'https://chatgpt.com/oauth/jwks.json'
  };

  try {
    const provider = new OAuthProvider({
      storePath,
      cimdEnabled: true,
      cimdHosts: new Set(['chatgpt.com']),
      cimdFetcher: async (url) => {
        assert.equal(url, clientId);
        return { ...document };
      },
      jwksFetcher: async (url) => {
        jwksFetches += 1;
        assert.equal(url, document.jwks_uri);
        return { keys: [{ ...jwk }] };
      }
    });

    const metadata = provider.metadata(issuer);
    assert.ok(metadata.token_endpoint_auth_methods_supported.includes('private_key_jwt'));
    const client = await provider.resolveClient(clientId, { redirectUri });
    assert.equal(client.tokenEndpointAuthMethod, 'private_key_jwt');
    assert.deepEqual(client.tokenEndpointAuthMethods, ['none', 'private_key_jwt']);
    assert.equal(client.jwksUri, document.jwks_uri);

    const assertion = signAssertion(privateKey, { clientId, audience: tokenEndpoint, kid });
    const privateForm = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion
    });
    const authenticated = await provider.authenticateClient({ headers: {} }, privateForm, issuer);
    assert.equal(authenticated.authenticatedWith, 'private_key_jwt');
    assert.equal(jwksFetches, 1);

    await assert.rejects(
      () => provider.authenticateClient({ headers: {} }, privateForm, issuer),
      /ya fue utilizada/i
    );

    const inferredAssertion = signAssertion(privateKey, { clientId, audience: issuer, kid });
    const inferred = await provider.authenticateClient({ headers: {} }, new URLSearchParams({
      redirect_uri: redirectUri,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: inferredAssertion
    }), issuer);
    assert.equal(inferred.clientId, clientId, 'client_id may be safely inferred from a verified CIMD assertion');
    assert.equal(jwksFetches, 1, 'JWKS should be cached');

    const publicClient = await provider.authenticateClient({ headers: {} }, new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri
    }), issuer);
    assert.equal(publicClient.authenticatedWith, 'none');

    const wrongAudience = signAssertion(privateKey, { clientId, audience: 'https://attacker.example/token', kid });
    await assert.rejects(
      () => provider.authenticateClient({ headers: {} }, new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: wrongAudience
      }), issuer),
      /audiencia/i
    );

    const otherKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongSignature = signAssertion(otherKeys.privateKey, { clientId, audience: tokenEndpoint, kid });
    await assert.rejects(
      () => provider.authenticateClient({ headers: {} }, new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: wrongSignature
      }), issuer),
      /firma/i
    );

    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const code = `mcp_ac_${crypto.randomBytes(32).toString('base64url')}`;
    provider.store.state.authorizationCodes[tokenHash(code)] = {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      scope: 'mcp:tools offline_access',
      resource,
      subject: 'tester',
      expiresAt: Math.floor(Date.now() / 1000) + 300
    };
    provider.store.save();

    const exchangeAssertion = signAssertion(privateKey, { clientId, audience: tokenEndpoint, kid });
    const exchangeBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: exchangeAssertion
    }).toString();
    const exchangeRes = fakeResponse();
    await provider.handleToken(fakeRequest(exchangeBody), exchangeRes, issuer);
    assert.equal(exchangeRes.statusCode, 200, exchangeRes.body);
    const tokens = JSON.parse(exchangeRes.body);
    assert.match(tokens.access_token, /^mcp_at_/);
    assert.match(tokens.refresh_token, /^mcp_rt_/);
    assert.equal(tokens.resource, resource);

    const refreshAssertion = signAssertion(privateKey, { clientId, audience: tokenEndpoint, kid });
    const refreshBody = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      resource,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: refreshAssertion
    }).toString();
    const refreshRes = fakeResponse();
    await provider.handleToken(fakeRequest(refreshBody), refreshRes, issuer);
    assert.equal(refreshRes.statusCode, 200, refreshRes.body);
    const refreshed = JSON.parse(refreshRes.body);
    assert.match(refreshed.access_token, /^mcp_at_/);
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);

    const badResourceBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: 'not-a-real-code',
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: 'https://attacker.example/mcp'
    }).toString();
    const badResourceRes = fakeResponse();
    await provider.handleToken(fakeRequest(badResourceBody), badResourceRes, issuer);
    assert.equal(badResourceRes.statusCode, 400);
    assert.match(badResourceRes.body, /invalid_grant|invalid_target/);

    process.stdout.write('oauth_private_key_jwt=OK\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
