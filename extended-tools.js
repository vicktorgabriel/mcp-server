'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function commandEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/token|password|passwd|secret|authorization|api[_-]?key/i.test(key)) delete env[key];
  }
  return env;
}

function execCommand(command, args = [], options = {}) {
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 900000);
  const outputLimit = clampInt(options.outputLimit, DEFAULT_OUTPUT_LIMIT, 1024, 32 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args.map(String), {
      cwd: options.cwd,
      env: { ...commandEnv(), ...(options.env || {}) },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, 1500).unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (Buffer.byteLength(stdout, 'utf8') < outputLimit) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (Buffer.byteLength(stderr, 'utf8') < outputLimit) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ command, args: args.map(String), exit_code: code, signal, timed_out: timedOut, stdout, stderr });
    });
    if (options.input !== undefined && options.input !== null) child.stdin.write(String(options.input));
    child.stdin.end();
  });
}

async function requireSuccess(command, args = [], options = {}) {
  const result = await execCommand(command, args, options);
  if (result.exit_code !== 0 || result.timed_out) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} failed${result.timed_out ? ' (timeout)' : ''}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

async function commandExists(command) {
  try {
    const result = await execCommand('sh', ['-c', 'command -v -- "$1" >/dev/null 2>&1', '_', command], { timeoutMs: 5000 });
    return result.exit_code === 0;
  } catch (_) {
    return false;
  }
}

async function privilegedCommand(command, args, options = {}) {
  if (options.dryRun) return { dryRun: true, command, args: args.map(String) };
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return requireSuccess(command, args, options);
  }
  if (!await commandExists('sudo')) {
    throw new Error(`La operación requiere permisos de administrador para ejecutar ${command}.`);
  }
  return requireSuccess('sudo', ['-n', '--', command, ...args], options);
}

async function readableStatusCommand(command, args, options = {}) {
  const direct = await execCommand(command, args, options);
  if (direct.exit_code === 0) return { readable: true, privileged: false, ...direct };
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return { readable: false, privileged: true, ...direct };
  }
  if (await commandExists('sudo')) {
    const elevated = await execCommand('sudo', ['-n', '--', command, ...args], options);
    if (elevated.exit_code === 0) return { readable: true, privileged: true, ...elevated, command, args };
  }
  return {
    readable: false,
    privileged: false,
    ...direct,
    error: (direct.stderr || direct.stdout || 'El estado requiere permisos de administrador.').trim()
  };
}

function makeTool(buildToolMetadata, name, title, description, properties = {}, required = [], annotations = {}) {
  return {
    name,
    ...buildToolMetadata(title, annotations),
    description,
    inputSchema: { type: 'object', properties, required }
  };
}

function fileType(stats) {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isBlockDevice()) return 'block';
  if (stats.isCharacterDevice()) return 'character';
  if (stats.isSocket()) return 'socket';
  if (stats.isFIFO()) return 'fifo';
  return 'other';
}

function isInsidePath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const CRITICAL_ROOTS = new Set(['/','/boot','/dev','/etc','/proc','/run','/sys','/usr','/var']);

function ensureNotCriticalRoot(fullPath, action) {
  const normalized = path.resolve(fullPath);
  if (CRITICAL_ROOTS.has(normalized)) {
    throw new Error(`${action} refuses to operate on the complete critical system path ${normalized}. Target a specific child instead.`);
  }
}

function validatePackageNames(packages) {
  for (const packageName of packages) {
    if (!/^[A-Za-z0-9][A-Za-z0-9+._:@/-]*$/.test(packageName) || packageName.includes('..')) {
      throw new Error(`Invalid package name: ${packageName}`);
    }
  }
}

function validateServiceNames(services) {
  for (const service of services) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(service)) throw new Error(`Invalid Compose service name: ${service}`);
  }
}

function requireConfirmation(actual, expected, action) {
  if (String(actual || '') !== expected) {
    throw new Error(`${action} requiere confirm="${expected}".`);
  }
}

function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function directoryTree(resolvePath, userPath, options = {}) {
  const { fullPath, displayPath } = resolvePath(userPath || '.');
  const rootStats = fs.lstatSync(fullPath);
  if (!rootStats.isDirectory()) throw new Error(`Not a directory: ${userPath}`);
  const maxDepth = clampInt(options.depth, 3, 0, 12);
  const maxEntries = clampInt(options.maxEntries, 1000, 1, 10000);
  const includeHidden = boolValue(options.includeHidden, false);
  const entries = [];
  let truncated = false;

  function walk(current, relative, depth) {
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    const children = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => includeHidden || !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      const childFull = path.join(current, child.name);
      const childRelative = relative ? path.join(relative, child.name) : child.name;
      let stats;
      try { stats = fs.lstatSync(childFull); } catch (error) {
        entries.push({ path: childRelative, type: 'unreadable', error: error.message });
        continue;
      }
      entries.push({
        path: childRelative,
        type: fileType(stats),
        size: stats.size,
        modified: stats.mtime.toISOString(),
        mode: `0${(stats.mode & 0o7777).toString(8)}`
      });
      if (stats.isDirectory() && !stats.isSymbolicLink() && depth < maxDepth) {
        walk(childFull, childRelative, depth + 1);
      }
    }
  }

  walk(fullPath, '', 0);
  return { path: displayPath, depth: maxDepth, count: entries.length, truncated, entries };
}

function packageManager() {
  const candidates = [
    ['apt', 'apt-get'],
    ['dnf', 'dnf'],
    ['yum', 'yum'],
    ['pacman', 'pacman'],
    ['zypper', 'zypper'],
    ['apk', 'apk']
  ];
  return candidates;
}

async function detectPackageManager() {
  for (const [name, command] of packageManager()) {
    if (await commandExists(command)) return { name, command };
  }
  return null;
}

async function composeCommand() {
  if (await commandExists('docker')) {
    const result = await execCommand('docker', ['compose', 'version'], { timeoutMs: 10000 });
    if (result.exit_code === 0) return { command: 'docker', prefix: ['compose'], backend: 'docker compose' };
  }
  if (await commandExists('docker-compose')) return { command: 'docker-compose', prefix: [], backend: 'docker-compose' };
  if (await commandExists('podman')) {
    const result = await execCommand('podman', ['compose', 'version'], { timeoutMs: 10000 });
    if (result.exit_code === 0) return { command: 'podman', prefix: ['compose'], backend: 'podman compose' };
  }
  return null;
}

const SAFE_ARCHIVE_EXTRACTOR = String.raw`
from pathlib import Path, PurePosixPath
import json, os, shutil, stat, sys, tarfile, zipfile
archive=Path(sys.argv[1]).resolve()
destination=Path(sys.argv[2]).resolve()
max_bytes=int(sys.argv[3])
destination.mkdir(parents=True, exist_ok=True)
count=0
total_bytes=0

def target_for(name):
    global count
    normalized=name.replace('\\\\','/')
    pure=PurePosixPath(normalized)
    if pure.is_absolute() or '..' in pure.parts or not pure.parts:
        raise RuntimeError(f'unsafe archive entry: {name}')
    target=destination.joinpath(*pure.parts)
    resolved=target.resolve(strict=False)
    try: resolved.relative_to(destination)
    except ValueError: raise RuntimeError(f'archive entry escapes destination: {name}')
    parent=target.parent
    parent.mkdir(parents=True, exist_ok=True)
    parent_resolved=parent.resolve()
    try: parent_resolved.relative_to(destination)
    except ValueError: raise RuntimeError(f'archive parent escapes destination: {name}')
    count += 1
    if count > 200000: raise RuntimeError('archive contains too many entries')
    return target

if zipfile.is_zipfile(archive):
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            mode=(info.external_attr >> 16) & 0xffff
            if stat.S_ISLNK(mode): raise RuntimeError(f'symbolic links are not allowed: {info.filename}')
            total_bytes += int(info.file_size or 0)
            if total_bytes > max_bytes: raise RuntimeError(f'archive exceeds extraction limit: {max_bytes} bytes')
            target=target_for(info.filename)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                with zf.open(info) as src, open(target, 'wb') as dst: shutil.copyfileobj(src, dst)
                if mode: os.chmod(target, mode & 0o777)
else:
    with tarfile.open(archive, 'r:*') as tf:
        for member in tf.getmembers():
            if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                raise RuntimeError(f'links/devices are not allowed: {member.name}')
            total_bytes += int(member.size or 0)
            if total_bytes > max_bytes: raise RuntimeError(f'archive exceeds extraction limit: {max_bytes} bytes')
            target=target_for(member.name)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                os.chmod(target, member.mode & 0o777)
            elif member.isfile():
                source=tf.extractfile(member)
                if source is None: raise RuntimeError(f'cannot read archive member: {member.name}')
                with source, open(target, 'wb') as dst: shutil.copyfileobj(source, dst)
                os.chmod(target, member.mode & 0o777)
            else:
                raise RuntimeError(f'unsupported archive entry: {member.name}')
print(json.dumps({'archive': str(archive), 'destination': str(destination), 'entries': count, 'bytes': total_bytes}))
`;

function createExtendedTools({ resolvePath, buildToolMetadata, textResult }) {
  const ro = { readOnlyHint: true, openWorldHint: true };
  const rw = { destructiveHint: true, idempotentHint: false, openWorldHint: true };

  const tools = [
    makeTool(buildToolMetadata, 'directory_tree', 'Directory Tree', 'Lists a directory recursively without following symbolic links.', {
      path: { type: 'string', description: 'Directory under the allowed paths. Default ".".' },
      depth: { type: 'number', description: 'Maximum recursion depth. Default 3, max 12.' },
      maxEntries: { type: 'number', description: 'Maximum entries. Default 1000, max 10000.' },
      includeHidden: { type: 'boolean', description: 'Include dotfiles. Default false.' }
    }, [], ro),
    makeTool(buildToolMetadata, 'file_hash', 'File Hash', 'Calculates a cryptographic hash for a file.', {
      path: { type: 'string' },
      algorithm: { type: 'string', enum: ['sha256', 'sha512', 'blake2b512'], description: 'Default sha256.' }
    }, ['path'], ro),
    makeTool(buildToolMetadata, 'file_copy', 'Copy File or Directory', 'Copies a file or directory inside the allowed paths.', {
      source: { type: 'string' },
      destination: { type: 'string' },
      recursive: { type: 'boolean', description: 'Required for directories.' },
      overwrite: { type: 'boolean', description: 'Default false.' }
    }, ['source', 'destination'], rw),
    makeTool(buildToolMetadata, 'file_move', 'Move File or Directory', 'Moves or renames a file or directory inside the allowed paths.', {
      source: { type: 'string' },
      destination: { type: 'string' },
      overwrite: { type: 'boolean', description: 'Default false.' }
    }, ['source', 'destination'], rw),
    makeTool(buildToolMetadata, 'file_delete', 'Delete File or Directory', 'Deletes a file or directory. Requires an explicit confirmation string.', {
      path: { type: 'string' },
      recursive: { type: 'boolean', description: 'Required for non-empty directories.' },
      confirm: { type: 'string', description: 'Must be exactly DELETE.' }
    }, ['path', 'confirm'], rw),
    makeTool(buildToolMetadata, 'archive_create', 'Create Archive', 'Creates tar, tar.gz or zip archives from an allowed file or directory.', {
      source: { type: 'string' },
      destination: { type: 'string' },
      format: { type: 'string', enum: ['tar.gz', 'tar', 'zip'], description: 'Default inferred from destination or tar.gz.' },
      overwrite: { type: 'boolean', description: 'Default false.' }
    }, ['source', 'destination'], rw),
    makeTool(buildToolMetadata, 'archive_extract', 'Extract Archive Safely', 'Extracts tar/tar.gz/zip archives while rejecting path traversal, links and device entries.', {
      archive: { type: 'string' },
      destination: { type: 'string' },
      overwrite: { type: 'boolean', description: 'Allow extraction into a non-empty destination. Default false.' },
      maxBytes: { type: 'number', description: 'Maximum total extracted size. Default 2 GiB, max 20 GiB.' }
    }, ['archive', 'destination'], rw),
    makeTool(buildToolMetadata, 'http_request', 'HTTP Request', 'Performs a bounded HTTP GET or HEAD request and returns status, headers and text content.', {
      url: { type: 'string' },
      method: { type: 'string', enum: ['GET', 'HEAD'], description: 'Default GET.' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      timeoutMs: { type: 'number', description: 'Default 15000, max 120000.' },
      maxBytes: { type: 'number', description: 'Default 2 MiB, max 16 MiB.' }
    }, ['url'], ro),
    makeTool(buildToolMetadata, 'port_check', 'Check TCP Port', 'Checks whether a TCP host and port are reachable.', {
      host: { type: 'string' },
      port: { type: 'number' },
      timeoutMs: { type: 'number', description: 'Default 3000, max 30000.' }
    }, ['host', 'port'], ro),
    makeTool(buildToolMetadata, 'download_file', 'Download File', 'Downloads an HTTP/HTTPS resource atomically into an allowed path.', {
      url: { type: 'string' },
      destination: { type: 'string' },
      overwrite: { type: 'boolean', description: 'Default false.' },
      maxBytes: { type: 'number', description: 'Default 100 MiB, max 512 MiB.' },
      timeoutMs: { type: 'number', description: 'Default 120000, max 900000.' }
    }, ['url', 'destination'], rw),
    makeTool(buildToolMetadata, 'package_status', 'Package Manager Status', 'Detects the system package manager and optionally checks installed packages and pending updates.', {
      packages: { type: 'array', items: { type: 'string' }, description: 'Optional package names.' },
      updates: { type: 'boolean', description: 'Include pending updates. Default false.' }
    }, [], ro),
    makeTool(buildToolMetadata, 'package_action', 'Package Manager Action', 'Refreshes, installs, removes or upgrades system packages. Requires explicit confirmation.', {
      action: { type: 'string', enum: ['refresh', 'install', 'remove', 'upgrade'] },
      packages: { type: 'array', items: { type: 'string' } },
      confirm: { type: 'string', description: 'Must be exactly APPLY PACKAGES.' },
      dryRun: { type: 'boolean', description: 'Return the command without executing it.' }
    }, ['action', 'confirm'], rw),
    makeTool(buildToolMetadata, 'firewall_status', 'Firewall Status', 'Reads UFW, firewalld or nftables status without changing rules.', {}, [], ro),
    makeTool(buildToolMetadata, 'firewall_action', 'Firewall Action', 'Allows or denies a UFW/firewalld rule, reloads, enables or disables the firewall. Requires explicit confirmation.', {
      action: { type: 'string', enum: ['allow', 'deny', 'reload', 'enable', 'disable'] },
      rule: { type: 'string', description: 'For example 9090/tcp. Required for allow/deny.' },
      confirm: { type: 'string', description: 'Must be exactly APPLY FIREWALL.' },
      dryRun: { type: 'boolean' }
    }, ['action', 'confirm'], rw),
    makeTool(buildToolMetadata, 'mount_status', 'Mount Status', 'Returns block devices and current mount points.', {}, [], ro),
    makeTool(buildToolMetadata, 'mount_action', 'Mount Action', 'Mounts a source at an allowed target or unmounts an allowed target. Requires explicit confirmation.', {
      action: { type: 'string', enum: ['mount', 'unmount'] },
      source: { type: 'string', description: 'Device/source for mount.' },
      target: { type: 'string', description: 'Mount point under allowed paths.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Mount options such as rw,noexec.' },
      confirm: { type: 'string', description: 'Must be exactly APPLY MOUNT.' },
      dryRun: { type: 'boolean' }
    }, ['action', 'target', 'confirm'], rw),
    makeTool(buildToolMetadata, 'user_accounts', 'User Accounts', 'Lists local users and privileged group memberships without reading password hashes.', {
      includeSystem: { type: 'boolean', description: 'Include system accounts below UID 1000. Default false.' }
    }, [], ro),
    makeTool(buildToolMetadata, 'container_status', 'Container Runtime Status', 'Reports Docker/Podman availability, service state and running containers.', {}, [], ro),
    makeTool(buildToolMetadata, 'container_compose', 'Container Compose Action', 'Runs common Docker/Podman Compose project actions. Mutating actions require explicit confirmation.', {
      project: { type: 'string', description: 'Project directory under allowed paths.' },
      action: { type: 'string', enum: ['ps', 'logs', 'config', 'up', 'down', 'restart', 'build', 'pull'] },
      services: { type: 'array', items: { type: 'string' } },
      lines: { type: 'number', description: 'Log lines, default 200.' },
      confirm: { type: 'string', description: 'For mutating actions, must be exactly APPLY CONTAINERS.' },
      dryRun: { type: 'boolean' }
    }, ['project', 'action'], rw),
    makeTool(buildToolMetadata, 'power_action', 'Power Action', 'Schedules a reboot or poweroff after a short delay. Requires confirmation matching the action.', {
      action: { type: 'string', enum: ['reboot', 'poweroff'] },
      delaySeconds: { type: 'number', description: 'Default 10, minimum 5, maximum 3600.' },
      confirm: { type: 'string', description: 'Must be exactly REBOOT or POWEROFF.' },
      dryRun: { type: 'boolean' }
    }, ['action', 'confirm'], rw)
  ];

  async function callTool(name, args = {}) {
    switch (name) {
      case 'directory_tree':
        return textResult(directoryTree(resolvePath, args.path || '.', args));
      case 'file_hash': {
        const { fullPath, displayPath } = resolvePath(args.path);
        const stats = fs.statSync(fullPath);
        if (!stats.isFile()) throw new Error(`Not a file: ${args.path}`);
        const algorithm = args.algorithm || 'sha256';
        if (!['sha256', 'sha512', 'blake2b512'].includes(algorithm)) throw new Error(`Unsupported hash algorithm: ${algorithm}`);
        return textResult({ path: displayPath, algorithm, hash: await hashFile(fullPath, algorithm), size: stats.size });
      }
      case 'file_copy': {
        const source = resolvePath(args.source);
        const destination = resolvePath(args.destination);
        const stats = fs.lstatSync(source.fullPath);
        if (stats.isDirectory() && !args.recursive) throw new Error('recursive=true is required to copy a directory.');
        const overwrite = boolValue(args.overwrite, false);
        ensureNotCriticalRoot(destination.fullPath, 'Copy');
        if (destination.displayPath === '.') throw new Error('The allowed root itself cannot be used as the copy destination.');
        if (stats.isDirectory() && isInsidePath(source.fullPath, destination.fullPath)) throw new Error('Destination cannot be inside the source directory.');
        if (fs.existsSync(destination.fullPath) && !overwrite) throw new Error(`Destination already exists: ${args.destination}`);
        fs.mkdirSync(path.dirname(destination.fullPath), { recursive: true });
        fs.cpSync(source.fullPath, destination.fullPath, { recursive: Boolean(args.recursive), force: overwrite, errorOnExist: !overwrite, dereference: false });
        return textResult({ ok: true, source: source.displayPath, destination: destination.displayPath, type: fileType(stats) });
      }
      case 'file_move': {
        const source = resolvePath(args.source);
        const destination = resolvePath(args.destination);
        const overwrite = boolValue(args.overwrite, false);
        const sourceStats = fs.lstatSync(source.fullPath);
        ensureNotCriticalRoot(source.fullPath, 'Move');
        ensureNotCriticalRoot(destination.fullPath, 'Move');
        if (source.displayPath === '.') throw new Error('The allowed root itself cannot be moved.');
        if (destination.displayPath === '.') throw new Error('The allowed root itself cannot be replaced.');
        if (sourceStats.isDirectory() && isInsidePath(source.fullPath, destination.fullPath)) throw new Error('Destination cannot be inside the source directory.');
        if (fs.existsSync(destination.fullPath)) {
          if (!overwrite) throw new Error(`Destination already exists: ${args.destination}`);
          const destinationStats = fs.lstatSync(destination.fullPath);
          if (!sourceStats.isFile() || !destinationStats.isFile()) throw new Error('overwrite=true only replaces a regular file; delete directories explicitly first.');
        }
        fs.mkdirSync(path.dirname(destination.fullPath), { recursive: true });
        try {
          fs.renameSync(source.fullPath, destination.fullPath);
        } catch (error) {
          if (error.code !== 'EXDEV') throw error;
          const temporary = `${destination.fullPath}.move-${process.pid}-${Date.now()}`;
          try {
            fs.cpSync(source.fullPath, temporary, { recursive: sourceStats.isDirectory(), dereference: false, errorOnExist: true });
            fs.renameSync(temporary, destination.fullPath);
            fs.rmSync(source.fullPath, { recursive: sourceStats.isDirectory(), force: false });
          } catch (copyError) {
            try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (_) {}
            throw copyError;
          }
        }
        return textResult({ ok: true, source: source.displayPath, destination: destination.displayPath });
      }
      case 'file_delete': {
        requireConfirmation(args.confirm, 'DELETE', 'El borrado');
        const target = resolvePath(args.path);
        ensureNotCriticalRoot(target.fullPath, 'Delete');
        if (target.displayPath === '.') throw new Error('The allowed root itself cannot be deleted.');
        const stats = fs.lstatSync(target.fullPath);
        if (stats.isDirectory() && !args.recursive) throw new Error('recursive=true is required to delete a directory.');
        fs.rmSync(target.fullPath, { recursive: Boolean(args.recursive), force: false });
        return textResult({ ok: true, path: target.displayPath, type: fileType(stats) });
      }
      case 'archive_create': {
        const source = resolvePath(args.source);
        const destination = resolvePath(args.destination);
        const overwrite = boolValue(args.overwrite, false);
        if (fs.existsSync(destination.fullPath) && !overwrite) throw new Error(`Destination already exists: ${args.destination}`);
        if (fs.existsSync(destination.fullPath) && overwrite) {
          const existing = fs.lstatSync(destination.fullPath);
          if (!existing.isFile()) throw new Error('Archive destination must be a regular file.');
          fs.unlinkSync(destination.fullPath);
        }
        fs.mkdirSync(path.dirname(destination.fullPath), { recursive: true });
        const lower = destination.fullPath.toLowerCase();
        const format = args.format || (lower.endsWith('.zip') ? 'zip' : lower.endsWith('.tar') ? 'tar' : 'tar.gz');
        const sourceStats = fs.lstatSync(source.fullPath);
        if (sourceStats.isDirectory() && isInsidePath(source.fullPath, destination.fullPath)) throw new Error('Archive destination cannot be inside the source directory.');
        const parent = path.dirname(source.fullPath);
        const basename = path.basename(source.fullPath);
        if (format === 'zip') {
          if (!await commandExists('zip')) throw new Error('zip is not installed.');
          const commandArgs = ['-r', destination.fullPath, '--', basename];
          await requireSuccess('zip', commandArgs, { cwd: parent, timeoutMs: 900000, outputLimit: 8 * 1024 * 1024 });
        } else {
          if (!await commandExists('tar')) throw new Error('tar is not installed.');
          const flag = format === 'tar' ? '-cf' : '-czf';
          await requireSuccess('tar', [flag, destination.fullPath, '--', basename], { cwd: parent, timeoutMs: 900000, outputLimit: 8 * 1024 * 1024 });
        }
        const stats = fs.statSync(destination.fullPath);
        return textResult({ ok: true, source: source.displayPath, destination: destination.displayPath, format, size: stats.size });
      }
      case 'archive_extract': {
        const archive = resolvePath(args.archive);
        const destination = resolvePath(args.destination);
        const archiveStats = fs.statSync(archive.fullPath);
        if (!archiveStats.isFile()) throw new Error(`Not a file: ${args.archive}`);
        if (fs.existsSync(destination.fullPath)) {
          const entries = fs.readdirSync(destination.fullPath);
          if (entries.length > 0 && !args.overwrite) throw new Error('Destination is not empty; set overwrite=true to continue.');
        }
        fs.mkdirSync(destination.fullPath, { recursive: true });
        const maxBytes = clampInt(args.maxBytes, 2 * 1024 * 1024 * 1024, 1024, 20 * 1024 * 1024 * 1024);
        const result = await requireSuccess('python3', ['-c', SAFE_ARCHIVE_EXTRACTOR, archive.fullPath, destination.fullPath, String(maxBytes)], { timeoutMs: 900000, outputLimit: 4 * 1024 * 1024 });
        return textResult(JSON.parse(result.stdout.trim()));
      }
      case 'http_request': {
        const url = new URL(String(args.url));
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// URLs are supported.');
        if (url.username || url.password) throw new Error('Credentials embedded in URLs are not allowed; use request headers when necessary.');
        const method = String(args.method || 'GET').toUpperCase();
        if (!['GET', 'HEAD'].includes(method)) throw new Error('Only GET and HEAD are supported.');
        const timeoutMs = clampInt(args.timeoutMs, 15000, 1000, 120000);
        const maxBytes = clampInt(args.maxBytes, 2 * 1024 * 1024, 1024, 16 * 1024 * 1024);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const headers = {};
          for (const [key, value] of Object.entries(args.headers || {})) {
            if (/^(host|content-length|connection|transfer-encoding)$/i.test(key)) continue;
            headers[key] = String(value);
          }
          const response = await fetch(url, { method, headers, redirect: 'follow', signal: controller.signal });
          const outputHeaders = Object.fromEntries(
            [...response.headers.entries()].filter(([key]) => !/^(set-cookie|authorization|proxy-authorization)$/i.test(key))
          );
          let body = '';
          let bytes = 0;
          let truncated = false;
          if (method !== 'HEAD' && response.body) {
            const chunks = [];
            for await (const chunk of response.body) {
              const buffer = Buffer.from(chunk);
              const remaining = maxBytes - bytes;
              if (remaining <= 0) { truncated = true; break; }
              chunks.push(buffer.subarray(0, remaining));
              bytes += Math.min(buffer.length, remaining);
              if (buffer.length > remaining || bytes >= maxBytes) { truncated = true; break; }
            }
            body = Buffer.concat(chunks).toString('utf8');
          }
          return textResult({ url: response.url, status: response.status, ok: response.ok, headers: outputHeaders, bytes, truncated, body });
        } finally {
          clearTimeout(timer);
        }
      }
      case 'port_check': {
        const host = String(args.host || '').trim();
        const port = clampInt(args.port, 0, 1, 65535);
        if (!host) throw new Error('host is required');
        const timeoutMs = clampInt(args.timeoutMs, 3000, 250, 30000);
        const started = Date.now();
        const result = await new Promise((resolve) => {
          const socket = net.createConnection({ host, port });
          let done = false;
          const finish = (open, error = '') => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve({ host, port, open, error, durationMs: Date.now() - started });
          };
          socket.setTimeout(timeoutMs, () => finish(false, 'timeout'));
          socket.once('connect', () => finish(true));
          socket.once('error', (error) => finish(false, error.code || error.message));
        });
        return textResult(result);
      }
      case 'download_file': {
        const url = new URL(String(args.url));
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// URLs are supported.');
        if (url.username || url.password) throw new Error('Credentials embedded in URLs are not allowed; use request headers when necessary.');
        const destination = resolvePath(args.destination);
        const overwrite = boolValue(args.overwrite, false);
        if (fs.existsSync(destination.fullPath) && !overwrite) throw new Error(`Destination already exists: ${args.destination}`);
        const maxBytes = clampInt(args.maxBytes, 100 * 1024 * 1024, 1024, MAX_DOWNLOAD_BYTES);
        const timeoutMs = clampInt(args.timeoutMs, 120000, 1000, 900000);
        fs.mkdirSync(path.dirname(destination.fullPath), { recursive: true });
        const temporary = `${destination.fullPath}.download-${process.pid}-${Date.now()}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let bytes = 0;
        const hash = crypto.createHash('sha256');
        try {
          const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}`);
          const file = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
          try {
            for await (const chunk of response.body) {
              const buffer = Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > maxBytes) throw new Error(`Download exceeds maxBytes (${maxBytes}).`);
              hash.update(buffer);
              if (!file.write(buffer)) await new Promise((resolve) => file.once('drain', resolve));
            }
          } finally {
            await new Promise((resolve) => file.end(resolve));
          }
          fs.renameSync(temporary, destination.fullPath);
          return textResult({ ok: true, url: response.url, destination: destination.displayPath, bytes, sha256: hash.digest('hex') });
        } catch (error) {
          try { fs.unlinkSync(temporary); } catch (_) {}
          throw error;
        } finally {
          clearTimeout(timer);
        }
      }
      case 'package_status': {
        const manager = await detectPackageManager();
        if (!manager) return textResult({ available: false, manager: null, packages: [], updates: '' });
        const packages = Array.isArray(args.packages) ? args.packages.map(String).filter(Boolean).slice(0, 200) : [];
        validatePackageNames(packages);
        const details = [];
        for (const packageName of packages) {
          let result;
          if (manager.name === 'apt') result = await execCommand('dpkg-query', ['-W', '-f=${db:Status-Abbrev}\t${Version}\n', packageName], { timeoutMs: 10000 });
          else if (manager.name === 'pacman') result = await execCommand('pacman', ['-Q', packageName], { timeoutMs: 10000 });
          else if (manager.name === 'apk') result = await execCommand('apk', ['info', '-e', packageName], { timeoutMs: 10000 });
          else result = await execCommand(manager.command, ['list', 'installed', packageName], { timeoutMs: 10000 });
          details.push({ name: packageName, installed: result.exit_code === 0, output: result.stdout.trim(), error: result.stderr.trim() });
        }
        let updates = '';
        if (args.updates) {
          let result;
          if (manager.name === 'apt') result = await execCommand('apt-get', ['-s', 'upgrade'], { timeoutMs: 60000 });
          else if (manager.name === 'pacman') result = await execCommand('pacman', ['-Qu'], { timeoutMs: 60000 });
          else if (manager.name === 'apk') result = await execCommand('apk', ['version', '-l', '<'], { timeoutMs: 60000 });
          else result = await execCommand(manager.command, ['check-update'], { timeoutMs: 60000 });
          updates = `${result.stdout}${result.stderr}`.trim();
        }
        return textResult({ available: true, manager: manager.name, command: manager.command, packages: details, updates });
      }
      case 'package_action': {
        requireConfirmation(args.confirm, 'APPLY PACKAGES', 'La modificación de paquetes');
        const manager = await detectPackageManager();
        if (!manager) throw new Error('No compatible package manager was found.');
        const action = String(args.action);
        if (!['refresh', 'install', 'remove', 'upgrade'].includes(action)) throw new Error(`Unsupported package action: ${action}`);
        const packages = Array.isArray(args.packages) ? args.packages.map(String).filter(Boolean).slice(0, 200) : [];
        validatePackageNames(packages);
        if (['install', 'remove'].includes(action) && packages.length === 0) throw new Error(`packages is required for ${action}.`);
        let command = manager.command;
        let commandArgs = [];
        if (manager.name === 'apt') {
          if (action === 'refresh') commandArgs = ['update'];
          else if (action === 'install') commandArgs = ['install', '-y', '--', ...packages];
          else if (action === 'remove') commandArgs = ['remove', '-y', '--', ...packages];
          else commandArgs = ['upgrade', '-y'];
        } else if (manager.name === 'pacman') {
          if (action === 'refresh') commandArgs = ['-Sy'];
          else if (action === 'install') commandArgs = ['-S', '--needed', '--noconfirm', ...packages];
          else if (action === 'remove') commandArgs = ['-R', '--noconfirm', ...packages];
          else commandArgs = ['-Syu', '--noconfirm'];
        } else if (manager.name === 'apk') {
          if (action === 'refresh') commandArgs = ['update'];
          else if (action === 'install') commandArgs = ['add', ...packages];
          else if (action === 'remove') commandArgs = ['del', ...packages];
          else commandArgs = ['upgrade'];
        } else if (manager.name === 'zypper') {
          commandArgs = action === 'refresh' ? ['--non-interactive', 'refresh']
            : action === 'install' ? ['--non-interactive', 'install', ...packages]
              : action === 'remove' ? ['--non-interactive', 'remove', ...packages]
                : ['--non-interactive', 'update'];
        } else {
          commandArgs = action === 'refresh' ? ['makecache']
            : action === 'install' ? ['install', '-y', ...packages]
              : action === 'remove' ? ['remove', '-y', ...packages]
                : ['upgrade', '-y'];
        }
        return textResult(await privilegedCommand(command, commandArgs, { dryRun: args.dryRun, timeoutMs: 900000, outputLimit: 16 * 1024 * 1024 }));
      }
      case 'firewall_status': {
        if (await commandExists('ufw')) return textResult({ backend: 'ufw', available: true, ...(await readableStatusCommand('ufw', ['status', 'verbose'], { timeoutMs: 30000 })) });
        if (await commandExists('firewall-cmd')) return textResult({ backend: 'firewalld', available: true, ...(await readableStatusCommand('firewall-cmd', ['--list-all'], { timeoutMs: 30000 })) });
        if (await commandExists('nft')) return textResult({ backend: 'nftables', available: true, ...(await readableStatusCommand('nft', ['list', 'ruleset'], { timeoutMs: 30000, outputLimit: 8 * 1024 * 1024 })) });
        return textResult({ backend: null, available: false, readable: false, error: 'No supported firewall backend was found.' });
      }
      case 'firewall_action': {
        requireConfirmation(args.confirm, 'APPLY FIREWALL', 'La modificación del firewall');
        const action = String(args.action);
        if (!['allow', 'deny', 'reload', 'enable', 'disable'].includes(action)) throw new Error(`Unsupported firewall action: ${action}`);
        const rule = String(args.rule || '').trim();
        if (['allow', 'deny'].includes(action) && !rule) throw new Error('rule is required for allow/deny.');
        if (rule && (!/^[A-Za-z0-9][A-Za-z0-9.:/_-]*$/.test(rule) || rule.includes('..'))) throw new Error(`Invalid firewall rule: ${rule}`);
        if (await commandExists('ufw')) {
          const commandArgs = ['--force', action];
          if (rule) commandArgs.push(rule);
          return textResult(await privilegedCommand('ufw', commandArgs, { dryRun: args.dryRun, timeoutMs: 60000 }));
        }
        if (await commandExists('firewall-cmd')) {
          let commandArgs;
          if (action === 'reload') commandArgs = ['--reload'];
          else if (action === 'enable' || action === 'disable') throw new Error('Use service_action for firewalld enable/disable.');
          else commandArgs = ['--permanent', `${action === 'allow' ? '--add-port' : '--remove-port'}=${rule}`];
          return textResult(await privilegedCommand('firewall-cmd', commandArgs, { dryRun: args.dryRun, timeoutMs: 60000 }));
        }
        throw new Error('No supported mutable firewall backend was found.');
      }
      case 'mount_status': {
        const findmnt = await execCommand('findmnt', ['--json', '--real', '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS'], { timeoutMs: 30000, outputLimit: 8 * 1024 * 1024 });
        const lsblk = await execCommand('lsblk', ['--json', '--output', 'NAME,PATH,MODEL,SIZE,FSTYPE,TYPE,MOUNTPOINTS'], { timeoutMs: 30000, outputLimit: 8 * 1024 * 1024 });
        const parse = (value) => { try { return JSON.parse(value); } catch (_) { return value.trim(); } };
        return textResult({ mounts: parse(findmnt.stdout), blockDevices: parse(lsblk.stdout), errors: [findmnt.stderr, lsblk.stderr].filter(Boolean) });
      }
      case 'mount_action': {
        requireConfirmation(args.confirm, 'APPLY MOUNT', 'La modificación de montajes');
        const action = String(args.action);
        if (!['mount', 'unmount'].includes(action)) throw new Error(`Unsupported mount action: ${action}`);
        const target = resolvePath(args.target);
        ensureNotCriticalRoot(target.fullPath, 'Mount');
        if (target.displayPath === '.') throw new Error('The allowed root itself cannot be used as a mount point.');
        let command;
        let commandArgs;
        if (action === 'mount') {
          const source = String(args.source || '').trim();
          if (!source) throw new Error('source is required for mount.');
          if (!args.dryRun) fs.mkdirSync(target.fullPath, { recursive: true });
          command = 'mount';
          commandArgs = [];
          if (Array.isArray(args.options) && args.options.length) commandArgs.push('-o', args.options.map(String).join(','));
          commandArgs.push('--', source, target.fullPath);
        } else {
          command = 'umount';
          commandArgs = ['--', target.fullPath];
        }
        return textResult(await privilegedCommand(command, commandArgs, { dryRun: args.dryRun, timeoutMs: 120000 }));
      }
      case 'user_accounts': {
        const includeSystem = boolValue(args.includeSystem, false);
        const passwd = await requireSuccess('getent', ['passwd'], { timeoutMs: 30000 });
        const users = passwd.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          const [name, , uidText, gidText, gecos, home, shell] = line.split(':');
          return { name, uid: Number(uidText), gid: Number(gidText), gecos, home, shell };
        }).filter((user) => includeSystem || user.uid === 0 || user.uid >= 1000);
        const privilegedGroups = {};
        for (const group of ['sudo', 'wheel', 'adm', 'docker', 'lxd']) {
          const result = await execCommand('getent', ['group', group], { timeoutMs: 5000 });
          if (result.exit_code === 0) {
            const [name, , gidText, membersText = ''] = result.stdout.trim().split(':');
            privilegedGroups[group] = { name, gid: Number(gidText), members: membersText.split(',').filter(Boolean) };
          }
        }
        return textResult({ users, privilegedGroups });
      }
      case 'container_status': {
        const runtimes = [];
        for (const runtime of ['docker', 'podman']) {
          if (!await commandExists(runtime)) continue;
          const version = await execCommand(runtime, ['version', '--format', '{{json .}}'], { timeoutMs: 15000 });
          const containers = await execCommand(runtime, ['ps', '-a', '--format', '{{json .}}'], { timeoutMs: 15000, outputLimit: 8 * 1024 * 1024 });
          runtimes.push({ runtime, available: true, version: version.stdout.trim(), containers: containers.stdout.trim(), error: `${version.stderr}${containers.stderr}`.trim() });
        }
        const compose = await composeCommand();
        return textResult({ runtimes, compose: compose ? compose.backend : null });
      }
      case 'container_compose': {
        const compose = await composeCommand();
        if (!compose) throw new Error('Docker/Podman Compose is not available.');
        const cwd = resolvePath(args.project).fullPath;
        if (!fs.statSync(cwd).isDirectory()) throw new Error('project must be a directory.');
        const action = String(args.action);
        if (!['ps', 'logs', 'config', 'up', 'down', 'restart', 'build', 'pull'].includes(action)) throw new Error(`Unsupported compose action: ${action}`);
        const mutating = ['up', 'down', 'restart', 'build', 'pull'].includes(action);
        if (mutating) requireConfirmation(args.confirm, 'APPLY CONTAINERS', 'La modificación de contenedores');
        const services = Array.isArray(args.services) ? args.services.map(String).filter(Boolean) : [];
        validateServiceNames(services);
        let commandArgs = [...compose.prefix];
        if (action === 'logs') commandArgs.push('logs', '--no-color', '--tail', String(clampInt(args.lines, 200, 1, 10000)), ...services);
        else if (action === 'up') commandArgs.push('up', '-d', ...services);
        else commandArgs.push(action, ...services);
        if (args.dryRun) return textResult({ dryRun: true, command: compose.command, args: commandArgs, cwd });
        return textResult(await requireSuccess(compose.command, commandArgs, { cwd, timeoutMs: 900000, outputLimit: 16 * 1024 * 1024 }));
      }
      case 'power_action': {
        const action = String(args.action);
        if (!['reboot', 'poweroff'].includes(action)) throw new Error(`Unsupported power action: ${action}`);
        const expected = action === 'reboot' ? 'REBOOT' : 'POWEROFF';
        requireConfirmation(args.confirm, expected, 'La acción de energía');
        const delaySeconds = clampInt(args.delaySeconds, 10, 5, 3600);
        const unit = `mcp-${action}-${Date.now()}`;
        const commandArgs = ['--unit', unit, `--on-active=${delaySeconds}s`, '--collect', 'systemctl', action];
        return textResult(await privilegedCommand('systemd-run', commandArgs, { dryRun: args.dryRun, timeoutMs: 60000 }));
      }
      default:
        return null;
    }
  }

  return { tools, callTool };
}

module.exports = { createExtendedTools };
