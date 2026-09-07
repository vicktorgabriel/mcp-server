'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { TextDecoder } = require('node:util');
const { validatePathWithinRoots, wrapCommandInSandbox } = require('../sandbox');
const { ensurePrivateDirectory } = require('../private-owner');
const { globalBlockRecorder } = require('../access-policy');

const NAMES = new Set(['code_search_symbols', 'project_dependency_map', 'patch_preview', 'patch_apply', 'file_restore_safe', 'project_test_runner', 'service_diagnostics', 'security_block_history', 'job_list_mine', 'job_tail_output']);
const MAX_FILE = 512 * 1024;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const integer = (n, fallback, min, max) => Number.isFinite(Number(n)) ? Math.max(min, Math.min(max, Math.trunc(Number(n)))) : fallback;

function readText(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Se requiere un archivo regular de hasta 512 KiB.');
    const data = Buffer.alloc(MAX_FILE + 1);
    let length = 0;
    while (length < data.length) {
      const read = fs.readSync(fd, data, length, data.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > MAX_FILE) throw new Error('Archivo demasiado grande.');
    const bytes = data.subarray(0, length);
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), hash: hash(bytes), stat };
  } finally { fs.closeSync(fd); }
}

function transform(original, patches) {
  if (!Array.isArray(patches) || !patches.length || patches.length > 100) throw new Error('Se requieren de 1 a 100 parches.');
  let text = original;
  for (const patch of patches) {
    if (!patch || typeof patch.search !== 'string' || !patch.search || typeof patch.replace !== 'string') throw new Error('Parche invalido: search no puede estar vacio.');
    if (Buffer.byteLength(patch.replace) > MAX_FILE) throw new Error('Reemplazo demasiado grande.');
    const index = text.indexOf(patch.search);
    if (index < 0) throw new Error('Texto exacto no encontrado.');
    if (!patch.replaceAll && text.indexOf(patch.search, index + patch.search.length) >= 0) throw new Error('Texto ambiguo: use replaceAll o un contexto unico.');
    const count = patch.replaceAll ? text.split(patch.search).length - 1 : 1;
    if (Buffer.byteLength(text) + count * (Buffer.byteLength(patch.replace) - Buffer.byteLength(patch.search)) > MAX_FILE) throw new Error('Resultado demasiado grande.');
    // Literal replacement, including dollar signs and replacement metacharacters.
    text = patch.replaceAll ? text.split(patch.search).join(patch.replace) : text.slice(0, index) + patch.replace + text.slice(index + patch.search.length);
  }
  return text;
}

function previewDiff(before, after, filename) {
  const lines = text => text ? text.replace(/\n$/, '').split('\n') : [];
  const a = lines(before), b = lines(after);
  if (before === after) return { diff: '', additions: 0, deletions: 0, truncated: false };
  const payload = [`--- a/${filename}`, `+++ b/${filename}`, `@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@`, ...a.map(l => `-${l}`)];
  if (before && !before.endsWith('\n')) payload.push('\\ No newline at end of file');
  payload.push(...b.map(l => `+${l}`));
  if (after && !after.endsWith('\n')) payload.push('\\ No newline at end of file');
  const diff = payload.join('\n') + '\n';
  return { diff: diff.slice(0, 65536), additions: b.length, deletions: a.length, truncated: diff.length > 65536 };
}

function createProjectTools({ resolvePath, allowedRoots, accessPolicy, jobManager, execCommand }) {
  async function call(name, args = {}, context = {}) {
    if (!NAMES.has(name)) return null;
    const clientId = String(context.clientId || 'local_or_stdio');
    if (accessPolicy) accessPolicy.assertAllowed(name, { clientId });
    const clientPolicy = accessPolicy?.clientPolicyStore?.getClientPolicy(clientId) || context.clientPolicy;
    const restricted = context.isRestrictedExecution || accessPolicy?.profile === 'trabajo_restringido' || clientPolicy?.profile === 'trabajo_restringido';
    const resolve = (target, write = false) => {
      const opts = { allowSensitive: !restricted && Boolean(context.isFullAccess), isMutating: write, isWriteOperation: write };
      const base = resolvePath(target || '.', opts).fullPath;
      let full = validatePathWithinRoots(base, allowedRoots, opts);
      if (Array.isArray(clientPolicy?.allowedRoots)) full = validatePathWithinRoots(full, clientPolicy.allowedRoots, opts);
      return full;
    };

    if (name === 'code_search_symbols') {
      const query = String(args.query || '').trim().toLowerCase();
      if (!query || query.length > 200 || args.isRegex) throw new Error('Use una consulta literal de 1 a 200 caracteres; regex no esta habilitado.');
      const root = resolve(args.path);
      const extensions = new Set((args.fileExtensions || ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'php']).map(e => String(e).replace(/^\./, '').toLowerCase()));
      const matches = [];
      let visited = 0, bytes = 0, truncated = false, skipped = 0;
      const patterns = [
        ['function', /\b(?:function|def|func|fn)\s+([\w$]+)/],
        ['class', /\b(?:class|struct|enum)\s+([\w$]+)/],
        ['type', /\b(?:type|interface)\s+([\w$]+)/],
        ['variable', /\b(?:const|let|var)\s+([\w$]+)\s*=/],
        ['export', /\bexport\s+(?:default\s+)?(?:const\s+|function\s+|class\s+)?([\w$]+)/]
      ];
      const walk = (directory, depth = 0) => {
        if (depth > 10 || visited >= 2000 || matches.length >= 1000 || bytes >= 10 * 1024 * 1024) { truncated = true; return; }
        // opendir avoids loading an unbounded directory listing into memory.
        const dir = fs.opendirSync(directory);
        try {
          let ent;
          while ((ent = dir.readSync())) {
            if (++visited > 2000 || matches.length >= 1000 || bytes >= 10 * 1024 * 1024) { truncated = true; break; }
            if (ent.name.startsWith('.') || ['node_modules', 'dist', 'build', 'target', 'vendor', 'coverage'].includes(ent.name) || ent.isSymbolicLink()) { skipped++; continue; }
            const file = path.join(directory, ent.name);
            let safe;
            try { safe = resolve(file); } catch (_) { skipped++; continue; }
            if (ent.isDirectory()) { walk(safe, depth + 1); continue; }
            if (!ent.isFile() || !extensions.has(path.extname(ent.name).slice(1).toLowerCase())) continue;
            let content;
            try { content = readText(safe).text; } catch (_) { skipped++; continue; }
            bytes += Buffer.byteLength(content);
            const lines = content.split('\n');
            for (let i = 0; i < lines.length && matches.length < 1000; i++) {
              const line = lines[i].slice(0, 4096);
              for (const [type, pattern] of patterns) {
                if (args.symbolType && args.symbolType !== 'any' && args.symbolType !== type) continue;
                const match = line.match(pattern);
                if (match && match[1].toLowerCase().includes(query)) { matches.push({ file: path.relative(root, safe), line: i + 1, symbol: match[1], type, snippet: line.trim().slice(0, 300) }); break; }
              }
            }
          }
        } finally { dir.closeSync(); }
      };
      walk(root);
      matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      const offset = integer(args.offset, 0, 0, 1000), limit = integer(args.limit, 20, 1, 100);
      return { query, symbols: matches.slice(offset, offset + limit), total: matches.length, offset, limit, nextOffset: Math.min(matches.length, offset + limit), hasMore: offset + limit < matches.length, truncated, skipped, analysis: 'heuristic_definitions_not_semantic_references' };
    }

    if (name === 'project_dependency_map') {
      const root = resolve(args.path);
      const result = { projectType: 'unknown', manifests: [], directDependencies: {}, devDependencies: {}, peerDependencies: {}, notes: [], truncated: false };
      for (const filename of ['package.json', 'requirements.txt', 'go.mod', 'pyproject.toml', 'Cargo.toml']) {
        const file = path.join(root, filename);
        if (!fs.existsSync(file)) continue;
        const text = readText(resolve(file)).text;
        result.manifests.push(filename);
        if (filename === 'package.json') {
          const pkg = JSON.parse(text);
          result.projectType = 'node'; result.name = String(pkg.name || '').slice(0, 200); result.version = String(pkg.version || '').slice(0, 100);
          for (const [input, output] of [['dependencies', 'directDependencies'], ['devDependencies', 'devDependencies'], ['peerDependencies', 'peerDependencies']]) {
            if (input === 'devDependencies' && args.includeDev === false) continue;
            const entries = Object.entries(pkg[input] || {});
            result[output] = Object.fromEntries(entries.slice(0, 200).map(([k, v]) => [k.slice(0, 200), String(v).slice(0, 300)]));
            if (entries.length > 200) result.truncated = true;
          }
        } else if (filename === 'requirements.txt' || filename === 'go.mod') {
          if (result.projectType === 'unknown') result.projectType = filename === 'go.mod' ? 'go' : 'python';
          for (const line of text.split('\n')) {
            const m = filename === 'go.mod' ? line.trim().match(/^(?:require\s+)?([\w./-]+)\s+(v[\w.+-]+)$/) : line.trim().match(/^([\w.-]+)\s*([=<>!~].*)?$/);
            if (!m) continue;
            if (Object.keys(result.directDependencies).length >= 200) { result.truncated = true; break; }
            Object.defineProperty(result.directDependencies, m[1], { value: (m[2] || '*').slice(0, 300), enumerable: true, configurable: true });
          }
        } else result.notes.push(`${filename}: detectado, sin analisis TOML ni resolucion transitiva.`);
      }
      result.totalDirect = Object.keys(result.directDependencies).length;
      result.totalDev = Object.keys(result.devDependencies).length;
      return result;
    }

    if (['patch_preview', 'patch_apply', 'file_restore_safe'].includes(name)) {
      const file = resolve(args.path, name !== 'patch_preview');
      if (name === 'patch_preview') {
        const before = readText(file), after = transform(before.text, args.patches);
        return { path: args.path, originalHash: before.hash, modifiedHash: hash(after), patchesCount: args.patches.length, ...previewDiff(before.text, after, path.basename(file)), canApply: true };
      }
      if (args.force) throw new Error('La restauracion segura no permite force ni sobrescribir conflictos.');
      if (name === 'patch_apply' && !/^[a-f0-9]{64}$/i.test(args.expectedHash || '')) throw new Error('expectedHash SHA-256 es obligatorio.');
      if (args.createBackup === false) throw new Error('La copia de respaldo es obligatoria.');
      const backupRoot = path.resolve(process.env.MCP_BACKUPS_DIR || '.runtime/backups');
      const clientDir = path.join(backupRoot, hash(clientId));
      ensurePrivateDirectory(backupRoot, 0o700); ensurePrivateDirectory(clientDir, 0o700);
      const lock = path.join(backupRoot, `${hash(file)}.lock`);
      const lockFd = fs.openSync(lock, 'wx', 0o600);
      let tmp;
      try {
        const before = readText(file);
        let after, record, backupId;
        if (name === 'patch_apply') {
          if (before.hash !== args.expectedHash.toLowerCase()) throw new Error('Conflicto: el archivo cambio desde la previsualizacion.');
          after = transform(before.text, args.patches);
          backupId = `bak_${crypto.randomBytes(16).toString('hex')}`;
          record = { clientId, file, originalHash: before.hash, postPatchHash: hash(after), content: Buffer.from(before.text).toString('base64'), mode: before.stat.mode & 0o777, createdAt: Date.now() };
          fs.writeFileSync(path.join(clientDir, backupId + '.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        } else {
          if (!/^bak_[a-f0-9]{32}$/.test(args.backupId || '')) throw new Error('backupId valido es obligatorio.');
          backupId = args.backupId;
          record = JSON.parse(fs.readFileSync(path.join(clientDir, backupId + '.json'), 'utf8'));
          if (record.clientId !== clientId || record.file !== file) throw new Error('Copia no pertenece al cliente y archivo solicitados.');
          if (before.hash !== record.postPatchHash) throw new Error('Conflicto: hay cambios posteriores; no se restaurara.');
          after = Buffer.from(record.content, 'base64').toString('utf8');
          if (hash(after) !== record.originalHash) throw new Error('Copia de respaldo corrupta.');
        }
        tmp = path.join(path.dirname(file), `.mcp-edit-${crypto.randomBytes(16).toString('hex')}`);
        fs.writeFileSync(tmp, after, { flag: 'wx', mode: 0o600 });
        fs.chmodSync(tmp, record.mode);
        const current = readText(resolve(args.path, true));
        if (current.hash !== before.hash || current.stat.ino !== before.stat.ino || current.stat.dev !== before.stat.dev) throw new Error('Conflicto: el archivo cambio durante la edicion.');
        fs.renameSync(tmp, file); tmp = null;
        return { path: args.path, applied: name === 'patch_apply', restored: name === 'file_restore_safe', originalHash: before.hash, newHash: hash(after), restoredHash: name === 'file_restore_safe' ? hash(after) : undefined, backupId, bytesWritten: Buffer.byteLength(after) };
      } finally { if (tmp) fs.rmSync(tmp, { force: true }); fs.closeSync(lockFd); fs.unlinkSync(lock); }
    }

    if (name === 'project_test_runner') {
      const cwd = resolve(args.cwd);
      const extra = args.args === undefined ? [] : args.args;
      if (!Array.isArray(extra) || extra.length > 100 || extra.some(s => typeof s !== 'string' || s.length > 4096 || s.includes('\0'))) throw new Error('Argumentos invalidos.');
      const runners = { npm_test: ['npm', ['test', '--']], npm_check: ['npm', ['run', 'check', '--']], npm_lint: ['npm', ['run', 'lint', '--']], pytest: ['pytest', []], cargo_test: ['cargo', ['test']], go_test: ['go', ['test', './...']] };
      let selected = runners[args.runner];
      if (args.runner === 'eslint' || args.runner === 'tsc') selected = [resolve(path.join(cwd, 'node_modules', '.bin', args.runner)), args.runner === 'tsc' ? ['--noEmit'] : []];
      if (args.runner === 'custom_script') {
        if (!/^[a-zA-Z0-9][\w:.-]{0,99}$/.test(args.script || '')) throw new Error('script valido es obligatorio.');
        const pkg = JSON.parse(readText(resolve(path.join(cwd, 'package.json'))).text);
        if (!Object.hasOwn(pkg.scripts || {}, args.script)) throw new Error('Script no definido en package.json.');
        selected = ['npm', ['run', args.script, '--']];
      }
      if (!selected) throw new Error('Runner no permitido.');
      const [binary, prefix] = selected, commandArgs = [...prefix, ...extra];
      const wrapped = restricted ? wrapCommandInSandbox(binary, commandArgs, { allowedRoots: clientPolicy?.allowedRoots || allowedRoots, cwd }) : { command: binary, args: commandArgs };
      const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      const job = jobManager.startJob({ clientId, command: wrapped.command, args: wrapped.args, cwd, env, timeoutMs: integer(args.timeoutMs, 60000, 1000, 300000), maxOutputBytes: 65536, idempotencyKey: args.idempotencyKey });
      let state = jobManager.getJob(job.jobId, clientId);
      while (state.status === 'running') { await new Promise(resolve => setTimeout(resolve, 50)); state = jobManager.getJob(job.jobId, clientId); }
      const output = jobManager.getJobOutput(job.jobId, clientId);
      return { runner: args.runner, binary, args: commandArgs, jobId: job.jobId, exit_code: state.exitCode, signal: state.signal, timed_out: state.status === 'timed_out', success: state.status === 'completed', stdout: output.output, stderr: '', streamsMerged: true, outputTruncated: state.outputTruncated };
    }

    if (name === 'service_diagnostics') {
      const ports = args.checkPorts || [], services = args.checkServices || [];
      if (!Array.isArray(ports) || !Array.isArray(services) || ports.length + services.length > 20) throw new Error('Maximo 20 comprobaciones explicitas.');
      const allowedPorts = new Set(String(process.env.MCP_DIAGNOSTIC_PORTS || '').split(',').filter(Boolean).map(Number));
      const allowedServices = new Set(String(process.env.MCP_DIAGNOSTIC_SERVICES || '').split(',').filter(Boolean));
      if (ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535 || !allowedPorts.has(p)) || services.some(s => typeof s !== 'string' || !/^[\w][\w.@-]{0,100}$/.test(s) || !allowedServices.has(s))) throw new Error('Destino no permitido en allowlist local de diagnostico.');
      if (restricted && (ports.length || services.length)) throw new Error('Diagnostico del host no permitido en perfil restringido.');
      const results = [];
      for (const port of ports) results.push(await new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        let settled = false;
        const finish = (open, error = null) => { if (settled) return; settled = true; socket.destroy(); resolve({ port, host: '127.0.0.1', open, error }); };
        socket.setTimeout(integer(args.timeoutMs, 1000, 100, 3000), () => finish(false, 'TIMEOUT'));
        socket.once('connect', () => finish(true)); socket.once('error', e => finish(false, e.code));
      }));
      const units = [];
      for (const service of services) { const r = await execCommand('systemctl', ['show', '--property=ActiveState,SubState,LoadState', '--no-pager', '--', service], { timeoutMs: 3000, outputLimit: 4096 }); units.push({ service, exitCode: r.exit_code, details: r.stdout.slice(0, 4096) }); }
      return { checkedAt: new Date().toISOString(), ports: results, services: units };
    }
    if (name === 'security_block_history') {
      if (args.clientId && args.clientId !== clientId) throw new Error('No se permite consultar otro cliente.');
      const recorder = accessPolicy?.blockRecorder || globalBlockRecorder;
      const history = recorder.getHistory({ clientId, limit: args.limit, since: args.since });
      return { totalRecorded: history.totalCount, returnedCount: history.blocks.length, events: history.blocks, scope: 'current_process_client_only' };
    }
    if (name === 'job_list_mine') {
      const all = jobManager.listJobs(clientId, { status: args.status });
      const offset = integer(args.offset, 0, 0, 100000), limit = integer(args.limit, 20, 1, 100);
      return { clientId, jobs: all.slice(offset, offset + limit), total: all.length, offset, limit, hasMore: offset + limit < all.length };
    }
    return jobManager.tailJobOutput(args.jobId, clientId, args);
  }
  return { call };
}

module.exports = { createProjectTools };
