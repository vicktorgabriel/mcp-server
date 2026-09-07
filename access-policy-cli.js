#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createAccessPolicy, TOOL_REQUIREMENTS, TOOL_CATEGORIES, TOOL_RISK, GROUPS, PROFILE_LABELS, PRESETS } = require('./lib/access-policy');
const { parseDotEnv } = require('./lib/runtime-diagnostics');
const { ApprovalsManager } = require('./lib/approvals');
const { detectOsIsolationCapabilities } = require('./lib/sandbox');
const { applyPrivateOwnership } = require('./lib/private-owner');

const approvals = new ApprovalsManager();

const USE_COLOR = process.stdout.isTTY && !Object.hasOwn(process.env, 'NO_COLOR');
const C = {
  reset: USE_COLOR ? '\x1b[0m' : '',
  bold: USE_COLOR ? '\x1b[1m' : '',
  dim: USE_COLOR ? '\x1b[2m' : '',
  green: USE_COLOR ? '\x1b[32m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  red: USE_COLOR ? '\x1b[31m' : '',
  cyan: USE_COLOR ? '\x1b[36m' : '',
  magenta: USE_COLOR ? '\x1b[35m' : ''
};

const TOOL_DESCRIPTIONS = {
  tool_policy_status: { label: 'Inspección de política', desc: 'Muestra perfil, grupos y herramientas permitidas sin exponer secretos.' },
  search: { label: 'Buscar archivos', desc: 'Búsqueda por nombre y texto en carpetas permitidas.' },
  fetch: { label: 'Recuperar archivo', desc: 'Obtiene contenido de un resultado de búsqueda.' },
  list_files: { label: 'Listar directorio', desc: 'Lista archivos y carpetas en rutas autorizadas.' },
  read_file: { label: 'Leer archivo', desc: 'Lectura de archivos UTF-8 con paginación y hash SHA-256.' },
  file_info: { label: 'Detalles de archivo', desc: 'Muestra metadatos, tamaño y permisos de archivo.' },
  read_image: { label: 'Leer imagen', desc: 'Lectura de imágenes con control de límite de bytes.' },
  tail_file: { label: 'Seguir archivo (tail)', desc: 'Lectura de las últimas líneas de archivos de log.' },
  directory_tree: { label: 'Árbol de directorios', desc: 'Visualiza la estructura jerárquica de carpetas.' },
  file_hash: { label: 'Hash de archivo', desc: 'Calcula SHA-256 de un archivo para validar integridad.' },
  write_file: { label: 'Escribir archivo', desc: 'Crea o sobrescribe un archivo (admite preview).' },
  patch_file: { label: 'Parchear archivo', desc: 'Aplica modificaciones exactas de búsqueda y reemplazo.' },
  file_copy: { label: 'Copiar archivo', desc: 'Duplica archivos dentro de rutas permitidas.' },
  file_move: { label: 'Mover archivo', desc: 'Mueve o renombra archivos dentro de rutas permitidas.' },
  file_delete: { label: 'Eliminar archivo', desc: 'Borrado permanente de archivos (Acción crítica).' },
  archive_create: { label: 'Crear archivo comprimido', desc: 'Genera archivos zip/tar de rutas permitidas.' },
  archive_extract: { label: 'Extraer archivo comprimido', desc: 'Descomprime archivos con validación Zip-Slip.' },
  run_command: { label: 'Ejecutar comando', desc: 'Ejecución estructurada argv (confinada en restringido).' },
  process_start: { label: 'Iniciar proceso', desc: 'Inicia procesos independientes en el host.' },
  job_start: { label: 'Iniciar trabajo en segundo plano', desc: 'Ejecución asíncrona con límites y propiedad.' },
  job_status: { label: 'Estado de trabajo', desc: 'Consulta el avance de un trabajo propio del cliente.' },
  job_output: { label: 'Salida de trabajo', desc: 'Lee salida incremental y paginada del trabajo.' },
  job_cancel: { label: 'Cancelar trabajo', desc: 'Detiene el trabajo y su árbol completo de procesos.' },
  system_snapshot: { label: 'Resumen del sistema', desc: 'Métricas de CPU, memoria y tiempo de actividad.' },
  hardware_info: { label: 'Información de hardware', desc: 'Detalles de procesador, memoria física y placa.' },
  disk_usage: { label: 'Uso de disco', desc: 'Espacio disponible en puntos de montaje permitidos.' },
  network_status: { label: 'Estado de red', desc: 'Interfaces de red y direcciones IP locales.' },
  gpu_status: { label: 'Estado de GPU', desc: 'Métricas y sensores de aceleradores gráficos.' },
  process_list: { label: 'Lista de procesos', desc: 'Procesos en ejecución en el sistema.' },
  process_info: { label: 'Detalle de proceso', desc: 'Métricas de CPU y memoria de un proceso específico.' },
  service_status: { label: 'Estado de servicio', desc: 'Consulta estado de unidades systemd.' },
  journal_tail: { label: 'Logs del sistema (journal)', desc: 'Consulta las últimas entradas de logs del sistema.' },
  package_status: { label: 'Consulta de paquetes', desc: 'Verifica si paquetes del sistema están instalados.' },
  firewall_status: { label: 'Estado del firewall', desc: 'Inspecciona reglas activas de ufw/iptables.' },
  mount_status: { label: 'Estado de montajes', desc: 'Puntos de montaje activos en el sistema.' },
  user_accounts: { label: 'Cuentas de usuario', desc: 'Lista de cuentas locales en el sistema.' },
  container_status: { label: 'Estado de contenedores', desc: 'Contenedores Docker locales activos.' },
  process_signal: { label: 'Señal a proceso', desc: 'Envía señales SIGTERM/SIGKILL a procesos del host.' },
  service_action: { label: 'Gestión de servicios', desc: 'Iniciar, detener o reiniciar servicios systemd.' },
  package_action: { label: 'Instalación de paquetes', desc: 'Instala o actualiza paquetes del sistema.' },
  firewall_action: { label: 'Reglas de firewall', desc: 'Modifica reglas del firewall del equipo.' },
  mount_action: { label: 'Montar/desmontar', desc: 'Modifica puntos de montaje del sistema de archivos.' },
  power_action: { label: 'Control de energía', desc: 'Reinicia o apaga el equipo físico (Crítica).' },
  git_status: { label: 'Estado de Git', desc: 'Consulta ramas y modificaciones de trabajo.' },
  git_diff: { label: 'Diferencias Git', desc: 'Visualiza cambios no confirmados en el repositorio.' },
  git_log: { label: 'Historial de Git', desc: 'Últimos commits en el repositorio.' },
  git_branches: { label: 'Ramas de Git', desc: 'Lista de ramas locales y remotas.' },
  git_action: { label: 'Acciones de Git', desc: 'Creación de ramas, commits o checkout.' },
  tmux_list: { label: 'Sesiones de tmux', desc: 'Lista sesiones activas de terminal multiplexada.' },
  tmux_capture: { label: 'Captura de tmux', desc: 'Lee el búfer de texto de un panel de tmux.' },
  tmux_send: { label: 'Enviar a tmux', desc: 'Envía texto o comandos a un panel de tmux.' },
  tmux_action: { label: 'Gestión de tmux', desc: 'Crea o destruye sesiones de tmux.' },
  desktop_view: { label: 'Captura de pantalla', desc: 'Captura la pantalla del escritorio (Sensible).' },
  camera_view: { label: 'Captura de cámara', desc: 'Toma fotografías con cámaras conectadas (Sensible).' },
  audio_record: { label: 'Grabación de audio', desc: 'Captura audio desde micrófonos (Sensible).' },
  input_keyboard: { label: 'Control de teclado', desc: 'Escribe texto o atajos en la sesión de escritorio.' },
  input_mouse: { label: 'Control de mouse', desc: 'Mueve el cursor o hace clics en la pantalla.' },
  window_list: { label: 'Ventanas abiertas', desc: 'Lista títulos y geometría de ventanas activas.' },
  window_action: { label: 'Gestión de ventanas', desc: 'Minimiza, enfoca o cierra ventanas.' },
  http_request: { label: 'Petición HTTP saliente', desc: 'Realiza solicitudes web validadas contra SSRF.' },
  port_check: { label: 'Verificar puerto', desc: 'Comprueba si un puerto TCP está en escucha.' },
  download_file: { label: 'Descarga de archivos', desc: 'Descarga archivos HTTP validando redirecciones y SSRF.' },
  container_compose: { label: 'Docker Compose', desc: 'Gestiona pilas de contenedores docker-compose.' },
  code_search_symbols: { label: 'Búsqueda de símbolos', desc: 'Localiza funciones, clases, tipos y variables sin ejecutar código.' },
  project_dependency_map: { label: 'Mapa de dependencias', desc: 'Analiza dependencias leyendo manifiestos directamente sin ejecutar código.' },
  patch_preview: { label: 'Previsualizar parche', desc: 'Calcula diff unificado y hashes sha256 antes de aplicar modificaciones.' },
  patch_apply: { label: 'Aplicar parche seguro', desc: 'Aplica modificaciones condicionadas a hash esperado con copia de respaldo automática.' },
  file_restore_safe: { label: 'Restauración segura', desc: 'Restaura copias de seguridad propias del servidor verificando conflictos.' },
  project_test_runner: { label: 'Ejecutor de pruebas', desc: 'Ejecuta suites de prueba autorizadas (npm, pytest, cargo) sin shell.' },
  service_diagnostics: { label: 'Diagnóstico de servicios', desc: 'Comprueba puertos locales y servicios del host sin escaneo externo.' },
  security_block_history: { label: 'Historial de bloqueos', desc: 'Auditoría de herramientas bloqueadas por política, denylist o falta de confirmación.' },
  job_list_mine: { label: 'Listar mis trabajos', desc: 'Lista trabajos en segundo plano del cliente con paginación y filtros.' },
  job_tail_output: { label: 'Seguimiento de trabajo', desc: 'Lee incrementalmente la salida de un trabajo propio con cursor offset.' }
};

function getToolMeta(name) {
  const meta = TOOL_DESCRIPTIONS[name] || {};
  const groups = TOOL_REQUIREMENTS[name] || [];
  const risk = (TOOL_RISK && TOOL_RISK[name]) || 'medio';
  const categoryKey = groups[0] || 'diagnostics';
  const category = (TOOL_CATEGORIES && TOOL_CATEGORIES[categoryKey]) || categoryKey;
  return {
    name,
    label: meta.label || name,
    desc: meta.desc || 'Herramienta de operación en el servidor MCP.',
    groups,
    category,
    risk
  };
}

function ask(rl, question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

function getToolStatusAndReason(policy, toolName, env, clientContext = null) {
  const allowed = policy.isAllowed(toolName, clientContext);
  const clientPolicy = clientContext?.clientId ? policy.clientPolicyStore.getClientPolicy(clientContext.clientId) : null;
  const isCrit = approvals.isApprovalRequired(toolName, {}, env, clientPolicy);
  const groups = TOOL_REQUIREMENTS[toolName] || [];

  if (!allowed) {
    let reason = `El perfil "${policy.profile}" no incluye los permisos requeridos (${groups.join(', ') || 'ninguno'})`;
    const inDenylist = policy.denylist && (typeof policy.denylist.has === 'function' ? policy.denylist.has(toolName) : Array.isArray(policy.denylist) && policy.denylist.includes(toolName));
    const hasAllowlist = policy.allowlist && (typeof policy.allowlist.has === 'function' ? policy.allowlist.size > 0 : Array.isArray(policy.allowlist) && policy.allowlist.length > 0);
    const inAllowlist = policy.allowlist && (typeof policy.allowlist.has === 'function' ? policy.allowlist.has(toolName) : Array.isArray(policy.allowlist) && policy.allowlist.includes(toolName));

    if (inDenylist) {
      reason = 'Bloqueada explícitamente en lista negra (denylist)';
    } else if (hasAllowlist && !inAllowlist) {
      reason = 'No incluida en lista de permitidas exclusivas (allowlist)';
    } else if (clientContext && clientContext.clientId) {
      reason = `Bloqueada para el cliente "${clientContext.clientId}" según política específica`;
    }
    return {
      status: 'BLOQUEADA',
      badge: `${C.red}[BLOQUEADA]${C.reset}`,
      reason
    };
  }

  if (isCrit) {
    return {
      status: 'APROBACIÓN',
      badge: `${C.yellow}[APROBACIÓN]${C.reset}`,
      reason: 'Requiere confirmación humana local antes de ejecutar (acción sensible/mutante)'
    };
  }

  return {
    status: 'PERMITIDA',
    badge: `${C.green}[PERMITIDA]${C.reset}`,
    reason: `Habilitada para ejecución directa en perfil "${policy.profile}"`
  };
}

function formatStatus(policy, toolName, env, clientContext = null) {
  return getToolStatusAndReason(policy, toolName, env, clientContext).badge;
}

function showSummary(env) {
  const policy = createAccessPolicy(env, Object.keys(TOOL_REQUIREMENTS));
  const s = policy.summary();
  const caps = detectOsIsolationCapabilities(env);

  process.stdout.write(`\n${C.bold}========================================================================${C.reset}\n`);
  process.stdout.write(` ${C.cyan}DIAGNÓSTICO Y POLÍTICA DE ACCESO DEL SERVIDOR MCP${C.reset}\n`);
  process.stdout.write(`${C.bold}========================================================================${C.reset}\n`);
  process.stdout.write(`Perfil configurado:       ${C.bold}${s.label}${C.reset} (${s.profile})\n`);
  process.stdout.write(`Versión de política:      ${policy.version || '1'}\n`);
  process.stdout.write(`Herramientas permitidas:  ${C.green}${s.allowedToolCount}${C.reset} / ${Object.keys(TOOL_REQUIREMENTS).length}\n`);
  process.stdout.write(`Herramientas bloqueadas:  ${C.red}${s.blockedToolCount}${C.reset}\n`);
  process.stdout.write(`Grupos activos:           ${s.groups.join(', ') || 'ninguno'}\n`);
  process.stdout.write(`Aislamiento de SO:        ${caps.hasOsIsolation ? `${C.green}DISPONIBLE (${caps.mechanism})${C.reset}` : `${C.yellow}NO DISPONIBLE${C.reset}`}\n`);
  process.stdout.write(`Cuenta de ejecución:      ${s.runAsRoot ? `${C.red}root (Peligro)${C.reset}` : 'usuario normal'}\n`);
  process.stdout.write(`Confirmaciones críticas:  ${s.criticalConfirmations ? `${C.green}ACTIVADAS${C.reset}` : `${C.red}DESACTIVADAS${C.reset}`}\n`);

  if (s.denylist.length) {
    process.stdout.write(`Bloqueos individuales:   ${C.red}${s.denylist.join(', ')}${C.reset}\n`);
  }
  if (s.allowlist.length) {
    process.stdout.write(`Lista exclusiva (allow):  ${C.cyan}${s.allowlist.join(', ')}${C.reset}\n`);
  }
  if (s.warnings.length) {
    process.stdout.write(`\n${C.yellow}Avisos de seguridad:${C.reset}\n`);
    for (const w of s.warnings) process.stdout.write(`  ! ${w}\n`);
  }
  process.stdout.write(`${C.bold}------------------------------------------------------------------------${C.reset}\n`);
  process.stdout.write(`Comandos útiles:\n`);
  process.stdout.write(`  ./mcpctl.sh permissions --catalog            Ver catálogo completo con categorías y riesgos\n`);
  process.stdout.write(`  ./mcpctl.sh permissions --catalog --client <id>  Ver catálogo evaluado para un cliente específico\n`);
  process.stdout.write(`  ./mcpctl.sh permissions --catalog --json      Exportar catálogo en formato JSON\n`);
  process.stdout.write(`  ./mcpctl.sh permissions --search <término>    Buscar herramientas por nombre o función\n`);
  process.stdout.write(`  ./mcpctl.sh permissions --group <grupo>       Ver herramientas de un grupo específico\n`);
  process.stdout.write(`  ./mcpctl.sh permissions --tools               Ver lista completa de herramientas\n`);
  process.stdout.write(`  ./mcpctl.sh permissions --interactive        Menú interactivo de selección\n`);
  process.stdout.write(`${C.bold}========================================================================${C.reset}\n\n`);
}

function showSearchResults(env, query) {
  const policy = createAccessPolicy(env, Object.keys(TOOL_REQUIREMENTS));
  const q = String(query || '').toLowerCase().trim();
  const allTools = Object.keys(TOOL_REQUIREMENTS);
  const matches = allTools.filter(name => {
    const meta = getToolMeta(name);
    return name.toLowerCase().includes(q) ||
      meta.label.toLowerCase().includes(q) ||
      meta.desc.toLowerCase().includes(q) ||
      meta.groups.some(g => g.toLowerCase().includes(q));
  });

  process.stdout.write(`\nResultados de búsqueda para "${C.bold}${query}${C.reset}" (${matches.length} encontradas):\n\n`);
  if (matches.length === 0) {
    process.stdout.write('  No se encontraron herramientas que coincidan con el término.\n\n');
    return;
  }

  for (const name of matches) {
    const meta = getToolMeta(name);
    const st = formatStatus(policy, name, env);
    process.stdout.write(`  ${st} ${C.bold}${meta.label}${C.reset} (${C.cyan}${name}${C.reset})\n`);
    process.stdout.write(`     Descripción: ${meta.desc}\n`);
    process.stdout.write(`     Grupos:      ${meta.groups.join(', ') || 'ninguno (siempre segura)'}\n\n`);
  }
}

function showGroupTools(env, groupName) {
  const policy = createAccessPolicy(env, Object.keys(TOOL_REQUIREMENTS));
  const grp = String(groupName || '').toLowerCase().trim();
  const allTools = Object.keys(TOOL_REQUIREMENTS);
  const matches = allTools.filter(name => {
    const groups = TOOL_REQUIREMENTS[name] || [];
    return groups.includes(grp);
  });

  process.stdout.write(`\nHerramientas en el grupo "${C.bold}${grp}${C.reset}" (${matches.length} herramientas):\n\n`);
  for (const name of matches) {
    const meta = getToolMeta(name);
    const st = formatStatus(policy, name, env);
    process.stdout.write(`  ${st} ${C.bold}${meta.label}${C.reset} (${C.cyan}${name}${C.reset}): ${meta.desc}\n`);
  }
  process.stdout.write('\n');
}

function saveDotEnvSettings(env) {
  const envPath = path.resolve('.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const varsToSet = {
    MCP_ACCESS_PROFILE: env.MCP_ACCESS_PROFILE,
    MCP_TOOL_DENYLIST: env.MCP_TOOL_DENYLIST || '',
    MCP_TOOL_APPROVALS: env.MCP_TOOL_APPROVALS || ''
  };

  for (const [key, val] of Object.entries(varsToSet)) {
    if (val === undefined) continue;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content = (content.endsWith('\n') || !content ? content : content + '\n') + `${key}=${val}\n`;
    }
  }

  const tmpPath = `${envPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, envPath);
  applyPrivateOwnership(envPath, 0o600);
}

function showCatalogOutput(env, options = {}) {
  const { clientId = null, asJson = false, search = '' } = options;
  const clientContext = clientId ? { clientId } : null;
  const policy = createAccessPolicy(env, Object.keys(TOOL_REQUIREMENTS));
  const allTools = Object.keys(TOOL_REQUIREMENTS).sort();

  const filtered = search
    ? allTools.filter(name => {
        const meta = getToolMeta(name);
        const q = search.toLowerCase();
        return name.toLowerCase().includes(q) ||
          meta.label.toLowerCase().includes(q) ||
          meta.desc.toLowerCase().includes(q) ||
          meta.category.toLowerCase().includes(q) ||
          meta.groups.some(g => g.toLowerCase().includes(q));
      })
    : allTools;

  const catalog = filtered.map(name => {
    const meta = getToolMeta(name);
    const info = getToolStatusAndReason(policy, name, env, clientContext);
    return {
      name,
      readableName: meta.label,
      description: meta.desc,
      category: meta.category,
      risk: meta.risk,
      requiredPermissions: meta.groups,
      status: info.status,
      badge: info.badge,
      reason: info.reason
    };
  });

  if (asJson) {
    process.stdout.write(JSON.stringify({
      catalogVersion: require('./package.json').version,
      profile: policy.profile,
      clientId: clientId || null,
      totalTools: allTools.length,
      displayedTools: catalog.length,
      tools: catalog.map(t => ({
        name: t.name,
        readableName: t.readableName,
        description: t.description,
        category: t.category,
        risk: t.risk,
        requiredPermissions: t.requiredPermissions,
        status: t.status,
        reason: t.reason
      }))
    }, null, 2) + '\n');
    return;
  }

  process.stdout.write(`\n${C.bold}========================================================================================================${C.reset}\n`);
  process.stdout.write(` ${C.cyan}CATÁLOGO GENERAL DE HERRAMIENTAS Y POLÍTICA DE ACCESO MCP${C.reset}`);
  if (clientId) {
    process.stdout.write(` (Cliente: ${C.bold}${clientId}${C.reset})`);
  }
  process.stdout.write(`\n Perfil activo: ${C.bold}${policy.label || policy.profile}${C.reset} | Total: ${allTools.length} capacidades\n`);
  process.stdout.write(`${C.bold}========================================================================================================${C.reset}\n\n`);

  let currentCategory = '';
  for (const item of catalog) {
    if (item.category !== currentCategory) {
      currentCategory = item.category;
      process.stdout.write(`\n${C.bold}--- [ ${currentCategory.toUpperCase()} ] ---${C.reset}\n`);
    }

    const riskColor = item.risk === 'critico' ? C.red : item.risk === 'medio' ? C.yellow : C.green;
    const riskBadge = `${riskColor}[Riesgo: ${item.risk.toUpperCase()}]${C.reset}`;

    process.stdout.write(`  ${item.badge} ${C.bold}${item.readableName}${C.reset} (${C.cyan}${item.name}${C.reset}) ${riskBadge}\n`);
    process.stdout.write(`     ${C.dim}Descripción:${C.reset} ${item.description}\n`);
    process.stdout.write(`     ${C.dim}Permisos:${C.reset}    ${item.requiredPermissions.join(', ') || 'ninguno (acceso general)'}\n`);
    process.stdout.write(`     ${C.dim}Motivo:${C.reset}      ${item.reason}\n\n`);
  }
  process.stdout.write(`${C.bold}========================================================================================================${C.reset}\n\n`);
}

async function configureClient(env, clientId, args, interactive) {
  if (!clientId || clientId.startsWith('--') || clientId.length > 2048 || ['__proto__', 'constructor', 'prototype'].includes(clientId)) throw new Error('Identificador de cliente invalido.');
  const policy = createAccessPolicy(env, Object.keys(TOOL_REQUIREMENTS));
  const store = policy.clientPolicyStore;
  const update = (action, value) => {
    if (action === '--profile') {
      if (!Object.hasOwn(PROFILE_LABELS, value) || value === 'custom') throw new Error('Perfil base invalido. Use un perfil predefinido y ajustes individuales.');
    } else if (!Object.hasOwn(TOOL_REQUIREMENTS, value)) throw new Error('Herramienta desconocida.');
    store._mutate(state => {
      const current = state.clients[clientId] || {};
      const denied = new Set(current.deniedTools || []), approvals = new Set(current.approvalTools || []);
      if (action === '--deny-tool') denied.add(value);
      if (action === '--allow-tool') { denied.delete(value); approvals.delete(value); }
      if (action === '--require-approval') { denied.delete(value); approvals.add(value); }
      const next = { ...current, deniedTools: [...denied], approvalTools: [...approvals], updatedAt: Date.now() };
      if (action === '--profile') next.profile = value;
      if ((action === '--allow-tool' || action === '--require-approval') && Array.isArray(next.allowedTools) && next.allowedTools.length && !next.allowedTools.includes(value)) next.allowedTools = [...next.allowedTools, value];
      state.clients[clientId] = next;
      store._setConfiguredExpected(true);
    });
    process.stdout.write('Politica del cliente guardada. El perfil global sigue limitando los permisos efectivos.\n');
  };
  if (!interactive) {
    const actions = ['--allow-tool', '--deny-tool', '--require-approval', '--profile'].filter(a => args.includes(a));
    if (actions.length !== 1) throw new Error('Indique exactamente una accion por comando.');
    update(actions[0], args[args.indexOf(actions[0]) + 1]);
    return;
  }
  if (!process.stdin.isTTY) throw new Error('El menu por cliente requiere una terminal interactiva.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      showCatalogOutput(env, { clientId });
      const action = await ask(rl, '1. Permitir  2. Bloquear  3. Pedir aprobacion  4. Perfil  0. Salir: ');
      if (action === '0') break;
      const flag = { '1': '--allow-tool', '2': '--deny-tool', '3': '--require-approval', '4': '--profile' }[action];
      if (!flag) continue;
      const value = await ask(rl, flag === '--profile' ? 'Perfil base: ' : 'Nombre tecnico de herramienta (visible en catalogo): ');
      try { update(flag, value.trim()); } catch (error) { process.stdout.write(error.message + '\n'); }
    }
  } finally { rl.close(); }
}

async function runInteractiveMenu(env) {
  if (!process.stdin.isTTY) {
    showSummary(env);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      process.stdout.write(`\n${C.bold}=== MENÚ DE CONTROL DE POLÍTICAS MCP ===${C.reset}\n`);
      process.stdout.write('  1) Ver diagnóstico y estado actual\n');
      process.stdout.write('  2) Buscar herramientas por nombre o función\n');
      process.stdout.write('  3) Explorar herramientas por grupo de seguridad\n');
      process.stdout.write('  4) Ver todas las herramientas organizadas por modo (Permitida/Aprobación/Bloqueada)\n');
      process.stdout.write('  5) Cambiar perfil base (Observación, Restringido, Desarrollo, etc.)\n');
      process.stdout.write('  6) Configurar modo de herramienta individual (Permitida / Aprobación / Bloqueada)\n');
      process.stdout.write('  7) Guardar cambios de política en el archivo .env\n');
      process.stdout.write('  8) Ver catálogo completo con categorías, riesgos y motivos\n');
      process.stdout.write('  0) Salir\n\n');

      const ans = await ask(rl, 'Seleccioná una opción [0-8]: ');
      if (ans === '0' || ans.toLowerCase() === 'q' || ans.toLowerCase() === 'salir') {
        break;
      } else if (ans === '1') {
        showSummary(env);
      } else if (ans === '2') {
        const q = await ask(rl, 'Ingresá el término a buscar: ');
        if (q) showSearchResults(env, q);
      } else if (ans === '3') {
        process.stdout.write('\nGrupos de seguridad disponibles:\n');
        for (const [g, desc] of Object.entries(GROUPS)) {
          process.stdout.write(`  - ${C.cyan}${g.padEnd(20)}${C.reset} ${desc}\n`);
        }
        const gName = await ask(rl, '\nIngresá el nombre del grupo a inspeccionar: ');
        if (gName) showGroupTools(env, gName);
      } else if (ans === '4') {
        const policy = createAccessPolicy(env, Object.keys(TOOL_REQUIREMENTS));
        const allTools = Object.keys(TOOL_REQUIREMENTS).sort();
        const allowed = [];
        const approval = [];
        const blocked = [];

        for (const name of allTools) {
          const meta = getToolMeta(name);
          if (!policy.isAllowed(name)) {
            blocked.push({ name, meta });
          } else if (approvals.isCriticalTool(name, {}, env)) {
            approval.push({ name, meta });
          } else {
            allowed.push({ name, meta });
          }
        }

        process.stdout.write(`\n${C.green}HERRAMIENTAS CON EJECUCIÓN DIRECTA (${allowed.length}):${C.reset}\n`);
        for (const { name, meta } of allowed) {
          process.stdout.write(`  ${C.green}[PERMITIDA]${C.reset}  ${C.bold}${meta.label}${C.reset} (${C.cyan}${name}${C.reset})\n`);
        }

        process.stdout.write(`\n${C.yellow}HERRAMIENTAS QUE REQUIEREN APROBACIÓN PREVIA (${approval.length}):${C.reset}\n`);
        for (const { name, meta } of approval) {
          process.stdout.write(`  ${C.yellow}[APROBACIÓN]${C.reset} ${C.bold}${meta.label}${C.reset} (${C.cyan}${name}${C.reset})\n`);
        }

        process.stdout.write(`\n${C.red}HERRAMIENTAS BLOQUEADAS (${blocked.length}):${C.reset}\n`);
        for (const { name, meta } of blocked) {
          process.stdout.write(`  ${C.red}[BLOQUEADA]${C.reset}  ${C.bold}${meta.label}${C.reset} (${C.cyan}${name}${C.reset})\n`);
        }
        process.stdout.write('\n');
      } else if (ans === '5') {
        process.stdout.write('\nPerfiles disponibles:\n');
        process.stdout.write('  1) observacion         - Sólo lectura, sin red ni capturas sensibles\n');
        process.stdout.write('  2) trabajo_restringido - Aislado con bwrap/SO, rutas estrictas\n');
        process.stdout.write('  3) developer           - Desarrollo local recomendado\n');
        process.stdout.write('  4) administrator       - Administración completa\n');
        process.stdout.write('  5) full                - Control total con confirmaciones\n');
        const pChoice = await ask(rl, 'Elegí un perfil [1-5]: ');
        const map = {
          '1': 'observacion',
          '2': 'trabajo_restringido',
          '3': 'developer',
          '4': 'administrator',
          '5': 'full'
        };
        const selected = map[pChoice];
        if (selected) {
          env.MCP_ACCESS_PROFILE = selected;
          process.stdout.write(`\n[OK] Perfil temporal cambiado a: ${selected}\n`);
          process.stdout.write('Para persistirlo en .env, seleccioná la opción 7 del menú.\n');
        }
      } else if (ans === '6') {
        const tName = await ask(rl, 'Nombre de la herramienta (ej. file_delete, run_command, process_start): ');
        if (tName && TOOL_REQUIREMENTS[tName]) {
          const meta = getToolMeta(tName);
          const policy = createAccessPolicy(env, Object.keys(TOOL_REQUIREMENTS));
          const currentStatus = formatStatus(policy, tName, env);
          process.stdout.write(`\nHerramienta: ${C.bold}${meta.label}${C.reset} (${C.cyan}${tName}${C.reset})\n`);
          process.stdout.write(`Descripción: ${meta.desc}\n`);
          process.stdout.write(`Estado actual: ${currentStatus}\n\n`);
          process.stdout.write('Seleccioná el nuevo modo:\n');
          process.stdout.write('  1) Permitida (ejecución directa)\n');
          process.stdout.write('  2) Requiere Aprobación (confirmación humana obligatoria antes de ejecutar)\n');
          process.stdout.write('  3) Bloqueada (denegada por completo)\n');
          process.stdout.write('  0) Cancelar\n');
          const mChoice = await ask(rl, 'Modo [0-3]: ');

          const currentDeny = (env.MCP_TOOL_DENYLIST || '').split(',').map(s => s.trim()).filter(Boolean);
          const currentAppr = (env.MCP_TOOL_APPROVALS || '').split(',').map(s => s.trim()).filter(Boolean);

          if (mChoice === '1') {
            env.MCP_TOOL_DENYLIST = currentDeny.filter(x => x !== tName).join(',');
            env.MCP_TOOL_APPROVALS = currentAppr.filter(x => x !== tName).join(',');
            process.stdout.write(`[OK] ${tName} configurada como PERMITIDA (ejecución directa).\n`);
          } else if (mChoice === '2') {
            env.MCP_TOOL_DENYLIST = currentDeny.filter(x => x !== tName).join(',');
            if (!currentAppr.includes(tName)) currentAppr.push(tName);
            env.MCP_TOOL_APPROVALS = currentAppr.join(',');
            process.stdout.write(`[OK] ${tName} configurada en modo APROBACIÓN (exige mcpctl approve).\n`);
          } else if (mChoice === '3') {
            env.MCP_TOOL_APPROVALS = currentAppr.filter(x => x !== tName).join(',');
            if (!currentDeny.includes(tName)) currentDeny.push(tName);
            env.MCP_TOOL_DENYLIST = currentDeny.join(',');
            process.stdout.write(`[OK] ${tName} configurada como BLOQUEADA.\n`);
          }
        } else {
          process.stdout.write('[AVISO] Herramienta no encontrada en el catálogo.\n');
        }
      } else if (ans === '7') {
        saveDotEnvSettings(env);
        process.stdout.write('\n[OK] Configuración persistida exitosamente en .env.\n');
      } else if (ans === '8') {
        showCatalogOutput(env, {});
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const fileEnv = parseDotEnv();
  const filePriority = String(process.env.MCP_CONFIG_SOURCE || '').toLowerCase() === 'file';
  const env = filePriority ? { ...process.env, ...fileEnv } : { ...fileEnv, ...process.env };

  const args = process.argv.slice(2);
  const searchIdx = args.indexOf('--search');
  const groupIdx = args.indexOf('--group');
  const clientIdx = args.indexOf('--client');
  const isInteractive = args.includes('--interactive') || args.includes('--menu');
  const showTools = args.includes('--tools') || args.includes('--all');
  const showCatalog = args.includes('--catalog');
  const asJson = args.includes('--json');
  const clientId = (clientIdx !== -1 && args[clientIdx + 1]) ? args[clientIdx + 1] : null;
  const searchVal = (searchIdx !== -1 && args[searchIdx + 1]) ? args[searchIdx + 1] : '';

  if (clientId && (isInteractive || args.includes('--allow-tool') || args.includes('--deny-tool') || args.includes('--require-approval') || args.includes('--profile'))) {
    await configureClient(env, clientId, args, isInteractive);
    return;
  }

  if (isInteractive) {
    await runInteractiveMenu(env);
    return;
  }

  if (showCatalog || asJson) {
    showCatalogOutput(env, { clientId, asJson, search: searchVal });
    return;
  }

  if (searchIdx !== -1 && searchVal) {
    showSearchResults(env, searchVal);
    return;
  }

  if (groupIdx !== -1 && args[groupIdx + 1]) {
    showGroupTools(env, args[groupIdx + 1]);
    return;
  }

  showSummary(env);

  if (showTools) {
    showCatalogOutput(env, { clientId, asJson: false });
  }
}

process.stdout.on('error', err => { if (err.code === 'EPIPE') process.exit(0); });

main().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});

