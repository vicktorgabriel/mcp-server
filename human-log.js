#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function resolveHumanLogPath() {
  const configured = String(process.env.MCP_HUMAN_LOG || path.join('.runtime', 'events.log'));
  return path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured);
}

function redactText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/(ngrok\s+config\s+add-authtoken\s+)\S+/gi, '$1[OCULTO]')
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1[OCULTO]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[OCULTO]@')
    .replace(/((?:^|\s)--?(?:authtoken|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|password|passwd|secret|api[_-]?key|authorization|auth)\s+)\S+/gi, '$1[OCULTO]')
    .replace(/(^|\s)-p[^\s;]+/gi, '$1-p[OCULTO]')
    .replace(/((?:authtoken|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|password|passwd|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}&;]+/gi, '$1[OCULTO]')
    .replace(/([?&](?:code|token|access_token|refresh_token|client_secret)=)[^&\s]+/gi, '$1[OCULTO]');
}

function compact(value, max = 220) {
  const normalized = redactText(value).replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch (_) {}
}

function logLimitBytes(value = process.env.MCP_HUMAN_LOG_MAX_BYTES || process.env.MCP_RUNTIME_LOG_MAX_BYTES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 10 * 1024 * 1024;
  return Math.max(64 * 1024, Math.min(1024 * 1024 * 1024, Math.trunc(parsed)));
}

function rotateLog(filePath, maxBytes = logLimitBytes()) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size < maxBytes) return false;
    const previous = `${filePath}.1`;
    try { fs.unlinkSync(previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(filePath, previous);
    try { fs.chmodSync(previous, 0o600); } catch (_) {}
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return false;
  }
}

function appendPrivateLine(filePath, line, options = {}) {
  ensureParent(filePath);
  rotateLog(filePath, logLimitBytes(options.maxBytes));
  fs.appendFileSync(filePath, `${String(line).replace(/\r?\n$/, '')}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function humanEvent(category, message, options = {}) {
  const ts = new Date().toISOString();
  const label = compact(category || 'INFO', 28).toUpperCase();
  const text = compact(message || '', Number(options.maxLength || 1200));
  const line = `${ts} | ${label.padEnd(10)} | ${text}`;
  const logPath = options.logPath || resolveHumanLogPath();

  try {
    appendPrivateLine(logPath, line, { maxBytes: options.maxBytes });
  } catch (_) {
    // Logging must never interrupt an MCP operation.
  }

  if (options.console !== false) {
    process.stderr.write(`${line}\n`);
  }
  return line;
}

function safePath(value, fallback = '.') {
  const raw = String(value || fallback);
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      parsed.username = '';
      parsed.password = '';
      for (const key of [...parsed.searchParams.keys()]) {
        if (/token|code|secret|password|passwd|auth|api[_-]?key/i.test(key)) parsed.searchParams.set(key, '[OCULTO]');
      }
      return compact(parsed.toString(), 260);
    } catch (_) {}
  }
  return compact(raw, 260);
}

function friendlyError(error) {
  const raw = redactText(error && (error.message || error) || 'error desconocido');
  const rules = [
    [/ENOENT|no such file or directory|not found/i, 'No se encontró el archivo, programa o recurso solicitado.'],
    [/EACCES|EPERM|permission denied|operation not permitted/i, 'El usuario del MCP no tiene permisos suficientes para completar la operación.'],
    [/timed? ?out|timeout/i, 'La operación superó el tiempo permitido y fue detenida.'],
    [/search text not found|texto.*no.*encontr/i, 'No se encontró el texto de referencia necesario para aplicar el cambio.'],
    [/connection refused|ECONNREFUSED/i, 'El servicio de destino rechazó la conexión.'],
    [/ENOSPC|no space left/i, 'No queda espacio suficiente en el dispositivo.'],
    [/already exists|EEXIST/i, 'El recurso que se intentó crear ya existe.']
  ];
  for (const [pattern, message] of rules) if (pattern.test(raw)) return message;
  return compact(raw, 360);
}

function safeCommand(args = {}) {
  const command = compact(args.command || 'comando', 100);
  const rawArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const safeArgs = [];
  let hideNext = false;

  for (const raw of rawArgs.slice(0, 18)) {
    if (hideNext) {
      safeArgs.push('[OCULTO]');
      hideNext = false;
      continue;
    }
    if (/^(?:-p|--?(?:token|authtoken|password|passwd|secret|api[-_]?key|client[-_]?secret|authorization|auth))$/i.test(raw)) {
      safeArgs.push(raw);
      hideNext = true;
      continue;
    }
    if (/^-p.+/i.test(raw)) {
      safeArgs.push('-p[OCULTO]');
      continue;
    }
    if (/^--?(?:token|authtoken|password|passwd|secret|api[-_]?key|client[-_]?secret|authorization|auth)=.+$/i.test(raw)) {
      safeArgs.push(`${raw.slice(0, raw.indexOf('='))}=[OCULTO]`);
      continue;
    }
    safeArgs.push(redactText(raw));
  }

  const suffix = rawArgs.length > safeArgs.length ? ` … (+${rawArgs.length - safeArgs.length} argumentos)` : '';
  return compact([command, ...safeArgs].join(' '), 320) + suffix;
}

function commandPurpose(args = {}) {
  const commandPath = String(args.command || 'comando');
  const command = path.basename(commandPath).toLowerCase();
  const rawArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const joined = rawArgs.join(' ').toLowerCase();

  if (['apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk'].includes(command)) {
    if (/\b(install|add)\b/.test(joined)) return 'Instalando o actualizando paquetes del sistema';
    if (/\b(remove|purge|erase|autoremove)\b/.test(joined)) return 'Retirando paquetes del sistema';
    if (/\b(update|upgrade|dist-upgrade|full-upgrade)\b/.test(joined)) return 'Actualizando el sistema operativo';
    return 'Consultando el gestor de paquetes del sistema';
  }
  if (command === 'systemctl' || /\bsystemctl\b/.test(joined)) return 'Administrando servicios del sistema';
  if (command === 'journalctl') return 'Revisando eventos de servicios del sistema';
  if (command === 'git') return 'Realizando una operación sobre un repositorio Git';
  if (['npm', 'pnpm', 'yarn', 'corepack'].includes(command)) return 'Preparando o ejecutando herramientas del proyecto Node.js';
  if (['python', 'python3', 'uv', 'poetry', 'pip', 'pip3', 'pipx'].includes(command)) return 'Preparando o ejecutando una tarea de Python';
  if (['docker', 'docker-compose', 'podman'].includes(command)) return 'Administrando contenedores del proyecto';
  if (['curl', 'wget'].includes(command)) return 'Comprobando o descargando un recurso de red';
  if (['bash', 'sh', 'zsh', 'fish'].includes(command)) {
    if (/\b(apt|apt-get|dnf|yum|pacman|zypper|apk)\b.*\b(install|upgrade|update|remove|purge)\b/.test(joined)) {
      return 'Ejecutando una tarea de mantenimiento de paquetes del sistema';
    }
    if (/\bsystemctl\b/.test(joined)) return 'Ejecutando una tarea de administración de servicios';
    if (/\bgit\b/.test(joined)) return 'Ejecutando una tarea de revisión o actualización de repositorio';
    if (/\b(curl|wget)\b/.test(joined)) return 'Ejecutando una comprobación de conectividad o descarga';
    return 'Ejecutando una secuencia de administración en la terminal';
  }
  return `Ejecutando una tarea mediante ${compact(command || 'el sistema', 80)}`;
}

function gitPurpose(args = {}) {
  const operation = String(Array.isArray(args.args) ? args.args[0] || '' : '').toLowerCase();
  const descriptions = {
    status: 'Revisando el estado del repositorio Git',
    diff: 'Comparando cambios del repositorio Git',
    log: 'Consultando el historial del repositorio Git',
    fetch: 'Consultando actualizaciones remotas del repositorio Git',
    pull: 'Descargando e integrando actualizaciones del repositorio Git',
    push: 'Publicando cambios del repositorio Git',
    add: 'Preparando cambios para un commit Git',
    commit: 'Registrando un commit en el repositorio Git',
    checkout: 'Cambiando la rama o revisión activa del repositorio Git',
    switch: 'Cambiando la rama activa del repositorio Git',
    merge: 'Integrando ramas del repositorio Git',
    rebase: 'Reorganizando commits del repositorio Git',
    branch: 'Administrando ramas del repositorio Git',
    worktree: 'Administrando árboles de trabajo Git'
  };
  return descriptions[operation] || 'Realizando una operación sobre el repositorio Git';
}

function describeToolStart(tool, args = {}) {
  const pathValue = args.path || args.id || args.file || '.';
  const repo = args.repo || args.cwd || '.';
  const target = args.target || args.session || '';

  switch (tool) {
    case 'search':
      return `Buscando contenido dentro de ${safePath(args.path)}.`;
    case 'fetch':
    case 'read_file':
      return `Leyendo el archivo ${safePath(pathValue)}.`;
    case 'list_files':
      return `Listando el contenido de ${safePath(pathValue)}.`;
    case 'write_file':
      return `${args.mode === 'append' ? 'Agregando contenido a' : 'Escribiendo'} ${safePath(pathValue)} (${Buffer.byteLength(String(args.content || ''), 'utf8')} bytes solicitados).`;
    case 'patch_file':
      return `Aplicando ${Array.isArray(args.patches) ? args.patches.length : 0} cambio(s) controlado(s) en ${safePath(pathValue)}.`;
    case 'run_command':
      return `${commandPurpose(args)} en ${safePath(args.cwd)}.`;
    case 'file_info':
      return `Consultando información de ${safePath(pathValue)}.`;
    case 'read_image':
      return `Abriendo la imagen ${safePath(pathValue)} para inspección visual.`;
    case 'tail_file':
      return `Leyendo las últimas líneas de ${safePath(pathValue)}.`;
    case 'tool_policy_status':
      return 'Consultando el perfil de acceso y las herramientas habilitadas.';
    case 'directory_tree':
      return `Recorriendo la estructura de carpetas de ${safePath(args.path)}.`;
    case 'file_hash':
      return `Calculando la huella ${compact(args.algorithm || 'sha256', 30)} de ${safePath(args.path)}.`;
    case 'file_copy':
      return `Copiando ${safePath(args.source)} hacia ${safePath(args.destination)}.`;
    case 'file_move':
      return `Moviendo ${safePath(args.source)} hacia ${safePath(args.destination)}.`;
    case 'file_delete':
      return `Eliminando ${safePath(args.path)} después de una confirmación explícita.`;
    case 'archive_create':
      return `Creando un archivo comprimido de ${safePath(args.source)} en ${safePath(args.destination)}.`;
    case 'archive_extract':
      return `Extrayendo de forma segura ${safePath(args.archive)} en ${safePath(args.destination)}.`;
    case 'http_request':
      return `Consultando por HTTP ${safePath(args.url)}.`;
    case 'port_check':
      return `Comprobando la conexión TCP con ${compact(args.host, 120)}:${compact(args.port, 20)}.`;
    case 'download_file':
      return `Descargando un recurso hacia ${safePath(args.destination)}.`;
    case 'package_status':
      return 'Consultando el gestor de paquetes y el estado de los paquetes solicitados.';
    case 'package_action':
      return `${args.dryRun ? 'Simulando' : 'Aplicando'} una operación de paquetes: ${compact(args.action, 40)}.`;
    case 'firewall_status':
      return 'Consultando el estado y las reglas del firewall.';
    case 'firewall_action':
      return `${args.dryRun ? 'Simulando' : 'Aplicando'} un cambio de firewall: ${compact(args.action, 40)}.`;
    case 'mount_status':
      return 'Consultando unidades y puntos de montaje.';
    case 'mount_action':
      return `${args.dryRun ? 'Simulando' : 'Aplicando'} una operación de montaje: ${compact(args.action, 40)}.`;
    case 'user_accounts':
      return 'Consultando cuentas locales y grupos administrativos.';
    case 'container_status':
      return 'Consultando motores y contenedores disponibles.';
    case 'container_compose':
      return `${args.dryRun ? 'Simulando' : 'Ejecutando'} la acción Compose ${compact(args.action, 40)} en ${safePath(args.project)}.`;
    case 'power_action':
      return `${args.dryRun ? 'Simulando' : 'Programando'} ${args.action === 'reboot' ? 'el reinicio' : 'el apagado'} del equipo.`;
    case 'system_snapshot':
      return 'Recopilando un resumen del estado general del equipo.';
    case 'hardware_info':
      return 'Consultando CPU, memoria y hardware disponible.';
    case 'disk_usage':
      return `Revisando espacio y uso de disco${args.path ? ` en ${safePath(args.path)}` : ''}.`;
    case 'network_status':
      return 'Consultando interfaces, rutas y conexiones de red.';
    case 'gpu_status':
      return 'Consultando el estado de la GPU.';
    case 'process_list':
      return `Listando procesos${args.filter ? ` que coinciden con “${compact(args.filter, 100)}”` : ''}.`;
    case 'process_info':
      return `Consultando detalles del proceso ${compact(args.pid, 40)}.`;
    case 'process_signal':
      return `Enviando la señal ${compact(args.signal || 'TERM', 30)} al proceso ${compact(args.pid, 40)}.`;
    case 'process_start':
      return `${commandPurpose(args)}${args.cwd ? ` en ${safePath(args.cwd)}` : ''}.`;
    case 'service_status':
      return `Consultando el estado del servicio ${compact(args.service, 120)}.`;
    case 'service_action':
      return `Solicitando “${compact(args.action, 60)}” para el servicio ${compact(args.service, 120)}.`;
    case 'journal_tail':
      return `Revisando eventos recientes del servicio ${compact(args.service || 'sistema', 120)}.`;
    case 'git_status':
      return `Revisando el estado Git de ${safePath(repo)}.`;
    case 'git_diff':
      return `Comparando cambios Git en ${safePath(repo)}.`;
    case 'git_log':
      return `Consultando el historial Git de ${safePath(repo)}.`;
    case 'git_branches':
      return `Listando ramas Git de ${safePath(repo)}.`;
    case 'git_worktrees':
      return `Listando árboles de trabajo Git de ${safePath(repo)}.`;
    case 'git_command':
      return `${gitPurpose(args)} en ${safePath(repo)}.`;
    case 'tmux_list':
      return 'Listando sesiones de trabajo tmux.';
    case 'tmux_panes':
      return `Consultando paneles tmux${target ? ` de ${compact(target, 100)}` : ''}.`;
    case 'tmux_create':
      return `Creando la sesión tmux ${compact(args.session, 100)}${args.cwd ? ` en ${safePath(args.cwd)}` : ''}.`;
    case 'tmux_capture':
      return `Leyendo la actividad visible de la sesión tmux ${compact(target, 100)}.`;
    case 'tmux_send':
      return `Enviando instrucciones a la sesión tmux ${compact(target, 100)}.`;
    case 'tmux_interrupt':
      return `Interrumpiendo la tarea activa en tmux ${compact(target, 100)}.`;
    case 'tmux_kill':
      return `Cerrando la sesión tmux ${compact(target, 100)}.`;
    case 'desktop_info':
      return 'Consultando el entorno gráfico y sus capacidades.';
    case 'screen_capture':
      return `Tomando una captura ${args.mode === 'window' ? 'de ventana' : 'de pantalla'}.`;
    case 'list_windows':
      return 'Listando ventanas abiertas en el escritorio.';
    case 'window_action':
      return `Aplicando “${compact(args.action, 60)}” a una ventana del escritorio.`;
    case 'mouse_move':
      return `Moviendo el puntero a la posición ${compact(args.x, 20)}, ${compact(args.y, 20)}.`;
    case 'mouse_click':
      return `Realizando un clic de mouse (${compact(args.button || 'izquierdo', 40)}).`;
    case 'mouse_scroll':
      return 'Desplazando la vista con la rueda del mouse.';
    case 'keyboard_hotkey':
      return `Ejecutando el atajo de teclado ${compact((args.keys || []).join('+'), 120)}.`;
    case 'keyboard_type':
      return `Escribiendo texto en la ventana activa (${String(args.text || '').length} caracteres; contenido oculto del log).`;
    case 'desktop_open':
      return `Abriendo ${safePath(args.target || args.path || args.url)} en el escritorio.`;
    case 'camera_list':
      return 'Consultando cámaras disponibles.';
    case 'camera_snapshot':
      return `Tomando una fotografía desde ${compact(args.device || 'la cámara seleccionada', 120)}.`;
    case 'audio_devices':
      return 'Consultando dispositivos de entrada y salida de audio.';
    case 'control_capabilities':
      return 'Comprobando qué capacidades de control están disponibles.';
    case 'mcp_runtime_status':
      return 'Comprobando el estado del propio servidor MCP y su conexión pública.';
    case 'mcp_runtime_logs':
      return 'Preparando un resumen legible de la actividad reciente del MCP.';
    default:
      return `Ejecutando la herramienta ${compact(tool || 'desconocida', 120)}.`;
  }
}

function payloadFromResult(result) {
  if (!result || typeof result !== 'object') return null;
  return result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : result;
}

function describeToolSuccess(tool, result, durationMs) {
  const payload = payloadFromResult(result) || {};
  let detail = 'Operación completada correctamente.';

  switch (tool) {
    case 'search':
      detail = `Búsqueda completada: ${Array.isArray(payload.results) ? payload.results.length : 0} coincidencia(s).`;
      break;
    case 'list_files':
      detail = `Listado completado: ${Array.isArray(payload.files) ? payload.files.length : 0} elemento(s).`;
      break;
    case 'fetch':
    case 'read_file':
      detail = `Lectura completada: ${Number(payload.size || 0)} bytes.`;
      break;
    case 'write_file':
      detail = `Archivo actualizado: ${Number(payload.bytes_written || 0)} bytes escritos.`;
      break;
    case 'patch_file':
      detail = `Cambios aplicados: ${Number(payload.patches_applied || 0)} parche(s).`;
      break;
    case 'run_command':
    case 'process_start':
      detail = `Comando finalizado con código ${payload.exit_code ?? payload.exitCode ?? 'desconocido'}${payload.timed_out || payload.timedOut ? ' después de alcanzar el tiempo límite' : ''}.`;
      break;
    case 'screen_capture':
    case 'camera_snapshot':
      detail = 'Imagen obtenida correctamente.';
      break;
    case 'service_action':
      detail = `Acción de servicio completada${payload.active !== undefined ? `; activo=${payload.active}` : ''}.`;
      break;
    case 'git_status':
    case 'git_diff':
    case 'git_log':
    case 'git_command':
      detail = `Operación Git finalizada con código ${payload.exit_code ?? payload.exitCode ?? 0}.`;
      break;
    case 'directory_tree':
      detail = `Estructura leída: ${Number(payload.count || 0)} elemento(s)${payload.truncated ? '; resultado limitado' : ''}.`;
      break;
    case 'file_hash':
      detail = `Huella ${payload.algorithm || ''} calculada correctamente.`;
      break;
    case 'file_copy':
    case 'file_move':
    case 'file_delete':
    case 'archive_create':
    case 'archive_extract':
    case 'download_file':
      detail = 'Operación de archivo completada correctamente.';
      break;
    case 'http_request':
      detail = `Solicitud HTTP finalizada con estado ${payload.status ?? 'desconocido'}.`;
      break;
    case 'port_check':
      detail = `Puerto ${payload.open ? 'accesible' : 'no accesible'}.`;
      break;
    case 'package_status':
      detail = payload.available === false
        ? 'No se encontró un gestor de paquetes compatible.'
        : `Gestor de paquetes detectado: ${payload.manager || 'desconocido'}.`;
      break;
    case 'firewall_status':
      detail = payload.available === false
        ? 'No se encontró un firewall compatible.'
        : payload.readable === false
          ? `Se detectó ${payload.backend || 'el firewall'}, pero el usuario del MCP no puede leer su estado sin privilegios administrativos.`
          : `Estado del firewall ${payload.backend || ''} consultado correctamente.`;
      break;
    case 'mount_status':
      detail = 'Unidades y montajes consultados correctamente.';
      break;
    case 'user_accounts':
      detail = `Cuentas consultadas: ${Array.isArray(payload.users) ? payload.users.length : 0}.`;
      break;
    case 'container_status':
      detail = Array.isArray(payload.runtimes) && payload.runtimes.length
        ? `Motores de contenedores detectados: ${payload.runtimes.map((item) => item.runtime).join(', ')}.`
        : 'No se encontró Docker ni Podman disponible para este usuario.';
      break;
    case 'tool_policy_status':
      detail = `Perfil ${payload.profile || 'desconocido'}: ${Number(payload.allowedToolCount || 0)} herramienta(s) visibles y ${Number(payload.blockedToolCount || 0)} bloqueada(s).`;
      break;
    case 'package_action':
    case 'firewall_action':
    case 'mount_action':
    case 'container_compose':
    case 'power_action':
      detail = payload.dryRun ? 'Simulación preparada; no se aplicaron cambios.' : 'Acción administrativa completada.';
      break;
    default:
      break;
  }

  return `${detail} Duración: ${Math.max(0, Number(durationMs || 0))} ms.`;
}

module.exports = {
  appendPrivateLine,
  compact,
  describeToolStart,
  describeToolSuccess,
  friendlyError,
  humanEvent,
  redactText,
  resolveHumanLogPath,
  rotateLog,
  safeCommand
};
