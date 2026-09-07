#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensurePrivateDirectory, applyPrivateOwnership } = require('./private-owner');

class PolicyCorruptedStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyCorruptedStateError';
    this.code = 'POLICY_CORRUPTED_STATE';
  }
}

function defaultClientPoliciesPath() {
  return process.env.MCP_CLIENT_POLICIES_STORE
    ? path.resolve(process.env.MCP_CLIENT_POLICIES_STORE)
    : path.resolve('.private/client-policies.json');
}

class ClientPolicyStore {
  constructor(filePathOrOptions) {
    let filePath;
    if (typeof filePathOrOptions === 'object' && filePathOrOptions !== null) {
      filePath = filePathOrOptions.storePath || filePathOrOptions.filePath || defaultClientPoliciesPath();
    } else if (typeof filePathOrOptions === 'string') {
      filePath = filePathOrOptions;
    } else {
      filePath = defaultClientPoliciesPath();
    }
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.markerPath = path.join(path.dirname(this.filePath), '.client-policies-configured');
    this.cache = null;
    this.lastMtime = 0;
    this._hasBeenConfigured = false;
    this._missingCorrupted = false;
    this._ensureStore();
  }

  _isConfiguredExpected() {
    if (this._hasBeenConfigured) return true;
    if (fs.existsSync(this.markerPath)) return true;
    return false;
  }

  _setConfiguredExpected(expected) {
    this._hasBeenConfigured = Boolean(expected);
    if (expected) {
      ensurePrivateDirectory(path.dirname(this.markerPath), 0o700);
      try {
        fs.writeFileSync(this.markerPath, `configured=${Date.now()}\n`, { mode: 0o600 });
        applyPrivateOwnership(this.markerPath, 0o600);
      } catch (_) {}
    } else {
      if (fs.existsSync(this.markerPath)) {
        try { fs.unlinkSync(this.markerPath); } catch (_) {}
      }
    }
  }

  _ensureStore() {
    ensurePrivateDirectory(path.dirname(this.filePath), 0o700);
    if (!fs.existsSync(this.filePath)) {
      if (this._isConfiguredExpected()) {
        this._missingCorrupted = true;
        return;
      }
      this._writeState({ version: 1, clients: {}, global: {} });
    } else {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data && data.clients && Object.keys(data.clients).length > 0) {
          this._setConfiguredExpected(true);
        }
      } catch (_) {
        this._missingCorrupted = true;
      }
    }
  }

  _readState() {
    if (!fs.existsSync(this.filePath)) {
      this.cache = null;
      this.lastMtime = 0;
      if (this._isConfiguredExpected() || this._missingCorrupted) {
        throw new PolicyCorruptedStateError(
          `Archivo de estado de políticas por cliente ausente o eliminado tras haber sido configurado previamente (${this.filePath}). Fallo cerrado por seguridad.`
        );
      }
      return { version: 1, clients: {}, global: {}, isFreshInstall: true };
    }

    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch (err) {
      this.cache = null;
      throw new PolicyCorruptedStateError(`No se pudo leer almacén de políticas: ${err.message}`);
    }

    if (this.cache && stat.mtimeMs === this.lastMtime) {
      return this.cache;
    }

    let content;
    try {
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.cache = null;
      throw new PolicyCorruptedStateError(`Error de lectura en almacén de políticas: ${err.message}`);
    }

    let data;
    try {
      data = JSON.parse(content);
    } catch (err) {
      this.cache = null;
      this._missingCorrupted = true;
      throw new PolicyCorruptedStateError(`Archivo de políticas por cliente corrupto o inválido (JSON parse error): ${err.message}. Fallo cerrado por seguridad.`);
    }

    if (!data || typeof data !== 'object') {
      this.cache = null;
      this._missingCorrupted = true;
      throw new PolicyCorruptedStateError('Estructura de políticas no válida. Fallo cerrado por seguridad.');
    }

    this.cache = data;
    this.cache.clients = this.cache.clients || {};
    this.cache.global = this.cache.global || {};
    this.lastMtime = stat.mtimeMs;
    if (Object.keys(this.cache.clients).length > 0) {
      this._setConfiguredExpected(true);
    }
    return this.cache;
  }

  _writeState(state) {
    ensurePrivateDirectory(path.dirname(this.filePath), 0o700);
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    applyPrivateOwnership(this.filePath, 0o600);
    try {
      this.lastMtime = fs.statSync(this.filePath).mtimeMs;
    } catch (_) {
      this.lastMtime = Date.now();
    }
    this.cache = state;
  }

  _mutate(fn) {
    ensurePrivateDirectory(path.dirname(this.filePath), 0o700);
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
              if (Date.now() - stat.mtimeMs > 10000) {
                fs.unlinkSync(this.lockPath);
              }
            } catch (_) {}
          }
          const waitEnd = Date.now() + 15;
          while (Date.now() < waitEnd) {}
          continue;
        }
        throw err;
      }
    }
  }

  getClientPolicy(clientId) {
    if (!clientId) return null;
    const state = this._readState();
    return state.clients[String(clientId)] || null;
  }

  setClientPolicy(clientId, policy = {}) {
    if (!clientId) throw new Error('clientId es requerido para configurar política.');
    return this._mutate(state => {
      state.clients = state.clients || {};
      state.clients[String(clientId)] = {
        ...(state.clients[String(clientId)] || {}),
        ...policy,
        updatedAt: Date.now()
      };
      this._setConfiguredExpected(true);
      return state.clients[String(clientId)];
    });
  }

  revokeClientTool(clientId, toolName) {
    if (!clientId || !toolName) return;
    return this._mutate(state => {
      state.clients = state.clients || {};
      const current = state.clients[String(clientId)] || {};
      const denied = new Set(current.deniedTools || []);
      const allowed = new Set(current.allowedTools || []);
      denied.add(toolName);
      allowed.delete(toolName);
      state.clients[String(clientId)] = {
        ...current,
        deniedTools: [...denied],
        allowedTools: allowed.size > 0 ? [...allowed] : undefined,
        updatedAt: Date.now()
      };
      this._setConfiguredExpected(true);
      return state.clients[String(clientId)];
    });
  }

  grantClientTool(clientId, toolName) {
    if (!clientId || !toolName) return;
    return this._mutate(state => {
      state.clients = state.clients || {};
      const current = state.clients[String(clientId)] || {};
      const denied = new Set(current.deniedTools || []);
      const allowed = new Set(current.allowedTools || []);
      denied.delete(toolName);
      allowed.add(toolName);
      state.clients[String(clientId)] = {
        ...current,
        deniedTools: [...denied],
        allowedTools: [...allowed],
        updatedAt: Date.now()
      };
      this._setConfiguredExpected(true);
      return state.clients[String(clientId)];
    });
  }

  setClientApprovalTool(clientId, toolName) {
    if (!clientId || !toolName) return;
    return this._mutate(state => {
      state.clients = state.clients || {};
      const current = state.clients[String(clientId)] || {};
      const approvals = new Set(current.approvalTools || []);
      approvals.add(toolName);
      state.clients[String(clientId)] = {
        ...current,
        approvalTools: [...approvals],
        updatedAt: Date.now()
      };
      this._setConfiguredExpected(true);
      return state.clients[String(clientId)];
    });
  }

  clearClientPolicy(clientId) {
    if (!clientId) return;
    return this._mutate(state => {
      if (state.clients && state.clients[String(clientId)]) {
        delete state.clients[String(clientId)];
      }
    });
  }

  resetConfiguredState() {
    this._setConfiguredExpected(false);
    if (fs.existsSync(this.filePath)) {
      try { fs.unlinkSync(this.filePath); } catch (_) {}
    }
    this.cache = null;
    this.lastMtime = 0;
    this._missingCorrupted = false;
  }

  getPolicyVersion(clientId = null, baseVersion = '') {
    const state = this._readState();
    const clientPolicy = clientId ? (state.clients[String(clientId)] || null) : null;
    const hashData = {
      baseVersion,
      clientPolicy,
      lastMtime: this.lastMtime
    };
    return crypto.createHash('sha256').update(JSON.stringify(hashData)).digest('hex').slice(0, 16);
  }
}

// Internal capability policy; access-policy-cli.js is the public entrypoint.

const GROUPS = Object.freeze({
  diagnostics: 'Estado y diagnóstico del MCP',
  files_read: 'Lectura y búsqueda de archivos',
  files_write: 'Creación, modificación, copia, movimiento y borrado de archivos',
  command_execution: 'Ejecución de comandos y procesos',
  system_read: 'Consulta del sistema, procesos, servicios, red y almacenamiento',
  system_manage: 'Control de procesos y servicios del sistema',
  git_read: 'Consulta de repositorios Git',
  git_write: 'Cambios, commits, pull, push y otras operaciones Git',
  tmux_read: 'Consulta de sesiones tmux',
  tmux_write: 'Creación y control de sesiones tmux',
  desktop_view: 'Visualización del escritorio y ventanas',
  desktop_control: 'Control de ventanas, teclado y mouse',
  camera: 'Listado y captura de cámaras',
  audio: 'Consulta de dispositivos de audio',
  network: 'Solicitudes HTTP, comprobación de puertos y descargas',
  packages: 'Instalación, actualización y eliminación de paquetes',
  firewall: 'Cambios en el firewall',
  mounts: 'Montaje y desmontaje de unidades',
  containers: 'Administración de proyectos Docker/Compose',
  power: 'Reinicio y apagado del equipo'
});

const TOOL_REQUIREMENTS = Object.freeze({
  // Always-safe policy inspector.
  tool_policy_status: [],

  // Core diagnostics.
  control_capabilities: ['diagnostics'],
  mcp_runtime_status: ['diagnostics'],
  mcp_runtime_logs: ['diagnostics'],

  // Files.
  search: ['files_read'],
  fetch: ['files_read'],
  list_files: ['files_read'],
  read_file: ['files_read'],
  file_info: ['files_read'],
  read_image: ['files_read'],
  tail_file: ['files_read'],
  directory_tree: ['files_read'],
  file_hash: ['files_read'],
  write_file: ['files_write'],
  patch_file: ['files_write'],
  file_copy: ['files_write'],
  file_move: ['files_write'],
  file_delete: ['files_write'],
  archive_create: ['files_read', 'files_write'],
  archive_extract: ['files_write'],

  // Generic command/process execution.
  run_command: ['command_execution'],
  process_start: ['command_execution'],

  // Read-only system inspection.
  system_snapshot: ['system_read'],
  hardware_info: ['system_read'],
  disk_usage: ['system_read'],
  network_status: ['system_read'],
  gpu_status: ['system_read'],
  process_list: ['system_read'],
  process_info: ['system_read'],
  service_status: ['system_read'],
  journal_tail: ['system_read'],
  package_status: ['system_read'],
  firewall_status: ['system_read'],
  mount_status: ['system_read'],
  user_accounts: ['system_read'],
  container_status: ['system_read'],

  // System changes.
  process_signal: ['system_manage'],
  service_action: ['system_manage'],
  package_action: ['packages'],
  firewall_action: ['firewall'],
  mount_action: ['mounts'],
  power_action: ['power'],

  // Git.
  git_status: ['git_read'],
  git_diff: ['git_read'],
  git_log: ['git_read'],
  git_branches: ['git_read'],
  git_worktrees: ['git_read'],
  git_command: ['git_write', 'command_execution'],

  // tmux.
  tmux_list: ['tmux_read'],
  tmux_panes: ['tmux_read'],
  tmux_capture: ['tmux_read'],
  tmux_create: ['tmux_write', 'command_execution'],
  tmux_send: ['tmux_write', 'command_execution'],
  tmux_interrupt: ['tmux_write'],
  tmux_kill: ['tmux_write'],

  // Desktop/media.
  desktop_info: ['desktop_view'],
  screen_capture: ['desktop_view'],
  list_windows: ['desktop_view'],
  window_action: ['desktop_control'],
  mouse_move: ['desktop_control'],
  mouse_click: ['desktop_control'],
  mouse_scroll: ['desktop_control'],
  keyboard_hotkey: ['desktop_control'],
  keyboard_type: ['desktop_control'],
  desktop_open: ['desktop_control'],
  camera_list: ['camera'],
  camera_snapshot: ['camera'],
  audio_devices: ['audio'],

  // Network and containers.
  http_request: ['network'],
  port_check: ['network'],
  download_file: ['network', 'files_write'],
  container_compose: ['containers', 'command_execution'],

  // Async jobs.
  job_start: ['command_execution'],
  job_status: ['command_execution'],
  job_output: ['command_execution'],
  job_cancel: ['command_execution']
});

const PROFILE_GROUPS = Object.freeze({
  observacion: [
    'diagnostics', 'files_read', 'system_read', 'git_read', 'tmux_read'
  ],
  trabajo_restringido: [
    'diagnostics', 'files_read', 'files_write', 'command_execution',
    'system_read', 'git_read', 'git_write'
  ],
  read_only: [
    'diagnostics', 'files_read', 'system_read', 'git_read', 'tmux_read',
    'desktop_view', 'network'
  ],
  developer: [
    'diagnostics', 'files_read', 'files_write', 'command_execution',
    'system_read', 'git_read', 'git_write', 'tmux_read', 'tmux_write',
    'desktop_view', 'network', 'containers'
  ],
  administrator: [
    'diagnostics', 'files_read', 'files_write', 'command_execution',
    'system_read', 'system_manage', 'git_read', 'git_write',
    'tmux_read', 'tmux_write', 'desktop_view', 'desktop_control',
    'camera', 'audio', 'network', 'packages', 'firewall', 'mounts',
    'containers'
  ],
  full: Object.keys(GROUPS)
});

const PROFILE_LABELS = Object.freeze({
  observacion: 'Observación y consulta segura',
  trabajo_restringido: 'Trabajo restringido',
  read_only: 'Sólo lectura y observación',
  developer: 'Desarrollo',
  administrator: 'Administración',
  full: 'Control total',
  custom: 'Personalizado'
});

const PRESETS = Object.freeze({
  observacion_auditoria: {
    label: 'Auditoría y Análisis Seguro',
    profile: 'observacion',
    description: 'Diagnóstico y lectura de código/sistema sin red ni capturas sensibles.'
  },
  desarrollo_web: {
    label: 'Desarrollo Frontend y Web',
    profile: 'developer',
    denylist: ['container_compose'],
    description: 'Edición de código, pruebas y herramientas Git/tmux sin Docker.'
  },
  devops_servidor: {
    label: 'Administración DevOps y Servidores',
    profile: 'administrator',
    description: 'Servicios, paquetes, Docker, montajes y firewall sin reinicios de energía.'
  },
  trabajo_acotado: {
    label: 'Trabajo Restringido en Carpeta',
    profile: 'trabajo_restringido',
    description: 'Lectura/escritura y ejecución confinada sin acceso a red externa ni privilegios.'
  }
});

function parseCsv(value) {
  return [...new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function confirmationsRequired(value) {
  if (value === undefined || value === null || value === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function normalizeProfile(value) {
  const raw = String(value || 'developer').trim().toLowerCase().replace(/[ -]+/g, '_');
  const aliases = {
    observacion: 'observacion',
    observación: 'observacion',
    observation: 'observacion',
    trabajo_restringido: 'trabajo_restringido',
    trabajorestringido: 'trabajo_restringido',
    'trabajo-restringido': 'trabajo_restringido',
    restringido: 'trabajo_restringido',
    restricted: 'trabajo_restringido',
    'restricted-work': 'trabajo_restringido',
    readonly: 'read_only',
    read: 'read_only',
    lectura: 'read_only',
    consulta: 'read_only',
    dev: 'developer',
    desarrollo: 'developer',
    admin: 'administrator',
    administracion: 'administrator',
    administración: 'administrator',
    completo: 'full',
    total: 'full',
    control_total: 'full',
    personalizado: 'custom'
  };
  const normalized = aliases[raw] || raw;
  if (!Object.prototype.hasOwnProperty.call(PROFILE_LABELS, normalized)) {
    throw new Error(`Perfil de acceso no válido: ${value}. Usá observacion, trabajo_restringido, read_only, developer, administrator, full o custom.`);
  }
  return normalized;
}

function createAccessPolicy(env = process.env, allToolNames = [], clientPolicyStore = null) {
  const store = clientPolicyStore || new ClientPolicyStore({ storePath: env.MCP_CLIENT_POLICIES_STORE });
  const profile = normalizeProfile(env.MCP_ACCESS_PROFILE || env.profile || 'developer');
  const configuredGroups = parseCsv(env.MCP_ACCESS_GROUPS);
  const groups = new Set(profile === 'custom' ? configuredGroups : PROFILE_GROUPS[profile]);
  const allowlist = new Set(parseCsv(env.MCP_TOOL_ALLOWLIST));
  const denylist = new Set(parseCsv(env.MCP_TOOL_DENYLIST));
  const runAsRoot = boolValue(env.MCP_RUN_AS_ROOT, false);
  const criticalConfirmations = confirmationsRequired(env.MCP_CRITICAL_CONFIRMATIONS);
  const knownGroups = new Set(Object.keys(GROUPS));
  const unknownGroups = [...groups].filter((group) => !knownGroups.has(group));
  if (unknownGroups.length > 0) {
    throw new Error(`MCP_ACCESS_GROUPS contiene grupos desconocidos: ${unknownGroups.join(', ')}`);
  }
  if (profile === 'custom' && groups.size === 0 && allowlist.size === 0) {
    throw new Error('El perfil custom requiere MCP_ACCESS_GROUPS o MCP_TOOL_ALLOWLIST.');
  }

  function isAllowed(toolName, clientContext = {}) {
    const name = String(toolName || '');
    if (name === 'tool_policy_status') return true;
    if (denylist.has(name)) return false;
    if (allowlist.size > 0 && !allowlist.has(name)) return false;

    // Resolve client identity from string, principal, or context
    let clientId = 'anonymous';
    if (typeof clientContext === 'string') {
      clientId = clientContext;
    } else if (clientContext && clientContext.principal && clientContext.principal.clientId) {
      clientId = clientContext.principal.clientId;
    } else if (clientContext && clientContext.clientId) {
      clientId = clientContext.clientId;
    }

    // Check authoritative store on every call
    let clientPolicy = (clientContext && clientContext.clientPolicy) || null;
    if (!clientPolicy) {
      try {
        clientPolicy = store.getClientPolicy(clientId);
      } catch (err) {
        if (err instanceof PolicyCorruptedStateError || err.name === 'PolicyCorruptedStateError') {
          // Fail-closed: corrupted or missing state after configuration denies access
          return false;
        }
        throw err;
      }
    }

    if (clientPolicy) {
      if (clientPolicy.deniedTools && clientPolicy.deniedTools.includes(name)) {
        return false;
      }
      if (clientPolicy.allowedTools && clientPolicy.allowedTools.length > 0 && !clientPolicy.allowedTools.includes(name)) {
        return false;
      }
    }

    // Backward compatibility if caller passed deniedTools/allowedTools directly
    if (clientContext && typeof clientContext === 'object') {
      if (clientContext.deniedTools && clientContext.deniedTools.includes(name)) {
        return false;
      }
      if (clientContext.allowedTools && !clientContext.allowedTools.includes(name)) {
        return false;
      }
    }

    const requirements = TOOL_REQUIREMENTS[name];
    if (!requirements) {
      // New or unmapped tools are denied by default unless full profile or explicit allowlist
      return profile === 'full' || allowlist.has(name);
    }
    let effectiveGroups = groups;
    if (clientPolicy && clientPolicy.profile && PROFILE_GROUPS[clientPolicy.profile]) {
      const clientGroups = new Set(PROFILE_GROUPS[clientPolicy.profile]);
      // Client profile can only sub-scope (restrict) permissions, never expand beyond global profile
      effectiveGroups = new Set([...clientGroups].filter(g => groups.has(g)));
    }
    return requirements.every((group) => effectiveGroups.has(group));
  }

  function assertAllowed(toolName, clientContext = {}) {
    let clientId = 'anonymous';
    if (typeof clientContext === 'string') {
      clientId = clientContext;
    } else if (clientContext && clientContext.principal && clientContext.principal.clientId) {
      clientId = clientContext.principal.clientId;
    } else if (clientContext && clientContext.clientId) {
      clientId = clientContext.clientId;
    }
    // Eagerly verify store integrity; re-throw PolicyCorruptedStateError so failure is explicit
    const clientPolicy = (clientContext && clientContext.clientPolicy) || store.getClientPolicy(clientId);

    if (isAllowed(toolName, clientContext)) return;
    const requirements = TOOL_REQUIREMENTS[toolName] || [];
    const needed = requirements.length ? ` Requiere: ${requirements.join(', ')}.` : '';
    const actor = clientId ? ` para el cliente ${clientId}` : '';
    const effectiveProfile = (clientPolicy && clientPolicy.profile) || profile;
    throw new Error(`La herramienta ${toolName} está bloqueada por el perfil de acceso ${effectiveProfile}${actor}.${needed} Reconfigurá localmente con ./mcpctl.sh configure.`);
  }

  function filterTools(tools, clientContext = {}) {
    return tools.filter((tool) => tool && isAllowed(tool.name, clientContext));
  }

  function summary(toolNames = allToolNames, clientContext = {}) {
    const uniqueTools = [...new Set(toolNames.map(String))].sort();
    const allowedTools = uniqueTools.filter((t) => isAllowed(t, clientContext));
    const blockedTools = uniqueTools.filter((name) => !isAllowed(name, clientContext));
    const warnings = [];
    const knownToolNames = new Set(uniqueTools);
    const unknownAllowlist = [...allowlist].filter((name) => !knownToolNames.has(name));
    const unknownDenylist = [...denylist].filter((name) => !knownToolNames.has(name));
    if (unknownAllowlist.length) warnings.push(`MCP_TOOL_ALLOWLIST contiene nombres desconocidos: ${unknownAllowlist.join(', ')}.`);
    if (unknownDenylist.length) warnings.push(`MCP_TOOL_DENYLIST contiene nombres desconocidos: ${unknownDenylist.join(', ')}.`);
    if (groups.has('command_execution')) warnings.push('La ejecución genérica de comandos puede realizar muchas acciones con los permisos del usuario del MCP e ignorar bloqueos de herramientas de alto nivel.');
    if (groups.has('network')) warnings.push('El perfil permite conexiones de red salientes (HTTP/descargas). En entornos hostiles, validar SSRF y endpoints.');
    if (groups.has('containers')) warnings.push('El control de contenedores Docker/Compose puede otorgar privilegios equivalentes a root en el anfitrión.');
    if (groups.has('desktop_control')) warnings.push('El perfil permite controlar teclado, mouse y ventanas.');
    if (groups.has('camera')) warnings.push('El perfil permite capturar imágenes de cámaras conectadas.');
    if (groups.has('power')) warnings.push(`El perfil permite reiniciar o apagar el equipo${criticalConfirmations ? ' con confirmación explícita' : ' sin confirmación adicional'}.`);
    if (String(env.MCP_FULL_ACCESS || '0') === '1') warnings.push('El alcance de archivos está configurado como FULL ACCESS (/).');
    if (runAsRoot) warnings.push('El servidor está configurado para ejecutarse como root.');
    if (!criticalConfirmations) warnings.push('Las confirmaciones adicionales para operaciones críticas están desactivadas.');
    return {
      profile,
      label: PROFILE_LABELS[profile],
      groups: [...groups].sort(),
      groupDescriptions: Object.fromEntries([...groups].sort().map((group) => [group, GROUPS[group]])),
      allowlist: [...allowlist].sort(),
      denylist: [...denylist].sort(),
      executionMode: runAsRoot ? 'root' : 'user',
      runAsRoot,
      criticalConfirmations,
      allowedToolCount: allowedTools.length,
      blockedToolCount: blockedTools.length,
      allowedTools,
      blockedTools,
      warnings,
      note: 'El perfil controla qué herramientas publica el MCP. Los permisos reales siguen limitados por el usuario del sistema y por ALLOWED_PATHS/MCP_FULL_ACCESS.'
    };
  }

  const basePolicyHash = crypto.createHash('sha256').update(JSON.stringify({
    profile,
    groups: [...groups].sort(),
    allowlist: [...allowlist].sort(),
    denylist: [...denylist].sort(),
    runAsRoot,
    criticalConfirmations
  })).digest('hex').slice(0, 16);

  return {
    get version() {
      return store.getPolicyVersion(null, basePolicyHash);
    },
    get policyVersion() {
      return store.getPolicyVersion(null, basePolicyHash);
    },
    getVersion(clientId) {
      return store.getPolicyVersion(clientId, basePolicyHash);
    },
    clientPolicyStore: store,
    profile,
    label: PROFILE_LABELS[profile],
    groups,
    allowlist,
    denylist,
    runAsRoot,
    criticalConfirmations,
    toolApprovals: env.MCP_TOOL_APPROVALS || '',
    isAllowed,
    assertAllowed,
    filterTools,
    summary
  };
}

module.exports = {
  GROUPS,
  PROFILE_GROUPS,
  PROFILE_LABELS,
  PRESETS,
  TOOL_REQUIREMENTS,
  ClientPolicyStore,
  PolicyCorruptedStateError,
  boolValue,
  confirmationsRequired,
  createAccessPolicy,
  normalizeProfile,
  parseCsv
};

