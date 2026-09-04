'use strict';

// Internal helpers for keeping runtime and OAuth state private.

const fs = require('fs');

function validId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 0x7fffffff ? number : null;
}

function configuredOwner() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const uid = validId(process.env.MCP_REPO_OWNER_UID);
  const gid = validId(process.env.MCP_REPO_OWNER_GID);
  if (uid === null || gid === null || (uid === 0 && gid === 0)) return null;
  return { uid, gid };
}

function applyPrivateOwnership(filePath, mode) {
  try {
    if (mode !== undefined && mode !== null) fs.chmodSync(filePath, mode);
  } catch (_) {}
  const owner = configuredOwner();
  if (!owner) return;
  try { fs.chownSync(filePath, owner.uid, owner.gid); } catch (_) {}
}

function ensurePrivateDirectory(directory, mode = 0o700) {
  fs.mkdirSync(directory, { recursive: true, mode });
  applyPrivateOwnership(directory, mode);
}

module.exports = {
  applyPrivateOwnership,
  configuredOwner,
  ensurePrivateDirectory,
  validId
};
