import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import pg from 'pg';
import { createApp } from '../api/app.js';
import { runMigrations } from '../api/db/migrate.js';
import { resolvePoolConfig, getPoolStats } from '../api/db/pool.js';
import { PostgresAccountRepository } from '../api/repositories/postgres-account.repository.js';
import { PostgresCustomerRepository } from '../api/repositories/postgres-customer.repository.js';
import { PostgresInvoiceRepository } from '../api/repositories/postgres-invoice.repository.js';
import { PasswordService } from '../api/services/password.service.js';
import { TokenService } from '../api/services/token.service.js';
import { AuthService } from '../api/services/auth.service.js';
import { HealthController } from '../api/controllers/health.controller.js';
import { assertSafeTestDatabaseUrl } from './helpers/fixtures.js';

const { Pool } = pg;

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5432/billing_system_test';

const SHARED_JWT_SECRET = 'phase-13-horizontal-scaling-shared-jwt-secret-key-min-32-chars';

function computePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1)
  );
  return sortedValues[idx];
}

describe('Billing System REST API - Phase 13 Scaling, Concurrency & Production Architecture Test Suite', () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let serverA: Server;
  let serverB: Server;
  let baseUrlA: string;
  let baseUrlB: string;

  // Use lightweight scrypt parameters in test instances so CPU-bound auth setup is fast
  // while testing production cryptographic verification paths
  const fastPasswordService = new PasswordService({ N: 1024, r: 8, p: 1 });

  before(async () => {
    assertSafeTestDatabaseUrl(TEST_DATABASE_URL, process.env.DATABASE_URL);
    await runMigrations(TEST_DATABASE_URL);

    // Initialize two independent bounded connection pools simulating two horizontal API instances
    // (2 instances * 4 max connections = 8 maximum concurrent PostgreSQL connections)
    poolA = new Pool({
      connectionString: TEST_DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
    poolB = new Pool({
      connectionString: TEST_DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });

    await poolA.query('TRUNCATE TABLE invoice_items, invoices, customers, accounts CASCADE;');

    const buildInstance = (pool: pg.Pool, apiRateLimitMax: number) => {
      const accountRepo = new PostgresAccountRepository(pool);
      const customerRepo = new PostgresCustomerRepository(pool);
      const invoiceRepo = new PostgresInvoiceRepository(pool);
      const tokenService = new TokenService({
        secret: SHARED_JWT_SECRET,
        expiresInSeconds: 3600,
      });
      const authService = new AuthService(accountRepo, fastPasswordService, tokenService);
      const healthController = new HealthController(async () => {
        const client = await pool.connect();
        try {
          await client.query('SELECT 1');
          return true;
        } finally {
          client.release();
        }
      }, pool);

      return createApp({
        accountRepository: accountRepo,
        customerRepository: customerRepo,
        invoiceRepository: invoiceRepo,
        passwordService: fastPasswordService,
        tokenService,
        authService,
        healthController,
        apiRateLimitOptions: {
          windowMs: 60_000,
          max: apiRateLimitMax,
        },
      });
    };

    const appA = buildInstance(poolA, 500);
    const appB = buildInstance(poolB, 500);

    await new Promise<void>((resolve) => {
      serverA = appA.listen(0, '127.0.0.1', () => {
        const addr = serverA.address();
        if (addr && typeof addr === 'object') {
          baseUrlA = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      serverB = appB.listen(0, '127.0.0.1', () => {
        const addr = serverB.address();
        if (addr && typeof addr === 'object') {
          baseUrlB = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    if (serverA) {
      await new Promise<void>((resolve) => serverA.close(() => resolve()));
    }
    if (serverB) {
      await new Promise<void>((resolve) => serverB.close(() => resolve()));
    }
    if (poolA) {
      await poolA.query('TRUNCATE TABLE invoice_items, invoices, customers, accounts CASCADE;').catch(() => {});
      await poolA.end();
    }
    if (poolB) {
      await poolB.end();
    }
  });

  describe('1. Stateless Horizontal Scaling Across Multiple API Instances', () => {
    it('verifies JWT tokens, customer state, invoice transactions, and IDOR checks seamlessly across Instance A and Instance B without sticky sessions', async () => {
      // 1. Register & login Tenant 1 on Instance A
      const reg1 = await fetch(`${baseUrlA}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'tenant1.scale@billing.example.com',
          password: 'ScalePassword123!',
        }),
      });
      assert.equal(reg1.status, 201);

      const login1 = await fetch(`${baseUrlA}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'tenant1.scale@billing.example.com',
          password: 'ScalePassword123!',
        }),
      });
      assert.equal(login1.status, 200);
      const token1 = (await login1.json()).data.token as string;

      // 2. Verify token issued by Instance A authenticates immediately on Instance B
      const meOnB = await fetch(`${baseUrlB}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token1}` },
      });
      assert.equal(meOnB.status, 200);
      const meBody = await meOnB.json();
      assert.equal(meBody.data.email, 'tenant1.scale@billing.example.com');

      // 3. Create Customer on Instance A, read and issue Invoice on Instance B
      const createCusRes = await fetch(`${baseUrlA}/api/v1/customers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Horizontal Corp',
          email: 'ap@horizontal.example.com',
          currency: 'USD',
        }),
      });
      assert.equal(createCusRes.status, 201);
      const customerId = (await createCusRes.json()).data.id as string;

      const getCusOnB = await fetch(`${baseUrlB}/api/v1/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${token1}` },
      });
      assert.equal(getCusOnB.status, 200);

      const createInvOnB = await fetch(`${baseUrlB}/api/v1/customers/${customerId}/invoices`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'issued',
          tax: 15,
          discount: 5,
          items: [
            { description: 'Multi-Instance API Gateway', quantity: 2, unitPrice: 100 },
            { description: 'PostgreSQL Connection Pooler', quantity: 1, unitPrice: 50 },
          ],
        }),
      });
      assert.equal(createInvOnB.status, 201);
      const invoiceId = (await createInvOnB.json()).data.id as string;

      // 4. Read Invoice on Instance A and verify consistent financial state
      const getInvOnA = await fetch(`${baseUrlA}/api/v1/invoices/${invoiceId}`, {
        headers: { Authorization: `Bearer ${token1}` },
      });
      assert.equal(getInvOnA.status, 200);
      const invBody = await getInvOnA.json();
      assert.equal(invBody.data.subtotal, 250);
      assert.equal(invBody.data.total, 260);
      assert.equal(invBody.data.items.length, 2);

      // 5. Register Tenant 2 on Instance B and verify cross-instance IDOR protection on Instance A
      await fetch(`${baseUrlB}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'tenant2.scale@billing.example.com',
          password: 'ScalePassword123!',
        }),
      });
      const login2 = await fetch(`${baseUrlB}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'tenant2.scale@billing.example.com',
          password: 'ScalePassword123!',
        }),
      });
      const token2 = (await login2.json()).data.token as string;

      const idorAttemptOnA = await fetch(`${baseUrlA}/api/v1/invoices/${invoiceId}`, {
        headers: { Authorization: `Bearer ${token2}` },
      });
      assert.equal(idorAttemptOnA.status, 403);
    });

    it('demonstrates process-local rate limiting across horizontal instances (independent per-instance windows)', async () => {
      const appLimited1 = createApp({
        apiRateLimitOptions: { windowMs: 60_000, max: 3 },
      });
      const appLimited2 = createApp({
        apiRateLimitOptions: { windowMs: 60_000, max: 3 },
      });

      const srv1 = await new Promise<Server>((resolve) => {
        const s = appLimited1.listen(0, '127.0.0.1', () => resolve(s));
      });
      const srv2 = await new Promise<Server>((resolve) => {
        const s = appLimited2.listen(0, '127.0.0.1', () => resolve(s));
      });

      try {
        const port1 = (srv1.address() as { port: number }).port;
        const port2 = (srv2.address() as { port: number }).port;

        // Exhaust limit (3 requests) on Instance 1
        for (let i = 0; i < 3; i++) {
          const r = await fetch(`http://127.0.0.1:${port1}/api/v1/health/live`);
          assert.equal(r.status, 200);
        }
        const blockedOn1 = await fetch(`http://127.0.0.1:${port1}/api/v1/health/live`);
        assert.equal(blockedOn1.status, 429);

        // Instance 2 maintains its own in-memory bucket until its own limit of 3 is reached
        const allowedOn2 = await fetch(`http://127.0.0.1:${port2}/api/v1/health/live`);
        assert.equal(allowedOn2.status, 200);
        assert.equal(allowedOn2.headers.get('x-ratelimit-remaining'), '2');
      } finally {
        srv1.close();
        srv2.close();
      }
    });
  });

  describe('2. Database Connection Pool Sizing, Timeout Configuration & Live Telemetry', () => {
    it('resolves pool configuration from environment variables and explicit overrides', () => {
      const prevMax = process.env.DB_POOL_MAX;
      const prevIdle = process.env.DB_POOL_IDLE_TIMEOUT_MS;
      const prevConn = process.env.DB_POOL_CONNECTION_TIMEOUT_MS;
      const prevStmt = process.env.DB_STATEMENT_TIMEOUT_MS;

      try {
        process.env.DB_POOL_MAX = '15';
        process.env.DB_POOL_IDLE_TIMEOUT_MS = '20000';
        process.env.DB_POOL_CONNECTION_TIMEOUT_MS = '3000';
        process.env.DB_STATEMENT_TIMEOUT_MS = '8000';

        const envResolved = resolvePoolConfig();
        assert.equal(envResolved.max, 15);
        assert.equal(envResolved.idleTimeoutMillis, 20_000);
        assert.equal(envResolved.connectionTimeoutMillis, 3_000);
        assert.equal(envResolved.statementTimeoutMillis, 8_000);

        const overrideResolved = resolvePoolConfig({
          max: 6,
          idleTimeoutMillis: 15_000,
          connectionTimeoutMillis: 2_500,
          statementTimeoutMillis: 5_000,
        });
        assert.equal(overrideResolved.max, 6);
        assert.equal(overrideResolved.idleTimeoutMillis, 15_000);
        assert.equal(overrideResolved.connectionTimeoutMillis, 2_500);
        assert.equal(overrideResolved.statementTimeoutMillis, 5_000);
      } finally {
        if (prevMax === undefined) delete process.env.DB_POOL_MAX;
        else process.env.DB_POOL_MAX = prevMax;
        if (prevIdle === undefined) delete process.env.DB_POOL_IDLE_TIMEOUT_MS;
        else process.env.DB_POOL_IDLE_TIMEOUT_MS = prevIdle;
        if (prevConn === undefined) delete process.env.DB_POOL_CONNECTION_TIMEOUT_MS;
        else process.env.DB_POOL_CONNECTION_TIMEOUT_MS = prevConn;
        if (prevStmt === undefined) delete process.env.DB_STATEMENT_TIMEOUT_MS;
        else process.env.DB_STATEMENT_TIMEOUT_MS = prevStmt;
      }
    });

    it('exposes real-time PostgreSQL connection pool metrics in GET /api/v1/health and GET /api/v1/metrics', async () => {
      const healthRes = await fetch(`${baseUrlA}/api/v1/health`);
      assert.equal(healthRes.status, 200);
      const healthBody = await healthRes.json();

      assert.equal(healthBody.data.database.status, 'healthy');
      assert.equal(typeof healthBody.data.database.latencyMs, 'number');
      assert.equal(healthBody.data.database.pool.max, 4);
      assert.equal(typeof healthBody.data.database.pool.totalCount, 'number');
      assert.equal(typeof healthBody.data.database.pool.idleCount, 'number');
      assert.equal(typeof healthBody.data.database.pool.waitingCount, 'number');
      assert.equal(typeof healthBody.data.database.pool.activeCount, 'number');

      const metricsRes = await fetch(`${baseUrlA}/api/v1/metrics`);
      assert.equal(metricsRes.status, 200);
      const metricsBody = await metricsRes.json();
      assert.equal(metricsBody.data.databasePool.max, 4);
      assert.equal(metricsBody.data.databasePool.waitingCount, 0);
    });
  });

  describe('3. Database Composite & Functional Index Verification (EXPLAIN Query Plans)', () => {
    it('verifies all Phase 13 composite and functional scaling indexes exist and eliminate Seq Scans / Sort nodes in EXPLAIN plans', async () => {
      // 1. Verify all 8 indexes from 006_add_composite_scaling_indexes.sql are present in pg_indexes
      const indexRes = await poolA.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'idx_customers_account_created_id',
            'idx_customers_created_id',
            'idx_invoices_invoice_number_upper',
            'idx_invoices_customer_created_id',
            'idx_invoices_customer_status_created_id',
            'idx_invoices_status_created_id',
            'idx_invoices_created_id',
            'idx_invoice_items_invoice_created_id'
          )
        ORDER BY indexname ASC;
      `);
      assert.equal(indexRes.rows.length, 8);

      // 2. Seed realistic multi-tenant distribution (10 accounts, 1,000 customers = 100 per account, 1,600 invoices)
      await poolA.query(`
        INSERT INTO accounts (id, email, password_hash, role)
        SELECT
          'acc_plan_' || g,
          'plan_acct_' || g || '@billing.example.com',
          'scrypt_dummy_hash',
          'user'
        FROM generate_series(1, 10) AS g
        ON CONFLICT (id) DO NOTHING;
      `);

      await poolA.query(`
        INSERT INTO customers (id, account_id, name, email, currency, created_at, updated_at)
        SELECT
          'cus_plan_' || g,
          'acc_plan_' || ((g % 10) + 1),
          'Indexed Customer ' || g,
          'indexed_cus_' || g || '@billing.example.com',
          'USD',
          NOW() - (g || ' minutes')::interval,
          NOW() - (g || ' minutes')::interval
        FROM generate_series(1, 1000) AS g
        ON CONFLICT (id) DO NOTHING;
      `);

      await poolA.query(`
        INSERT INTO invoices (id, customer_id, invoice_number, status, currency, subtotal, tax, discount, total, issue_date, due_date, created_at, updated_at)
        SELECT
          'inv_plan_' || g,
          'cus_plan_' || ((g % 1000) + 1),
          'INV-PLAN-' || lpad(g::text, 6, '0'),
          CASE (g % 3) WHEN 0 THEN 'draft' WHEN 1 THEN 'issued' ELSE 'paid' END,
          'USD',
          100.00, 10.00, 0.00, 110.00,
          NOW() - (g || ' minutes')::interval,
          NOW() + ('30 days')::interval,
          NOW() - (g || ' minutes')::interval,
          NOW() - (g || ' minutes')::interval
        FROM generate_series(1, 1600) AS g
        ON CONFLICT (id) DO NOTHING;
      `);

      await poolA.query('ANALYZE accounts, customers, invoices, invoice_items;');

      // 3. Verify UPPER(invoice_number) lookup uses functional index idx_invoices_invoice_number_upper
      const explainUpper = await poolA.query(`
        EXPLAIN (FORMAT JSON)
        SELECT id, customer_id, invoice_number
        FROM invoices
        WHERE UPPER(invoice_number) = UPPER('inv-plan-000850');
      `);
      const upperPlanJson = JSON.stringify(explainUpper.rows[0]);
      assert.ok(
        upperPlanJson.includes('idx_invoices_invoice_number_upper'),
        `Expected idx_invoices_invoice_number_upper in plan: ${upperPlanJson}`
      );
      assert.ok(!upperPlanJson.includes('"Node Type":"Seq Scan"'));

      // 4. Verify tenant-scoped customer pagination uses idx_customers_account_created_id without Sort
      const explainCustomerPage = await poolA.query(`
        EXPLAIN (FORMAT JSON)
        SELECT id, account_id, name, email, currency, created_at, updated_at
        FROM customers
        WHERE account_id = 'acc_plan_5'
        ORDER BY created_at DESC, id DESC
        LIMIT 5 OFFSET 0;
      `);
      const customerPlanJson = JSON.stringify(explainCustomerPage.rows[0]);
      assert.ok(
        customerPlanJson.includes('idx_customers_account_created_id'),
        `Expected idx_customers_account_created_id in plan: ${customerPlanJson}`
      );
      assert.ok(
        !customerPlanJson.includes('"Node Type":"Sort"'),
        `Expected zero Sort node in tenant customer pagination plan: ${customerPlanJson}`
      );

      // 5. Verify customer + status invoice pagination uses idx_invoices_customer_status_created_id without Sort
      const explainInvoicePage = await poolA.query(`
        EXPLAIN (FORMAT JSON)
        SELECT id, customer_id, invoice_number, status, total, created_at
        FROM invoices
        WHERE customer_id = 'cus_plan_10' AND status = 'issued'
        ORDER BY created_at DESC, id DESC
        LIMIT 20 OFFSET 0;
      `);
      const invoicePlanJson = JSON.stringify(explainInvoicePage.rows[0]);
      assert.ok(
        invoicePlanJson.includes('idx_invoices_customer_status_created_id'),
        `Expected idx_invoices_customer_status_created_id in plan: ${invoicePlanJson}`
      );
      assert.ok(
        !invoicePlanJson.includes('"Node Type":"Sort"'),
        `Expected zero Sort node in customer+status invoice pagination plan: ${invoicePlanJson}`
      );
    });
  });

  describe('4. Batched Multi-Row Invoice Item Writes & Concurrent Load Verification', () => {
    it('persists and updates a 25-item invoice in a single batched INSERT statement inside the transaction', async () => {
      const executedQueries: string[] = [];
      const rawConnect = poolA.connect.bind(poolA);

      // Instrument a single connection checkout to count SQL statements executed during create()
      const instrumentedPool = {
        connect: async () => {
          const client = await rawConnect();
          const rawQuery = client.query.bind(client);
          const wrappedClient = new Proxy(client, {
            get(target, prop, receiver) {
              if (prop === 'query') {
                return (...args: unknown[]) => {
                  if (typeof args[0] === 'string') {
                    executedQueries.push(args[0].trim().split(/\s+/).slice(0, 3).join(' '));
                  }
                  return (rawQuery as (...a: unknown[]) => unknown)(...args);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          return wrappedClient;
        },
      } as unknown as pg.Pool;

      const repo = new PostgresInvoiceRepository(instrumentedPool);
      const now = new Date().toISOString();
      const items = Array.from({ length: 25 }, (_, i) => ({
        id: `item_batch_${i + 1}`,
        invoiceId: 'inv_batch_25_test',
        description: `Line Item #${i + 1}`,
        quantity: 2,
        unitPrice: 10,
        lineTotal: 20,
        createdAt: now,
        updatedAt: now,
      }));

      const created = await repo.create({
        id: 'inv_batch_25_test',
        customerId: 'cus_plan_1',
        invoiceNumber: 'INV-2026-BATCH-0025',
        status: 'issued',
        currency: 'USD',
        subtotal: 500,
        tax: 0,
        discount: 0,
        total: 500,
        issueDate: now,
        dueDate: now,
        notes: 'Batched 25-item write verification',
        items,
        createdAt: now,
        updatedAt: now,
      });

      assert.equal(created.items.length, 25);
      // Exactly 4 SQL statements: BEGIN, INSERT INTO invoices, INSERT INTO invoice_items (batched), COMMIT
      assert.deepEqual(executedQueries, [
        'BEGIN',
        'INSERT INTO invoices',
        'INSERT INTO invoice_items',
        'COMMIT',
      ]);
    });

    it('sustains 60 concurrent mixed read/write requests across Instance A and Instance B under a bounded connection pool with 0% error rate', async () => {
      // Authenticate a load-test operator
      await fetch(`${baseUrlA}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'loadtest.operator@billing.example.com',
          password: 'LoadTestPassword123!',
        }),
      });
      const loginRes = await fetch(`${baseUrlB}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'loadtest.operator@billing.example.com',
          password: 'LoadTestPassword123!',
        }),
      });
      const token = (await loginRes.json()).data.token as string;

      // Create a customer for concurrent invoice writes
      const cusRes = await fetch(`${baseUrlA}/api/v1/customers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Concurrent Load Customer',
          email: 'concurrent@billing.example.com',
          currency: 'USD',
        }),
      });
      assert.equal(cusRes.status, 201);
      const customerId = (await cusRes.json()).data.id as string;

      const urls = [baseUrlA, baseUrlB];
      const latenciesMs: number[] = [];
      const createdInvoiceNumbers = new Set<string>();

      const startWallMs = Date.now();

      // Dispatch 60 concurrent requests (20 invoice creations, 20 paginated invoice reads, 20 paginated customer reads)
      // distributed round-robin across Instance A and Instance B (total pool capacity = 2 * 4 = 8 connections)
      const tasks = Array.from({ length: 60 }, async (_, idx) => {
        const targetBaseUrl = urls[idx % urls.length];
        const reqStart = Date.now();

        if (idx % 3 === 0) {
          // Concurrent transactional write (create invoice with 5 line items)
          const res = await fetch(`${targetBaseUrl}/api/v1/customers/${customerId}/invoices`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              status: 'issued',
              tax: 10,
              discount: 0,
              items: Array.from({ length: 5 }, (__, itemIdx) => ({
                description: `Concurrent Load Item ${idx}-${itemIdx}`,
                quantity: 1,
                unitPrice: 20,
              })),
            }),
          });
          latenciesMs.push(Date.now() - reqStart);
          assert.equal(res.status, 201);
          const body = await res.json();
          createdInvoiceNumbers.add(body.data.invoiceNumber);
        } else if (idx % 3 === 1) {
          // Concurrent paginated customer-invoices query
          const res = await fetch(
            `${targetBaseUrl}/api/v1/customers/${customerId}/invoices?page=1&limit=10&status=issued&sort=createdAt&order=desc`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          latenciesMs.push(Date.now() - reqStart);
          assert.equal(res.status, 200);
          const body = await res.json();
          assert.equal(body.status, 'success');
        } else {
          // Concurrent paginated customers query
          const res = await fetch(
            `${targetBaseUrl}/api/v1/customers?page=1&limit=10&sort=createdAt&order=desc`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          latenciesMs.push(Date.now() - reqStart);
          assert.equal(res.status, 200);
          const body = await res.json();
          assert.equal(body.status, 'success');
        }
      });

      await Promise.all(tasks);

      const totalWallMs = Math.max(1, Date.now() - startWallMs);
      const sortedLatencies = [...latenciesMs].sort((a, b) => a - b);
      const p50Ms = computePercentile(sortedLatencies, 50);
      const p95Ms = computePercentile(sortedLatencies, 95);
      const maxMs = sortedLatencies[sortedLatencies.length - 1];

      // All 20 concurrent invoice creations must have produced distinct invoice numbers
      assert.equal(createdInvoiceNumbers.size, 20);
      assert.equal(latenciesMs.length, 60);
      assert.ok(p50Ms < 1000, `Expected p50 latency < 1000ms, got ${p50Ms}ms`);
      assert.ok(p95Ms < 2000, `Expected p95 latency < 2000ms, got ${p95Ms}ms`);
      assert.ok(maxMs < 5000, `Expected max latency < 5000ms, got ${maxMs}ms`);
      assert.ok(totalWallMs < 10000);

      // Verify both connection pools drained active clients cleanly after the concurrent burst
      const statsA = getPoolStats(poolA);
      const statsB = getPoolStats(poolB);
      assert.equal(statsA.waitingCount, 0);
      assert.equal(statsB.waitingCount, 0);
      assert.equal(statsA.activeCount, 0);
      assert.equal(statsB.activeCount, 0);
      assert.ok(statsA.totalCount <= 4);
      assert.ok(statsB.totalCount <= 4);
    });

    it('automatically retries and succeeds if a cross-instance invoiceNumber collision (DuplicateResourceError) occurs on first attempt', async () => {
      const { InvoiceService } = await import('../api/services/invoice.service.js');
      const { DuplicateResourceError } = await import('../api/services/errors.js');
      const { InMemoryCustomerRepository } = await import(
        '../api/repositories/in-memory-customer.repository.js'
      );
      const { InMemoryInvoiceRepository } = await import(
        '../api/repositories/in-memory-invoice.repository.js'
      );

      const cusRepo = new InMemoryCustomerRepository();
      const baseInvRepo = new InMemoryInvoiceRepository(cusRepo);
      const now = new Date().toISOString();
      await cusRepo.create({
        id: 'cus_retry_test',
        accountId: 'acc_retry_owner',
        name: 'Retry Test Corp',
        email: 'retry@billing.example.com',
        currency: 'USD',
        createdAt: now,
        updatedAt: now,
      });

      let createAttempts = 0;
      const seenInvoiceNumbers: string[] = [];
      const collidingRepo = new Proxy(baseInvRepo, {
        get(target, prop, receiver) {
          if (prop === 'create') {
            return async (inv: Parameters<typeof baseInvRepo.create>[0]) => {
              createAttempts += 1;
              seenInvoiceNumbers.push(inv.invoiceNumber);
              if (createAttempts === 1) {
                throw new DuplicateResourceError(
                  'An invoice with this identifier or invoice number already exists'
                );
              }
              return target.create(inv);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const service = new InvoiceService(collidingRepo, cusRepo);
      const created = await service.createInvoice(
        {
          customerId: 'cus_retry_test',
          status: 'issued',
          items: [{ description: 'Resilient Invoice Number Item', quantity: 1, unitPrice: 100 }],
        },
        { id: 'acc_retry_owner', email: 'owner@billing.example.com', role: 'user' }
      );

      assert.equal(createAttempts, 2);
      assert.equal(seenInvoiceNumbers.length, 2);
      assert.notEqual(seenInvoiceNumbers[0], seenInvoiceNumbers[1]);
      assert.equal(created.invoiceNumber, seenInvoiceNumbers[1]);
    });
  });
});
