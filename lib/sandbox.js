'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { spawnSync } = require('child_process');

const SENSITIVE_PATTERNS = [
  /(?:^|\/)\.env(?:\..*)?$/i,
  /(?:^|\/)\.private(?:\/|$)/i,
  /(?:^|\/)\.runtime(?:\/|$)/i,
  /(?:^|\/)\.git(?:\/|$)/i,
  /(?:^|\/)\.ssh(?:\/|$)/i,
  /(?:^|\/)\.aws(?:\/|$)/i,
  /(?:^|\/)\.gnupg(?:\/|$)/i,
  /(?:^|\/)id_rsa(?:\.pub)?$/i,
  /(?:^|\/)id_ed25519(?:\.pub)?$/i,
  /(?:^|\/)id_ecdsa(?:\.pub)?$/i,
  /(?:^|\/)id_dsa(?:\.pub)?$/i,
  /(?:^|\/).*\.(?:key|pem|p12|pfx|pkcs12)$/i,
  /(?:^|\/)(?:approvals\.json|client-policies\.json|oauth-state\.json|mfa-state\.json|mcp\.sock|mcp\.token|\.mfa-configured|\.client-policies-configured|\.emergency-pause)(?:\.lock|\..*)?$/i,
  /\/etc\/shadow$/i,
  /\/etc\/sudoers(?:\.d)?/i,
  /\/var\/run\/docker\.sock$/i
];

function isSubpathOrEqual(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false;
  const normTarget = path.resolve(targetPath);
  const normRoot = path.resolve(rootPath);
  if (normTarget === normRoot) return true;
  const rel = path.relative(normRoot, normTarget);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true;
  // 0.0.0.0/8
  if (parts[0] === 0) return true;
  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 127.0.0.0/8
  if (parts[0] === 127) return true;
  // 169.254.0.0/16 (Link local / Cloud metadata 169.254.169.254)
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 224.0.0.0/4 (Multicast)
  if (parts[0] >= 224 && parts[0] <= 239) return true;
  // 240.0.0.0/4 (Reserved)
  if (parts[0] >= 240) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::') return true;
  // IPv4 mapped (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1 or ::ffff:a9fe:a9fe)
  if (normalized.startsWith('::ffff:')) {
    const tail = normalized.substring(7);
    if (net.isIPv4(tail)) return isPrivateIpv4(tail);
    const hexParts = tail.split(':');
    if (hexParts.length === 2) {
      const high = parseInt(hexParts[0], 16);
      const low = parseInt(hexParts[1], 16);
      if (!Number.isNaN(high) && !Number.isNaN(low)) {
        const b0 = (high >> 8) & 0xff;
        const b1 = high & 0xff;
        const b2 = (low >> 8) & 0xff;
        const b3 = low & 0xff;
        return isPrivateIpv4(`${b0}.${b1}.${b2}.${b3}`);
      }
    }
  }
  // fc00::/7 (Unique local)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // fe80::/10 (Link local)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  return false;
}

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return true;
}

function isLoopbackAddress(addr) {
  if (!addr) return false;
  const clean = String(addr).toLowerCase().replace(/^\[|\]$/g, '');
  if (clean === 'localhost' || clean === '127.0.0.1' || clean.startsWith('127.') || clean === '::1' || clean === '0.0.0.0' || clean === '::') {
    return true;
  }
  if (clean.startsWith('::ffff:')) {
    const tail = clean.substring(7);
    if (tail.startsWith('127.') || tail.startsWith('7f00:')) return true;
  }
  return false;
}

async function validateEgressUrl(urlString, options = {}) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (err) {
    throw new Error(`URL inválida: ${err.message}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Protocolo no permitido: ${parsed.protocol}. Solo se permite http y https.`);
  }

  const rawHostname = parsed.hostname;
  const hostname = String(rawHostname || '').replace(/^\[|\]$/g, '');
  const allowLoopback = Boolean(options.allowLoopback || (options.env || process.env).MCP_ALLOW_LOCAL_EGRESS === '1');

  if (!allowLoopback && isLoopbackAddress(hostname)) {
    throw new Error(`Acceso denegado por SSRF: destino loopback no permitido (${rawHostname})`);
  }

  if (Array.isArray(options.allowedDomains) && options.allowedDomains.length > 0) {
    if (!options.allowedDomains.includes(hostname) && !options.allowedDomains.includes(rawHostname)) {
      throw new Error(`El dominio ${rawHostname} no está en la lista de dominios permitidos.`);
    }
  }

  if (net.isIP(hostname)) {
    const isLoopback = isLoopbackAddress(hostname);
    if (!allowLoopback && isLoopback) {
      throw new Error(`Acceso denegado por SSRF: destino loopback no permitido (${rawHostname})`);
    }
    if (isBlockedIp(hostname) && !isLoopback) {
      throw new Error(`Acceso denegado por SSRF: dirección IP privada/restringida no permitida (${hostname})`);
    }
    return { url: parsed.href, resolvedIp: hostname, hostname };
  }

  if (options.resolveDns === false) {
    return { url: parsed.href, hostname };
  }

  // Resolve DNS to verify IP
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      throw new Error(`No se pudo resolver el host ${hostname}`);
    }
    for (const addr of addresses) {
      const isLoopback = isLoopbackAddress(addr.address);
      if (!allowLoopback && isLoopback) {
        throw new Error(`Acceso denegado por SSRF: ${hostname} resuelve a dirección loopback (${addr.address})`);
      }
      if (isBlockedIp(addr.address) && !isLoopback) {
        throw new Error(`Acceso denegado por SSRF: ${hostname} resuelve a dirección interna/restringida (${addr.address})`);
      }
    }
    return { url: parsed.href, resolvedIp: addresses[0].address, hostname };
  } catch (err) {
    if (err.message && err.message.includes('SSRF')) throw err;
    throw new Error(`Fallo de resolución DNS para ${hostname}: ${err.message}`);
  }
}

function isServerControlPlaneFile(filePath) {
  if (!filePath) return false;
  const norm = String(filePath).replace(/\\/g, '/');
  if (/(?:^|\/)(?:approvals\.json|client-policies\.json|oauth-state\.json|mfa-state\.json|mcp\.sock|mcp\.token|\.mfa-configured|\.client-policies-configured|\.emergency-pause)(?:\.lock|\..*)?$/i.test(norm)) {
    return true;
  }
  try {
    const resolved = path.resolve(filePath);
    const serverRoot = path.resolve(__dirname, '..');
    if (isSubpathOrEqual(resolved, serverRoot)) {
      const rel = path.relative(serverRoot, resolved).replace(/\\/g, '/');
      if (/^(?:mcp-server\.js|mcp-supervisor\.js|mcpctl\.sh|package\.json|package-lock\.json|lib(?:\/|$))/.test(rel)) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

function isSensitiveFile(filePath) {
  if (!filePath) return false;
  const norm = String(filePath).replace(/\\/g, '/');
  if (SENSITIVE_PATTERNS.some(pattern => pattern.test(norm))) {
    return true;
  }
  try {
    const resolved = path.resolve(filePath);
    const serverRoot = path.resolve(__dirname, '..');
    if (isSubpathOrEqual(resolved, serverRoot)) {
      const rel = path.relative(serverRoot, resolved).replace(/\\/g, '/');
      if (/^(?:mcp-server\.js|mcp-supervisor\.js|mcpctl\.sh|package\.json|package-lock\.json|lib(?:\/|$))/.test(rel)) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

function nearestExistingPath(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    try {
      const lst = fs.lstatSync(current);
      if (lst.isSymbolicLink()) {
        return current;
      }
    } catch (_) {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function resolveCanonicalPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const existing = nearestExistingPath(resolved);
  let realExisting;
  try {
    realExisting = fs.realpathSync(existing);
  } catch (err) {
    throw new Error(`Acceso denegado: ruta no resoluble o enlace roto (${existing})`);
  }
  const remainder = path.relative(existing, resolved);
  return path.resolve(realExisting, remainder);
}

function validatePathWithinRoots(targetPath, allowedRoots = [], options = {}) {
  const allowSensitive = Boolean(options.allowSensitive);
  const isMutating = Boolean(options.isMutating || options.isWriteOperation);
  const resolved = path.resolve(targetPath);

  // When mutating, server control plane is strictly immutable even in full access mode
  if (isMutating && isServerControlPlaneFile(resolved)) {
    throw new Error(`Acceso denegado: ${path.basename(resolved)} es un archivo de control del servidor MCP protegido contra modificación.`);
  }

  if (!allowSensitive && isSensitiveFile(resolved)) {
    throw new Error(`Acceso denegado: ${path.basename(resolved)} es un archivo o directorio protegido.`);
  }

  // Canonicalize allowed roots
  const canonicalRoots = (allowedRoots.length > 0 ? allowedRoots : [process.cwd()]).map(root => {
    try {
      return fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    } catch (_) {
      return path.resolve(root);
    }
  });

  const canonicalTarget = resolveCanonicalPath(resolved);

  if (isMutating && isServerControlPlaneFile(canonicalTarget)) {
    throw new Error(`Acceso denegado: ${path.basename(canonicalTarget)} es un archivo de control del servidor MCP protegido contra modificación.`);
  }

  if (!allowSensitive && isSensitiveFile(canonicalTarget)) {
    throw new Error(`Acceso denegado: ${path.basename(canonicalTarget)} es un archivo o directorio protegido.`);
  }

  let withinRoot = false;
  for (const root of canonicalRoots) {
    if (isSubpathOrEqual(canonicalTarget, root)) {
      withinRoot = true;
      break;
    }
  }

  if (!withinRoot && allowedRoots.length > 0) {
    throw new Error(`Acceso denegado: la ruta ${targetPath} (resuelta como ${canonicalTarget}) está fuera de las rutas permitidas (${allowedRoots.join(', ')}).`);
  }

  if (fs.existsSync(resolved)) {
    const realExisting = fs.realpathSync(resolved);
    if (isMutating && isServerControlPlaneFile(realExisting)) {
      throw new Error(`Acceso denegado: el destino real del enlace simbólico es un archivo de control del servidor MCP protegido contra modificación.`);
    }
    if (!allowSensitive && isSensitiveFile(realExisting)) {
      throw new Error(`Acceso denegado: el destino real del enlace simbólico es un archivo protegido.`);
    }
    let realWithin = false;
    for (const root of canonicalRoots) {
      if (isSubpathOrEqual(realExisting, root)) {
        realWithin = true;
        break;
      }
    }
    if (!realWithin && allowedRoots.length > 0) {
      throw new Error(`Acceso denegado: el enlace simbólico ${targetPath} apunta fuera de las rutas permitidas.`);
    }
  }

  return canonicalTarget;
}

function validateZipSlip(entryPath, destDir) {
  const resolvedDest = path.resolve(destDir);
  const resolvedTarget = path.resolve(destDir, entryPath);
  if (!isSubpathOrEqual(resolvedTarget, resolvedDest)) {
    throw new Error(`Seguridad: intento de Zip-Slip detectado en ${entryPath}`);
  }
  return resolvedTarget;
}

let bwrapSupportCached = null;

function testBwrapSupport() {
  if (bwrapSupportCached !== null) return bwrapSupportCached;
  if (process.platform !== 'linux') {
    bwrapSupportCached = false;
    return false;
  }
  try {
    const probe = spawnSync('bwrap', [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/bin', '/bin',
      '--proc', '/proc',
      '--dev', '/dev',
      '--unshare-all',
      '--unshare-net',
      '/usr/bin/true'
    ], { stdio: 'pipe', timeout: 3000 });
    bwrapSupportCached = probe.status === 0;
  } catch (_) {
    bwrapSupportCached = false;
  }
  return bwrapSupportCached;
}

function detectOsIsolationCapabilities(env = process.env) {
  if (env.MCP_TEST_FORCE_NO_ISOLATION === '1') {
    return {
      isLinux: process.platform === 'linux',
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      isRoot: false,
      hasBwrap: false,
      hasDockerSocket: false,
      isDedicatedUser: false,
      inSystemd: false,
      hasOsIsolation: false,
      mechanism: 'none'
    };
  }

  const isLinux = process.platform === 'linux';
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const isRoot = uid === 0;

  // Real probe check for bubblewrap with functional unprivileged namespaces
  const hasBwrap = isLinux && testBwrapSupport();

  // Strict check for systemd sandbox markers
  const inSystemd = Boolean(env.INVOCATION_ID);
  const hasSystemdSandbox = false;

  // Check docker socket
  const hasDockerSocket = fs.existsSync('/var/run/docker.sock');

  // Dedicated unprivileged user: only true if the actual running OS user is non-root and dedicated
  const isDedicatedUser = false;

  const hasOsIsolation = hasBwrap;

  return {
    isLinux,
    uid,
    isRoot,
    hasBwrap,
    hasDockerSocket,
    isDedicatedUser,
    inSystemd,
    hasOsIsolation,
    mechanism: hasBwrap ? 'bubblewrap' : 'none'
  };
}

function assertRestrictedIsolationAllowed(env = process.env) {
  const caps = detectOsIsolationCapabilities(env);
  if (!caps.hasOsIsolation) {
    throw new Error(
      'El perfil de trabajo restringido ("trabajo_restringido") requiere aislamiento real a nivel de SO ' +
      '(bubblewrap con namespaces de usuario y red activos). La plataforma o entorno actual no dispone ' +
      'de soporte para aislamiento real en el kernel. Para no proveer una falsa garantía de seguridad, ' +
      'el sistema falla cerrado sin fallback silencioso.'
    );
  }

  return { ok: true, mechanism: caps.mechanism };
}

let systemdScopeSupportCached = null;

function testSystemdScopeSupport() {
  if (systemdScopeSupportCached !== null) return systemdScopeSupportCached;
  if (process.platform !== 'linux') {
    systemdScopeSupportCached = false;
    return false;
  }
  try {
    const probe = spawnSync('systemd-run', ['--user', '--scope', '-q', '--', 'true'], {
      stdio: 'pipe',
      timeout: 4000
    });
    systemdScopeSupportCached = (probe.status === 0);
  } catch (_) {
    systemdScopeSupportCached = false;
  }
  return systemdScopeSupportCached;
}

let prlimitSupportCached = null;

function testPrlimitSupport() {
  if (prlimitSupportCached !== null) return prlimitSupportCached;
  if (process.platform !== 'linux') {
    prlimitSupportCached = false;
    return false;
  }
  try {
    const probe = spawnSync('prlimit', ['--pid', String(process.pid), '--nofile'], {
      stdio: 'pipe',
      timeout: 3000
    });
    prlimitSupportCached = (probe.status === 0);
  } catch (_) {
    prlimitSupportCached = false;
  }
  return prlimitSupportCached;
}

function getResourceLimitsConfig(env = process.env) {
  const cpuLimit = String(env.MCP_CPU_LIMIT ?? '').trim();
  const memoryLimit = String(env.MCP_MEMORY_LIMIT ?? '').trim();
  const processLimit = String(env.MCP_PROCESS_LIMIT ?? '').trim();
  const requestedBackend = String(env.MCP_RESOURCE_LIMITS_BACKEND || 'auto').trim().toLowerCase();
  const required = ['1', 'true', 'yes', 'on'].includes(String(env.MCP_REQUIRE_RESOURCE_LIMITS || '0').trim().toLowerCase());

  const invalid = (name) => { throw new Error(`Invalid resource limit: ${name}`); };
  if (!['auto', 'systemd', 'prlimit', 'none'].includes(requestedBackend)) invalid('MCP_RESOURCE_LIMITS_BACKEND');
  const positiveInteger = value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const cpuIsQuota = cpuLimit.endsWith('%');
  if (cpuLimit) {
    if (cpuIsQuota) {
      const value = Number(cpuLimit.slice(0, -1));
      if (!/^\d+(?:\.\d+)?%$/.test(cpuLimit) || !Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) invalid('MCP_CPU_LIMIT');
    } else if (!positiveInteger(cpuLimit)) invalid('MCP_CPU_LIMIT');
  }
  if (processLimit && !positiveInteger(processLimit)) invalid('MCP_PROCESS_LIMIT');
  let memoryBytes = null;
  if (memoryLimit) {
    const match = memoryLimit.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:B)?$/i);
    if (!match) invalid('MCP_MEMORY_LIMIT');
    const exponent = { '': 0, K: 1, M: 2, G: 3, T: 4 }[match[2].toUpperCase()];
    memoryBytes = Number(match[1]) * (1024 ** exponent);
    if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) invalid('MCP_MEMORY_LIMIT');
  }
  // A quota and a per-process CPU-time budget are not interchangeable.
  if (cpuLimit && ((requestedBackend === 'prlimit' && cpuIsQuota) || (requestedBackend === 'systemd' && !cpuIsQuota))) {
    throw new Error(`CPU limit incompatible with backend ${requestedBackend}`);
  }

  const hasSystemd = testSystemdScopeSupport();
  const hasPrlimit = testPrlimitSupport();

  let backend = 'none';
  if (requestedBackend === 'systemd') {
    backend = hasSystemd ? 'systemd' : 'none';
  } else if (requestedBackend === 'prlimit') {
    backend = hasPrlimit ? 'prlimit' : 'none';
  } else if (requestedBackend === 'none') {
    backend = 'none';
  } else {
    // auto
    if (hasSystemd && (!cpuLimit || cpuIsQuota)) backend = 'systemd';
    else if (hasPrlimit && (!cpuLimit || !cpuIsQuota)) backend = 'prlimit';
    else backend = 'none';
  }

  const limitsConfigured = Boolean(cpuLimit || memoryLimit || processLimit);
  const active = limitsConfigured && backend !== 'none';

  return {
    active,
    backend,
    hasSystemd,
    hasPrlimit,
    limitsConfigured,
    required,
    cpuLimit,
    memoryLimit,
    memoryBytes,
    processLimit
  };
}

function detectResourceLimitsCapabilities(env = process.env) {
  const cfg = getResourceLimitsConfig(env);
  const availableBackends = [];
  if (cfg.hasSystemd) availableBackends.push('systemd');
  if (cfg.hasPrlimit) availableBackends.push('prlimit');
  return {
    isLinux: process.platform === 'linux',
    hasSystemd: cfg.hasSystemd,
    hasPrlimit: cfg.hasPrlimit,
    systemdScope: cfg.hasSystemd,
    prlimit: cfg.hasPrlimit,
    availableBackends,
    preferredBackend: cfg.backend,
    activeBackend: cfg.backend,
    limitsConfigured: cfg.limitsConfigured,
    active: cfg.active,
    required: cfg.required,
    cpuLimit: cfg.cpuLimit || null,
    memoryLimit: cfg.memoryLimit || null,
    processLimit: cfg.processLimit || null
  };
}

function applyResourceLimits(command, args = [], options = {}, env = process.env) {
  const effectiveEnv = (options && typeof options === 'object')
    ? { ...env, ...options }
    : env;
  const cfg = getResourceLimitsConfig(effectiveEnv);

  if ((cfg.required || cfg.limitsConfigured) && !cfg.active) {
    throw new Error(
      'Límites de recursos obligatorios (MCP_REQUIRE_RESOURCE_LIMITS=1) pero no hay backend compatible activo ' +
      `(systemd: ${cfg.hasSystemd}, prlimit: ${cfg.hasPrlimit}, backend: ${cfg.backend}). Fallo cerrado por seguridad.`
    );
  }

  if (!cfg.active) {
    return { command, args, resourceLimitsApplied: false, backend: 'none' };
  }

  if (cfg.backend === 'systemd') {
    const scopeArgs = ['--user', '--scope', '-q'];
    if (cfg.memoryLimit) {
      scopeArgs.push('-p', `MemoryMax=${cfg.memoryBytes}`);
    }
    if (cfg.cpuLimit) {
      scopeArgs.push('-p', `CPUQuota=${cfg.cpuLimit}`);
    }
    if (cfg.processLimit) {
      scopeArgs.push('-p', `TasksMax=${cfg.processLimit}`);
    }
    scopeArgs.push('--', command, ...args);
    return {
      command: 'systemd-run',
      args: scopeArgs,
      resourceLimitsApplied: true,
      backend: 'systemd'
    };
  }

  if (cfg.backend === 'prlimit') {
    const prlimitArgs = [];
    if (cfg.memoryLimit) {
      prlimitArgs.push(`--as=${cfg.memoryBytes}`);
    }
    if (cfg.processLimit) {
      prlimitArgs.push(`--nproc=${Number(cfg.processLimit)}`);
    }
    if (cfg.cpuLimit) {
      prlimitArgs.push(`--cpu=${Number(cfg.cpuLimit)}`);
    }
    prlimitArgs.push('--', command, ...args);
    return {
      command: 'prlimit',
      args: prlimitArgs,
      resourceLimitsApplied: true,
      backend: 'prlimit'
    };
  }

  return { command, args, resourceLimitsApplied: false, backend: 'none' };
}

function scanForMasking(dirPath, depth = 0, state = { maskDirs: [], maskFiles: [], visitedDirs: new Set() }) {
  const sensitiveDirNames = new Set(['.git', '.runtime', '.private', '.ssh', '.aws', '.gnupg']);
  if (depth > 25) {
    throw new Error(`Estructura de directorios excede la profundidad máxima analizable (${depth} niveles) en '${dirPath}'. Fallo cerrado por seguridad.`);
  }
  let realDir;
  try {
    realDir = fs.realpathSync(dirPath);
  } catch (err) {
    throw new Error(`No se pudo resolver la ruta del directorio para aislamiento en '${dirPath}': ${err.message}. Fallo cerrado sin degradación silenciosa.`);
  }
  if (state.visitedDirs.has(realDir)) return state;
  state.visitedDirs.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    throw new Error(`No se pudo analizar el directorio para aislamiento de seguridad en '${dirPath}': ${err.message}. Fallo cerrado sin degradación silenciosa.`);
  }
  for (const ent of entries) {
    const full = path.join(dirPath, ent.name);
    if (ent.isDirectory()) {
      if (sensitiveDirNames.has(ent.name.toLowerCase())) {
        state.maskDirs.push(full);
      } else {
        scanForMasking(full, depth + 1, state);
      }
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      if (isSensitiveFile(full)) {
        state.maskFiles.push(full);
      }
    }
  }
  return state;
}

function wrapCommandInSandbox(command, args = [], options = {}, env = process.env) {
  const caps = detectOsIsolationCapabilities(env);
  assertRestrictedIsolationAllowed(env);

  if (caps.hasBwrap) {
    const rawRoots = (options.allowedRoots && options.allowedRoots.length > 0)
      ? options.allowedRoots
      : [process.cwd()];

    const forbiddenHostRoots = new Set(['/', '/etc', '/root', '/bin', '/sbin', '/lib', '/lib64', '/usr', '/home']);
    const serverRoot = path.resolve(__dirname, '..');
    const homeDir = process.env.HOME || '/home/victor';

    const resolvedRoots = [];
    for (const r of rawRoots) {
      const absR = path.resolve(r);
      let realR = absR;
      try {
        if (fs.existsSync(absR)) realR = fs.realpathSync(absR);
      } catch (_) {}

      if (forbiddenHostRoots.has(absR) || forbiddenHostRoots.has(realR)) {
        throw new Error(`Configuración inválida en perfil restringido: no se permite '${absR}' como raíz permitida.`);
      }
      if (absR === homeDir || realR === homeDir) {
        throw new Error(`Configuración inválida en perfil restringido: no se permite el directorio personal raíz '${absR}' como raíz permitida. Debe especificar un subdirectorio de proyecto.`);
      }
      if (realR === serverRoot || (isSubpathOrEqual(serverRoot, realR) && !isSubpathOrEqual(realR, '/tmp') && !isSubpathOrEqual(realR, '/var/tmp'))) {
        throw new Error('Configuración inválida en perfil restringido: no se permite superposición con el repositorio del servidor MCP ni su plano de control.');
      }
      resolvedRoots.push(absR);
    }

    const trimmedCmd = String(command || '').trim();
    if (!trimmedCmd) {
      throw new Error('Comando requerido para ejecución en sandbox.');
    }

    const isPathCmd = trimmedCmd.includes('/') || trimmedCmd.includes('\\');
    let effectiveCommand = trimmedCmd;
    if (isPathCmd) {
      const absCmd = path.resolve(trimmedCmd);
      let realCmd = absCmd;
      try {
        if (fs.existsSync(absCmd)) {
          realCmd = fs.realpathSync(absCmd);
        }
      } catch (_) {}

      const isSystemBin = /^(?:\/usr(?:\/local)?|\/bin|\/sbin)(?:\/|$)/.test(absCmd) ||
                          /^(?:\/usr(?:\/local)?|\/bin|\/sbin)(?:\/|$)/.test(realCmd);
      let isNodeBin = false;
      try {
        isNodeBin = absCmd === process.execPath || realCmd === fs.realpathSync(process.execPath);
      } catch (_) {
        isNodeBin = absCmd === process.execPath;
      }

      if (!isSystemBin && !isNodeBin) {
        let withinRoots = false;
        for (const root of resolvedRoots) {
          let realRoot = root;
          try { if (fs.existsSync(root)) realRoot = fs.realpathSync(root); } catch (_) {}
          const inAbs = isSubpathOrEqual(absCmd, root);
          const inReal = isSubpathOrEqual(realCmd, realRoot);
          if (inAbs && inReal) {
            withinRoots = true;
            break;
          }
        }
        if (!withinRoots) {
          throw new Error(`Acceso denegado: el ejecutable '${trimmedCmd}' está fuera de las rutas permitidas y no es un binario de sistema administrado.`);
        }
      }
    }

    const nodeBinDir = path.dirname(process.execPath);
    const bwrapArgs = [
      '--unshare-all',
      '--unshare-net',
      '--die-with-parent',
      '--new-session',
      '--cap-drop', 'ALL',
      '--clearenv',
      '--setenv', 'PATH', `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin`,
      '--setenv', 'HOME', '/tmp',
      '--setenv', 'TMPDIR', '/tmp',
      '--setenv', 'USER', 'nobody',
      '--setenv', 'LANG', 'C.UTF-8',
      '--setenv', 'LC_ALL', 'C.UTF-8'
    ];

    const roBinds = [
      '/usr', '/lib', '/lib64', '/bin', '/sbin',
      '/etc/alternatives', '/etc/ssl', '/etc/resolv.conf'
    ];
    for (const p of roBinds) {
      if (fs.existsSync(p)) {
        bwrapArgs.push('--ro-bind', p, p);
      }
    }

    // Bind ONLY the single node executable file if outside /usr
    try {
      bwrapArgs.push('--ro-bind-try', process.execPath, process.execPath);
      const realNode = fs.realpathSync(process.execPath);
      if (realNode !== process.execPath) {
        bwrapArgs.push('--ro-bind-try', realNode, realNode);
      }
    } catch (_) {}

    bwrapArgs.push('--proc', '/proc');
    bwrapArgs.push('--dev', '/dev');
    bwrapArgs.push('--tmpfs', '/tmp');

    // Recursively discover sensitive files and directories across the entire tree
    const maskState = { maskDirs: [], maskFiles: [], visitedDirs: new Set() };

    // Deduplicate nested roots so parents are bound cleanly
    const dedupedRoots = [];
    for (const root of resolvedRoots) {
      const alreadyCovered = dedupedRoots.some(parent => isSubpathOrEqual(root, parent));
      if (!alreadyCovered) {
        dedupedRoots.push(root);
      }
    }

    for (const root of dedupedRoots) {
      if (fs.existsSync(root)) {
        bwrapArgs.push('--bind', root, root);
        scanForMasking(root, 0, maskState);

        // Protect server source code from modification ONLY if root encompasses serverRoot
        if (isSubpathOrEqual(serverRoot, root) || isSubpathOrEqual(root, serverRoot)) {
          for (const codeFile of ['package.json', 'mcp-server.js', 'mcp-supervisor.js', 'mcpctl.sh']) {
            const cp = path.join(serverRoot, codeFile);
            if (fs.existsSync(cp)) {
              bwrapArgs.push('--ro-bind-try', cp, cp);
            }
          }
          const libDir = path.join(serverRoot, 'lib');
          if (fs.existsSync(libDir)) {
            bwrapArgs.push('--ro-bind-try', libDir, libDir);
          }
        }
      }
    }

    // Apply directory tmpfs masks
    for (const d of maskState.maskDirs) {
      bwrapArgs.push('--tmpfs', d);
    }

    // Apply file dev/null masks
    for (const f of maskState.maskFiles) {
      bwrapArgs.push('--ro-bind-try', '/dev/null', f);
    }

    const defaultCwd = dedupedRoots[0] || process.cwd();
    let cwd = defaultCwd;
    if (options.cwd) {
      const candidateCwd = path.resolve(options.cwd);
      let realCwd = candidateCwd;
      try { if (fs.existsSync(candidateCwd)) realCwd = fs.realpathSync(candidateCwd); } catch (_) {}
      const isWithin = dedupedRoots.some(r => {
        let realR = r;
        try { if (fs.existsSync(r)) realR = fs.realpathSync(r); } catch (_) {}
        return isSubpathOrEqual(candidateCwd, r) && isSubpathOrEqual(realCwd, realR);
      });
      if (isWithin) {
        cwd = candidateCwd;
      }
    }

    bwrapArgs.push('--chdir', cwd);
    bwrapArgs.push('--', effectiveCommand, ...args);

    let finalCommand = 'bwrap';
    let finalArgs = bwrapArgs;
    const rlResult = applyResourceLimits(finalCommand, finalArgs, options, env);
    if (rlResult.resourceLimitsApplied) {
      finalCommand = rlResult.command;
      finalArgs = rlResult.args;
    }

    return {
      command: finalCommand,
      args: finalArgs,
      isolated: true,
      mechanism: 'bubblewrap',
      resourceLimitsApplied: rlResult.resourceLimitsApplied,
      resourceLimitsBackend: rlResult.backend
    };
  }

  // Fallback if bwrap is not active: apply resource limits directly if configured
  const rlFallback = applyResourceLimits(command, args, options, env);
  return {
    command: rlFallback.command,
    args: rlFallback.args,
    isolated: false,
    mechanism: 'none',
    resourceLimitsApplied: rlFallback.resourceLimitsApplied,
    resourceLimitsBackend: rlFallback.backend
  };
}

module.exports = {
  isBlockedIp,
  validateEgressUrl,
  isSensitiveFile,
  isServerControlPlaneFile,
  isSubpathOrEqual,
  validatePathWithinRoots,
  validateZipSlip,
  detectOsIsolationCapabilities,
  assertRestrictedIsolationAllowed,
  wrapCommandInSandbox,
  scanForMasking,
  testBwrapSupport,
  testSystemdScopeSupport,
  testPrlimitSupport,
  detectResourceLimitsCapabilities,
  getResourceLimitsConfig,
  applyResourceLimits
};
