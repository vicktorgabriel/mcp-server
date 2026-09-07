#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const cbor = require('@levischuck/tiny-cbor');
const { MfaManager, MfaCorruptedStateError, generateTotpCode } = require('../lib/mfa');
const { OAuthProvider, configureOAuthAdmin } = require('../lib/oauth-provider');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function createVirtualAuthenticator(rpId, origin) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');

  const coseKey = new Map();
  coseKey.set(1, 2); // EC2
  coseKey.set(3, -7); // ES256
  coseKey.set(-1, 1); // P-256
  coseKey.set(-2, new Uint8Array(x));
  coseKey.set(-3, new Uint8Array(y));
  const coseKeyBytes = Buffer.from(cbor.encodeCBOR(coseKey));

  const credId = crypto.randomBytes(16);
  let counter = 0;

  return {
    credId,
    getRegistrationResponse(challenge, opts = {}) {
      const userVerified = opts.userVerification !== false;
      const testOrigin = opts.origin || origin;
      const testRpId = opts.rpId || rpId;
      const rpIdHash = crypto.createHash('sha256').update(testRpId).digest();
      const flags = (userVerified ? 0x05 : 0x01) | 0x40; // UP | (UV) | AT
      const signCount = Buffer.alloc(4);
      signCount.writeUInt32BE(0, 0);
      const aaguid = Buffer.alloc(16, 0);
      const credIdLen = Buffer.alloc(2);
      credIdLen.writeUInt16BE(credId.length, 0);
      const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), signCount, aaguid, credIdLen, credId, coseKeyBytes]);

      const attestationObject = new Map();
      attestationObject.set('fmt', 'none');
      attestationObject.set('attStmt', new Map());
      attestationObject.set('authData', new Uint8Array(authData));
      const attestationBytes = Buffer.from(cbor.encodeCBOR(attestationObject));

      const clientDataJSON = Buffer.from(JSON.stringify({
        type: 'webauthn.create',
        challenge,
        origin: testOrigin,
        crossOrigin: false
      }));

      return {
        id: credId.toString('base64url'),
        rawId: credId.toString('base64url'),
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          attestationObject: attestationBytes.toString('base64url')
        },
        type: 'public-key',
        clientExtensionResults: {}
      };
    },
    getAuthenticationResponse(challenge, opts = {}) {
      const userVerified = opts.userVerification !== false;
      const testOrigin = opts.origin || origin;
      const testRpId = opts.rpId || rpId;
      const rpIdHash = crypto.createHash('sha256').update(testRpId).digest();
      if (opts.counter !== undefined) {
        counter = opts.counter;
      } else {
        counter += 1;
      }
      const signCount = Buffer.alloc(4);
      signCount.writeUInt32BE(counter, 0);
      const flags = userVerified ? 0x05 : 0x01; // UP | (UV)
      const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), signCount]);

      const clientDataJSON = Buffer.from(JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: testOrigin,
        crossOrigin: false
      }));
      const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();

      const signer = crypto.createSign('SHA256');
      signer.update(Buffer.concat([authData, clientDataHash]));
      const sig = signer.sign(privateKey);

      return {
        id: credId.toString('base64url'),
        rawId: credId.toString('base64url'),
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: sig.toString('base64url')
        },
        type: 'public-key',
        clientExtensionResults: {}
      };
    }
  };
}

async function testTotpGenerationAndDrift() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mfa-test-'));
  const mfaFile = path.join(tempDir, 'mfa-state.json');
  const mfa = new MfaManager(mfaFile);

  try {
    // 1. Enroll TOTP
    const enroll = mfa.enrollTotp('testuser', 'MCP Test Server');
    assert.ok(enroll.secret);
    assert.ok(enroll.uri.startsWith('otpauth://totp/'));
    assert.equal(enroll.recoveryCodes.length, 8);

    // Finding F: 80-bit recovery codes format
    assert.match(enroll.recoveryCodes[0], /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const secret = enroll.secret;
    const nowSec = Math.floor(Date.now() / 1000);

    // 2. Correct code for current step
    const currentCode = generateTotpCode(secret, nowSec);
    assert.equal(currentCode.length, 6);

    // Confirm enrollment with current code
    const confirmRes = mfa.confirmTotp(currentCode);
    assert.equal(confirmRes.ok, true);

    const status = mfa.getStatus();
    assert.equal(status.enrolled, true);
    assert.equal(status.method, 'totp');
    assert.equal(status.remainingRecoveryCodes, 8);
    assert.equal(status.secret, undefined);

    // 3. Anti-replay: cannot reuse the exact same code in the same window
    const replayRes = mfa.verify(currentCode);
    assert.equal(replayRes.ok, false, 'Replaying identical TOTP code in same window must fail');

    // 4. Time drift tolerance: code for +30s (+1 step)
    const futureCode = generateTotpCode(secret, nowSec + 30);
    const futureRes = mfa.verify(futureCode);
    assert.equal(futureRes.ok, true, 'Code with +1 step drift should be accepted');

    // Code for +3 steps (90 seconds ahead) MUST be rejected
    const farFutureCode = generateTotpCode(secret, nowSec + 90);
    const farFutureRes = mfa.verify(farFutureCode);
    assert.equal(farFutureRes.ok, false, 'Code beyond drift window must be rejected');

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testRateLimiting() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mfa-rate-'));
  const mfaFile = path.join(tempDir, 'mfa-state.json');
  const mfa = new MfaManager(mfaFile);

  try {
    const enroll = mfa.enrollTotp('testuser', 'MCP Test Server');
    mfa.confirmTotp(generateTotpCode(enroll.secret));

    // Send 5 wrong codes
    for (let i = 0; i < 5; i++) {
      const res = mfa.verify('000000');
      assert.equal(res.ok, false);
    }

    // 6th attempt should be blocked by rate limit
    const blockedRes = mfa.verify('000000');
    assert.equal(blockedRes.ok, false);
    assert.ok(/demasiados intentos/i.test(blockedRes.error));

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testRecoveryCodesSingleUse() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mfa-rec-'));
  const mfaFile = path.join(tempDir, 'mfa-state.json');
  const mfa = new MfaManager(mfaFile);

  try {
    const enroll = mfa.enrollTotp('testuser', 'MCP Test Server');
    mfa.confirmTotp(generateTotpCode(enroll.secret));

    const code1 = enroll.recoveryCodes[0];
    const code2 = enroll.recoveryCodes[1];

    // State file check: plaintext recovery codes must NEVER be stored on disk
    const rawState = JSON.parse(fs.readFileSync(mfaFile, 'utf8'));
    assert.ok(!JSON.stringify(rawState).includes(code1), 'Raw recovery code must not exist in state file');

    // Use code 1
    const use1 = mfa.verify(code1);
    assert.equal(use1.ok, true);
    assert.equal(use1.usedRecoveryCode, true);

    // Remaining count should decrease
    assert.equal(mfa.getStatus().remainingRecoveryCodes, 7);

    // Replay code 1 -> must fail
    const replay1 = mfa.verify(code1);
    assert.equal(replay1.ok, false, 'Recovery code must be single-use');

    // Use code 2 -> succeeds
    const use2 = mfa.verify(code2);
    assert.equal(use2.ok, true);
    assert.equal(mfa.getStatus().remainingRecoveryCodes, 6);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testCorruptedStateFailsClosed() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mfa-corrupt-'));
  const mfaFile = path.join(tempDir, 'mfa-state.json');

  try {
    // 1. Initial non-existent file returns clean disabled state
    const mfa = new MfaManager(mfaFile);
    assert.equal(mfa.isMfaEnabled(), false);
    assert.equal(mfa.getStatus().enabled, false);

    // 2. Corrupt JSON in state file
    fs.writeFileSync(mfaFile, '{"enabled": true, "corrupted_incomplete...');
    assert.throws(() => {
      mfa.isMfaEnabled();
    }, (err) => err instanceof MfaCorruptedStateError || /corrupto|dañado/i.test(err.message));

    assert.throws(() => {
      mfa.getStatus();
    }, (err) => err instanceof MfaCorruptedStateError);

    // 3. Invalid schema (e.g. non-boolean enabled)
    fs.writeFileSync(mfaFile, JSON.stringify({ enabled: "not_a_boolean", version: 1 }));
    assert.throws(() => {
      mfa.isMfaEnabled();
    }, (err) => err instanceof MfaCorruptedStateError || /esquema/i.test(err.message));

    // 4. Invalid recovery codes type
    fs.writeFileSync(mfaFile, JSON.stringify({ enabled: true, recoveryCodes: "should_be_array", version: 1 }));
    assert.throws(() => {
      mfa.isMfaEnabled();
    }, (err) => err instanceof MfaCorruptedStateError);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testOAuthHttpFailsClosedOnCorruptMfa() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-mfa-corrupt-'));
  const mfaFile = path.join(tempDir, 'mfa-state.json');
  fs.writeFileSync(mfaFile, '{"enabled": true, corrupted');

  const oauthStore = path.join(tempDir, 'oauth.json');
  configureOAuthAdmin(oauthStore, 'admin', 'Password123!');
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;

  const provider = new OAuthProvider({
    storePath: oauthStore,
    mfaStorePath: mfaFile,
    publicBaseUrl: issuer
  });

  const callbackUri = `${issuer}/callback`;
  provider.store.mutate(state => {
    state.clients['test-client'] = {
      clientId: 'test-client',
      clientName: 'Test Client',
      redirectUris: [callbackUri],
      grantTypes: ['authorization_code'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      applicationType: 'web'
    };
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const handled = await provider.handle(req, res, url, issuer);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));

  try {
    // 1. GET /oauth/authorize with corrupt MFA state -> Must return HTTP 500
    const authUrl = `${issuer}/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(callbackUri)}&resource=${encodeURIComponent(issuer + '/mcp')}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=xyz123`;
    const getRes = await fetch(authUrl, { redirect: 'manual' });
    assert.equal(getRes.status, 500, 'GET /oauth/authorize must fail closed (500) when MFA state is corrupted');
    const getText = await getRes.text();
    assert.ok(getText.includes('No se pudo autorizar') || getText.includes('Error'));

    // 2. POST /oauth/authorize with corrupt MFA state -> Must return HTTP 500 or error
    const postRes = await fetch(`${issuer}/oauth/authorize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'origin': issuer
      },
      body: 'transaction=invalid&decision=allow&username=admin&password=Password123!'
    });
    assert.ok(postRes.status >= 400, 'POST /oauth/authorize must not issue an authorization code');

  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testOAuthWebAuthnHttpEndpoints() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-wa-http-'));
  const mfaFile = path.join(tempDir, 'mfa-state.json');
  const oauthStore = path.join(tempDir, 'oauth.json');
  configureOAuthAdmin(oauthStore, 'admin', 'Password123!');

  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const rpId = '127.0.0.1';
  const origin = issuer;

  const mfa = new MfaManager(mfaFile);
  const va = createVirtualAuthenticator(rpId, origin);

  // Pre-enroll WebAuthn credential in MFA manager
  const regOpts = await mfa.generateRegistrationOptions('admin', rpId);
  const regResp = va.getRegistrationResponse(regOpts.challenge);
  await mfa.verifyRegistrationResponse({
    challengeId: regOpts.challengeId,
    response: regResp,
    expectedOrigin: origin,
    expectedRPID: rpId
  });
  assert.equal(mfa.getStatus().webauthnEnrolled, true);

  const provider = new OAuthProvider({
    storePath: oauthStore,
    mfaStorePath: mfaFile,
    publicBaseUrl: issuer
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const handled = await provider.handle(req, res, url, issuer);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));

  try {
    // 1. Start OAuth authorize GET -> verify passkey UI is rendered
    const callbackUri = 'http://127.0.0.1:45000/callback';
    provider.store.mutate(state => {
      state.clients['test-client'] = {
        clientId: 'test-client',
        clientName: 'Test Client',
        redirectUris: [callbackUri],
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
        tokenEndpointAuthMethod: 'none',
        applicationType: 'web'
      };
    });
    const authUrl = `${issuer}/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(callbackUri)}&resource=${encodeURIComponent(issuer + '/mcp')}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=state-wa-123`;
    const getRes = await fetch(authUrl);
    assert.equal(getRes.status, 200);
    const pageHtml = await getRes.text();
    assert.ok(pageHtml.includes('passkey-btn'), 'Page must include passkey button when WebAuthn is enrolled');
    const txMatch = pageHtml.match(/name="transaction" value="([^"]+)"/);
    assert.ok(txMatch, 'Must contain transaction hidden input');
    const transactionId = txMatch[1];

    // 2. Request WebAuthn auth options
    const optionsRes = await fetch(`${issuer}/oauth/mfa/webauthn/auth/options`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': issuer },
      body: JSON.stringify({
        transaction: transactionId,
        username: 'admin',
        password: 'Password123!'
      })
    });
    assert.equal(optionsRes.status, 200);
    const optionsData = await optionsRes.json();
    assert.equal(optionsData.ok, true);
    assert.ok(optionsData.challengeId);
    assert.ok(optionsData.options.challenge);

    // 3. Authenticate with virtual authenticator
    const authResp = va.getAuthenticationResponse(optionsData.options.challenge);

    // 4. Verify assertion via HTTP endpoint
    const verifyRes = await fetch(`${issuer}/oauth/mfa/webauthn/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': issuer },
      body: JSON.stringify({
        transaction: transactionId,
        challengeId: optionsData.challengeId,
        response: authResp
      })
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.ok, true);
    const redirectUrl = verifyData.redirectUrl || verifyData.redirectUri;
    assert.ok(redirectUrl);
    assert.ok(redirectUrl.includes('code=mcp_ac_'));
    assert.ok(redirectUrl.includes('state=state-wa-123'));

  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testWebAuthnVirtualAuthenticatorRegistrationAndAuth() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-va-e2e-'));
  const mfaFile = path.join(tempDir, 'mfa.json');
  const mfa = new MfaManager(mfaFile);
  const rpId = 'localhost';
  const origin = 'https://localhost:8443';

  const va = createVirtualAuthenticator(rpId, origin);

  try {
    // 1. Negative: Registration without User Verification (UV=false) must be rejected
    const regOptsNoUv = await mfa.generateRegistrationOptions('admin', rpId);
    const noUvResp = va.getRegistrationResponse(regOptsNoUv.challenge, { userVerification: false });
    await assert.rejects(async () => {
      await mfa.verifyRegistrationResponse({
        challengeId: regOptsNoUv.challengeId,
        response: noUvResp,
        expectedOrigin: origin,
        expectedRPID: rpId
      });
    }, /User verification/i);

    // 2. Negative: Registration with origin mismatch must be rejected
    const regOptsOrigin = await mfa.generateRegistrationOptions('admin', rpId);
    const badOriginResp = va.getRegistrationResponse(regOptsOrigin.challenge, { origin: 'https://evil.com' });
    await assert.rejects(async () => {
      await mfa.verifyRegistrationResponse({
        challengeId: regOptsOrigin.challengeId,
        response: badOriginResp,
        expectedOrigin: origin,
        expectedRPID: rpId
      });
    }, /origin/i);

    // 3. Negative: Registration with RPID mismatch must be rejected
    const regOptsRp = await mfa.generateRegistrationOptions('admin', rpId);
    const badRpResp = va.getRegistrationResponse(regOptsRp.challenge, { rpId: 'attacker.com' });
    await assert.rejects(async () => {
      await mfa.verifyRegistrationResponse({
        challengeId: regOptsRp.challengeId,
        response: badRpResp,
        expectedOrigin: origin,
        expectedRPID: rpId
      });
    }, /RP ID|rpid/i);

    // 4. Positive: Registration with correct options and UV succeeds
    const regOptsGood = await mfa.generateRegistrationOptions('admin', rpId);
    const goodRegResp = va.getRegistrationResponse(regOptsGood.challenge);
    const regRes = await mfa.verifyRegistrationResponse({
      challengeId: regOptsGood.challengeId,
      response: goodRegResp,
      expectedOrigin: origin,
      expectedRPID: rpId
    });
    assert.equal(regRes.verified, true);
    assert.equal(regRes.recoveryCodes.length, 8);

    const statusAfterReg = mfa.getStatus();
    assert.equal(statusAfterReg.enrolled, true);
    assert.equal(statusAfterReg.webauthnEnrolled, true);
    assert.equal(statusAfterReg.credentialCount, 1);

    // 5. Negative: Replaying registration challenge must fail
    await assert.rejects(async () => {
      await mfa.verifyRegistrationResponse({
        challengeId: regOptsGood.challengeId,
        response: goodRegResp,
        expectedOrigin: origin,
        expectedRPID: rpId
      });
    }, /inválido o expirado/i);

    // 6. Positive: Authentication with Virtual Authenticator
    const authOpts = await mfa.generateAuthenticationOptions({ rpId });
    assert.ok(authOpts.challengeId);
    assert.ok(authOpts.options.challenge);

    const goodAuthResp = va.getAuthenticationResponse(authOpts.options.challenge);
    const authRes = await mfa.verifyAuthenticationResponse({
      challengeId: authOpts.challengeId,
      response: goodAuthResp,
      expectedOrigin: origin,
      expectedRPID: rpId
    });
    assert.equal(authRes.verified, true);

    // 7. Negative: Authentication with UV=false rejected
    const authOptsNoUv = await mfa.generateAuthenticationOptions({ rpId });
    const authNoUvResp = va.getAuthenticationResponse(authOptsNoUv.options.challenge, { userVerification: false });
    await assert.rejects(async () => {
      await mfa.verifyAuthenticationResponse({
        challengeId: authOptsNoUv.challengeId,
        response: authNoUvResp,
        expectedOrigin: origin,
        expectedRPID: rpId
      });
    }, /User verification/i);

    // 8. Negative: Challenge replay for authentication
    await assert.rejects(async () => {
      await mfa.verifyAuthenticationResponse({
        challengeId: authOpts.challengeId,
        response: goodAuthResp,
        expectedOrigin: origin,
        expectedRPID: rpId
      });
    }, /inválido o expirado/i);

    // 9. Reset MFA
    mfa.reset();
    assert.equal(mfa.getStatus().enrolled, false);
    assert.equal(mfa.getStatus().webauthnEnrolled, false);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run() {
  await testTotpGenerationAndDrift();
  await testRateLimiting();
  await testRecoveryCodesSingleUse();
  await testCorruptedStateFailsClosed();
  await testOAuthHttpFailsClosedOnCorruptMfa();
  await testOAuthWebAuthnHttpEndpoints();
  await testWebAuthnVirtualAuthenticatorRegistrationAndAuth();
  process.stdout.write('mfa_security=OK\n');
}

run().catch((err) => {
  console.error('MFA test failed:', err);
  process.exit(1);
});

