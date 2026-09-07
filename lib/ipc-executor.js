'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const {
  MessageFramer,
  validateIpcRequest,
  DEFAULT_TIMEOUT_MS,
  SOCK_DIR,
  SOCK_PATH,
  TOKEN_PATH
} = require('./ipc-protocol');
const { createAccessPolicy, TOOL_REQUIREMENTS } = require('./access-policy');
const { ApprovalsManager } = require('./approvals');
const { JobManager } = require('./job-manager');
const {
  validatePathWithinRoots,
  validateEgressUrl,
  validateZipSlip,
  assertRestrictedIsolationAllowed,
  detectOsIsolationCapabilities,
  wrapCommandInSandbox
} = require('./sandbox');
const { createFullControl } = require('./full-control-tools');
const { createExtendedTools } = require('./extended-tools');
const { humanEvent, redactText } = require('./human-log');
const { ensurePrivateDirectory, applyPrivateOwnership } = require('./private-owner');

const FULL_ACCESS = (process.env.MCP_FULL_ACCESS === '1' || process.env.MCP_FULL_ACCESS === 'true');
const DEFAULT_ROOT = process.env.WORKING_DIR || process.cwd();
const ALLOWED_ROOTS = FULL_ACCESS
  ? [path.resolve('/')]
  : (process.env.ALLOWED_PATHS ? process.env.ALLOWED_PATHS.split(',').map(p => path.resolve(p.trim())).filter(Boolean) : [DEFAULT_ROOT]);

const ACCESS_POLICY = createAccessPolicy(process.env, Object.keys(TOOL_REQUIREMENTS));
const approvalsManager = new ApprovalsManager();
const jobManager = new JobManager();

function textResult(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return {
    content: [{ type: 'text', text }]
  };
}

function buildToolMetadata(name, extra = {}) {
  return {
    title: name,
    ...extra
  };
}

function resolveExecutionContext(accessPolicy, context = {}, args = {}) {
  const { clientInfo = {}, auth = {}, principal = {} } = context;
  const clientId = context.clientId || auth.clientId || principal.clientId || clientInfo.clientId || 'local_or_stdio';
  const clientPolicy = context.clientPolicy || ((accessPolicy && accessPolicy.clientPolicyStore)
    ? accessPolicy.clientPolicyStore.getClientPolicy(clientId)
    : null);

  const globalProfile = accessPolicy ? accessPolicy.profile : 'developer';
  const clientProfile = (clientPolicy && clientPolicy.profile) || context.profile || (clientInfo && clientInfo.profile) || null;

  const isRestrictedExecution = (globalProfile === 'trabajo_restringido') ||
    (clientProfile === 'trabajo_restringido');

  const isFullAccess = !isRestrictedExecution && Boolean(
    (accessPolicy && accessPolicy.fullAccess) ||
    (clientPolicy && clientPolicy.fullAccess) ||
    (context.isFullAccess) ||
    (process.env.MCP_FULL_ACCESS === '1' || process.env.MCP_FULL_ACCESS === 'true')
  );

  const effectiveProfile = isRestrictedExecution
    ? 'trabajo_restringido'
    : (clientProfile || globalProfile);

  return {
    clientId,
    clientPolicy,
    isRestrictedExecution,
    isFullAccess,
    effectiveProfile
  };
}

class ToolExecutorCore {
  constructor(options = {}) {
    this.allowedRoots = options.allowedRoots || ALLOWED_ROOTS;
    this.accessPolicy = options.accessPolicy || ACCESS_POLICY;
    this.approvals = options.approvals || approvalsManager;
    this.jobs = options.jobs || jobManager;

    const resolvePath = (targetPath, pathOptions = {}) => {
      const isRestricted = this.accessPolicy && this.accessPolicy.profile === 'trabajo_restringido';
      const isFull = Boolean(
        (this.accessPolicy && this.accessPolicy.fullAccess) ||
        pathOptions.isFullAccess ||
        (process.env.MCP_FULL_ACCESS === '1' || process.env.MCP_FULL_ACCESS === 'true')
      );
      let allowSensitive = false;
      if (isRestricted) {
        allowSensitive = false;
      } else if (pathOptions.allowSensitive !== undefined) {
        allowSensitive = Boolean(pathOptions.allowSensitive);
      } else if (isFull) {
        allowSensitive = true;
      }
      const resolved = validatePathWithinRoots(targetPath || '.', this.allowedRoots, {
        allowSensitive,
        isMutating: Boolean(pathOptions.isMutating)
      });
      return {
        fullPath: resolved,
        displayPath: path.relative(DEFAULT_ROOT, resolved) || '.'
      };
    };
    this.resolvePath = resolvePath;

    this.fullControl = createFullControl({
      resolvePath,
      buildToolMetadata,
      textResult,
      allowedRoots: this.allowedRoots,
      accessPolicy: this.accessPolicy
    });
    this.extendedTools = createExtendedTools({
      resolvePath,
      buildToolMetadata,
      textResult,
      allowedRoots: this.allowedRoots,
      accessPolicy: this.accessPolicy,
      jobManager: this.jobs,
      approvals: this.approvals
    });
  }

  getAllTools() {
    const baseTools = [
      {
        name: 'tool_policy_status',
        ...buildToolMetadata('Tool Access Policy', { readOnlyHint: true }),
        description: 'Muestra la política de acceso efectiva, perfil, herramientas bloqueadas y avisos de seguridad.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'search',
        ...buildToolMetadata('Search Files', { readOnlyHint: true }),
        description: 'Busca archivos por nombre y contenido en las rutas permitidas.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Texto o fragmento a buscar.' },
            path: { type: 'string', description: 'Carpeta relativa donde buscar.' },
            limit: { type: 'number', description: 'Cantidad máxima de resultados.' }
          },
          required: ['query']
        }
      },
      {
        name: 'fetch',
        ...buildToolMetadata('Fetch Search Result', { readOnlyHint: true }),
        description: 'Obtiene el contenido de un archivo obtenido mediante búsqueda.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Identificador o ruta del archivo.' } },
          required: ['id']
        }
      },
      {
        name: 'list_files',
        ...buildToolMetadata('List Files', { readOnlyHint: true }),
        description: 'Lista archivos y carpetas dentro de una ruta permitida.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Ruta relativa o permitida.' } },
          required: []
        }
      },
      {
        name: 'read_file',
        ...buildToolMetadata('Read File', { readOnlyHint: true }),
        description: 'Lee un archivo UTF-8 de texto, con soporte para offset, límite y hash SHA-256.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Ruta relativa o permitida.' },
            offset: { type: 'number', description: 'Offset de bytes desde el inicio.' },
            limit: { type: 'number', description: 'Límite de bytes a leer.' }
          },
          required: ['path']
        }
      },
      {
        name: 'write_file',
        ...buildToolMetadata('Write File', { destructiveHint: true }),
        description: 'Escribe un archivo de texto en una ruta permitida. Soporta preview=true para ver diferencias.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Ruta del archivo a escribir.' },
            content: { type: 'string', description: 'Contenido a escribir.' },
            mode: {
              type: 'string',
              enum: ['write', 'append'],
              description: 'write sobrescribe; append agrega al final.',
              default: 'write'
            },
            preview: { type: 'boolean', description: 'Si es true, muestra un diff sin modificar el archivo.' }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'patch_file',
        ...buildToolMetadata('Patch File', { destructiveHint: true }),
        description: 'Aplica parches de reemplazo a un archivo de texto.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Ruta del archivo a modificar.' },
            patches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  search: { type: 'string', description: 'Texto exacto a buscar.' },
                  replace: { type: 'string', description: 'Texto de reemplazo.' },
                  replaceAll: { type: 'boolean', description: 'Reemplazar todas las apariciones.' }
                },
                required: ['search', 'replace']
              },
              description: 'Lista de reemplazos {search, replace, replaceAll}.'
            }
          },
          required: ['path', 'patches']
        }
      },
      {
        name: 'run_command',
        ...buildToolMetadata('Run Command', { destructiveHint: true }),
        description: 'Ejecuta un comando con argv estructurado (sin shell por defecto) dentro del entorno configurado.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Nombre o ruta del ejecutable.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Argumentos estructurados.' },
            cwd: { type: 'string', description: 'Directorio de trabajo permitido.' },
            timeoutMs: { type: 'number', description: 'Límite de tiempo en milisegundos.' },
            shell: { type: 'boolean', description: 'Ejecutar mediante shell (deshabilitado en modo restringido).' }
          },
          required: ['command']
        }
      },
      // Async Job Tools
      {
        name: 'job_start',
        ...buildToolMetadata('Start Background Job', { destructiveHint: true }),
        description: 'Inicia un comando en segundo plano con seguimiento y límites de recursos.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Ejecutable.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Argumentos.' },
            cwd: { type: 'string', description: 'Directorio de trabajo.' },
            timeoutMs: { type: 'number', description: 'Tiempo límite.' },
            idempotencyKey: { type: 'string', description: 'Clave de idempotencia única para prevenir ejecuciones duplicadas simultáneas.' }
          },
          required: ['command']
        }
      },
      {
        name: 'job_status',
        ...buildToolMetadata('Check Job Status', { readOnlyHint: true }),
        description: 'Consulta el estado de un trabajo en segundo plano propio del cliente autenticado.',
        inputSchema: {
          type: 'object',
          properties: { jobId: { type: 'string', description: 'Identificador del trabajo.' } },
          required: ['jobId']
        }
      },
      {
        name: 'job_output',
        ...buildToolMetadata('Read Job Output', { readOnlyHint: true }),
        description: 'Lee la salida generada por un trabajo en segundo plano con paginación.',
        inputSchema: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Identificador del trabajo.' },
            offset: { type: 'number', description: 'Offset de bytes.' },
            limit: { type: 'number', description: 'Cantidad máxima de bytes.' }
          },
          required: ['jobId']
        }
      },
      {
        name: 'job_cancel',
        ...buildToolMetadata('Cancel Job', { destructiveHint: true }),
        description: 'Cancela un trabajo en segundo plano y todo su árbol de procesos asociados.',
        inputSchema: {
          type: 'object',
          properties: { jobId: { type: 'string', description: 'Identificador del trabajo.' } },
          required: ['jobId']
        }
      }
    ];

    return [...baseTools, ...this.fullControl.tools, ...this.extendedTools.tools];
  }

  getPublishedTools(clientContext = {}) {
    const all = this.getAllTools();
    return this.accessPolicy.filterTools(all, clientContext);
  }

  async executeTool(name, args = {}, context = {}) {
    if (this.jobs.isPaused()) {
      throw new Error('El servidor MCP se encuentra en pausa administrativa.');
    }

    // Sanitize client-supplied arguments to prevent injection of internal approval verification markers
    if (args && typeof args === 'object') {
      delete args._approvedByApprovalId;
      delete args._approved;
      delete args._approvedByApprovalIdVerified;
    }

    const { clientInfo = {}, auth = {}, approvalId: ctxApprovalId = null } = context;
    const clientId = context.principal?.clientId || context.clientId || auth.clientId || clientInfo.clientId || 'local_or_stdio';
    const approvalId = ctxApprovalId || (args && (args.approvalId || args._approvalId || args.approval_id));
    const clientContext = {
      clientId,
      authenticated: Boolean(auth.authenticated),
      allowedTools: auth.allowedTools,
      deniedTools: auth.deniedTools,
      scope: auth.scope,
      subject: auth.subject
    };

    // 1. Effective Policy Check per call
    const underlyingCheck = name.startsWith('job_')
      ? 'run_command'
      : (name === 'diff_preview' ? 'patch_file' : (name.startsWith('approval_') ? 'tool_policy_status' : name));
    this.accessPolicy.assertAllowed(underlyingCheck, clientContext);
    if (name !== underlyingCheck) {
      this.accessPolicy.assertAllowed(name, clientContext);
    }

    // 2. Confinement check for restricted profile
    const execContext = resolveExecutionContext(this.accessPolicy, context, args);
    const clientPolicy = execContext.clientPolicy;
    const isRestrictedExecution = execContext.isRestrictedExecution;
    const isFullAccess = execContext.isFullAccess;

    const resolvePathHelper = (p, pOpts = {}) => {
      const isMutatingTool = ['write_file', 'patch_file', 'file_move', 'archive_extract', 'file_delete'].includes(name);
      let allowSens = false;
      if (isRestrictedExecution) {
        allowSens = false;
      } else if (isFullAccess) {
        allowSens = true; // Consented full access mode: allow sensitive reads
      } else {
        allowSens = !isMutatingTool && Boolean(pOpts.allowSensitive);
      }
      return this.resolvePath(p, {
        allowSensitive: allowSens,
        isMutating: isMutatingTool,
        isFullAccess
      });
    };

    if (isRestrictedExecution) {
      assertRestrictedIsolationAllowed();
      // Block shell in restricted mode
      if (args && args.shell) {
        throw new Error('La opción shell:true está estrictamente denegada en el perfil de trabajo restringido.');
      }
    }

    // 3. Human Approval Enforcement
    const currentPolicyVersion = this.accessPolicy.getVersion ? this.accessPolicy.getVersion(clientId) : (this.accessPolicy.version || '1');

    const envForApprovals = {
      ...process.env,
      ...(this.accessPolicy && this.accessPolicy.criticalConfirmations !== undefined
        ? { criticalConfirmations: this.accessPolicy.criticalConfirmations, MCP_CRITICAL_CONFIRMATIONS: this.accessPolicy.criticalConfirmations ? '1' : '0' }
        : {}),
      ...(this.accessPolicy && this.accessPolicy.toolApprovals !== undefined
        ? { MCP_TOOL_APPROVALS: this.accessPolicy.toolApprovals }
        : {})
    };

    const requiresApproval = this.approvals.isApprovalRequired
      ? this.approvals.isApprovalRequired(name, args, envForApprovals, clientPolicy)
      : false;

    if (requiresApproval || approvalId) {
      if (!approvalId) {
        const pending = this.approvals.createPendingApproval({
          clientId,
          tool: name,
          args,
          scope: 'tool_execution',
          policyVersion: currentPolicyVersion
        });
        const err = new Error(`Aprobación requerida: la acción '${name}' exige confirmación humana local.`);
        err.isApprovalRequired = true;
        err.approvalId = pending.id;
        err.argsSummary = pending.argsSummary;
        throw err;
      } else {
        // Consume single-use approval atomically
        this.approvals.consumeApproval({
          id: approvalId,
          clientId,
          tool: name,
          args,
          policyVersion: currentPolicyVersion
        });
        if (args && typeof args === 'object') {
          args._approvedByApprovalId = approvalId;
          args._approvedByApprovalIdVerified = true;
        }
      }
    }

    // 4. Dispatch tool
    switch (name) {
      case 'tool_policy_status':
        return textResult(this.accessPolicy.summary(this.getAllTools().map(t => t.name)));

      case 'search': {
        const query = String(args.query || '').toLowerCase();
        const folder = resolvePathHelper(args.path || '.').fullPath;
        const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
        const results = [];
        const scan = (dir) => {
          if (results.length >= limit) return;
          let entries = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
          for (const ent of entries) {
            if (results.length >= limit) break;
            if (ent.name === 'node_modules' || ent.name === '.git') continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) scan(full);
            else if (ent.isFile()) {
              if (ent.name.toLowerCase().includes(query)) {
                results.push({ path: path.relative(DEFAULT_ROOT, full), match: 'filename' });
              }
            }
          }
        };
        scan(folder);
        return textResult({ query, matches: results });
      }

      case 'fetch': {
        const filePath = resolvePathHelper(args.id || args.path).fullPath;
        const stat = fs.statSync(filePath);
        if (stat.size > 5 * 1024 * 1024) throw new Error('Archivo demasiado grande para fetch.');
        const content = fs.readFileSync(filePath, 'utf8');
        return textResult(content);
      }

      case 'list_files': {
        const dirPath = resolvePathHelper(args.path || '.').fullPath;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const list = entries.map(ent => ({
          name: ent.name,
          type: ent.isDirectory() ? 'directory' : 'file'
        }));
        return textResult({ path: args.path || '.', entries: list });
      }

      case 'read_file': {
        const filePath = resolvePathHelper(args.path).fullPath;
        const stat = fs.statSync(filePath);
        const hasOffset = typeof args.offset === 'number';
        const hasLimit = typeof args.limit === 'number';

        const fd = fs.openSync(filePath, 'r');
        try {
          const offset = Math.max(0, Number(args.offset) || 0);
          const limit = hasLimit ? Math.max(1, Math.min(Number(args.limit), 10 * 1024 * 1024)) : stat.size;
          const buffer = Buffer.alloc(Math.min(limit, Math.max(0, stat.size - offset)));
          fs.readSync(fd, buffer, 0, buffer.length, offset);
          const hash = crypto.createHash('sha256').update(buffer).digest('hex');
          return textResult({
            path: args.path,
            totalSize: stat.size,
            offset,
            bytesRead: buffer.length,
            sha256: hash,
            content: buffer.toString('utf8')
          });
        } finally {
          fs.closeSync(fd);
        }
      }

      case 'write_file': {
        const filePath = resolvePathHelper(args.path).fullPath;
        if (args.preview) {
          const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
          return textResult({
            preview: true,
            path: args.path,
            originalLength: oldContent.length,
            newLength: String(args.content).length,
            status: fs.existsSync(filePath) ? 'modificación' : 'creación'
          });
        }
        const mode = args.mode || 'write';
        if (!['write', 'append'].includes(mode)) throw new Error('mode must be "write" or "append"');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (mode === 'append') {
          fs.appendFileSync(filePath, String(args.content), 'utf8');
        } else {
          const tmp = `${filePath}.tmp`;
          fs.writeFileSync(tmp, String(args.content), 'utf8');
          fs.renameSync(tmp, filePath);
        }
        const stats = fs.statSync(filePath);
        return textResult({
          path: args.path,
          bytes_written: Buffer.byteLength(String(args.content), 'utf8'),
          mode,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          ok: true
        });
      }

      case 'patch_file': {
        const filePath = resolvePathHelper(args.path).fullPath;
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) throw new Error(`Not a file: ${args.path}`);
        let content = fs.readFileSync(filePath, 'utf8');
        const patches = Array.isArray(args.patches) ? args.patches : [];
        if (patches.length === 0) throw new Error('patches must be a non-empty array');
        const applied = [];
        for (const patch of patches) {
          const search = patch && patch.search;
          const replace = patch && patch.replace;
          if (typeof search !== 'string' || search.length === 0) throw new Error('patch.search must be a non-empty string');
          if (typeof replace !== 'string') throw new Error('patch.replace must be a string');
          const occurrences = (content.match(new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
          if (occurrences === 0) throw new Error(`Search text not found in ${args.path}`);
          if (!patch.replaceAll && occurrences > 1) {
            throw new Error(`Search text appears ${occurrences} times in ${args.path}; set replaceAll=true or use a more specific search`);
          }
          content = patch.replaceAll
            ? content.split(search).join(replace)
            : content.replace(search, replace);
          applied.push({
            searchBytes: Buffer.byteLength(search, 'utf8'),
            replaceBytes: Buffer.byteLength(replace, 'utf8'),
            occurrences: patch.replaceAll ? occurrences : 1
          });
        }
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, filePath);
        const nextStats = fs.statSync(filePath);
        return textResult({
          path: args.path,
          patches_applied: applied.length,
          replacements: applied,
          size: nextStats.size,
          modified: nextStats.mtime.toISOString(),
          ok: true
        });
      }

      case 'run_command': {
        const cmd = String(args.command || '').trim();
        if (!cmd) throw new Error('command is required');
        const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        const cwd = args.cwd ? resolvePathHelper(args.cwd).fullPath : DEFAULT_ROOT;
        const timeout = Math.min(Math.max(1000, Number(args.timeoutMs) || 30000), 120000);
        const shell = Boolean(args.shell);

        let execCmd = cmd;
        let execArgs = cmdArgs;
        if (isRestrictedExecution) {
          if (shell) {
            throw new Error('La opción shell:true está estrictamente denegada en el perfil de trabajo restringido.');
          }
          const wrapped = wrapCommandInSandbox(cmd, cmdArgs, { allowedRoots: this.allowedRoots, cwd }, process.env);
          execCmd = wrapped.command;
          execArgs = wrapped.args;
        }

        return new Promise((resolve, reject) => {
          const proc = spawn(execCmd, execArgs, {
            cwd,
            timeout,
            shell: isRestrictedExecution ? false : shell
          });
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', d => { if (stdout.length < 1024 * 1024) stdout += d; });
          proc.stderr.on('data', d => { if (stderr.length < 1024 * 1024) stderr += d; });
          proc.on('close', code => {
            resolve(textResult({ command: cmd, exitCode: code, stdout, stderr }));
          });
          proc.on('error', err => reject(err));
        });
      }

      case 'job_start': {
        let effectiveCmd = String(args.command || '').trim();
        let effectiveArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        const cwd = args.cwd ? resolvePathHelper(args.cwd).fullPath : DEFAULT_ROOT;
        if (isRestrictedExecution) {
          const wrapped = wrapCommandInSandbox(effectiveCmd, effectiveArgs, { allowedRoots: this.allowedRoots, cwd }, process.env);
          effectiveCmd = wrapped.command;
          effectiveArgs = wrapped.args;
        }
        return textResult(this.jobs.startJob({
          clientId,
          command: effectiveCmd,
          args: effectiveArgs,
          cwd,
          timeoutMs: args.timeoutMs,
          idempotencyKey: args.idempotencyKey
        }));
      }

      case 'job_status':
        return textResult(this.jobs.getJob(args.jobId, clientId));

      case 'job_output':
        return textResult(this.jobs.getJobOutput(args.jobId, clientId, args.offset, args.limit));

      case 'job_cancel':
        return textResult(this.jobs.cancelJob(args.jobId, clientId));

      case 'process_start': {
        const cmd = String(args.command || '').trim();
        if (!cmd) throw new Error('command is required');
        const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        const cwd = args.cwd ? resolvePathHelper(args.cwd).fullPath : (this.allowedRoots[0] || DEFAULT_ROOT);
        let logPath;
        if (args.logPath) {
          logPath = resolvePathHelper(args.logPath).fullPath;
        } else {
          logPath = path.join(cwd, `.mcp-process-${Date.now()}.log`);
        }
        fs.mkdirSync(path.dirname(logPath), { recursive: true });

        let execCmd = cmd;
        let execArgs = cmdArgs;
        if (isRestrictedExecution) {
          if (args.shell) {
            throw new Error('La opción shell:true está estrictamente denegada en el perfil de trabajo restringido.');
          }
          const wrapped = wrapCommandInSandbox(cmd, cmdArgs, { allowedRoots: this.allowedRoots, cwd }, process.env);
          execCmd = wrapped.command;
          execArgs = wrapped.args;
        }

        const fd = fs.openSync(logPath, 'a');
        const child = spawn(execCmd, execArgs, {
          cwd,
          shell: false,
          detached: true,
          stdio: ['ignore', fd, fd]
        });
        child.unref();
        fs.closeSync(fd);
        return textResult({ ok: true, pid: child.pid, command: cmd, args: cmdArgs, cwd, logPath });
      }

      case 'git_command': {
        const repo = resolvePathHelper(args.repo || '.').fullPath;
        if (!Array.isArray(args.args) || args.args.length === 0) {
          throw new Error('args array is required for git_command');
        }
        const gitArgs = ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args.args.map(String)];
        let execCmd = 'git';
        let execArgs = gitArgs;
        if (isRestrictedExecution) {
          const wrapped = wrapCommandInSandbox('git', gitArgs, { allowedRoots: this.allowedRoots, cwd: repo }, process.env);
          execCmd = wrapped.command;
          execArgs = wrapped.args;
        }
        return new Promise((resolve, reject) => {
          const proc = spawn(execCmd, execArgs, {
            cwd: repo,
            timeout: 60000,
            shell: false
          });
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', d => { if (stdout.length < 16 * 1024 * 1024) stdout += d; });
          proc.stderr.on('data', d => { if (stderr.length < 16 * 1024 * 1024) stderr += d; });
          proc.on('close', code => {
            resolve(textResult({ command: 'git', exitCode: code, stdout, stderr }));
          });
          proc.on('error', reject);
        });
      }

      default: {
        if (isRestrictedExecution) {
          if (name.startsWith('tmux_')) {
            throw new Error('La capacidad tmux está estrictamente denegada en el perfil de trabajo restringido porque no puede ser confinada dentro del aislamiento del SO.');
          }
        }
        // FullControl / Extended tools
        const extended = await this.extendedTools.callTool(name, args, execContext);
        if (extended !== null) return extended;
        const extra = await this.fullControl.callTool(name, args, execContext);
        if (extra !== null) return extra;
        throw new Error(`Herramienta no encontrada: ${name}`);
      }
    }
  }
}

// IPC Server Lifecycle
class IpcExecutor {
  constructor(options = {}) {
    this.sockPath = options.sockPath || SOCK_PATH;
    this.tokenPath = options.tokenPath || TOKEN_PATH;
    this.allowedRoots = options.allowedRoots;
    this.accessPolicy = options.accessPolicy;
    this.executor = new ToolExecutorCore({
      accessPolicy: this.accessPolicy,
      allowedRoots: this.allowedRoots
    });
    this.server = null;
    this.sessionAuthToken = null;
  }

  async start() {
    ensurePrivateDirectory(path.dirname(this.sockPath), 0o700);
    ensurePrivateDirectory(path.dirname(this.tokenPath), 0o700);
    this.sessionAuthToken = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(this.tokenPath, this.sessionAuthToken, { mode: 0o600 });
    applyPrivateOwnership(this.tokenPath, 0o600);

    if (fs.existsSync(this.sockPath)) {
      try { fs.unlinkSync(this.sockPath); } catch (_) {}
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const framer = new MessageFramer();
        let authenticated = false;
        const handshakeTimeout = setTimeout(() => {
          if (!authenticated) socket.destroy();
        }, 5000);

        socket.on('data', async (chunk) => {
          let messages = [];
          try {
            messages = framer.feed(chunk);
          } catch (err) {
            const errFrame = MessageFramer.frame({
              jsonrpc: '2.0',
              error: { code: -32700, message: err.message }
            });
            socket.write(errFrame);
            socket.destroy();
            return;
          }

          for (const msg of messages) {
            const val = validateIpcRequest(msg);
            if (!val.ok) {
              socket.write(MessageFramer.frame({
                jsonrpc: '2.0',
                id: msg ? msg.id : null,
                error: { code: -32600, message: val.error }
              }));
              continue;
            }

            if (msg.type === 'handshake') {
              clearTimeout(handshakeTimeout);
              const expected = Buffer.from(this.sessionAuthToken, 'utf8');
              const submitted = Buffer.from(String(msg.token || ''), 'utf8');
              if (expected.length === submitted.length && crypto.timingSafeEqual(expected, submitted)) {
                authenticated = true;
                socket.write(MessageFramer.frame({ type: 'handshake_ack', ok: true }));
              } else {
                socket.write(MessageFramer.frame({ type: 'handshake_ack', ok: false, error: 'Token de autenticación IPC inválido.' }));
                socket.destroy();
              }
              continue;
            }

            if (!authenticated) {
              socket.write(MessageFramer.frame({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32001, message: 'Conexión IPC no autenticada.' }
              }));
              socket.destroy();
              return;
            }

            // Handle MCP request
            const started = Date.now();
            const { id, method, params = {}, auth = {}, clientInfo = {} } = msg;

            try {
              if (method === 'tools/list') {
                const tools = this.executor.getPublishedTools({ clientId: auth.clientId });
                socket.write(MessageFramer.frame({
                  jsonrpc: '2.0',
                  id,
                  result: { tools },
                  timings: { t_executor_ms: Date.now() - started }
                }));
              } else if (method === 'tools/call') {
                const { name, arguments: args, approvalId } = params;
                const effectiveApprovalId = approvalId || (args && (args.approvalId || args._approvalId || args.approval_id));
                const result = await this.executor.executeTool(name, args, { auth, clientInfo, approvalId: effectiveApprovalId });
                socket.write(MessageFramer.frame({
                  jsonrpc: '2.0',
                  id,
                  result,
                  timings: { t_executor_ms: Date.now() - started }
                }));
              } else if (method === 'ping') {
                socket.write(MessageFramer.frame({ jsonrpc: '2.0', id, result: {} }));
              } else if (method === 'policy/summary') {
                socket.write(MessageFramer.frame({
                  jsonrpc: '2.0',
                  id,
                  result: this.executor.accessPolicy.summary(this.executor.getAllTools().map(t => t.name))
                }));
              } else {
                socket.write(MessageFramer.frame({
                  jsonrpc: '2.0',
                  id,
                  error: { code: -32601, message: `Método desconocido en el ejecutor: ${method}` }
                }));
              }
            } catch (err) {
              const errorPayload = {
                code: err.isApprovalRequired ? -32001 : -32603,
                message: err.message
              };
              if (err.isApprovalRequired) {
                errorPayload.data = {
                  approvalId: err.approvalId,
                  argsSummary: err.argsSummary
                };
              }
              socket.write(MessageFramer.frame({
                jsonrpc: '2.0',
                id,
                error: errorPayload,
                timings: { t_executor_ms: Date.now() - started }
              }));
            }
          }
        });

        socket.on('error', () => {});
      });

      server.listen(this.sockPath, () => {
        try {
          fs.chmodSync(this.sockPath, 0o600);
          applyPrivateOwnership(this.sockPath, 0o600);
        } catch (_) {}
        this.server = server;
        resolve(this);
      });

      server.on('error', reject);
    });
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch (_) {}
      this.server = null;
    }
    if (fs.existsSync(this.sockPath)) {
      try { fs.unlinkSync(this.sockPath); } catch (_) {}
    }
  }
}

let defaultServer = null;

function startIpcExecutor(options = {}) {
  const instance = new IpcExecutor(options);
  instance.start();
  defaultServer = instance;
  return instance;
}

function stopIpcExecutor() {
  if (defaultServer) {
    defaultServer.stop();
    defaultServer = null;
  }
}

process.on('SIGTERM', () => { stopIpcExecutor(); });
process.on('SIGINT', () => { stopIpcExecutor(); });

if (require.main === module) {
  startIpcExecutor();
  console.log(`MCP IPC Executor activo en ${SOCK_PATH}`);
}

module.exports = {
  ToolExecutorCore,
  IpcExecutor,
  resolveExecutionContext,
  startIpcExecutor,
  stopIpcExecutor,
  SOCK_PATH,
  TOKEN_PATH
};
