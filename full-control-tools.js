'use strict';

/*
 * Extra full-control tools for the local MCP server.
 *
 * The module intentionally uses only Node.js built-ins plus commands normally
 * present on a Linux workstation. Desktop input uses desktop-control.py with
 * python-xlib when available. Every action still runs with the OS permissions
 * of the user that launched the MCP server; it does not bypass sudo/root.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { collectRuntimeLogs, collectRuntimeStatus } = require('./runtime-diagnostics');

const HELPER = path.join(__dirname, 'desktop-control.py');
const DEFAULT_TIMEOUT_MS = numberEnv('MCP_CONTROL_TIMEOUT_MS', 120000, 1000, 600000);
const IMAGE_LIMIT_BYTES = numberEnv('MCP_IMAGE_LIMIT_BYTES', 25 * 1024 * 1024, 1024, 100 * 1024 * 1024);
const DESKTOP_ENABLED = boolEnv('MCP_DESKTOP_ENABLED', true);
const INPUT_ENABLED = boolEnv('MCP_INPUT_ENABLED', true);

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function commandEnv(extra = {}) {
  return {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':0',
    ...extra
  };
}

function execCommand(command, args = [], options = {}) {
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 600000);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args.map(String), {
      cwd: options.cwd,
      shell: false,
      env: commandEnv(options.env || {}),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const outputLimit = clampInt(options.outputLimit, 4 * 1024 * 1024, 1024, 32 * 1024 * 1024);

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
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
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
  const raw = String(command || '').trim();
  if (!raw || raw.includes('\0')) return false;
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const names = path.extname(raw) || process.platform !== 'win32'
    ? [raw]
    : extensions.map((extension) => `${raw}${extension}`);
  const directories = raw.includes('/') || raw.includes('\\')
    ? ['']
    : String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory ? path.join(directory, name) : name;
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return true;
      } catch (_) {}
    }
  }
  return false;
}

function imageMime(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.png': return 'image/png';
    default: return 'image/png';
  }
}

function imageToolResult(filePath, metadata = {}, removeAfter = false) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stats.size > IMAGE_LIMIT_BYTES) throw new Error(`Image too large: ${stats.size} bytes (limit ${IMAGE_LIMIT_BYTES})`);
  const data = fs.readFileSync(filePath).toString('base64');
  const payload = {
    ...metadata,
    path: filePath,
    size: stats.size,
    modified: stats.mtime.toISOString()
  };
  if (removeAfter) {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload, null, 2) },
      { type: 'image', data, mimeType: imageMime(filePath) }
    ],
    structuredContent: payload
  };
}

function temporaryPng(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`);
}

function makeTool(buildToolMetadata, name, title, description, properties = {}, required = [], annotations = {}) {
  return {
    name,
    ...buildToolMetadata(title, annotations),
    description,
    inputSchema: { type: 'object', properties, required }
  };
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout.trim() || '{}');
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}; ${result.stdout || result.stderr}`);
  }
}

function createFullControl({ resolvePath, buildToolMetadata, textResult }) {
  const ro = { readOnlyHint: true, openWorldHint: true };
  const rw = { destructiveHint: true, idempotentHint: false, openWorldHint: true };

  const tools = [
    // Capability / diagnostics
    makeTool(buildToolMetadata, 'control_capabilities', 'Control Capabilities', 'Probes which full-control backends are available on this machine (desktop, tmux, git, camera, audio, system tools).', {}, [], ro),
    makeTool(buildToolMetadata, 'mcp_runtime_status', 'MCP Runtime Status', 'Diagnoses this MCP server, its persistent systemd service, local health endpoint and ngrok/public URL without exposing tokens.', {}, [], ro),
    makeTool(buildToolMetadata, 'mcp_runtime_logs', 'MCP Runtime Logs', 'Returns a redacted, human-readable explanation of recent MCP activity, including what was requested, whether it succeeded and relevant service notices.', {
      lines: { type: 'number', description: 'Default 200, max 5000.' }
    }, [], ro),

    // Files / binary / logs
    makeTool(buildToolMetadata, 'file_info', 'File Info', 'Returns stat metadata for a file or directory.', {
      path: { type: 'string' }
    }, ['path'], ro),
    makeTool(buildToolMetadata, 'read_image', 'Read Image', 'Reads a local PNG/JPEG/WebP/GIF and returns it to the model as an image.', {
      path: { type: 'string' }
    }, ['path'], ro),
    makeTool(buildToolMetadata, 'tail_file', 'Tail File', 'Reads the last lines of a local text/log file.', {
      path: { type: 'string' },
      lines: { type: 'number', description: 'Number of lines, default 200, max 5000.' }
    }, ['path'], ro),

    // System / processes / services
    makeTool(buildToolMetadata, 'system_snapshot', 'System Snapshot', 'Returns host, OS, uptime, memory, load and desktop/session information.', {}, [], ro),
    makeTool(buildToolMetadata, 'hardware_info', 'Hardware Info', 'Returns CPU, memory, block devices and optional sensor information.', {}, [], ro),
    makeTool(buildToolMetadata, 'disk_usage', 'Disk Usage', 'Returns filesystem usage for a path.', {
      path: { type: 'string', description: 'Path to inspect. Default /.' }
    }, [], ro),
    makeTool(buildToolMetadata, 'network_status', 'Network Status', 'Returns interface addresses, routes and listening sockets.', {}, [], ro),
    makeTool(buildToolMetadata, 'gpu_status', 'GPU Status', 'Returns NVIDIA GPU status when available, otherwise PCI display adapters.', {}, [], ro),
    makeTool(buildToolMetadata, 'process_list', 'Process List', 'Lists local processes with PID, parent, CPU, memory, elapsed time and command.', {
      filter: { type: 'string', description: 'Optional case-insensitive substring filter.' },
      limit: { type: 'number', description: 'Default 200, max 2000.' }
    }, [], ro),
    makeTool(buildToolMetadata, 'process_info', 'Process Info', 'Returns detailed ps/proc information for a PID. Process environment is omitted by default to avoid accidental secret disclosure.', {
      pid: { type: 'number' },
      includeEnvironment: { type: 'boolean', description: 'Include /proc/PID/environ. Default false; may contain credentials or tokens.' }
    }, ['pid'], ro),
    makeTool(buildToolMetadata, 'process_signal', 'Signal Process', 'Sends a POSIX signal to a process owned/accessible by the MCP user.', {
      pid: { type: 'number' },
      signal: { type: 'string', description: 'SIGTERM, SIGINT, SIGKILL, SIGHUP, etc. Default SIGTERM.' }
    }, ['pid'], rw),
    makeTool(buildToolMetadata, 'process_start', 'Start Background Process', 'Starts a persistent detached process and redirects stdout/stderr to a log file.', {
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string', description: 'Working directory. Default current MCP working directory.' },
      logPath: { type: 'string', description: 'Optional log path. Defaults to /tmp/mcp-process-*.log when allowed.' }
    }, ['command'], rw),
    makeTool(buildToolMetadata, 'service_status', 'Service Status', 'Reads systemd service status.', {
      service: { type: 'string' },
      user: { type: 'boolean', description: 'Use systemctl --user.' }
    }, ['service'], ro),
    makeTool(buildToolMetadata, 'service_action', 'Service Action', 'Starts, stops, restarts, reloads, enables or disables a systemd service, subject to OS permissions.', {
      service: { type: 'string' },
      action: { type: 'string', enum: ['start', 'stop', 'restart', 'reload', 'enable', 'disable'] },
      user: { type: 'boolean', description: 'Use systemctl --user.' }
    }, ['service', 'action'], rw),
    makeTool(buildToolMetadata, 'journal_tail', 'Journal Tail', 'Reads recent systemd journal entries.', {
      unit: { type: 'string', description: 'Optional unit name.' },
      lines: { type: 'number', description: 'Default 200, max 5000.' },
      since: { type: 'string', description: 'Optional journalctl --since value, e.g. "1 hour ago".' },
      user: { type: 'boolean', description: 'Use user journal.' }
    }, [], ro),

    // Git
    makeTool(buildToolMetadata, 'git_status', 'Git Status', 'Shows branch and working tree status for a repository.', {
      repo: { type: 'string' }
    }, ['repo'], ro),
    makeTool(buildToolMetadata, 'git_diff', 'Git Diff', 'Shows a repository diff.', {
      repo: { type: 'string' },
      staged: { type: 'boolean' },
      pathspec: { type: 'string' }
    }, ['repo'], ro),
    makeTool(buildToolMetadata, 'git_log', 'Git Log', 'Shows recent commits.', {
      repo: { type: 'string' },
      limit: { type: 'number', description: 'Default 20, max 200.' }
    }, ['repo'], ro),
    makeTool(buildToolMetadata, 'git_branches', 'Git Branches', 'Shows local and remote branches with tracking information.', {
      repo: { type: 'string' }
    }, ['repo'], ro),
    makeTool(buildToolMetadata, 'git_worktrees', 'Git Worktrees', 'Shows worktrees for a repository.', {
      repo: { type: 'string' }
    }, ['repo'], ro),
    makeTool(buildToolMetadata, 'git_command', 'Git Command', 'Runs arbitrary git arguments inside a repository. Useful for commit, checkout, fetch, pull, push, worktree and other git operations.', {
      repo: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      timeoutMs: { type: 'number' }
    }, ['repo', 'args'], rw),

    // tmux / persistent agent sessions
    makeTool(buildToolMetadata, 'tmux_list', 'Tmux Sessions', 'Lists tmux sessions.', {}, [], ro),
    makeTool(buildToolMetadata, 'tmux_panes', 'Tmux Panes', 'Lists panes and current commands for a tmux session or all sessions.', {
      target: { type: 'string', description: 'Optional tmux target/session.' }
    }, [], ro),
    makeTool(buildToolMetadata, 'tmux_create', 'Create Tmux Session', 'Creates a detached tmux session, optionally launching a command such as codex.', {
      session: { type: 'string' },
      cwd: { type: 'string' },
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } }
    }, ['session'], rw),
    makeTool(buildToolMetadata, 'tmux_capture', 'Capture Tmux Pane', 'Captures recent text from a tmux pane so the model can audit an agent/terminal.', {
      target: { type: 'string', description: 'tmux target, e.g. ailen or ailen:0.0' },
      lines: { type: 'number', description: 'Default 300, max 10000.' }
    }, ['target'], ro),
    makeTool(buildToolMetadata, 'tmux_send', 'Send To Tmux', 'Sends literal text to a tmux pane and optionally presses Enter. Designed for supervising Codex CLI sessions.', {
      target: { type: 'string' },
      text: { type: 'string' },
      enter: { type: 'boolean', description: 'Press Enter after the text. Default true.' }
    }, ['target', 'text'], rw),
    makeTool(buildToolMetadata, 'tmux_interrupt', 'Interrupt Tmux Pane', 'Sends Ctrl-C to a tmux pane.', {
      target: { type: 'string' }
    }, ['target'], rw),
    makeTool(buildToolMetadata, 'tmux_kill', 'Kill Tmux Session', 'Kills a tmux session.', {
      session: { type: 'string' }
    }, ['session'], rw),

    // Desktop vision / input
    makeTool(buildToolMetadata, 'desktop_info', 'Desktop Info', 'Returns DISPLAY/session/window-manager information and input backend availability.', {}, [], ro),
    makeTool(buildToolMetadata, 'screen_capture', 'Capture Screen', 'Captures the full desktop or active window and returns the screenshot as an image.', {
      mode: { type: 'string', enum: ['screen', 'active_window'], description: 'Default screen.' },
      delay: { type: 'number', description: 'Optional delay in seconds, 0-10.' }
    }, [], ro),
    makeTool(buildToolMetadata, 'list_windows', 'List Windows', 'Lists X11 windows with IDs, geometry, class and title.', {}, [], ro),
    makeTool(buildToolMetadata, 'window_action', 'Window Action', 'Focuses, closes, maximizes, unmaximizes, minimizes, raises or moves/resizes an X11 window.', {
      id: { type: 'string', description: 'Window ID from list_windows.' },
      action: { type: 'string', enum: ['focus', 'close', 'maximize', 'unmaximize', 'minimize', 'raise', 'move_resize'] },
      x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }
    }, ['id', 'action'], rw),
    makeTool(buildToolMetadata, 'mouse_move', 'Move Mouse', 'Moves the X11 pointer to absolute screen coordinates.', {
      x: { type: 'number' }, y: { type: 'number' }
    }, ['x', 'y'], rw),
    makeTool(buildToolMetadata, 'mouse_click', 'Mouse Click', 'Clicks an X11 mouse button at the current pointer position.', {
      button: { type: 'number', description: '1 left, 2 middle, 3 right. Default 1.' },
      count: { type: 'number', description: 'Click count. Default 1.' },
      intervalMs: { type: 'number', description: 'Delay between clicks.' }
    }, [], rw),
    makeTool(buildToolMetadata, 'mouse_scroll', 'Mouse Scroll', 'Scrolls the X11 mouse wheel. Positive is up, negative is down.', {
      amount: { type: 'number' }
    }, ['amount'], rw),
    makeTool(buildToolMetadata, 'keyboard_hotkey', 'Keyboard Hotkey', 'Presses an X11 keyboard chord such as ctrl+shift+t or alt+f4.', {
      keys: { type: 'array', items: { type: 'string' } }
    }, ['keys'], rw),
    makeTool(buildToolMetadata, 'keyboard_type', 'Type Text', 'Types text into the focused X11 window using XTEST. Best for normal keyboard characters; tmux_send is preferred for long agent prompts.', {
      text: { type: 'string' },
      intervalMs: { type: 'number', description: 'Delay between keys, default 5 ms.' }
    }, ['text'], rw),
    makeTool(buildToolMetadata, 'desktop_open', 'Open Desktop Target', 'Opens a URL or local path with xdg-open in the desktop session.', {
      target: { type: 'string' }
    }, ['target'], rw),

    // Camera / audio
    makeTool(buildToolMetadata, 'camera_list', 'Camera List', 'Lists local video devices and optional v4l2 metadata.', {}, [], ro),
    makeTool(buildToolMetadata, 'camera_snapshot', 'Camera Snapshot', 'Captures one frame from a V4L2 camera and returns it as an image.', {
      device: { type: 'string', description: 'Default /dev/video0.' },
      width: { type: 'number' },
      height: { type: 'number' }
    }, [], ro),
    makeTool(buildToolMetadata, 'audio_devices', 'Audio Devices', 'Lists PulseAudio/PipeWire or ALSA sources and sinks.', {}, [], ro)
  ];

  async function shellBundle(commands) {
    const entries = await Promise.all(commands.map(async ([key, command, args]) => {
      try {
        const result = await execCommand(command, args, { timeoutMs: 15000 });
        return [key, { exit_code: result.exit_code, stdout: result.stdout.trim(), stderr: result.stderr.trim() }];
      } catch (error) {
        return [key, { error: error.message }];
      }
    }));
    return Object.fromEntries(entries);
  }

  function resolvedDirectory(userPath) {
    const resolved = resolvePath(userPath || '.');
    const stats = fs.statSync(resolved.fullPath);
    if (!stats.isDirectory()) throw new Error(`Not a directory: ${userPath}`);
    return resolved.fullPath;
  }

  async function runDesktopHelper(args) {
    if (!DESKTOP_ENABLED || !INPUT_ENABLED) throw new Error('Desktop input is disabled by MCP_DESKTOP_ENABLED/MCP_INPUT_ENABLED');
    if (!fs.existsSync(HELPER)) throw new Error(`Desktop helper missing: ${HELPER}`);
    const result = await requireSuccess('python3', [HELPER, ...args], { timeoutMs: 30000 });
    return parseJsonOutput(result, 'desktop-control.py');
  }

  async function captureScreen(args) {
    if (!DESKTOP_ENABLED) throw new Error('Desktop capture is disabled by MCP_DESKTOP_ENABLED');
    const mode = args.mode || 'screen';
    const delay = clampInt(args.delay, 0, 0, 10);
    const output = temporaryPng('mcp-screen');
    const failures = [];
    const wayland = String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY);
    const desktop = `${process.env.XDG_CURRENT_DESKTOP || ''} ${process.env.DESKTOP_SESSION || ''}`;
    const kdeWayland = wayland && /kde|plasma/i.test(desktop);

    async function attempt(backend, fn) {
      try {
        await fn();
        return imageToolResult(output, { kind: 'screenshot', mode, backend }, true);
      } catch (error) {
        failures.push(`${backend}: ${error.message}`);
        try { fs.unlinkSync(output); } catch (_) {}
        return null;
      }
    }

    // KDE Plasma Wayland exposes a reliable non-interactive screenshot path via Spectacle.
    // Prefer it there because gnome-screenshot can block waiting for GNOME-specific services.
    if (kdeWayland && await commandExists('spectacle')) {
      const result = await attempt('spectacle', async () => {
        const cmdArgs = ['-b', '-n', mode === 'active_window' ? '-a' : '-f'];
        if (delay > 0) cmdArgs.push('-d', String(delay * 1000));
        cmdArgs.push('-o', output);
        await requireSuccess('spectacle', cmdArgs, { timeoutMs: (delay + 20) * 1000 });
      });
      if (result) return result;
    }

    if (!kdeWayland && await commandExists('gnome-screenshot')) {
      const result = await attempt('gnome-screenshot', async () => {
        const cmdArgs = [];
        if (mode === 'active_window') cmdArgs.push('-w');
        if (delay > 0) cmdArgs.push('-d', String(delay));
        cmdArgs.push('-f', output);
        await requireSuccess('gnome-screenshot', cmdArgs, { timeoutMs: (delay + 15) * 1000 });
      });
      if (result) return result;
    }

    if (mode === 'screen' && await commandExists('grim')) {
      const result = await attempt('grim', async () => {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        await requireSuccess('grim', [output], { timeoutMs: 15000 });
      });
      if (result) return result;
    }

    if (mode === 'screen' && await commandExists('scrot')) {
      const result = await attempt('scrot', async () => {
        await requireSuccess('scrot', delay > 0 ? ['-d', String(delay), output] : [output], { timeoutMs: (delay + 15) * 1000 });
      });
      if (result) return result;
    }

    // Spectacle is also a useful fallback on X11/KDE and other sessions where it is installed.
    if (!kdeWayland && await commandExists('spectacle')) {
      const result = await attempt('spectacle', async () => {
        const cmdArgs = ['-b', '-n', mode === 'active_window' ? '-a' : '-f'];
        if (delay > 0) cmdArgs.push('-d', String(delay * 1000));
        cmdArgs.push('-o', output);
        await requireSuccess('spectacle', cmdArgs, { timeoutMs: (delay + 20) * 1000 });
      });
      if (result) return result;
    }

    throw new Error(`No screenshot backend succeeded${failures.length ? `: ${failures.join('; ')}` : ''}`);
  }

  async function callTool(name, args = {}) {
    switch (name) {
      case 'control_capabilities': {
        const commands = [
          'bash', 'git', 'tmux', 'systemctl', 'systemd-run', 'journalctl', 'ps', 'ip', 'ss',
          'lscpu', 'lsblk', 'findmnt', 'mount', 'umount', 'getent', 'tar', 'zip', 'unzip',
          'curl', 'wget', 'sha256sum', 'apt-get', 'dnf', 'pacman', 'zypper', 'apk',
          'ufw', 'firewall-cmd', 'nft', 'docker', 'podman', 'docker-compose',
          'nvidia-smi', 'wmctrl', 'spectacle', 'gnome-screenshot', 'grim', 'scrot',
          'ffmpeg', 'v4l2-ctl', 'pactl', 'arecord', 'aplay', 'xdg-open', 'python3'
        ];
        const available = {};
        for (const command of commands) available[command] = await commandExists(command);
        let desktopHelper = { available: false };
        if (available.python3 && fs.existsSync(HELPER)) {
          const probe = await execCommand('python3', [HELPER, '--help'], { timeoutMs: 10000 });
          desktopHelper = { available: probe.exit_code === 0, exit_code: probe.exit_code, stderr: probe.stderr.trim() };
        }
        const effectiveUid = typeof process.getuid === 'function' ? process.getuid() : null;
        let sudoNonInteractive = false;
        if (effectiveUid !== 0 && await commandExists('sudo')) {
          const sudoProbe = await execCommand('sudo', ['-n', 'true'], { timeoutMs: 5000 });
          sudoNonInteractive = sudoProbe.exit_code === 0;
        }
        return textResult({
          platform: process.platform,
          fullControlModule: true,
          desktopEnabled: DESKTOP_ENABLED,
          inputEnabled: INPUT_ENABLED,
          display: process.env.DISPLAY || '',
          waylandDisplay: process.env.WAYLAND_DISPLAY || '',
          sessionType: process.env.XDG_SESSION_TYPE || '',
          commands: available,
          desktopHelper,
          privileges: {
            effectiveUid,
            user: os.userInfo().username,
            root: effectiveUid === 0,
            sudoNonInteractive,
            administrativeToolsUsable: effectiveUid === 0 || sudoNonInteractive
          },
          note: 'All tools run with the permissions of the MCP server user; root-only actions require root or non-interactive sudo configured by the local administrator.'
        });
      }
      case 'mcp_runtime_status':
        return textResult(await collectRuntimeStatus());
      case 'mcp_runtime_logs':
        return textResult(await collectRuntimeLogs(clampInt(args.lines, 200, 1, 5000)));
      case 'file_info': {
        const { fullPath, displayPath } = resolvePath(args.path);
        const s = fs.statSync(fullPath);
        return textResult({
          path: displayPath,
          type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other',
          size: s.size,
          mode: `0${(s.mode & 0o7777).toString(8)}`,
          uid: s.uid,
          gid: s.gid,
          modified: s.mtime.toISOString(),
          created: s.birthtime.toISOString()
        });
      }
      case 'read_image': {
        const { fullPath, displayPath } = resolvePath(args.path);
        return imageToolResult(fullPath, { kind: 'local_image', displayPath });
      }
      case 'tail_file': {
        const { fullPath, displayPath } = resolvePath(args.path);
        const lines = clampInt(args.lines, 200, 1, 5000);
        const result = await requireSuccess('tail', ['-n', String(lines), '--', fullPath]);
        return textResult({ path: displayPath, lines, content: result.stdout });
      }
      case 'system_snapshot': {
        const extra = await shellBundle([
          ['os_release', 'bash', ['-lc', '. /etc/os-release 2>/dev/null; printf "%s" "${PRETTY_NAME:-unknown}"']],
          ['session', 'loginctl', ['show-session', process.env.XDG_SESSION_ID || 'self', '-p', 'Type', '-p', 'Class', '-p', 'State']]
        ]);
        return textResult({
          hostname: os.hostname(),
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          uptime_seconds: os.uptime(),
          loadavg: os.loadavg(),
          memory: { total: os.totalmem(), free: os.freemem() },
          user: os.userInfo().username,
          cwd: process.cwd(),
          desktop: {
            DISPLAY: process.env.DISPLAY || '',
            WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || '',
            XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE || '',
            DESKTOP_SESSION: process.env.DESKTOP_SESSION || '',
            XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP || ''
          },
          extra
        });
      }
      case 'hardware_info': {
        return textResult(await shellBundle([
          ['cpu', 'lscpu', []],
          ['memory', 'free', ['-h']],
          ['block_devices', 'lsblk', ['-o', 'NAME,MODEL,SIZE,FSTYPE,TYPE,MOUNTPOINTS']],
          ['sensors', 'sensors', []]
        ]));
      }
      case 'disk_usage': {
        const { fullPath } = resolvePath(args.path || '/');
        const result = await requireSuccess('df', ['-hT', '--', fullPath]);
        return textResult({ path: fullPath, output: result.stdout });
      }
      case 'network_status': {
        return textResult(await shellBundle([
          ['addresses', 'ip', ['-brief', 'address']],
          ['routes', 'ip', ['route']],
          ['listening', 'ss', ['-lntup']]
        ]));
      }
      case 'gpu_status': {
        if (await commandExists('nvidia-smi')) {
          const result = await requireSuccess('nvidia-smi', []);
          return textResult({ backend: 'nvidia-smi', output: result.stdout });
        }
        const result = await requireSuccess('lspci', []);
        const lines = result.stdout.split(/\r?\n/).filter((line) => /vga|3d|display/i.test(line));
        return textResult({ backend: 'lspci', output: lines.join('\n') });
      }
      case 'process_list': {
        const limit = clampInt(args.limit, 200, 1, 2000);
        const result = await requireSuccess('ps', ['-eo', 'pid,ppid,user,state,pcpu,pmem,etime,comm,args', '--sort=-pcpu']);
        let lines = result.stdout.split(/\r?\n/);
        const header = lines.shift() || '';
        if (args.filter) {
          const needle = String(args.filter).toLowerCase();
          lines = lines.filter((line) => line.toLowerCase().includes(needle));
        }
        return textResult({ filter: args.filter || null, output: [header, ...lines.slice(0, limit)].join('\n') });
      }
      case 'process_info': {
        const pid = clampInt(args.pid, 0, 1, 2147483647);
        const ps = await requireSuccess('ps', ['-p', String(pid), '-o', 'pid,ppid,user,group,state,pcpu,pmem,etime,lstart,comm,args']);
        const procPath = `/proc/${pid}`;
        const payload = { pid, ps: ps.stdout };
        for (const file of ['status', 'cmdline']) {
          try {
            const raw = fs.readFileSync(path.join(procPath, file));
            payload[file] = raw.toString('utf8').replace(/\0/g, ' ');
          } catch (_) {}
        }
        if (args.includeEnvironment) {
          try {
            payload.environ = fs.readFileSync(path.join(procPath, 'environ'), 'utf8').replace(/\0/g, '\n');
          } catch (_) {}
        }
        try { payload.cwd = fs.readlinkSync(path.join(procPath, 'cwd')); } catch (_) {}
        try { payload.exe = fs.readlinkSync(path.join(procPath, 'exe')); } catch (_) {}
        return textResult(payload);
      }
      case 'process_signal': {
        const pid = clampInt(args.pid, 0, 1, 2147483647);
        const signal = String(args.signal || 'SIGTERM').toUpperCase();
        process.kill(pid, signal);
        return textResult({ ok: true, pid, signal });
      }
      case 'process_start': {
        const cwd = resolvedDirectory(args.cwd || process.env.WORKING_DIR || '.');
        let logPath;
        if (args.logPath) {
          logPath = resolvePath(args.logPath).fullPath;
        } else {
          try {
            logPath = resolvePath(path.join(os.tmpdir(), `mcp-process-${Date.now()}.log`)).fullPath;
          } catch (_) {
            logPath = path.join(cwd, `.mcp-process-${Date.now()}.log`);
          }
        }
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const fd = fs.openSync(logPath, 'a');
        const child = spawn(String(args.command), Array.isArray(args.args) ? args.args.map(String) : [], {
          cwd,
          env: commandEnv(),
          shell: false,
          detached: true,
          stdio: ['ignore', fd, fd]
        });
        child.unref();
        fs.closeSync(fd);
        return textResult({ ok: true, pid: child.pid, command: args.command, args: args.args || [], cwd, logPath });
      }
      case 'service_status': {
        const cmdArgs = [];
        if (args.user) cmdArgs.push('--user');
        cmdArgs.push('status', String(args.service), '--no-pager', '--full');
        const result = await execCommand('systemctl', cmdArgs, { timeoutMs: 30000 });
        return textResult(result);
      }
      case 'service_action': {
        const cmdArgs = [];
        if (args.user) cmdArgs.push('--user');
        cmdArgs.push(String(args.action), String(args.service));
        const result = await requireSuccess('systemctl', cmdArgs, { timeoutMs: 60000 });
        return textResult(result);
      }
      case 'journal_tail': {
        const lines = clampInt(args.lines, 200, 1, 5000);
        const cmdArgs = ['--no-pager', '-n', String(lines), '-o', 'short-iso'];
        if (args.user) cmdArgs.push('--user');
        if (args.unit) cmdArgs.push('-u', String(args.unit));
        if (args.since) cmdArgs.push('--since', String(args.since));
        const result = await execCommand('journalctl', cmdArgs, { timeoutMs: 30000 });
        return textResult(result);
      }
      case 'git_status': {
        const repo = resolvedDirectory(args.repo);
        return textResult(await requireSuccess('git', ['-C', repo, 'status', '--short', '--branch']));
      }
      case 'git_diff': {
        const repo = resolvedDirectory(args.repo);
        const cmdArgs = ['-C', repo, 'diff'];
        if (args.staged) cmdArgs.push('--staged');
        if (args.pathspec) cmdArgs.push('--', String(args.pathspec));
        return textResult(await requireSuccess('git', cmdArgs, { outputLimit: 16 * 1024 * 1024 }));
      }
      case 'git_log': {
        const repo = resolvedDirectory(args.repo);
        const limit = clampInt(args.limit, 20, 1, 200);
        return textResult(await requireSuccess('git', ['-C', repo, 'log', '--oneline', '--decorate', `-${limit}`]));
      }
      case 'git_branches': {
        const repo = resolvedDirectory(args.repo);
        return textResult(await requireSuccess('git', ['-C', repo, 'branch', '--all', '-vv']));
      }
      case 'git_worktrees': {
        const repo = resolvedDirectory(args.repo);
        return textResult(await requireSuccess('git', ['-C', repo, 'worktree', 'list', '--porcelain']));
      }
      case 'git_command': {
        const repo = resolvedDirectory(args.repo);
        if (!Array.isArray(args.args)) throw new Error('args must be an array');
        return textResult(await execCommand('git', ['-C', repo, ...args.args.map(String)], { timeoutMs: clampInt(args.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 600000), outputLimit: 16 * 1024 * 1024 }));
      }
      case 'tmux_list': {
        const result = await execCommand('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created_string}']);
        if (result.exit_code !== 0 && /no server running|failed to connect/i.test(result.stderr)) return textResult({ sessions: [], output: '' });
        if (result.exit_code !== 0) throw new Error(result.stderr.trim() || 'tmux list-sessions failed');
        return textResult({ output: result.stdout });
      }
      case 'tmux_panes': {
        const cmdArgs = ['list-panes'];
        if (args.target) cmdArgs.push('-t', String(args.target));
        else cmdArgs.push('-a');
        cmdArgs.push('-F', '#{session_name}:#{window_index}.#{pane_index}\tpid=#{pane_pid}\tactive=#{pane_active}\tcmd=#{pane_current_command}\tcwd=#{pane_current_path}\ttitle=#{pane_title}');
        return textResult(await requireSuccess('tmux', cmdArgs));
      }
      case 'tmux_create': {
        const cmdArgs = ['new-session', '-d', '-s', String(args.session)];
        if (args.cwd) cmdArgs.push('-c', resolvedDirectory(args.cwd));
        if (args.command) cmdArgs.push(String(args.command), ...(Array.isArray(args.args) ? args.args.map(String) : []));
        return textResult(await requireSuccess('tmux', cmdArgs));
      }
      case 'tmux_capture': {
        const lines = clampInt(args.lines, 300, 1, 10000);
        const result = await requireSuccess('tmux', ['capture-pane', '-p', '-J', '-t', String(args.target), '-S', `-${lines}`], { outputLimit: 16 * 1024 * 1024 });
        return textResult({ target: args.target, lines, content: result.stdout });
      }
      case 'tmux_send': {
        const target = String(args.target);
        await requireSuccess('tmux', ['send-keys', '-t', target, '-l', '--', String(args.text)], { timeoutMs: 30000 });
        if (args.enter !== false) await requireSuccess('tmux', ['send-keys', '-t', target, 'Enter'], { timeoutMs: 30000 });
        return textResult({ ok: true, target, chars: String(args.text).length, enter: args.enter !== false });
      }
      case 'tmux_interrupt': {
        await requireSuccess('tmux', ['send-keys', '-t', String(args.target), 'C-c']);
        return textResult({ ok: true, target: args.target });
      }
      case 'tmux_kill': {
        await requireSuccess('tmux', ['kill-session', '-t', String(args.session)]);
        return textResult({ ok: true, session: args.session });
      }
      case 'desktop_info': {
        const commands = await shellBundle([
          ['window_manager', 'wmctrl', ['-m']],
          ['display', 'xdpyinfo', []]
        ]);
        return textResult({
          enabled: DESKTOP_ENABLED,
          inputEnabled: INPUT_ENABLED,
          helperExists: fs.existsSync(HELPER),
          env: {
            DISPLAY: process.env.DISPLAY || '',
            WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || '',
            XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE || '',
            XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP || '',
            DESKTOP_SESSION: process.env.DESKTOP_SESSION || ''
          },
          commands
        });
      }
      case 'screen_capture':
        return captureScreen(args);
      case 'list_windows': {
        if (!DESKTOP_ENABLED) throw new Error('Desktop tools disabled');
        const result = await requireSuccess('wmctrl', ['-lGpx']);
        return textResult({ output: result.stdout });
      }
      case 'window_action': {
        if (!DESKTOP_ENABLED) throw new Error('Desktop tools disabled');
        const id = String(args.id);
        switch (args.action) {
          case 'focus': await requireSuccess('wmctrl', ['-ia', id]); break;
          case 'close': await requireSuccess('wmctrl', ['-ic', id]); break;
          case 'maximize': await requireSuccess('wmctrl', ['-ir', id, '-b', 'add,maximized_vert,maximized_horz']); break;
          case 'unmaximize': await requireSuccess('wmctrl', ['-ir', id, '-b', 'remove,maximized_vert,maximized_horz']); break;
          case 'minimize': await requireSuccess('wmctrl', ['-ir', id, '-b', 'add,hidden']); break;
          case 'raise': await requireSuccess('wmctrl', ['-ir', id, '-b', 'add,above']); break;
          case 'move_resize': {
            for (const key of ['x', 'y', 'width', 'height']) if (!Number.isFinite(Number(args[key]))) throw new Error(`${key} is required for move_resize`);
            await requireSuccess('wmctrl', ['-ir', id, '-e', `0,${Math.trunc(args.x)},${Math.trunc(args.y)},${Math.trunc(args.width)},${Math.trunc(args.height)}`]);
            break;
          }
          default: throw new Error(`Unsupported window action: ${args.action}`);
        }
        return textResult({ ok: true, id, action: args.action });
      }
      case 'mouse_move':
        return textResult(await runDesktopHelper(['mouse-move', String(Math.trunc(args.x)), String(Math.trunc(args.y))]));
      case 'mouse_click':
        return textResult(await runDesktopHelper(['mouse-click', '--button', String(clampInt(args.button, 1, 1, 9)), '--count', String(clampInt(args.count, 1, 1, 20)), '--interval-ms', String(clampInt(args.intervalMs, 80, 0, 5000))]));
      case 'mouse_scroll':
        return textResult(await runDesktopHelper(['mouse-scroll', String(clampInt(args.amount, 0, -100, 100))]));
      case 'keyboard_hotkey': {
        if (!Array.isArray(args.keys) || args.keys.length === 0) throw new Error('keys must be a non-empty array');
        return textResult(await runDesktopHelper(['hotkey', args.keys.map(String).join('+')]));
      }
      case 'keyboard_type':
        return textResult(await runDesktopHelper(['type-text', String(args.text), '--interval-ms', String(clampInt(args.intervalMs, 5, 0, 5000))]));
      case 'desktop_open': {
        if (!DESKTOP_ENABLED) throw new Error('Desktop tools disabled');
        const target = String(args.target);
        let resolvedTarget = target;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
          try { resolvedTarget = resolvePath(target).fullPath; } catch (_) { resolvedTarget = target; }
        }
        const child = spawn('xdg-open', [resolvedTarget], { detached: true, stdio: 'ignore', env: commandEnv() });
        child.unref();
        return textResult({ ok: true, target: resolvedTarget, pid: child.pid });
      }
      case 'camera_list': {
        const devices = [];
        try {
          for (const entry of fs.readdirSync('/dev')) if (/^video\d+$/.test(entry)) devices.push(`/dev/${entry}`);
        } catch (_) {}
        let v4l2 = null;
        if (await commandExists('v4l2-ctl')) v4l2 = await execCommand('v4l2-ctl', ['--list-devices'], { timeoutMs: 10000 });
        return textResult({ devices, v4l2 });
      }
      case 'camera_snapshot': {
        const device = String(args.device || '/dev/video0');
        if (!fs.existsSync(device)) throw new Error(`Camera device not found: ${device}`);
        const output = temporaryPng('mcp-camera');
        const cmdArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'v4l2'];
        if (args.width && args.height) cmdArgs.push('-video_size', `${clampInt(args.width, 640, 16, 7680)}x${clampInt(args.height, 480, 16, 4320)}`);
        cmdArgs.push('-i', device, '-frames:v', '1', output);
        await requireSuccess('ffmpeg', cmdArgs, { timeoutMs: 20000 });
        return imageToolResult(output, { kind: 'camera_snapshot', device }, true);
      }
      case 'audio_devices': {
        if (await commandExists('pactl')) {
          const sources = await execCommand('pactl', ['list', 'short', 'sources']);
          const sinks = await execCommand('pactl', ['list', 'short', 'sinks']);
          return textResult({ backend: 'pactl', sources: sources.stdout, sinks: sinks.stdout, errors: [sources.stderr, sinks.stderr].filter(Boolean) });
        }
        return textResult(await shellBundle([
          ['capture', 'arecord', ['-l']],
          ['playback', 'aplay', ['-l']]
        ]));
      }
      default:
        return null;
    }
  }

  return { tools, callTool };
}

module.exports = { createFullControl };
