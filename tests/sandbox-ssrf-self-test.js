#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  validatePathWithinRoots,
  validateEgressUrl,
  detectOsIsolationCapabilities,
  assertRestrictedIsolationAllowed,
  wrapCommandInSandbox
} = require('../lib/sandbox');
const { createExtendedTools, safeFetchWithEgressValidation } = require('../lib/extended-tools');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function testPathTraversalAndContainment() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sandbox-fs-'));
  const subFolder = path.join(tempDir, 'allowed_folder');
  fs.mkdirSync(subFolder);
  const secretFolder = path.join(tempDir, 'secret_folder');
  fs.mkdirSync(secretFolder);
  fs.writeFileSync(path.join(secretFolder, 'secret.txt'), 'PRIVATE_DATA');

  try {
    const allowedRoots = [subFolder];

    // Valid path inside allowed folder
    const validFile = path.join(subFolder, 'hello.txt');
    fs.writeFileSync(validFile, 'hello');
    const checked = validatePathWithinRoots(validFile, allowedRoots);
    assert.equal(checked, path.resolve(validFile));

    // Traversal via ../
    assert.throws(() => {
      validatePathWithinRoots(path.join(subFolder, '../secret_folder/secret.txt'), allowedRoots);
    }, /fuera de las rutas permitidas|traversal/i);

    // Deep traversal
    assert.throws(() => {
      validatePathWithinRoots(path.join(subFolder, '../../../../../../etc/passwd'), allowedRoots);
    }, /fuera de las rutas permitidas/i);

    // Symlink escape on existing file
    const symlinkEscape = path.join(subFolder, 'symlink_to_secret');
    fs.symlinkSync(secretFolder, symlinkEscape);
    assert.throws(() => {
      validatePathWithinRoots(path.join(symlinkEscape, 'secret.txt'), allowedRoots);
    }, /fuera de las rutas permitidas|symlink/i);

    // Finding B reproduction: symlink to outside, target file DOES NOT EXIST yet.
    // validatePathWithinRoots must check the nearest existing ancestor, resolve its canonical symlink target,
    // and reject the path BEFORE allowing write_file or patch_file to write into secretFolder!
    const nonExistentInsideSymlink = path.join(symlinkEscape, 'new_secret_file.txt');
    assert.throws(() => {
      validatePathWithinRoots(nonExistentInsideSymlink, allowedRoots);
    }, /fuera de las rutas permitidas|symlink/i);

    // Ensure outside folder remains completely untouched
    assert.equal(fs.existsSync(path.join(secretFolder, 'new_secret_file.txt')), false);

    // Deep non-existent path via symlink
    const deepNonExistent = path.join(symlinkEscape, 'sub1', 'sub2', 'file.txt');
    assert.throws(() => {
      validatePathWithinRoots(deepNonExistent, allowedRoots);
    }, /fuera de las rutas permitidas|symlink/i);

    // Broken symlink pointing outside
    const brokenSymlink = path.join(subFolder, 'broken_link');
    fs.symlinkSync(path.join(tempDir, 'does_not_exist_outside'), brokenSymlink);
    assert.throws(() => {
      validatePathWithinRoots(path.join(brokenSymlink, 'file.txt'), allowedRoots);
    }, /fuera de las rutas permitidas|symlink|enlace roto/i);

    // Zip slip validation test
    const maliciousZipEntry = '../../etc/shadow';
    assert.throws(() => {
      validatePathWithinRoots(maliciousZipEntry, allowedRoots);
    }, /fuera de las rutas permitidas|protegido/i);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testEgressSsrfDefenses() {
  // 1. Loopback IPv4
  await assert.rejects(async () => {
    await validateEgressUrl('http://127.0.0.1:8080/admin');
  }, /loopback|privada|bloquead/i);

  await assert.rejects(async () => {
    await validateEgressUrl('http://127.123.4.5:3000/internal');
  }, /loopback|privada|bloquead/i);

  await assert.rejects(async () => {
    await validateEgressUrl('http://0.0.0.0:80');
  }, /loopback|privada|bloquead/i);

  // 2. IPv4 Private Ranges
  // 10.0.0.0/8
  await assert.rejects(async () => {
    await validateEgressUrl('http://10.0.0.1/status');
  }, /privada|restringida|no permitida/i);

  // 172.16.0.0/12
  await assert.rejects(async () => {
    await validateEgressUrl('http://172.16.0.10:9000');
  }, /privada|restringida|no permitida/i);

  // 192.168.0.0/16
  await assert.rejects(async () => {
    await validateEgressUrl('http://192.168.1.1/router');
  }, /privada|restringida|no permitida/i);

  // 169.254.169.254 (Cloud metadata service)
  await assert.rejects(async () => {
    await validateEgressUrl('http://169.254.169.254/latest/meta-data/');
  }, /privada|restringida|link-local|no permitida/i);

  // 3. IPv6 Loopback & Link-local
  await assert.rejects(async () => {
    await validateEgressUrl('http://[::1]:8080/');
  }, /loopback|no permitida/i);

  await assert.rejects(async () => {
    await validateEgressUrl('http://[fc00::1]:80/');
  }, /privada|restringida|no permitida/i);

  await assert.rejects(async () => {
    await validateEgressUrl('http://[fe80::1]:80/');
  }, /privada|restringida|no permitida/i);

  // 4. Localhost hostname
  await assert.rejects(async () => {
    await validateEgressUrl('http://localhost:3000/');
  }, /loopback|localhost|no permitida/i);

  // 5. Allowed domains filtering
  const allowed = ['api.github.com', 'raw.githubusercontent.com'];

  // Allowed domain succeeds URL check
  const validated = await validateEgressUrl('https://api.github.com/zen', { allowedDomains: allowed, resolveDns: false });
  assert.equal(validated.hostname, 'api.github.com');

  // Non-allowed domain rejected
  await assert.rejects(async () => {
    await validateEgressUrl('https://evil-attacker.com/leak', { allowedDomains: allowed, resolveDns: false });
  }, /no está en la lista de dominios permitidos/i);
}

async function testEgressRedirectSsrfBlocking() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const server = http.createServer((req, res) => {
    if (req.url === '/redirect-to-metadata') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (req.url === '/redirect-to-private') {
      res.writeHead(302, { Location: 'http://10.0.0.1/admin' });
      res.end();
      return;
    }
    if (req.url === '/redirect-to-loopback') {
      res.writeHead(302, { Location: `http://127.0.0.1:22/` });
      res.end();
      return;
    }
    if (req.url === '/redirect-loop') {
      res.writeHead(302, { Location: `${base}/redirect-loop` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));

  const origAllow = process.env.MCP_ALLOW_LOCAL_EGRESS;
  try {
    // 1. Without MCP_ALLOW_LOCAL_EGRESS, initial connection to 127.0.0.1 is blocked
    delete process.env.MCP_ALLOW_LOCAL_EGRESS;
    await assert.rejects(async () => {
      await safeFetchWithEgressValidation(`${base}/ok`);
    }, /loopback|privada|bloquead/i);

    // 2. With MCP_ALLOW_LOCAL_EGRESS=1 (simulating public URL that redirects to internal/private targets):
    process.env.MCP_ALLOW_LOCAL_EGRESS = '1';

    // Normal fetch succeeds
    const okRes = await safeFetchWithEgressValidation(`${base}/ok`);
    assert.equal(await okRes.text(), 'ok');

    // Finding K: Redirect to AWS metadata service (169.254.169.254) MUST be blocked
    await assert.rejects(async () => {
      await safeFetchWithEgressValidation(`${base}/redirect-to-metadata`);
    }, /privada|restringida|link-local|no permitida/i);

    // Redirect to private IP (10.0.0.1) MUST be blocked
    await assert.rejects(async () => {
      await safeFetchWithEgressValidation(`${base}/redirect-to-private`);
    }, /privada|restringida|no permitida/i);

    // Redirect loop is bounded (max 5 redirects)
    await assert.rejects(async () => {
      await safeFetchWithEgressValidation(`${base}/redirect-loop`);
    }, /demasiadas redirecciones/i);

  } finally {
    if (origAllow !== undefined) process.env.MCP_ALLOW_LOCAL_EGRESS = origAllow;
    else delete process.env.MCP_ALLOW_LOCAL_EGRESS;
    server.close();
  }
}

async function testZipSlipAndArchiveExtractionSafety() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-archive-slip-'));
  const allowedDir = path.join(tempDir, 'allowed');
  const targetDir = path.join(allowedDir, 'dest');
  fs.mkdirSync(allowedDir);
  fs.mkdirSync(targetDir);

  const outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(outsideDir);

  try {
    const extTools = createExtendedTools({
      resolvePath: (targetPath) => ({
        fullPath: validatePathWithinRoots(targetPath || '.', [allowedDir]),
        displayPath: targetPath
      }),
      buildToolMetadata: (name, extra = {}) => ({ title: name, ...extra }),
      textResult: (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] })
    });

    // 1. Create malicious TAR with relative path traversal entry ../../outside/escaped.txt
    const maliciousTar = path.join(allowedDir, 'slip.tar');
    const createTar = spawnSync('python3', ['-c', [
      'import io, tarfile, sys',
      'with tarfile.open(sys.argv[1], "w") as tf:',
      '  data = b"ESCAPED_TAR_DATA"',
      '  info = tarfile.TarInfo("../../outside/escaped.txt")',
      '  info.size = len(data)',
      '  tf.addfile(info, io.BytesIO(data))'
    ].join('\n'), maliciousTar], { encoding: 'utf8' });
    assert.equal(createTar.status, 0);

    // Attempt extraction via archive_extract
    await assert.rejects(async () => {
      await extTools.callTool('archive_extract', {
        archive: maliciousTar,
        destination: targetDir
      });
    }, /unsafe archive entry|escapes destination/i);

    // Outside file must NOT exist
    assert.equal(fs.existsSync(path.join(outsideDir, 'escaped.txt')), false);

    // 2. Create malicious ZIP with relative path traversal entry
    const maliciousZip = path.join(allowedDir, 'slip.zip');
    const createZip = spawnSync('python3', ['-c', [
      'import io, zipfile, sys',
      'with zipfile.ZipFile(sys.argv[1], "w") as zf:',
      '  zf.writestr("../../outside/escaped_zip.txt", b"ESCAPED_ZIP_DATA")'
    ].join('\n'), maliciousZip], { encoding: 'utf8' });
    assert.equal(createZip.status, 0);

    await assert.rejects(async () => {
      await extTools.callTool('archive_extract', {
        archive: maliciousZip,
        destination: targetDir
      });
    }, /unsafe archive entry|escapes destination/i);

    assert.equal(fs.existsSync(path.join(outsideDir, 'escaped_zip.txt')), false);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testFailClosedRestrictedIsolation() {
  const caps = detectOsIsolationCapabilities();
  assert.ok(typeof caps === 'object');
  assert.ok('hasBwrap' in caps);
  assert.ok('hasDockerSocket' in caps);
  assert.ok('hasOsIsolation' in caps);

  // String '0' in MCP_SYSTEMD_SANDBOX must NOT be treated as active isolation
  const envFakeSystemd = {
    INVOCATION_ID: 'test-unit-123',
    MCP_SYSTEMD_SANDBOX: '0',
    MCP_TEST_FORCE_NO_ISOLATION: '1'
  };
  const capsFake = detectOsIsolationCapabilities(envFakeSystemd);
  assert.equal(capsFake.hasOsIsolation, false, 'MCP_SYSTEMD_SANDBOX="0" must not be considered isolation');

  // When isolation is requested without explicit authorized boundary,
  // assertRestrictedIsolationAllowed MUST fail closed rather than falling back silently.
  const envNoIsolation = {
    MCP_ALLOW_RESTRICTED_WITHOUT_ISOLATION: '0',
    MCP_TEST_FORCE_NO_ISOLATION: '1'
  };

  assert.throws(() => {
    assertRestrictedIsolationAllowed(envNoIsolation);
  }, /no cuenta con aislamiento real|falla cerrado|sin fallback silencioso/i);

  // Finding C: Production mode must ignore MCP_TEST_MOCK_ISOLATION
  const envProd = {
    NODE_ENV: 'production',
    MCP_TEST_MOCK_ISOLATION: '1',
    MCP_TEST_FORCE_NO_ISOLATION: '1'
  };
  const capsProd = detectOsIsolationCapabilities(envProd);
  assert.equal(capsProd.hasOsIsolation, false, 'MCP_TEST_MOCK_ISOLATION must be ignored in production');
}

async function testSandboxCommandWrapping() {
  const caps = detectOsIsolationCapabilities();
  if (caps.hasBwrap) {
    const tempDir = fs.mkdtempSync('/tmp/mcp-wrap-test-');
    try {
      const wrapped = wrapCommandInSandbox('echo', ['hello'], {
        allowedRoots: [tempDir],
        cwd: tempDir
      });

      assert.equal(wrapped.isolated, true);
      assert.equal(wrapped.mechanism, 'bubblewrap');
      assert.equal(wrapped.command, 'bwrap');

      const argsStr = wrapped.args.join(' ');
      // Must drop caps, isolate net, and isolate namespaces
      assert.ok(argsStr.includes('--unshare-all'));
      assert.ok(argsStr.includes('--unshare-net'));
      assert.ok(argsStr.includes('--cap-drop ALL'));
      assert.ok(argsStr.includes('--ro-bind /usr /usr'));
      assert.ok(argsStr.includes('--tmpfs /tmp'));
      assert.ok(argsStr.includes(`--chdir ${tempDir}`));
      assert.ok(argsStr.includes('-- echo hello'));
    } finally {
      try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
    }
  }
}

async function run() {
  await testPathTraversalAndContainment();
  await testEgressSsrfDefenses();
  await testEgressRedirectSsrfBlocking();
  await testZipSlipAndArchiveExtractionSafety();
  await testFailClosedRestrictedIsolation();
  await testSandboxCommandWrapping();
  process.stdout.write('sandbox_ssrf=OK\n');
}

run().catch((err) => {
  console.error('Sandbox SSRF test failed:', err);
  process.exit(1);
});

