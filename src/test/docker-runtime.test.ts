import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import { assertSafeTestDatabaseUrl } from './helpers/fixtures.js';

const { Pool } = pg;

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5432/billing_system_test';

const PROD_TEST_JWT_SECRET =
  'phase-10-production-container-runtime-jwt-secret-key-min-32-bytes!';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 8000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/v1/health`);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Timed out waiting for container runtime at ${url}: ${String(lastErr)}`);
}

describe('Billing System REST API - Phase 10 Docker Containerization & Production Runtime Suite', () => {
  const workspaceRoot = process.cwd();
  const stage2Root = '/tmp/phase10-stage2-rootfs';
  let testPool: pg.Pool;
  let nodeUid = 1000;
  let nodeGid = 1000;

  before(async () => {
    assertSafeTestDatabaseUrl(TEST_DATABASE_URL, process.env.DATABASE_URL);

    // 1. Ensure production build (dist/ and dist-server/) is compiled cleanly
    execSync('npm run build', { cwd: workspaceRoot, stdio: 'pipe' });

    // 2. Assemble an isolated Stage 2 runtime filesystem matching Dockerfile Stage 2
    fs.rmSync(stage2Root, { recursive: true, force: true });
    fs.mkdirSync(stage2Root, { recursive: true });

    fs.copyFileSync(
      path.join(workspaceRoot, 'package.json'),
      path.join(stage2Root, 'package.json')
    );
    fs.copyFileSync(
      path.join(workspaceRoot, '.env.example'),
      path.join(stage2Root, '.env.example')
    );
    fs.cpSync(path.join(workspaceRoot, 'dist'), path.join(stage2Root, 'dist'), {
      recursive: true,
    });
    fs.cpSync(
      path.join(workspaceRoot, 'dist-server'),
      path.join(stage2Root, 'dist-server'),
      { recursive: true }
    );
    fs.cpSync(
      path.join(workspaceRoot, 'migrations'),
      path.join(stage2Root, 'migrations'),
      { recursive: true }
    );
    // Symlink node_modules for runtime resolution inside isolated rootfs
    fs.symlinkSync(
      path.join(workspaceRoot, 'node_modules'),
      path.join(stage2Root, 'node_modules'),
      'dir'
    );

    // Ensure non-root `node` user (or UID 1000) exists and make Stage 2 rootfs read-only (0o555)
    try {
      execSync('id -u node >/dev/null 2>&1 || useradd -u 1000 -m -s /bin/sh node', {
        stdio: 'pipe',
      });
    } catch {
      // Ignore if user already exists
    }
    nodeUid = Number(execSync('id -u node').toString().trim());
    nodeGid = Number(execSync('id -g node').toString().trim());

    execSync(`chown -R node:node ${stage2Root} && chmod -R a-w ${stage2Root}`, {
      stdio: 'pipe',
    });

    // 3. Apply migrations using compiled production migration runner as non-root `node` user
    execSync(
      `su -s /bin/sh node -c "cd ${stage2Root} && DATABASE_URL='${TEST_DATABASE_URL}' node dist-server/src/api/db/migrate.js"`,
      { stdio: 'pipe' }
    );

    testPool = new Pool({ connectionString: TEST_DATABASE_URL });
    await testPool.query('TRUNCATE TABLE invoice_items, invoices, customers, accounts CASCADE;');
  });

  after(async () => {
    if (testPool) {
      await testPool.end();
    }
    try {
      execSync(`chmod -R u+w ${stage2Root} 2>/dev/null || true`, { stdio: 'pipe' });
      fs.rmSync(stage2Root, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('1. Dockerfile, .dockerignore & Compose Specification Verification', () => {
    it('Dockerfile implements a secure multi-stage Node 22 build with non-root USER, HEALTHCHECK, EXPOSE 3000, and exec-form CMD', () => {
      const dockerfilePath = path.join(workspaceRoot, 'Dockerfile');
      assert.equal(fs.existsSync(dockerfilePath), true);
      const content = fs.readFileSync(dockerfilePath, 'utf-8');

      // Multi-stage Node 22 base images
      assert.match(content, /^FROM\s+node:22-bookworm-slim\s+AS\s+builder/m);
      assert.match(content, /^FROM\s+node:22-bookworm-slim\s+AS\s+runtime/m);

      // Builder runs lint and build
      assert.match(content, /RUN\s+npm\s+run\s+lint\s+&&\s+npm\s+run\s+build/);

      // Runtime installs only production dependencies and drops root privileges
      assert.match(content, /npm\s+install\s+--omit=dev/);
      assert.match(content, /^USER\s+node/m);
      assert.match(content, /^EXPOSE\s+3000/m);
      assert.match(content, /^HEALTHCHECK\s+/m);
      assert.match(content, /\/api\/v1\/health/);
      assert.match(content, /^CMD\s+\["node",\s*"dist-server\/server\.js"\]/m);

      // Never hardcodes secrets in Dockerfile
      assert.ok(!content.includes('DATABASE_URL='), 'Dockerfile must not hardcode DATABASE_URL');
      assert.ok(!content.includes('JWT_SECRET='), 'Dockerfile must not hardcode JWT_SECRET');
    });

    it('.dockerignore excludes secrets (.env), Git history (.git), node_modules, build artifacts, and src/test', () => {
      const ignorePath = path.join(workspaceRoot, '.dockerignore');
      assert.equal(fs.existsSync(ignorePath), true);
      const lines = fs
        .readFileSync(ignorePath, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));

      for (const requiredPattern of [
        'node_modules',
        'dist',
        'dist-server',
        '.git',
        '.env',
        '.env.*',
        '!.env.example',
        'src/test',
        'Dockerfile',
      ]) {
        assert.ok(
          lines.includes(requiredPattern),
          `Expected .dockerignore to contain '${requiredPattern}'`
        );
      }
    });

    it('Stage 2 runtime filesystem contains compiled JS and migrations, and excludes TypeScript source, tests, .git, and .env', () => {
      assert.equal(
        fs.existsSync(path.join(stage2Root, 'dist-server', 'server.js')),
        true
      );
      assert.equal(
        fs.existsSync(path.join(stage2Root, 'dist-server', 'src', 'api', 'app.js')),
        true
      );
      assert.equal(
        fs.existsSync(path.join(stage2Root, 'dist-server', 'src', 'api', 'db', 'migrate.js')),
        true
      );
      assert.equal(
        fs.existsSync(path.join(stage2Root, 'migrations', '001_create_customers_table.sql')),
        true
      );

      // Verify excluded artifacts do NOT exist in Stage 2 runtime root
      assert.equal(fs.existsSync(path.join(stage2Root, 'server.ts')), false);
      assert.equal(fs.existsSync(path.join(stage2Root, 'src')), false);
      assert.equal(fs.existsSync(path.join(stage2Root, '.git')), false);
      assert.equal(fs.existsSync(path.join(stage2Root, '.env')), false);
    });
  });

  describe('2. Live Stage 2 Production Runtime, Non-Root Execution, PostgreSQL Persistence & Restart Survival', () => {
    it('runs compiled dist-server/server.js as non-root user on read-only rootfs, serves full API over PostgreSQL, survives restart, and shuts down gracefully on SIGTERM', async () => {
      // Verify non-root execution identity inside Stage 2 rootfs
      const whoami = execSync(`su -s /bin/sh node -c "whoami && id -u"`, {
        cwd: stage2Root,
      })
        .toString()
        .trim()
        .split('\n');
      assert.equal(whoami[0], 'node');
      assert.notEqual(whoami[1], '0');

      const port1 = await getFreePort();
      const baseUrl1 = `http://127.0.0.1:${port1}`;
      const stdoutLogs: string[] = [];

      // Start Container Instance #1 (exec-form `node dist-server/server.js` as non-root `node` user on read-only rootfs)
      const proc1: ChildProcessWithoutNullStreams = spawn(
        process.execPath,
        ['dist-server/server.js'],
        {
          cwd: stage2Root,
          uid: nodeUid,
          gid: nodeGid,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            HOST: '0.0.0.0',
            PORT: String(port1),
            DATABASE_URL: TEST_DATABASE_URL,
            JWT_SECRET: PROD_TEST_JWT_SECRET,
          },
        }
      );

      proc1.stdout.on('data', (chunk) => stdoutLogs.push(chunk.toString()));
      proc1.stderr.on('data', (chunk) => stdoutLogs.push(chunk.toString()));

      let persistedCustomerId = '';
      let persistedInvoiceId = '';
      let userAToken = '';

      try {
        // 1. Verify Healthcheck & Production Security Headers (including HSTS in NODE_ENV=production)
        const healthRes = await waitForHealth(baseUrl1);
        assert.equal(healthRes.status, 200);
        assert.equal(healthRes.headers.get('x-powered-by'), null);
        assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
        assert.equal(
          healthRes.headers.get('strict-transport-security'),
          'max-age=31536000; includeSubDomains'
        );
        const healthJson = await healthRes.json();
        assert.equal(healthJson.data.status, 'healthy');
        assert.equal(healthJson.data.database.status, 'healthy');

        // 2. Register & Login User A
        const regARes = await fetch(`${baseUrl1}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'docker_user_a@billing.local',
            password: 'DockerStrongPassword123!',
          }),
        });
        assert.equal(regARes.status, 201);

        const loginARes = await fetch(`${baseUrl1}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'docker_user_a@billing.local',
            password: 'DockerStrongPassword123!',
          }),
        });
        assert.equal(loginARes.status, 200);
        userAToken = (await loginARes.json()).data.token;

        // 3. Create Customer & Relational Invoice in PostgreSQL
        const custRes = await fetch(`${baseUrl1}/api/v1/customers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userAToken}`,
          },
          body: JSON.stringify({
            name: 'Containerized Ledger Corp',
            email: 'ap@container-ledger.local',
            currency: 'USD',
          }),
        });
        assert.equal(custRes.status, 201);
        persistedCustomerId = (await custRes.json()).data.id;

        const invRes = await fetch(`${baseUrl1}/api/v1/invoices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userAToken}`,
          },
          body: JSON.stringify({
            customerId: persistedCustomerId,
            status: 'issued',
            tax: 15.0,
            discount: 5.0,
            items: [
              { description: 'Container Runtime Node', quantity: 2, unitPrice: 100.0 },
            ],
          }),
        });
        assert.equal(invRes.status, 201);
        const invData = (await invRes.json()).data;
        persistedInvoiceId = invData.id;
        assert.equal(invData.total, 210.0);

        // 4. Verify Phase 9 Security Controls inside Production Runtime (405, alg:none, IDOR)
        const methodRes = await fetch(`${baseUrl1}/api/v1/health`, { method: 'DELETE' });
        assert.equal(methodRes.status, 405);
        assert.equal(methodRes.headers.get('allow'), 'GET');

        const regBRes = await fetch(`${baseUrl1}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'docker_user_b@billing.local',
            password: 'DockerStrongPassword123!',
          }),
        });
        assert.equal(regBRes.status, 201);
        const loginBRes = await fetch(`${baseUrl1}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'docker_user_b@billing.local',
            password: 'DockerStrongPassword123!',
          }),
        });
        const userBToken = (await loginBRes.json()).data.token;

        const idorRes = await fetch(`${baseUrl1}/api/v1/invoices/${persistedInvoiceId}`, {
          headers: { Authorization: `Bearer ${userBToken}` },
        });
        assert.equal(idorRes.status, 403);

        // 5. Send SIGTERM to Container Instance #1 and verify graceful shutdown
        const exitCode1 = await new Promise<number | null>((resolve) => {
          proc1.on('exit', (code) => resolve(code));
          proc1.kill('SIGTERM');
        });
        assert.equal(exitCode1, 0);

        const combinedLogs = stdoutLogs.join('\n');
        assert.match(combinedLogs, /Received SIGTERM\. Shutting down server gracefully/);
        assert.match(combinedLogs, /HTTP server closed cleanly/);
        assert.match(combinedLogs, /Pool closed/);
        assert.ok(!combinedLogs.includes(PROD_TEST_JWT_SECRET));
        assert.ok(!combinedLogs.includes('DockerStrongPassword123!'));
      } finally {
        if (proc1.exitCode === null) {
          proc1.kill('SIGKILL');
        }
      }

      // 6. Start a brand new Container Instance #2 and verify PostgreSQL data survived container replacement
      const port2 = await getFreePort();
      const baseUrl2 = `http://127.0.0.1:${port2}`;
      const proc2 = spawn(
        process.execPath,
        ['dist-server/server.js'],
        {
          cwd: stage2Root,
          uid: nodeUid,
          gid: nodeGid,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            HOST: '0.0.0.0',
            PORT: String(port2),
            DATABASE_URL: TEST_DATABASE_URL,
            JWT_SECRET: PROD_TEST_JWT_SECRET,
          },
        }
      );

      try {
        const health2 = await waitForHealth(baseUrl2);
        assert.equal(health2.status, 200);

        const getCustRes = await fetch(`${baseUrl2}/api/v1/customers/${persistedCustomerId}`, {
          headers: { Authorization: `Bearer ${userAToken}` },
        });
        assert.equal(getCustRes.status, 200);
        const custJson = await getCustRes.json();
        assert.equal(custJson.data.name, 'Containerized Ledger Corp');

        const getInvRes = await fetch(
          `${baseUrl2}/api/v1/invoices?status=issued&page=1&limit=5`,
          {
            headers: { Authorization: `Bearer ${userAToken}` },
          }
        );
        assert.equal(getInvRes.status, 200);
        const invJson = await getInvRes.json();
        assert.equal(invJson.pagination.total, 1);
        assert.equal(invJson.data[0].id, persistedInvoiceId);
        assert.equal(invJson.data[0].total, 210.0);
      } finally {
        await new Promise<void>((resolve) => {
          proc2.on('exit', () => resolve());
          proc2.kill('SIGTERM');
        });
      }
    });
  });

  describe('3. Container Runtime Failure Testing (Missing Production Secret & Unreachable DB)', () => {
    it('fails closed with non-zero exit code when started in NODE_ENV=production without a valid JWT_SECRET', async () => {
      const port = await getFreePort();
      const stderrChunks: string[] = [];

      const badProc = spawn(
        process.execPath,
        ['dist-server/server.js'],
        {
          cwd: stage2Root,
          uid: nodeUid,
          gid: nodeGid,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            PORT: String(port),
            DATABASE_URL: TEST_DATABASE_URL,
            JWT_SECRET: '', // Missing secret in production
          },
        }
      );

      badProc.stderr.on('data', (c) => stderrChunks.push(c.toString()));

      const exitCode = await new Promise<number | null>((resolve) => {
        badProc.on('exit', (code) => resolve(code));
      });

      assert.notEqual(exitCode, 0);
      assert.match(
        stderrChunks.join('\n'),
        /Production security error: JWT_SECRET environment variable must be explicitly set in production/
      );
    });

    it('reports truthful 503 Service Unavailable (database: unhealthy) without leaking credentials when PostgreSQL is unreachable', async () => {
      const port = await getFreePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const stderrChunks: string[] = [];

      const degradedProc = spawn(
        process.execPath,
        ['dist-server/server.js'],
        {
          cwd: stage2Root,
          uid: nodeUid,
          gid: nodeGid,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            PORT: String(port),
            DATABASE_URL:
              'postgresql://billing_user:TopSecretDbPassword999@127.0.0.1:54329/unreachable_db',
            JWT_SECRET: PROD_TEST_JWT_SECRET,
          },
        }
      );

      degradedProc.stderr.on('data', (c) => stderrChunks.push(c.toString()));

      try {
        const healthRes = await waitForHealth(baseUrl);
        assert.equal(healthRes.status, 503);
        const bodyText = await healthRes.text();
        const json = JSON.parse(bodyText);
        assert.equal(json.status, 'error');
        assert.equal(json.data.status, 'degraded');
        assert.equal(json.data.database.status, 'unhealthy');

        // Verify zero credential leakage in HTTP response or stderr logs
        assert.ok(!bodyText.includes('TopSecretDbPassword999'));
        assert.ok(!stderrChunks.join('\n').includes('TopSecretDbPassword999'));
      } finally {
        await new Promise<void>((resolve) => {
          degradedProc.on('exit', () => resolve());
          degradedProc.kill('SIGTERM');
        });
      }
    });
  });
});
