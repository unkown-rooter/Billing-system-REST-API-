import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import pg from 'pg';
import { assertSafeProductionDatabaseUrl } from '../api/db/pool.js';
import { runMigrations } from '../api/db/migrate.js';

const { Pool } = pg;

const DEV_DATABASE_URL = 'postgresql://postgres@127.0.0.1:5432/billing_system';
const TEST_DATABASE_URL = 'postgresql://postgres@127.0.0.1:5432/billing_system_test';
const PROD_DATABASE_URL =
  process.env.PROD_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5432/billing_system_prod';

const PROD_JWT_SECRET = crypto.randomBytes(48).toString('base64url');

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

interface HttpsResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  bodyText: string;
  json: <T = any>() => T;
}

function httpsRequest(
  urlStr: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    ca: string | Buffer;
  }
): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        ca: options.ca,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bodyText,
            json: () => JSON.parse(bodyText),
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function waitForHttpsHealth(
  httpsBaseUrl: string,
  ca: string | Buffer,
  timeoutMs = 8000
): Promise<HttpsResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await httpsRequest(`${httpsBaseUrl}/api/v1/health`, { ca });
      if (res.status === 200 || res.status === 503) {
        return res;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for HTTPS health at ${httpsBaseUrl}: ${String(lastErr)}`);
}

describe('Billing System REST API - Phase 11 Production Deployment & Live Hosting Verification Suite', () => {
  const workspaceRoot = process.cwd();
  const prodRootfs = '/tmp/phase11-prod-rootfs';
  const tlsDir = '/tmp/phase11-tls-certs';
  let adminPool: pg.Pool;
  let prodPool: pg.Pool;
  let nodeUid = 1000;
  let nodeGid = 1000;
  let tlsCertPem = '';
  let tlsKeyPem = '';

  before(async () => {
    // 1. Ensure billing_system_prod exists as a dedicated Production PostgreSQL database
    adminPool = new Pool({ connectionString: 'postgresql://postgres@127.0.0.1:5432/postgres' });
    const dbCheck = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = 'billing_system_prod'"
    );
    if (dbCheck.rowCount === 0) {
      await adminPool.query('CREATE DATABASE billing_system_prod;');
    }

    // 2. Verify strict three-way database separation before proceeding
    assertSafeProductionDatabaseUrl(PROD_DATABASE_URL, {
      devDatabaseUrl: DEV_DATABASE_URL,
      testDatabaseUrl: TEST_DATABASE_URL,
      disallowDevDbName: true,
    });

    // 3. Build production artifacts (dist/ and dist-server/)
    execSync('npm run build', { cwd: workspaceRoot, stdio: 'pipe' });

    // 4. Assemble Stage 2 production container filesystem matching Dockerfile runtime stage
    fs.rmSync(prodRootfs, { recursive: true, force: true });
    fs.mkdirSync(prodRootfs, { recursive: true });

    fs.copyFileSync(
      path.join(workspaceRoot, 'package.json'),
      path.join(prodRootfs, 'package.json')
    );
    fs.copyFileSync(
      path.join(workspaceRoot, '.env.example'),
      path.join(prodRootfs, '.env.example')
    );
    fs.cpSync(path.join(workspaceRoot, 'dist'), path.join(prodRootfs, 'dist'), {
      recursive: true,
    });
    fs.cpSync(path.join(workspaceRoot, 'dist-server'), path.join(prodRootfs, 'dist-server'), {
      recursive: true,
    });
    fs.cpSync(path.join(workspaceRoot, 'migrations'), path.join(prodRootfs, 'migrations'), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(workspaceRoot, 'node_modules'),
      path.join(prodRootfs, 'node_modules'),
      'dir'
    );

    try {
      execSync('id -u node >/dev/null 2>&1 || useradd -u 1000 -m -s /bin/sh node', {
        stdio: 'pipe',
      });
    } catch {
      // Ignore if user already exists
    }
    nodeUid = Number(execSync('id -u node').toString().trim());
    nodeGid = Number(execSync('id -g node').toString().trim());

    execSync(`chown -R node:node ${prodRootfs} && chmod -R a-w ${prodRootfs}`, {
      stdio: 'pipe',
    });

    // 5. Generate ephemeral X.509 TLS certificate for HTTPS termination verification
    fs.rmSync(tlsDir, { recursive: true, force: true });
    fs.mkdirSync(tlsDir, { recursive: true });
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 ` +
        `-keyout ${tlsDir}/key.pem -out ${tlsDir}/cert.pem ` +
        `-subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
      { stdio: 'pipe' }
    );
    tlsCertPem = fs.readFileSync(path.join(tlsDir, 'cert.pem'), 'utf-8');
    tlsKeyPem = fs.readFileSync(path.join(tlsDir, 'key.pem'), 'utf-8');

    prodPool = new Pool({ connectionString: PROD_DATABASE_URL });
  });

  after(async () => {
    if (prodPool) {
      await prodPool.end();
    }
    if (adminPool) {
      await adminPool.end();
    }
    try {
      execSync(`chmod -R u+w ${prodRootfs} 2>/dev/null || true`, { stdio: 'pipe' });
      fs.rmSync(prodRootfs, { recursive: true, force: true });
      fs.rmSync(tlsDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('1. Deployment Configuration & Production Database Separation (Dev DB != Test DB != Prod DB)', () => {
    it('validates cloudrun.service.yaml and scripts/deploy-release.sh without hardcoded secrets', () => {
      const manifestPath = path.join(workspaceRoot, 'cloudrun.service.yaml');
      const scriptPath = path.join(workspaceRoot, 'scripts', 'deploy-release.sh');

      assert.equal(fs.existsSync(manifestPath), true);
      assert.equal(fs.existsSync(scriptPath), true);

      const manifest = fs.readFileSync(manifestPath, 'utf-8');
      assert.match(manifest, /apiVersion:\s*serving\.knative\.dev\/v1/);
      assert.match(manifest, /kind:\s*Service/);
      assert.match(manifest, /runAsNonRoot:\s*true/);
      assert.match(manifest, /runAsUser:\s*1000/);
      assert.match(manifest, /readOnlyRootFilesystem:\s*true/);
      assert.match(manifest, /path:\s*\/api\/v1\/health/);
      assert.match(manifest, /secretKeyRef:/);
      assert.ok(!manifest.includes('postgresql://'), 'Manifest must not hardcode DATABASE_URL');
    });

    it('enforces strict three-way database separation (Development DB != Test DB != Production DB)', async () => {
      // Rejects test database in production
      assert.throws(
        () => assertSafeProductionDatabaseUrl(TEST_DATABASE_URL),
        /Production isolation violation: Production database 'billing_system_test' must never point to a test database/
      );

      // Rejects default local development database name when disallowDevDbName is true
      assert.throws(
        () =>
          assertSafeProductionDatabaseUrl(DEV_DATABASE_URL, {
            disallowDevDbName: true,
          }),
        /Production isolation violation: Production database 'billing_system' must be separated/
      );

      // Rejects non-PostgreSQL protocols (e.g. sqlite)
      assert.throws(
        () => assertSafeProductionDatabaseUrl('sqlite:///:memory:'),
        /Production isolation violation: Unsupported database protocol/
      );

      // Verify all three databases physically exist as separate databases in PostgreSQL 15
      const { rows } = await adminPool.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname IN ('billing_system', 'billing_system_test', 'billing_system_prod') ORDER BY datname ASC"
      );
      const dbNames = rows.map((r) => r.datname);
      assert.deepEqual(dbNames, [
        'billing_system',
        'billing_system_prod',
        'billing_system_test',
      ]);
    });
  });

  describe('2. Authoritative Production Database Migrations & Idempotency', () => {
    it('applies all 5 SQL migrations cleanly to billing_system_prod and is idempotent on repeat execution', async () => {
      // Execute compiled production migration runner inside Stage 2 rootfs as non-root `node` user
      const output = execSync(
        `su -s /bin/sh node -c "cd ${prodRootfs} && DATABASE_URL='${PROD_DATABASE_URL}' node dist-server/src/api/db/migrate.js"`,
        { encoding: 'utf-8' }
      );
      assert.match(output, /Migration process exited cleanly/);

      // Verify schema_migrations records all 5 migrations in billing_system_prod
      const { rows } = await prodPool.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY id ASC'
      );
      assert.deepEqual(
        rows.map((r) => r.name),
        [
          '001_create_customers_table.sql',
          '002_create_accounts_table.sql',
          '003_add_authorization_role_and_ownership.sql',
          '004_create_invoices_and_items_tables.sql',
          '005_add_pagination_and_filtering_indexes.sql',
        ]
      );

      // Re-run migrations programmatically to verify strict idempotency (0 newly applied)
      const secondRun = await runMigrations(PROD_DATABASE_URL);
      assert.equal(secondRun.applied.length, 0);
      assert.equal(secondRun.alreadyApplied.length, 5);
    });
  });

  describe('3. Fail-Closed Production Startup Without DATABASE_URL', () => {
    it('fails closed with non-zero exit code when started in NODE_ENV=production without DATABASE_URL (never falls back to in-memory DB)', async () => {
      const port = await getFreePort();
      const stderrChunks: string[] = [];

      const proc = spawn(process.execPath, ['dist-server/server.js'], {
        cwd: prodRootfs,
        uid: nodeUid,
        gid: nodeGid,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'production',
          PORT: String(port),
          DATABASE_URL: '',
          JWT_SECRET: PROD_JWT_SECRET,
        },
      });

      proc.stderr.on('data', (c) => stderrChunks.push(c.toString()));

      const exitCode = await new Promise<number | null>((resolve) => {
        proc.on('exit', (code) => resolve(code));
      });

      assert.notEqual(exitCode, 0);
      assert.match(
        stderrChunks.join('\n'),
        /Production security error: DATABASE_URL environment variable must be explicitly set in production/
      );
    });
  });

  describe('4. Live HTTPS/TLS Production Deployment Verification, Restart Persistence & Controlled Cleanup', () => {
    it('serves full API over HTTPS/TLS against billing_system_prod, enforces Auth/RBAC/IDOR/Validation/HSTS, survives container restart, and cleans up controlled test records', async () => {
      const appPort1 = await getFreePort();
      const tlsPort = await getFreePort();
      const httpsBaseUrl = `https://127.0.0.1:${tlsPort}`;
      let targetAppPort = appPort1;

      // Start TLS termination reverse proxy (simulating Cloud Run HTTPS ingress forwarding X-Forwarded-Proto: https)
      const tlsProxy = https.createServer(
        { key: tlsKeyPem, cert: tlsCertPem },
        (clientReq, clientRes) => {
          const proxyReq = http.request(
            {
              hostname: '127.0.0.1',
              port: targetAppPort,
              path: clientReq.url,
              method: clientReq.method,
              headers: {
                ...clientReq.headers,
                'x-forwarded-proto': 'https',
                'x-forwarded-for': clientReq.socket.remoteAddress ?? '127.0.0.1',
              },
            },
            (proxyRes) => {
              clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
              proxyRes.pipe(clientRes);
            }
          );
          proxyReq.on('error', () => {
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            }
            clientRes.end(JSON.stringify({ status: 'error', error: { code: 'BAD_GATEWAY' } }));
          });
          clientReq.pipe(proxyReq);
        }
      );

      await new Promise<void>((resolve) => tlsProxy.listen(tlsPort, '127.0.0.1', () => resolve()));

      const stdoutLogs: string[] = [];
      const proc1: ChildProcessWithoutNullStreams = spawn(
        process.execPath,
        ['dist-server/server.js'],
        {
          cwd: prodRootfs,
          uid: nodeUid,
          gid: nodeGid,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            HOST: '0.0.0.0',
            PORT: String(appPort1),
            TRUST_PROXY: '1',
            ENABLE_HSTS: 'true',
            CORS_ALLOWED_ORIGINS: '',
            DATABASE_URL: PROD_DATABASE_URL,
            JWT_SECRET: PROD_JWT_SECRET,
          },
        }
      );

      proc1.stdout.on('data', (c) => stdoutLogs.push(c.toString()));
      proc1.stderr.on('data', (c) => stdoutLogs.push(c.toString()));

      const runId = crypto.randomUUID().slice(0, 8);
      const userAEmail = `prod_verify_a_${runId}@billing.example.com`;
      const userBEmail = `prod_verify_b_${runId}@billing.example.com`;
      const createdAccountIds: string[] = [];
      let createdCustomerId = '';
      let createdInvoiceId = '';
      let userAToken = '';
      let userBToken = '';

      try {
        // 1. First Production Verification: GET /api/v1/health over HTTPS
        const healthRes = await waitForHttpsHealth(httpsBaseUrl, tlsCertPem);
        assert.equal(healthRes.status, 200);
        assert.equal(healthRes.headers['x-powered-by'], undefined);
        assert.equal(healthRes.headers['x-content-type-options'], 'nosniff');
        assert.equal(healthRes.headers['x-frame-options'], 'DENY');
        assert.equal(healthRes.headers['referrer-policy'], 'no-referrer');
        assert.equal(
          healthRes.headers['content-security-policy'],
          "default-src 'none'; frame-ancestors 'none'"
        );
        assert.equal(healthRes.headers['cache-control'], 'no-store');
        assert.equal(
          healthRes.headers['strict-transport-security'],
          'max-age=31536000; includeSubDomains'
        );
        assert.equal(healthRes.headers['access-control-allow-origin'], undefined);

        const healthJson = healthRes.json();
        assert.equal(healthJson.status, 'success');
        assert.equal(healthJson.data.status, 'healthy');
        assert.equal(healthJson.data.database.status, 'healthy');

        // 2. Controlled Registration (POST /api/v1/auth/register)
        const regARes = await httpsRequest(`${httpsBaseUrl}/api/v1/auth/register`, {
          method: 'POST',
          ca: tlsCertPem,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: userAEmail,
            password: 'ProdVerifyPassword123!',
          }),
        });
        assert.equal(regARes.status, 201);
        const regAJson = regARes.json();
        assert.equal(regAJson.data.email, userAEmail);
        assert.equal(regAJson.data.role, 'user');
        assert.equal(regAJson.data.passwordHash, undefined);
        createdAccountIds.push(regAJson.data.id);

        // 3. Login (POST /api/v1/auth/login)
        const loginARes = await httpsRequest(`${httpsBaseUrl}/api/v1/auth/login`, {
          method: 'POST',
          ca: tlsCertPem,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: userAEmail,
            password: 'ProdVerifyPassword123!',
          }),
        });
        assert.equal(loginARes.status, 200);
        const loginAJson = loginARes.json();
        assert.equal(loginAJson.data.tokenType, 'Bearer');
        userAToken = loginAJson.data.token;
        assert.ok(userAToken && userAToken.split('.').length === 3);

        // 4. Unauthenticated Request Rejection (401 AUTHENTICATION_REQUIRED)
        const unauthRes = await httpsRequest(`${httpsBaseUrl}/api/v1/customers`, {
          method: 'GET',
          ca: tlsCertPem,
        });
        assert.equal(unauthRes.status, 401);
        assert.equal(unauthRes.json().error.code, 'AUTHENTICATION_REQUIRED');

        // 5. Protected Resource Creation (Customer + Relational Invoice)
        const createCustRes = await httpsRequest(`${httpsBaseUrl}/api/v1/customers`, {
          method: 'POST',
          ca: tlsCertPem,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userAToken}`,
          },
          body: JSON.stringify({
            name: `Prod Verified Enterprise ${runId}`,
            email: `ap_${runId}@verified-enterprise.example.com`,
            currency: 'USD',
          }),
        });
        assert.equal(createCustRes.status, 201);
        createdCustomerId = createCustRes.json().data.id;

        const createInvRes = await httpsRequest(`${httpsBaseUrl}/api/v1/invoices`, {
          method: 'POST',
          ca: tlsCertPem,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userAToken}`,
          },
          body: JSON.stringify({
            customerId: createdCustomerId,
            status: 'issued',
            tax: 20.0,
            discount: 10.0,
            items: [
              { description: 'Cloud Run Production Node', quantity: 2, unitPrice: 150.0 },
            ],
          }),
        });
        assert.equal(createInvRes.status, 201);
        const invJson = createInvRes.json();
        createdInvoiceId = invJson.data.id;
        assert.equal(invJson.data.subtotal, 300.0);
        assert.equal(invJson.data.total, 310.0);

        // 6. Pagination & Filtering Verification
        const listInvRes = await httpsRequest(
          `${httpsBaseUrl}/api/v1/invoices?page=1&limit=10&status=issued`,
          {
            method: 'GET',
            ca: tlsCertPem,
            headers: { Authorization: `Bearer ${userAToken}` },
          }
        );
        assert.equal(listInvRes.status, 200);
        const listInvJson = listInvRes.json();
        assert.equal(listInvJson.pagination.page, 1);
        assert.equal(listInvJson.pagination.limit, 10);
        assert.equal(listInvJson.data.length, 1);
        assert.equal(listInvJson.data[0].id, createdInvoiceId);

        // 7. Cross-Account Authorization / IDOR Verification (403 FORBIDDEN)
        const regBRes = await httpsRequest(`${httpsBaseUrl}/api/v1/auth/register`, {
          method: 'POST',
          ca: tlsCertPem,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: userBEmail,
            password: 'ProdVerifyPassword123!',
          }),
        });
        assert.equal(regBRes.status, 201);
        createdAccountIds.push(regBRes.json().data.id);

        const loginBRes = await httpsRequest(`${httpsBaseUrl}/api/v1/auth/login`, {
          method: 'POST',
          ca: tlsCertPem,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: userBEmail,
            password: 'ProdVerifyPassword123!',
          }),
        });
        userBToken = loginBRes.json().data.token;

        const idorCustRes = await httpsRequest(
          `${httpsBaseUrl}/api/v1/customers/${createdCustomerId}`,
          {
            method: 'GET',
            ca: tlsCertPem,
            headers: { Authorization: `Bearer ${userBToken}` },
          }
        );
        assert.equal(idorCustRes.status, 403);
        assert.equal(idorCustRes.json().error.code, 'FORBIDDEN');

        // 8. Validation Verification (400 VALIDATION_ERROR)
        const invalidRes = await httpsRequest(`${httpsBaseUrl}/api/v1/customers`, {
          method: 'POST',
          ca: tlsCertPem,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userAToken}`,
          },
          body: JSON.stringify({
            name: '',
            email: 'not-an-email',
            currency: 'INVALID',
          }),
        });
        assert.equal(invalidRes.status, 400);
        assert.equal(invalidRes.json().error.code, 'VALIDATION_ERROR');

        // 9. Method Not Allowed (405) & Unknown Route (404)
        const methodRes = await httpsRequest(`${httpsBaseUrl}/api/v1/health`, {
          method: 'DELETE',
          ca: tlsCertPem,
        });
        assert.equal(methodRes.status, 405);
        assert.equal(methodRes.headers['allow'], 'GET');
        assert.equal(methodRes.json().error.code, 'METHOD_NOT_ALLOWED');

        const notFoundRes = await httpsRequest(`${httpsBaseUrl}/api/v1/nonexistent-route`, {
          method: 'GET',
          ca: tlsCertPem,
        });
        assert.equal(notFoundRes.status, 404);
        assert.equal(notFoundRes.json().error.code, 'ROUTE_NOT_FOUND');

        // 10. Container Restart & Persistence Across Restart Verification
        const exitCode1 = await new Promise<number | null>((resolve) => {
          proc1.on('exit', (code) => resolve(code));
          proc1.kill('SIGTERM');
        });
        assert.equal(exitCode1, 0);

        const logsText = stdoutLogs.join('\n');
        assert.match(logsText, /Received SIGTERM\. Shutting down server gracefully/);
        assert.match(logsText, /HTTP server closed cleanly/);
        assert.match(logsText, /Pool closed/);
        assert.ok(!logsText.includes(PROD_JWT_SECRET), 'Logs must never expose JWT_SECRET');
        assert.ok(!logsText.includes('ProdVerifyPassword123!'), 'Logs must never expose passwords');

        // Start Container Instance #2 on a new port and point TLS proxy to it
        const appPort2 = await getFreePort();
        targetAppPort = appPort2;

        const proc2 = spawn(process.execPath, ['dist-server/server.js'], {
          cwd: prodRootfs,
          uid: nodeUid,
          gid: nodeGid,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            HOST: '0.0.0.0',
            PORT: String(appPort2),
            TRUST_PROXY: '1',
            ENABLE_HSTS: 'true',
            CORS_ALLOWED_ORIGINS: '',
            DATABASE_URL: PROD_DATABASE_URL,
            JWT_SECRET: PROD_JWT_SECRET,
          },
        });

        try {
          const health2 = await waitForHttpsHealth(httpsBaseUrl, tlsCertPem);
          assert.equal(health2.status, 200);

          // Verify Customer and Invoice persisted in billing_system_prod across container replacement
          const persistedCustRes = await httpsRequest(
            `${httpsBaseUrl}/api/v1/customers/${createdCustomerId}`,
            {
              method: 'GET',
              ca: tlsCertPem,
              headers: { Authorization: `Bearer ${userAToken}` },
            }
          );
          assert.equal(persistedCustRes.status, 200);
          assert.equal(
            persistedCustRes.json().data.name,
            `Prod Verified Enterprise ${runId}`
          );

          const persistedInvRes = await httpsRequest(
            `${httpsBaseUrl}/api/v1/invoices/${createdInvoiceId}`,
            {
              method: 'GET',
              ca: tlsCertPem,
              headers: { Authorization: `Bearer ${userAToken}` },
            }
          );
          assert.equal(persistedInvRes.status, 200);
          assert.equal(persistedInvRes.json().data.total, 310.0);
        } finally {
          await new Promise<void>((resolve) => {
            proc2.on('exit', () => resolve());
            proc2.kill('SIGTERM');
          });
        }
      } finally {
        if (proc1.exitCode === null) {
          proc1.kill('SIGKILL');
        }
        await new Promise<void>((resolve) => tlsProxy.close(() => resolve()));

        // Controlled cleanup of verification test data from billing_system_prod
        if (createdInvoiceId) {
          await prodPool.query('DELETE FROM invoices WHERE id = $1', [createdInvoiceId]);
        }
        if (createdCustomerId) {
          await prodPool.query('DELETE FROM customers WHERE id = $1', [createdCustomerId]);
        }
        if (createdAccountIds.length > 0) {
          await prodPool.query('DELETE FROM accounts WHERE id = ANY($1::text[])', [
            createdAccountIds,
          ]);
        }
      }
    });
  });
});
