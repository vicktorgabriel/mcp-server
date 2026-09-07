'use strict';

const crypto = require('crypto');
if (!globalThis.SubtleCrypto && crypto.webcrypto?.subtle?.constructor) {
  globalThis.SubtleCrypto = crypto.webcrypto.subtle.constructor;
}
const fs = require('fs');
const path = require('path');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { ensurePrivateDirectory, applyPrivateOwnership } = require('./private-owner');

const MFA_FILE = path.resolve(process.env.MCP_MFA_STORE || '.private/mfa-state.json');
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

class MfaCorruptedStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MfaCorruptedStateError';
    this.isCorrupted = true;
  }
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  let index = 0;
  const clean = String(str || '').replace(/[=\s]/g, '').toUpperCase();
  const output = Buffer.alloc(Math.floor(clean.length * 5 / 8) + 1);
  for (let i = 0; i < clean.length; i++) {
    const val = BASE32_ALPHABET.indexOf(clean[i]);
    if (val === -1) throw new Error(`Carácter Base32 inválido: ${clean[i]}`);
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return output.subarray(0, index);
}

function computeTotp(secretBase32, step) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] & 0xff) << 16 | (hmac[offset + 2] & 0xff) << 8 | (hmac[offset + 3] & 0xff)) % 1000000;
  return String(binary).padStart(6, '0');
}

function generateRecoveryCodes(count = 8) {
  const plain = [];
  const hashed = [];
  for (let i = 0; i < count; i++) {
    // 10 bytes = 80 bits of cryptographic entropy
    const raw = crypto.randomBytes(10).toString('hex').toUpperCase();
    const code = raw.match(/.{1,4}/g).join('-');
    plain.push(code);
    hashed.push(crypto.createHash('sha256').update(code, 'utf8').digest('hex'));
  }
  return { plain, hashed };
}

class MfaManager {
  constructor(filePathOrOptions = MFA_FILE) {
    let filePath = MFA_FILE;
    let oauthStore = null;
    if (typeof filePathOrOptions === 'object' && filePathOrOptions !== null) {
      filePath = filePathOrOptions.filePath || filePathOrOptions.storePath || MFA_FILE;
      oauthStore = filePathOrOptions.oauthStore || null;
    } else if (typeof filePathOrOptions === 'string') {
      filePath = filePathOrOptions;
    }
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.markerPath = path.join(path.dirname(this.filePath), '.mfa-configured');
    this.oauthStatePath = path.join(path.dirname(this.filePath), 'oauth-state.json');
    this.oauthStore = oauthStore;
    this._hasBeenEnabled = false;
    this._missingCorrupted = false;
    this.attemptLimits = new Map(); // ip/user -> { failures: count, resetAt }
    this._ensureStore();
  }

  _isMfaExpected() {
    if (this._hasBeenEnabled) return true;
    if (this.oauthStore && typeof this.oauthStore.state === 'object') {
      if (this.oauthStore.state.mfaExpected === true) return true;
    }
    if (fs.existsSync(this.markerPath)) return true;
    if (fs.existsSync(this.oauthStatePath)) {
      try {
        const raw = fs.readFileSync(this.oauthStatePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.mfaExpected === true) return true;
      } catch (_) {}
    }
    return false;
  }

  _setMfaExpected(expected) {
    this._hasBeenEnabled = Boolean(expected);
    if (expected) {
      ensurePrivateDirectory(path.dirname(this.markerPath), 0o700);
      try {
        fs.writeFileSync(this.markerPath, `configured=${Date.now()}\n`, { mode: 0o600 });
        applyPrivateOwnership(this.markerPath, 0o600);
      } catch (_) {}
      if (this.oauthStore && typeof this.oauthStore.mutate === 'function') {
        try {
          this.oauthStore.mutate(() => {
            this.oauthStore.state.mfaExpected = true;
          });
        } catch (_) {}
      } else if (fs.existsSync(this.oauthStatePath)) {
        try {
          const raw = fs.readFileSync(this.oauthStatePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            parsed.mfaExpected = true;
            const tmp = `${this.oauthStatePath}.${process.pid}.${Date.now()}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
            fs.renameSync(tmp, this.oauthStatePath);
            applyPrivateOwnership(this.oauthStatePath, 0o600);
          }
        } catch (_) {}
      }
    } else {
      if (fs.existsSync(this.markerPath)) {
        try { fs.unlinkSync(this.markerPath); } catch (_) {}
      }
      if (this.oauthStore && typeof this.oauthStore.mutate === 'function') {
        try {
          this.oauthStore.mutate(() => {
            this.oauthStore.state.mfaExpected = false;
          });
        } catch (_) {}
      } else if (fs.existsSync(this.oauthStatePath)) {
        try {
          const raw = fs.readFileSync(this.oauthStatePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            parsed.mfaExpected = false;
            const tmp = `${this.oauthStatePath}.${process.pid}.${Date.now()}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
            fs.renameSync(tmp, this.oauthStatePath);
            applyPrivateOwnership(this.oauthStatePath, 0o600);
          }
        } catch (_) {}
      }
    }
  }

  _ensureStore() {
    ensurePrivateDirectory(path.dirname(this.filePath), 0o700);
    if (!fs.existsSync(this.filePath)) {
      if (this._isMfaExpected()) {
        // MFA was expected, but file is missing: fail closed without silently recreating disabled state
        this._missingCorrupted = true;
        return;
      }
      this._writeState({
        enabled: false,
        webauthn: { credentials: [] },
        totp: null,
        recoveryCodes: [],
        activeChallenges: {}
      });
    } else {
      try {
        const state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (state && state.enabled === true) {
          this._hasBeenEnabled = true;
          this._setMfaExpected(true);
        }
      } catch (_) {}
    }
  }

  _readState() {
    if (!fs.existsSync(this.filePath)) {
      if (this._hasBeenEnabled || this._isMfaExpected() || this._missingCorrupted) {
        throw new MfaCorruptedStateError(
          `Archivo de estado MFA ausente o eliminado tras haber sido configurado previamente (${this.filePath}). Fallo cerrado por seguridad.`
        );
      }
      return {
        enabled: false,
        webauthn: { credentials: [] },
        totp: null,
        recoveryCodes: [],
        activeChallenges: {},
        isFreshInstall: true
      };
    }
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      throw new MfaCorruptedStateError(`Error al leer archivo de estado MFA (${this.filePath}): ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new MfaCorruptedStateError(`Estado de MFA corrupto en ${this.filePath}: JSON inválido (${err.message})`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new MfaCorruptedStateError(`Estado de MFA corrupto en ${this.filePath}: no es un objeto JSON.`);
    }
    if (typeof parsed.enabled !== 'boolean') {
      throw new MfaCorruptedStateError(`Estado de MFA corrupto en ${this.filePath}: campo "enabled" inválido o ausente.`);
    }
    if (parsed.webauthn && (!Array.isArray(parsed.webauthn.credentials))) {
      throw new MfaCorruptedStateError(`Estado de MFA corrupto en ${this.filePath}: credenciales WebAuthn inválidas.`);
    }
    if (parsed.recoveryCodes && !Array.isArray(parsed.recoveryCodes)) {
      throw new MfaCorruptedStateError(`Estado de MFA corrupto en ${this.filePath}: estructura de recoveryCodes inválida.`);
    }
    if (parsed.totp && (typeof parsed.totp !== 'object' || typeof parsed.totp.secret !== 'string')) {
      throw new MfaCorruptedStateError(`Estado de MFA corrupto en ${this.filePath}: estructura TOTP inválida.`);
    }
    if (parsed.enabled === true) {
      this._hasBeenEnabled = true;
      this._setMfaExpected(true);
    }
    return parsed;
  }

  _writeState(state) {
    if (state && state.enabled === true) {
      this._hasBeenEnabled = true;
      this._setMfaExpected(true);
    }
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    applyPrivateOwnership(this.filePath, 0o600);
  }

  _mutate(fn) {
    const start = Date.now();
    while (true) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          const state = this._readState();
          const result = fn(state);
          this._writeState(state);
          return result;
        } finally {
          fs.closeSync(fd);
          try { fs.unlinkSync(this.lockPath); } catch (_) {}
        }
      } catch (err) {
        if (err.code === 'EEXIST') {
          if (Date.now() - start > 5000) {
            try {
              const stat = fs.statSync(this.lockPath);
              if (Date.now() - stat.mtimeMs > 10000) fs.unlinkSync(this.lockPath);
            } catch (_) {}
          }
          const waitEnd = Date.now() + 10;
          while (Date.now() < waitEnd) {}
          continue;
        }
        throw err;
      }
    }
  }

  _checkRateLimit(key = 'global') {
    const now = Date.now();
    const entry = this.attemptLimits.get(key);
    if (entry && entry.resetAt > now) {
      if (entry.failures >= 5) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        throw new Error(`Demasiados intentos de MFA fallidos. Intente nuevamente en ${retryAfter} segundos.`);
      }
    } else if (entry && entry.resetAt <= now) {
      this.attemptLimits.delete(key);
    }
  }

  _recordFailure(key = 'global') {
    const now = Date.now();
    const entry = this.attemptLimits.get(key) || { failures: 0, resetAt: now + 60000 };
    entry.failures++;
    if (entry.resetAt <= now) entry.resetAt = now + 60000;
    this.attemptLimits.set(key, entry);
  }

  _clearFailure(key = 'global') {
    this.attemptLimits.delete(key);
  }

  isMfaEnabled() {
    const state = this._readState();
    return Boolean(state.enabled);
  }

  getStatus() {
    const state = this._readState();
    return {
      enabled: Boolean(state.enabled),
      enrolled: Boolean(state.enabled),
      method: (state.totp && state.totp.secret) ? 'totp' : (state.webauthn?.credentials?.length ? 'webauthn' : 'none'),
      webauthnEnrolled: Boolean(state.webauthn && state.webauthn.credentials && state.webauthn.credentials.length > 0),
      credentialCount: (state.webauthn && state.webauthn.credentials) ? state.webauthn.credentials.length : 0,
      totpEnrolled: Boolean(state.totp && state.totp.secret),
      recoveryCodesRemaining: Array.isArray(state.recoveryCodes) ? state.recoveryCodes.length : 0,
      remainingRecoveryCodes: Array.isArray(state.recoveryCodes) ? state.recoveryCodes.length : 0
    };
  }

  // --- WebAuthn ---

  async generateRegistrationOptions(optionsOrUser = {}, maybeRpId = 'localhost') {
    let userName = 'admin';
    let rpId = 'localhost';
    let rpName = 'MCP Local';
    let userId = 'admin';

    if (typeof optionsOrUser === 'string') {
      userName = optionsOrUser;
      userId = optionsOrUser;
      rpId = maybeRpId;
    } else if (typeof optionsOrUser === 'object' && optionsOrUser !== null) {
      userName = optionsOrUser.userName || optionsOrUser.user || 'admin';
      userId = optionsOrUser.userId || userName;
      rpId = optionsOrUser.rpId || optionsOrUser.rpID || 'localhost';
      rpName = optionsOrUser.rpName || 'MCP Local';
    }

    const state = this._readState();
    const existingCredentials = (state.webauthn && state.webauthn.credentials)
      ? state.webauthn.credentials.map(c => ({
          id: c.id,
          transports: c.transports
        }))
      : [];

    const options = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userID: new TextEncoder().encode(userId),
      userName,
      attestationType: 'none',
      excludeCredentials: existingCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required'
      }
    });

    const elevationVerified = Boolean(optionsOrUser && optionsOrUser.elevationVerified);
    const mfaEnabledAtIssue = Boolean(state.enabled);
    const securityVersion = state.version || 1;

    const challengeId = crypto.randomUUID();
    this._mutate(s => {
      s.activeChallenges = s.activeChallenges || {};
      s.activeChallenges[challengeId] = {
        challenge: options.challenge,
        type: 'registration',
        userName,
        rpId,
        elevationVerified,
        mfaEnabledAtIssue,
        securityVersion,
        expiresAt: Date.now() + 5 * 60 * 1000
      };
    });

    return { ...options, options, challengeId, challenge: options.challenge };
  }

  async verifyRegistrationResponse(params) {
    const { challengeId, response, expectedOrigin, expectedRPID, userName } = params || {};
    this._checkRateLimit('webauthn');
    let storedChallenge;

    this._mutate(s => {
      storedChallenge = (s.activeChallenges || {})[challengeId];
      if (storedChallenge) {
        delete s.activeChallenges[challengeId];
      }
    });

    if (!storedChallenge || storedChallenge.type !== 'registration' || storedChallenge.expiresAt < Date.now()) {
      this._recordFailure('webauthn');
      throw new Error('Desafío WebAuthn inválido o expirado.');
    }

    if (storedChallenge.userName && userName && storedChallenge.userName !== userName) {
      this._recordFailure('webauthn');
      throw new Error('El usuario de la verificación no coincide con el desafío registrado.');
    }

    if (storedChallenge.rpId && expectedRPID && storedChallenge.rpId !== expectedRPID) {
      this._recordFailure('webauthn');
      throw new Error('El RP ID de la verificación no coincide con el desafío registrado.');
    }

    const currentState = this._readState();
    if (!storedChallenge.mfaEnabledAtIssue && currentState.enabled) {
      this._recordFailure('webauthn');
      throw new Error('El desafío de registro fue emitido antes de que MFA estuviera activo; se requiere un nuevo desafío con elevación.');
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: storedChallenge.challenge,
        expectedOrigin,
        expectedRPID,
        requireUserVerification: true
      });
    } catch (err) {
      this._recordFailure('webauthn');
      throw new Error(`Verificación WebAuthn fallida: ${err.message}`);
    }

    if (!verification.verified || !verification.registrationInfo) {
      this._recordFailure('webauthn');
      throw new Error('No se pudo verificar la credencial WebAuthn.');
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const recovery = generateRecoveryCodes();

    this._mutate(s => {
      s.webauthn = s.webauthn || { credentials: [] };
      s.webauthn.credentials.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        createdAt: Date.now()
      });
      s.recoveryCodes = recovery.hashed;
      s.enabled = true;
    });

    this._clearFailure('webauthn');
    return {
      verified: true,
      recoveryCodes: recovery.plain // Returned ONCE to user upon enrollment
    };
  }

  async generateAuthenticationOptions({ rpId = 'localhost' }) {
    const state = this._readState();
    const credentials = (state.webauthn && state.webauthn.credentials) ? state.webauthn.credentials : [];
    if (credentials.length === 0) {
      throw new Error('No hay credenciales WebAuthn registradas.');
    }

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: credentials.map(c => ({
        id: c.id,
        transports: c.transports
      })),
      userVerification: 'required'
    });

    const challengeId = crypto.randomUUID();
    this._mutate(s => {
      s.activeChallenges = s.activeChallenges || {};
      s.activeChallenges[challengeId] = {
        challenge: options.challenge,
        type: 'authentication',
        expiresAt: Date.now() + 5 * 60 * 1000
      };
    });

    return { options, challengeId };
  }

  async verifyAuthenticationResponse({ challengeId, response, expectedOrigin, expectedRPID }) {
    this._checkRateLimit('webauthn');
    let storedChallenge;
    this._mutate(s => {
      storedChallenge = (s.activeChallenges || {})[challengeId];
      if (storedChallenge) delete s.activeChallenges[challengeId];
    });

    if (!storedChallenge || storedChallenge.type !== 'authentication' || storedChallenge.expiresAt < Date.now()) {
      this._recordFailure('webauthn');
      throw new Error('Desafío de autenticación WebAuthn inválido o expirado.');
    }

    const state = this._readState();
    const credentialRecord = (state.webauthn && state.webauthn.credentials)
      ? state.webauthn.credentials.find(c => c.id === response.id)
      : null;

    if (!credentialRecord) {
      this._recordFailure('webauthn');
      throw new Error('Credencial WebAuthn no reconocida.');
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: storedChallenge.challenge,
        expectedOrigin,
        expectedRPID,
        credential: {
          id: credentialRecord.id,
          publicKey: Buffer.from(credentialRecord.publicKey, 'base64url'),
          counter: credentialRecord.counter,
          transports: credentialRecord.transports
        },
        requireUserVerification: true
      });
    } catch (err) {
      this._recordFailure('webauthn');
      throw new Error(`Autenticación WebAuthn fallida: ${err.message}`);
    }

    if (!verification.verified) {
      this._recordFailure('webauthn');
      throw new Error('Verificación WebAuthn no superada.');
    }

    // Update counter for anti-replay
    this._mutate(s => {
      const cred = s.webauthn.credentials.find(c => c.id === response.id);
      if (cred) {
        cred.counter = verification.authenticationInfo.newCounter;
      }
    });

    this._clearFailure('webauthn');
    return { verified: true };
  }

  // --- TOTP ---

  generateTotpSecret(issuer = 'MCP Server', user = 'admin') {
    const rawSecret = crypto.randomBytes(20);
    const secretBase32 = base32Encode(rawSecret);
    const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    return { secret: secretBase32, uri };
  }

  verifyAndEnableTotp(secretBase32, submittedCode, customRecovery = null) {
    this._checkRateLimit('totp_enroll');
    const cleanCode = String(submittedCode || '').trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      this._recordFailure('totp_enroll');
      throw new Error('El código TOTP debe ser de 6 dígitos.');
    }

    const currentStep = Math.floor(Date.now() / 30000);
    let valid = false;
    let matchingStep = currentStep;

    // Check drift -1, 0, +1
    for (const step of [currentStep, currentStep - 1, currentStep + 1]) {
      if (computeTotp(secretBase32, step) === cleanCode) {
        valid = true;
        matchingStep = step;
        break;
      }
    }

    if (!valid) {
      this._recordFailure('totp_enroll');
      throw new Error('Código TOTP de verificación incorrecto.');
    }

    const recovery = customRecovery || this._pendingRecovery || generateRecoveryCodes();
    this._pendingRecovery = null;

    this._mutate(s => {
      s.totp = {
        secret: secretBase32,
        enrolledAt: Date.now(),
        lastVerifiedStep: matchingStep
      };
      s.recoveryCodes = recovery.hashed;
      s.enabled = true;
    });

    this._clearFailure('totp_enroll');
    return {
      verified: true,
      recoveryCodes: recovery.plain
    };
  }

  verifyTotp(submittedCode) {
    this._checkRateLimit('totp');
    const cleanCode = String(submittedCode || '').trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      this._recordFailure('totp');
      throw new Error('El código TOTP debe ser de 6 dígitos.');
    }

    const currentStep = Math.floor(Date.now() / 30000);

    return this._mutate(s => {
      if (!s.totp || !s.totp.secret) {
        throw new Error('TOTP no está configurado.');
      }

      const lastStep = s.totp.lastVerifiedStep || 0;
      let valid = false;
      let matchedStep = currentStep;

      for (const step of [currentStep, currentStep - 1, currentStep + 1]) {
        if (step <= lastStep) {
          // Replay prevention: do not allow using the exact same step again
          continue;
        }
        if (computeTotp(s.totp.secret, step) === cleanCode) {
          valid = true;
          matchedStep = step;
          break;
        }
      }

      if (!valid) {
        this._recordFailure('totp');
        throw new Error('Código TOTP incorrecto o ya utilizado.');
      }

      s.totp.lastVerifiedStep = matchedStep;
      this._clearFailure('totp');
      return { verified: true };
    });
  }

  // --- Recovery Codes ---

  verifyRecoveryCode(code) {
    this._checkRateLimit('recovery');
    const raw = String(code || '').trim().toUpperCase();
    const clean = raw.replace(/\s+/g, '');
    const normalized = clean.includes('-') ? clean : (clean.match(/.{1,4}/g)?.join('-') || clean);
    const hashed = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');

    let matched = false;
    let remaining = 0;

    this._mutate(s => {
      const idx = (s.recoveryCodes || []).indexOf(hashed);
      if (idx !== -1) {
        s.recoveryCodes.splice(idx, 1);
        matched = true;
        remaining = s.recoveryCodes.length;
      }
    });

    if (!matched) {
      this._recordFailure('recovery');
      throw new Error('Código de recuperación inválido o ya utilizado.');
    }

    this._clearFailure('recovery');
    return { verified: true, remaining };
  }

  verify(input) {
    const clean = String(input || '').trim();
    if (/^\d{6}$/.test(clean)) {
      try {
        const res = this.verifyTotp(clean);
        return { ok: true, method: 'totp', ...res };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    try {
      const res = this.verifyRecoveryCode(clean);
      return { ok: true, method: 'recovery', usedRecoveryCode: true, ...res };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  enrollTotp(user = 'admin', issuer = 'MCP Server') {
    const { secret, uri } = this.generateTotpSecret(issuer, user);
    this._pendingEnrollmentSecret = secret;
    const recovery = generateRecoveryCodes();
    this._pendingRecovery = recovery;
    return { secret, uri, recoveryCodes: recovery.plain };
  }

  confirmTotp(code) {
    if (!this._pendingEnrollmentSecret) {
      throw new Error('No hay enrolamiento TOTP pendiente.');
    }
    const res = this.verifyAndEnableTotp(this._pendingEnrollmentSecret, code);
    this._pendingEnrollmentSecret = null;
    return { ok: true, recoveryCodes: res.recoveryCodes };
  }

  reset() {
    return this.resetMfa();
  }

  resetMfa() {
    this._mutate(s => {
      s.enabled = false;
      s.webauthn = { credentials: [] };
      s.totp = null;
      s.recoveryCodes = [];
      s.activeChallenges = {};
    });
    this._hasBeenEnabled = false;
    this._missingCorrupted = false;
    this._setMfaExpected(false);
    this.attemptLimits.clear();
    return { ok: true, message: 'MFA reseteado exitosamente.' };
  }
}

function generateTotpCode(secret, timeSec = Math.floor(Date.now() / 1000)) {
  return computeTotp(secret, Math.floor(timeSec / 30));
}

module.exports = {
  MfaManager,
  MfaCorruptedStateError,
  base32Encode,
  base32Decode,
  computeTotp,
  generateTotpCode,
  generateRecoveryCodes
};
