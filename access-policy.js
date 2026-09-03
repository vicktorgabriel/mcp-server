#!/usr/bin/env node
'use strict';

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
  container_compose: ['containers', 'command_execution']
});

const PROFILE_GROUPS = Object.freeze({
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
  read_only: 'Sólo lectura y observación',
  developer: 'Desarrollo',
  administrator: 'Administración',
  full: 'Control total',
  custom: 'Personalizado'
});

function parseCsv(value) {
  return [...new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

function normalizeProfile(value) {
  const raw = String(value || 'developer').trim().toLowerCase().replace(/[ -]+/g, '_');
  const aliases = {
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
    personalizado: 'custom'
  };
  const normalized = aliases[raw] || raw;
  if (!Object.prototype.hasOwnProperty.call(PROFILE_LABELS, normalized)) {
    throw new Error(`Perfil de acceso no válido: ${value}. Usá read_only, developer, administrator, full o custom.`);
  }
  return normalized;
}

function createAccessPolicy(env = process.env, allToolNames = []) {
  const profile = normalizeProfile(env.MCP_ACCESS_PROFILE || 'developer');
  const configuredGroups = parseCsv(env.MCP_ACCESS_GROUPS);
  const groups = new Set(profile === 'custom' ? configuredGroups : PROFILE_GROUPS[profile]);
  const allowlist = new Set(parseCsv(env.MCP_TOOL_ALLOWLIST));
  const denylist = new Set(parseCsv(env.MCP_TOOL_DENYLIST));
  const knownGroups = new Set(Object.keys(GROUPS));
  const unknownGroups = [...groups].filter((group) => !knownGroups.has(group));
  if (unknownGroups.length > 0) {
    throw new Error(`MCP_ACCESS_GROUPS contiene grupos desconocidos: ${unknownGroups.join(', ')}`);
  }
  if (profile === 'custom' && groups.size === 0 && allowlist.size === 0) {
    throw new Error('El perfil custom requiere MCP_ACCESS_GROUPS o MCP_TOOL_ALLOWLIST.');
  }

  function isAllowed(toolName) {
    const name = String(toolName || '');
    if (name === 'tool_policy_status') return true;
    if (denylist.has(name)) return false;
    if (allowlist.size > 0 && !allowlist.has(name)) return false;
    const requirements = TOOL_REQUIREMENTS[name];
    if (!requirements) return profile === 'full' || allowlist.has(name);
    return requirements.every((group) => groups.has(group));
  }

  function assertAllowed(toolName) {
    if (isAllowed(toolName)) return;
    const requirements = TOOL_REQUIREMENTS[toolName] || [];
    const needed = requirements.length ? ` Requiere: ${requirements.join(', ')}.` : '';
    throw new Error(`La herramienta ${toolName} está bloqueada por el perfil de acceso ${profile}.${needed} Reconfigurá localmente con ./mcpctl.sh configure.`);
  }

  function filterTools(tools) {
    return tools.filter((tool) => tool && isAllowed(tool.name));
  }

  function summary(toolNames = allToolNames) {
    const uniqueTools = [...new Set(toolNames.map(String))].sort();
    const allowedTools = uniqueTools.filter(isAllowed);
    const blockedTools = uniqueTools.filter((name) => !isAllowed(name));
    const warnings = [];
    const knownToolNames = new Set(uniqueTools);
    const unknownAllowlist = [...allowlist].filter((name) => !knownToolNames.has(name));
    const unknownDenylist = [...denylist].filter((name) => !knownToolNames.has(name));
    if (unknownAllowlist.length) warnings.push(`MCP_TOOL_ALLOWLIST contiene nombres desconocidos: ${unknownAllowlist.join(', ')}.`);
    if (unknownDenylist.length) warnings.push(`MCP_TOOL_DENYLIST contiene nombres desconocidos: ${unknownDenylist.join(', ')}.`);
    if (groups.has('command_execution')) warnings.push('La ejecución genérica de comandos puede realizar muchas acciones con los permisos del usuario del MCP.');
    if (groups.has('desktop_control')) warnings.push('El perfil permite controlar teclado, mouse y ventanas.');
    if (groups.has('camera')) warnings.push('El perfil permite capturar imágenes de cámaras conectadas.');
    if (groups.has('power')) warnings.push('El perfil permite reiniciar o apagar el equipo con confirmación explícita.');
    if (String(env.MCP_FULL_ACCESS || '0') === '1') warnings.push('El alcance de archivos está configurado como FULL ACCESS (/).');
    return {
      profile,
      label: PROFILE_LABELS[profile],
      groups: [...groups].sort(),
      groupDescriptions: Object.fromEntries([...groups].sort().map((group) => [group, GROUPS[group]])),
      allowlist: [...allowlist].sort(),
      denylist: [...denylist].sort(),
      allowedToolCount: allowedTools.length,
      blockedToolCount: blockedTools.length,
      allowedTools,
      blockedTools,
      warnings,
      note: 'El perfil controla qué herramientas publica el MCP. Los permisos reales siguen limitados por el usuario del sistema y por ALLOWED_PATHS/MCP_FULL_ACCESS.'
    };
  }

  return {
    profile,
    label: PROFILE_LABELS[profile],
    groups,
    allowlist,
    denylist,
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
  TOOL_REQUIREMENTS,
  createAccessPolicy,
  normalizeProfile,
  parseCsv
};
