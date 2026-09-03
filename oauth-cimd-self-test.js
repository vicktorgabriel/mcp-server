#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OAuthProvider, OAuthStateStore } = require('./oauth-provider');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-cimd-'));
  const storePath = path.join(temp, 'oauth-state.json');
  const clientId = 'https://chatgpt.com/oauth/client.json';
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  let fetches = 0;
  const document = {
    client_id: clientId,
    client_uri: 'https://chatgpt.com/',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'ChatGPT',
    jwks_uri: 'https://chatgpt.com/oauth/jwks.json'
  };

  try {
    const provider = new OAuthProvider({
      storePath,
      cimdEnabled: true,
      cimdHosts: new Set(['chatgpt.com']),
      cimdCacheTtl: 3600,
      cimdFetcher: async (url) => {
        fetches += 1;
        assert.equal(url, clientId);
        return { ...document };
      }
    });

    const metadata = provider.metadata('https://mcp.example.test');
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.ok(metadata.token_endpoint_auth_methods_supported.includes('none'));
    assert.ok(metadata.token_endpoint_auth_methods_supported.includes('private_key_jwt'));
    assert.ok(metadata.registration_endpoint.endsWith('/oauth/register'), 'DCR must remain available as fallback');

    const resolved = await provider.resolveClient(clientId, { redirectUri });
    assert.equal(resolved.clientName, 'ChatGPT');
    assert.equal(resolved.registrationType, 'cimd');
    assert.equal(resolved.tokenEndpointAuthMethod, 'private_key_jwt');
    assert.deepEqual(resolved.tokenEndpointAuthMethods, ['none', 'private_key_jwt']);
    assert.equal(resolved.jwksUri, 'https://chatgpt.com/oauth/jwks.json');
    assert.deepEqual(resolved.redirectUris, [redirectUri]);
    assert.equal(fetches, 1);

    const cached = await provider.resolveClient(clientId, { redirectUri });
    assert.equal(cached.clientId, clientId);
    assert.equal(fetches, 1, 'a fresh CIMD cache entry must not refetch immediately');

    const persisted = new OAuthStateStore(storePath).state.clients[clientId];
    assert.equal(persisted.registrationType, 'cimd');
    assert.equal(persisted.clientSecretHash, '');
    assert.equal(Object.hasOwn(persisted, 'jwks_uri'), false, 'unneeded remote metadata should not be persisted');

    const authUrl = new URL('https://mcp.example.test/oauth/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'mcp:tools offline_access');
    authUrl.searchParams.set('code_challenge', 'A'.repeat(43));
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('resource', 'https://mcp.example.test/mcp');
    const validated = await provider.validateAuthorizationRequest(authUrl, 'https://mcp.example.test');
    assert.equal(validated.clientId, clientId);
    assert.equal(validated.client.clientName, 'ChatGPT');

    const tokenForm = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri });
    const tokenClient = await provider.authenticateClient({ headers: {} }, tokenForm);
    assert.equal(tokenClient.clientId, clientId);
    assert.equal(tokenClient.authenticatedWith, 'none');

    assert.equal(await provider.resolveClient('https://evil.example/oauth/client.json', { redirectUri }), null);

    const unsafeHostProvider = new OAuthProvider({
      storePath: path.join(temp, 'unsafe-host.json'),
      cimdEnabled: true,
      cimdHosts: new Set(['127.0.0.1', 'localhost']),
      cimdFetcher: async () => { throw new Error('must not fetch local hosts'); }
    });
    assert.equal(await unsafeHostProvider.resolveClient('https://127.0.0.1/oauth/client.json', { redirectUri }), null);
    assert.equal(await unsafeHostProvider.resolveClient('https://localhost/oauth/client.json', { redirectUri }), null);

    const legacyStorePath = path.join(temp, 'legacy-cimd.json');
    const legacyStore = new OAuthStateStore(legacyStorePath);
    legacyStore.state.clients[clientId] = {
      clientId,
      clientName: 'ChatGPT',
      redirectUris: [redirectUri],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      clientSecretHash: '',
      applicationType: 'web',
      scope: 'mcp:tools offline_access',
      registrationType: 'cimd',
      cimdMetadataUrl: clientId,
      cimdValidatedAt: Math.floor(Date.now() / 1000),
      issuedAt: Math.floor(Date.now() / 1000),
      createdAt: new Date().toISOString()
    };
    legacyStore.save();
    let legacyRefreshes = 0;
    const migrationProvider = new OAuthProvider({
      storePath: legacyStorePath,
      cimdEnabled: true,
      cimdHosts: new Set(['chatgpt.com']),
      cimdFetcher: async () => { legacyRefreshes += 1; return { ...document }; }
    });
    const migrated = await migrationProvider.resolveClient(clientId, { redirectUri });
    assert.equal(legacyRefreshes, 1, 'a 4.3-era CIMD record must refresh immediately after upgrading');
    assert.ok(migrated.tokenEndpointAuthMethods.includes('private_key_jwt'));
    assert.equal(migrated.jwksUri, document.jwks_uri);

    const badRedirectProvider = new OAuthProvider({
      storePath: path.join(temp, 'bad-redirect.json'),
      cimdEnabled: true,
      cimdHosts: new Set(['chatgpt.com']),
      cimdFetcher: async () => ({ ...document })
    });
    await assert.rejects(
      () => badRedirectProvider.resolveClient(clientId, { redirectUri: 'https://attacker.example/callback' }),
      /redirect_uri no coincide/i
    );

    const wrongIdProvider = new OAuthProvider({
      storePath: path.join(temp, 'wrong-id.json'),
      cimdEnabled: true,
      cimdHosts: new Set(['chatgpt.com']),
      cimdFetcher: async () => ({ ...document, client_id: 'https://chatgpt.com/oauth/other.json' })
    });
    await assert.rejects(
      () => wrongIdProvider.resolveClient(clientId, { redirectUri }),
      /client_id.*no coincide/i
    );

    const privateOnlyProvider = new OAuthProvider({
      storePath: path.join(temp, 'private-only.json'),
      cimdEnabled: true,
      cimdHosts: new Set(['chatgpt.com']),
      cimdFetcher: async () => ({
        ...document,
        token_endpoint_auth_methods_supported: ['private_key_jwt']
      })
    });
    const privateOnly = await privateOnlyProvider.resolveClient(clientId, { redirectUri });
    assert.deepEqual(privateOnly.tokenEndpointAuthMethods, ['private_key_jwt']);
    assert.equal(privateOnly.tokenEndpointAuthMethod, 'private_key_jwt');

    process.stdout.write('oauth_cimd=OK\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
