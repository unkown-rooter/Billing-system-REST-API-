import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import pg from 'pg';
import { createApp } from '../api/app.js';
import { runMigrations } from '../api/db/migrate.js';
import { PostgresCustomerRepository } from '../api/repositories/postgres-customer.repository.js';
import { PostgresAccountRepository } from '../api/repositories/postgres-account.repository.js';
import { PostgresInvoiceRepository } from '../api/repositories/postgres-invoice.repository.js';
import { TokenService } from '../api/services/token.service.js';
import { HealthController } from '../api/controllers/health.controller.js';
import { assertSafeTestDatabaseUrl } from './helpers/fixtures.js';

const { Pool } = pg;

// Dedicated test database connection string
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:5432/billing_system_test';

describe('Billing System REST API - Phase 2 & Phase 5 PostgreSQL Integration Test Suite', () => {
  let testPool: pg.Pool;
  let server: Server;
  let baseUrl: string;
  let tokenService: TokenService;
  let authHeader: Record<string, string>;
  const testAccountId = 'acc_pg_integration_admin';

  before(async () => {
    // 0. Enforce strict Test DB != Dev DB isolation guard before any destructive SQL
    assertSafeTestDatabaseUrl(TEST_DATABASE_URL, process.env.DATABASE_URL);

    // 1. Run migrations against dedicated test database
    await runMigrations(TEST_DATABASE_URL);

    // 2. Setup connection pool for test operations
    testPool = new Pool({ connectionString: TEST_DATABASE_URL });

    // Clean test database tables to start in pristine empty state
    await testPool.query('TRUNCATE TABLE invoice_items, invoices, customers, accounts CASCADE;');

    // Seed controlled test account in PostgreSQL for foreign key ownership & authenticated requests
    const accountRepo = new PostgresAccountRepository(testPool);
    const now = new Date().toISOString();
    await accountRepo.create({
      id: testAccountId,
      email: 'pg_admin@billing.com',
      passwordHash: 'scrypt$N=16384,r=8,p=1$00000000000000000000000000000000$00',
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });

    tokenService = new TokenService();
    const token = tokenService.generateToken({
      id: testAccountId,
      email: 'pg_admin@billing.com',
      role: 'admin',
    });
    authHeader = { Authorization: `Bearer ${token}` };

    // 3. Create app wired directly to Postgres repositories with testPool
    const customerRepo = new PostgresCustomerRepository(testPool);
    const invoiceRepo = new PostgresInvoiceRepository(testPool);
    const healthController = new HealthController(async () => {
      try {
        const client = await testPool.connect();
        try {
          await client.query('SELECT 1');
          return true;
        } finally {
          client.release();
        }
      } catch {
        return false;
      }
    });

    const app = createApp({
      customerRepository: customerRepo,
      accountRepository: accountRepo,
      invoiceRepository: invoiceRepo,
      tokenService,
      healthController,
    });

    // 4. Start HTTP test server on ephemeral port
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    // Teardown HTTP server and database pool cleanly
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    if (testPool) {
      await testPool.end();
    }
  });

  describe('1. Migration System & Idempotency', () => {
    it('running migration runner again is safe and applies 0 new migrations', async () => {
      const result = await runMigrations(TEST_DATABASE_URL);
      assert.equal(result.applied.length, 0);
      assert.ok(result.alreadyApplied.includes('001_create_customers_table.sql'));
      assert.ok(result.alreadyApplied.includes('002_create_accounts_table.sql'));
      assert.ok(result.alreadyApplied.includes('003_add_authorization_role_and_ownership.sql'));
      assert.ok(result.alreadyApplied.includes('004_create_invoices_and_items_tables.sql'));
      assert.ok(result.alreadyApplied.includes('005_add_pagination_and_filtering_indexes.sql'));
    });

    it('schema_migrations table tracks applied migrations', async () => {
      const res = await testPool.query('SELECT name FROM schema_migrations;');
      const names = res.rows.map((r) => r.name);
      assert.ok(names.includes('001_create_customers_table.sql'));
      assert.ok(names.includes('002_create_accounts_table.sql'));
      assert.ok(names.includes('003_add_authorization_role_and_ownership.sql'));
      assert.ok(names.includes('004_create_invoices_and_items_tables.sql'));
      assert.ok(names.includes('005_add_pagination_and_filtering_indexes.sql'));
    });
  });

  describe('2. PostgreSQL Database Constraints Verification', () => {
    it('primary key constraint prevents duplicate IDs at SQL level', async () => {
      const id = 'cus_test_pk_123';
      await testPool.query(
        'INSERT INTO customers (id, account_id, name, email, currency) VALUES ($1, $2, $3, $4, $5);',
        [id, testAccountId, 'First Entry', 'pk1@test.com', 'USD']
      );

      await assert.rejects(
        testPool.query(
          'INSERT INTO customers (id, account_id, name, email, currency) VALUES ($1, $2, $3, $4, $5);',
          [id, testAccountId, 'Second Entry', 'pk2@test.com', 'USD']
        ),
        (err: Error & { code?: string }) => err.code === '23505'
      );

      await testPool.query('DELETE FROM customers WHERE id = $1;', [id]);
    });

    it('case-insensitive unique index prevents duplicate email variants at SQL level', async () => {
      const id1 = 'cus_email_test_1';
      const id2 = 'cus_email_test_2';

      await testPool.query(
        'INSERT INTO customers (id, account_id, name, email, currency) VALUES ($1, $2, $3, $4, $5);',
        [id1, testAccountId, 'Case One', 'case.test@example.com', 'USD']
      );

      // Attempt insert with uppercase variant of the same email
      await assert.rejects(
        testPool.query(
          'INSERT INTO customers (id, account_id, name, email, currency) VALUES ($1, $2, $3, $4, $5);',
          [id2, testAccountId, 'Case Two', 'CASE.TEST@EXAMPLE.COM', 'USD']
        ),
        (err: Error & { code?: string }) => err.code === '23505'
      );

      await testPool.query('DELETE FROM customers WHERE id IN ($1, $2);', [id1, id2]);
    });

    it('currency check constraint enforces 3 uppercase letters', async () => {
      const id = 'cus_curr_invalid';
      await assert.rejects(
        testPool.query(
          'INSERT INTO customers (id, account_id, name, email, currency) VALUES ($1, $2, $3, $4, $5);',
          [id, testAccountId, 'Invalid Currency', 'curr@test.com', 'usd'] // lowercase is rejected
        ),
        (err: Error & { code?: string }) => err.code === '23514' // check_violation
      );
    });

    it('account role check constraint enforces only valid roles ("user", "admin") at SQL level', async () => {
      await assert.rejects(
        testPool.query(
          'INSERT INTO accounts (id, email, password_hash, role) VALUES ($1, $2, $3, $4);',
          ['acc_bad_role', 'badrole@test.com', 'hash', 'superadmin']
        ),
        (err: Error & { code?: string }) => err.code === '23514' // check_violation
      );
    });

    it('customer foreign key constraint enforces valid owning account_id at SQL level', async () => {
      await assert.rejects(
        testPool.query(
          'INSERT INTO customers (id, account_id, name, email, currency) VALUES ($1, $2, $3, $4, $5);',
          ['cus_orphan_fk', 'acc_nonexistent_owner', 'Orphan Corp', 'orphan@test.com', 'USD']
        ),
        (err: Error & { code?: string }) => err.code === '23503' // foreign_key_violation
      );
    });
  });

  describe('3. Database Health Endpoint', () => {
    it('GET /api/v1/health returns 200 and reports database: healthy via SELECT 1', async () => {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.status, 'healthy');
      assert.equal(json.data.database.status, 'healthy');
      assert.ok(json.data.timestamp);
    });
  });

  describe('4. Empty Database Verification', () => {
    it('GET /api/v1/customers returns 200 with empty array [] when 0 records exist', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: authHeader,
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.deepEqual(json.data, []);
    });
  });

  describe('5. Customer Lifecycle via PostgreSQL', () => {
    let createdId: string;

    it('POST /api/v1/customers inserts customer into PostgreSQL and returns 201 with Location header', async () => {
      const payload = {
        name: 'Wayne Enterprises',
        email: 'finance@wayne.com',
        currency: 'USD',
      };

      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(payload),
      });

      assert.equal(res.status, 201);
      assert.ok(res.headers.get('Location'));

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(json.data.id.startsWith('cus_'));
      assert.equal(json.data.accountId, testAccountId);
      assert.equal(json.data.name, 'Wayne Enterprises');
      assert.equal(json.data.email, 'finance@wayne.com');
      assert.equal(json.data.currency, 'USD');
      assert.ok(json.data.createdAt);
      assert.ok(json.data.updatedAt);

      createdId = json.data.id;

      // Verify record directly in PostgreSQL
      const dbRes = await testPool.query('SELECT * FROM customers WHERE id = $1;', [createdId]);
      assert.equal(dbRes.rows.length, 1);
      assert.equal(dbRes.rows[0].email, 'finance@wayne.com');
      assert.equal(dbRes.rows[0].account_id, testAccountId);
    });

    it('GET /api/v1/customers/:id retrieves persisted customer from PostgreSQL', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${createdId}`, {
        headers: authHeader,
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.id, createdId);
      assert.equal(json.data.accountId, testAccountId);
      assert.equal(json.data.name, 'Wayne Enterprises');
      assert.equal(json.data.email, 'finance@wayne.com');
    });

    it('POST /api/v1/customers rejects duplicate email with 409 Conflict (case-insensitive)', async () => {
      const duplicatePayload = {
        name: 'Wayne Alternate',
        email: 'FINANCE@WAYNE.COM', // Same email, uppercase
        currency: 'USD',
      };

      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(duplicatePayload),
      });

      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'DUPLICATE_RESOURCE');
    });

    it('PATCH /api/v1/customers/:id updates customer in PostgreSQL and preserves immutable fields', async () => {
      const initialRes = await fetch(`${baseUrl}/api/v1/customers/${createdId}`, {
        headers: authHeader,
      });
      const initialJson = await initialRes.json();
      const initialCreatedAt = initialJson.data.createdAt;

      // Wait 10ms to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10));

      const updatePayload = {
        name: 'Wayne Enterprises Global',
        currency: 'EUR',
      };

      const res = await fetch(`${baseUrl}/api/v1/customers/${createdId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(updatePayload),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.name, 'Wayne Enterprises Global');
      assert.equal(json.data.currency, 'EUR');
      assert.equal(json.data.accountId, testAccountId); // Immutable ownership
      assert.equal(json.data.createdAt, initialCreatedAt); // Immutable timestamp
      assert.notEqual(json.data.updatedAt, initialCreatedAt);
    });

    it('DELETE /api/v1/customers/:id deletes record from PostgreSQL and returns 204 No Content', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${createdId}`, {
        method: 'DELETE',
        headers: authHeader,
      });

      assert.equal(res.status, 204);
      assert.equal(await res.text(), ''); // Strict 204 has empty body

      // Verify deletion in database directly
      const dbRes = await testPool.query('SELECT * FROM customers WHERE id = $1;', [createdId]);
      assert.equal(dbRes.rows.length, 0);

      // Verify subsequent GET returns 404
      const lookupRes = await fetch(`${baseUrl}/api/v1/customers/${createdId}`, {
        headers: authHeader,
      });
      assert.equal(lookupRes.status, 404);
    });
  });

  describe('6. Durable Persistence Across Server Process Restart', () => {
    it('customer record survives complete server shutdown and restart', async () => {
      // 1. Create a customer on the running server
      const createRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          name: 'LexCorp Industries',
          email: 'legal@lexcorp.com',
          currency: 'USD',
        }),
      });
      assert.equal(createRes.status, 201);
      const createJson = await createRes.json();
      const customerId = createJson.data.id;

      // 2. Shut down Server Instance 1 completely
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });

      // 3. Instantiate and start a brand-new Server Instance 2
      const freshCustomerRepo = new PostgresCustomerRepository(testPool);
      const freshAccountRepo = new PostgresAccountRepository(testPool);
      const freshApp = createApp({
        customerRepository: freshCustomerRepo,
        accountRepository: freshAccountRepo,
        tokenService,
      });

      let newServer!: Server;
      let newBaseUrl = '';

      await new Promise<void>((resolve) => {
        newServer = freshApp.listen(0, '127.0.0.1', () => {
          const address = newServer.address();
          if (address && typeof address === 'object') {
            newBaseUrl = `http://127.0.0.1:${address.port}`;
          }
          resolve();
        });
      });

      try {
        // 4. Query the customer on Server Instance 2
        const queryRes = await fetch(`${newBaseUrl}/api/v1/customers/${customerId}`, {
          headers: authHeader,
        });
        assert.equal(queryRes.status, 200);

        const queryJson = await queryRes.json();
        assert.equal(queryJson.status, 'success');
        assert.equal(queryJson.data.id, customerId);
        assert.equal(queryJson.data.accountId, testAccountId);
        assert.equal(queryJson.data.name, 'LexCorp Industries');
        assert.equal(queryJson.data.email, 'legal@lexcorp.com');
      } finally {
        // Clean up Server Instance 2
        await new Promise<void>((resolve) => {
          newServer.close(() => resolve());
        });
      }
    });
  });

  describe('7. Database Failure & Truthful Degraded State', () => {
    let brokenPool: pg.Pool;
    let brokenServer: Server;
    let brokenBaseUrl: string;

    before(async () => {
      // Configure pool pointing to a dead port with fast timeout
      brokenPool = new Pool({
        connectionString: 'postgresql://postgres:badpass@127.0.0.1:54329/nonexistent',
        connectionTimeoutMillis: 500,
      });

      const brokenRepo = new PostgresCustomerRepository(brokenPool);
      const brokenHealth = new HealthController(async () => {
        try {
          const client = await brokenPool.connect();
          try {
            await client.query('SELECT 1');
            return true;
          } finally {
            client.release();
          }
        } catch {
          return false;
        }
      });

      const app = createApp({
        customerRepository: brokenRepo,
        tokenService,
        healthController: brokenHealth,
      });

      await new Promise<void>((resolve) => {
        brokenServer = app.listen(0, '127.0.0.1', () => {
          const addr = brokenServer.address();
          if (addr && typeof addr === 'object') {
            brokenBaseUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });
    });

    after(async () => {
      if (brokenServer) {
        await new Promise<void>((resolve) => {
          brokenServer.close(() => resolve());
        });
      }
      if (brokenPool) {
        await brokenPool.end();
      }
    });

    it('GET /api/v1/health returns 503 Service Unavailable and reports database: unhealthy', async () => {
      const res = await fetch(`${brokenBaseUrl}/api/v1/health`);
      assert.equal(res.status, 503);

      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.data.status, 'degraded');
      assert.equal(json.data.database.status, 'unhealthy');
    });

    it('customer operations fail safely with 500 without leaking credentials or switching to in-memory fallback', async () => {
      const res = await fetch(`${brokenBaseUrl}/api/v1/customers`, {
        headers: authHeader,
      });
      assert.equal(res.status, 500);

      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.ok(
        ['DATABASE_ERROR', 'INTERNAL_SERVER_ERROR'].includes(json.error.code),
        `Expected DATABASE_ERROR or INTERNAL_SERVER_ERROR, got ${json.error.code}`
      );
      // Ensure password or connection string is never leaked in the error message
      assert.ok(!JSON.stringify(json).includes('badpass'));
      assert.ok(!JSON.stringify(json).includes('54329'));
    });
  });

  describe('8. PostgreSQL Role & Ownership Authorization Enforcement', () => {
    let authzServer: Server;
    let authzBaseUrl: string;
    let userAToken: string;
    let userBToken: string;
    let customerAId: string;
    let customerBId: string;

    before(async () => {
      const customerRepo = new PostgresCustomerRepository(testPool);
      const accountRepo = new PostgresAccountRepository(testPool);
      const invoiceRepo = new PostgresInvoiceRepository(testPool);
      const app = createApp({
        customerRepository: customerRepo,
        accountRepository: accountRepo,
        invoiceRepository: invoiceRepo,
        tokenService,
      });

      await new Promise<void>((resolve) => {
        authzServer = app.listen(0, '127.0.0.1', () => {
          const addr = authzServer.address();
          if (addr && typeof addr === 'object') {
            authzBaseUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });

      // Register User A & User B against PostgreSQL
      const regA = await fetch(`${authzBaseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'pg_user_a@tenant.com', password: 'PasswordA123!' }),
      });
      assert.equal(regA.status, 201);
      const regAJson = await regA.json();
      assert.equal(regAJson.data.role, 'user');

      const loginA = await fetch(`${authzBaseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'pg_user_a@tenant.com', password: 'PasswordA123!' }),
      });
      userAToken = (await loginA.json()).data.token;

      const regB = await fetch(`${authzBaseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'pg_user_b@tenant.com', password: 'PasswordB123!' }),
      });
      assert.equal(regB.status, 201);

      const loginB = await fetch(`${authzBaseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'pg_user_b@tenant.com', password: 'PasswordB123!' }),
      });
      userBToken = (await loginB.json()).data.token;
    });

    after(async () => {
      if (authzServer) {
        await new Promise<void>((resolve) => {
          authzServer.close(() => resolve());
        });
      }
    });

    it('persists customer ownership in PostgreSQL and enforces IDOR 403 across accounts', async () => {
      const createA = await fetch(`${authzBaseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ name: 'PG Tenant A', email: 'a@pg-tenant.com', currency: 'USD' }),
      });
      assert.equal(createA.status, 201);
      customerAId = (await createA.json()).data.id;

      const createB = await fetch(`${authzBaseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userBToken}`,
        },
        body: JSON.stringify({ name: 'PG Tenant B', email: 'b@pg-tenant.com', currency: 'EUR' }),
      });
      assert.equal(createB.status, 201);
      customerBId = (await createB.json()).data.id;

      // User A cannot read User B's customer in PostgreSQL (403 FORBIDDEN)
      const idorGet = await fetch(`${authzBaseUrl}/api/v1/customers/${customerBId}`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(idorGet.status, 403);
      const idorGetJson = await idorGet.json();
      assert.equal(idorGetJson.error.code, 'FORBIDDEN');

      // User A list only returns Customer A from PostgreSQL
      const listA = await fetch(`${authzBaseUrl}/api/v1/customers`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(listA.status, 200);
      const listAJson = await listA.json();
      assert.equal(listAJson.data.length, 1);
      assert.equal(listAJson.data[0].id, customerAId);
    });

    it('enforces admin-only DELETE against PostgreSQL records (user -> 403, admin -> 204)', async () => {
      const userDelete = await fetch(`${authzBaseUrl}/api/v1/customers/${customerAId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(userDelete.status, 403);
      const userDeleteJson = await userDelete.json();
      assert.equal(userDeleteJson.error.code, 'FORBIDDEN');

      const adminDelete = await fetch(`${authzBaseUrl}/api/v1/customers/${customerAId}`, {
        method: 'DELETE',
        headers: authHeader,
      });
      assert.equal(adminDelete.status, 204);
    });

    it('enforces PostgreSQL foreign keys, check constraints, atomic transactions, ON DELETE RESTRICT (customer) and ON DELETE CASCADE (invoice)', async () => {
      // 1. SQL-level FK constraint on invoices.customer_id
      await assert.rejects(
        testPool.query(
          `INSERT INTO invoices (id, customer_id, invoice_number, status, currency, subtotal, tax, discount, total, due_date)
           VALUES ('inv_orphan_sql', 'cus_nonexistent_sql', 'INV-SQL-001', 'draft', 'EUR', 100.00, 0.00, 0.00, 100.00, NOW());`
        ),
        (err: Error & { code?: string }) => err.code === '23503'
      );

      // 2. SQL-level FK constraint on invoice_items.invoice_id
      await assert.rejects(
        testPool.query(
          `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, line_total)
           VALUES ('item_orphan_sql', 'inv_nonexistent_sql', 'Orphan Item', 1, 50.00, 50.00);`
        ),
        (err: Error & { code?: string }) => err.code === '23503'
      );

      // 3. Create an invoice with 2 line items for Customer B via HTTP API
      const createInvRes = await fetch(`${authzBaseUrl}/api/v1/customers/${customerBId}/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userBToken}`,
        },
        body: JSON.stringify({
          tax: 15.25,
          discount: 5.0,
          items: [
            { description: 'PostgreSQL HA Cluster', quantity: 2, unitPrice: 149.95 },
            { description: 'Point-in-Time Recovery Addon', quantity: 1, unitPrice: 50.10 },
          ],
        }),
      });
      assert.equal(createInvRes.status, 201);
      const createdInv = (await createInvRes.json()).data;
      assert.equal(createdInv.subtotal, 350.0);
      assert.equal(createdInv.total, 360.25);
      assert.equal(createdInv.items.length, 2);

      // 4. Verify ON DELETE RESTRICT prevents deleting Customer B while invoice exists
      const deleteCustWithInv = await fetch(`${authzBaseUrl}/api/v1/customers/${customerBId}`, {
        method: 'DELETE',
        headers: authHeader,
      });
      assert.equal(deleteCustWithInv.status, 409);
      const conflictJson = await deleteCustWithInv.json();
      assert.equal(conflictJson.error.code, 'CONFLICT');

      // 5. Verify atomic rollback in PostgresInvoiceRepository.create if an item violates SQL constraint
      const repo = new PostgresInvoiceRepository(testPool);
      const badInvoiceId = 'inv_atomic_rollback_test';
      await assert.rejects(
        repo.create({
          id: badInvoiceId,
          customerId: customerBId,
          invoiceNumber: 'INV-ROLLBACK-9999',
          status: 'draft',
          currency: 'EUR',
          subtotal: 100,
          tax: 0,
          discount: 0,
          total: 100,
          issueDate: new Date().toISOString(),
          dueDate: new Date().toISOString(),
          notes: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          items: [
            {
              id: 'item_valid_1',
              invoiceId: badInvoiceId,
              description: 'Valid first item',
              quantity: 1,
              unitPrice: 100,
              lineTotal: 100,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: 'item_invalid_2',
              invoiceId: badInvoiceId,
              description: 'Invalid second item with negative quantity violating SQL CHECK',
              quantity: -5,
              unitPrice: 100,
              lineTotal: -500,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        })
      );

      // Confirm neither the invoice header nor the first valid item remained in PostgreSQL
      const rolledBackInv = await testPool.query('SELECT * FROM invoices WHERE id = $1;', [badInvoiceId]);
      assert.equal(rolledBackInv.rows.length, 0);
      const rolledBackItems = await testPool.query('SELECT * FROM invoice_items WHERE invoice_id = $1;', [badInvoiceId]);
      assert.equal(rolledBackItems.rows.length, 0);

      // 6. Verify ON DELETE CASCADE removes invoice_items when Admin deletes the invoice
      const delInvRes = await fetch(`${authzBaseUrl}/api/v1/invoices/${createdInv.id}`, {
        method: 'DELETE',
        headers: authHeader,
      });
      assert.equal(delInvRes.status, 204);

      const remainingItems = await testPool.query('SELECT * FROM invoice_items WHERE invoice_id = $1;', [createdInv.id]);
      assert.equal(remainingItems.rows.length, 0);
    });

    it('executes SQL LIMIT/OFFSET pagination, parameterized filtering, and deterministic sorting in PostgreSQL', async () => {
      // Seed 3 invoices for Customer B with different statuses and totals
      const payloads = [
        {
          status: 'draft',
          issueDate: '2026-01-15T00:00:00.000Z',
          dueDate: '2026-02-15T00:00:00.000Z',
          items: [{ description: 'PG Node Alpha', quantity: 1, unitPrice: 100.0 }],
        },
        {
          status: 'issued',
          issueDate: '2026-02-20T00:00:00.000Z',
          dueDate: '2026-03-20T00:00:00.000Z',
          items: [{ description: 'PG Node Beta', quantity: 3, unitPrice: 100.0 }],
        },
        {
          status: 'issued',
          issueDate: '2026-03-25T00:00:00.000Z',
          dueDate: '2026-04-25T00:00:00.000Z',
          items: [{ description: 'PG Node Gamma', quantity: 2, unitPrice: 100.0 }],
        },
      ];

      for (const p of payloads) {
        const res = await fetch(`${authzBaseUrl}/api/v1/customers/${customerBId}/invoices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userBToken}`,
          },
          body: JSON.stringify(p),
        });
        assert.equal(res.status, 201);
      }

      // Query issued invoices sorted by total DESC with limit=1, page=1
      const page1Res = await fetch(
        `${authzBaseUrl}/api/v1/invoices?status=issued&sort=total&order=desc&page=1&limit=1`,
        {
          headers: { Authorization: `Bearer ${userBToken}` },
        }
      );
      assert.equal(page1Res.status, 200);
      const page1Json = await page1Res.json();
      assert.equal(page1Json.data.length, 1);
      assert.equal(page1Json.data[0].total, 300.0);
      assert.deepEqual(page1Json.pagination, {
        page: 1,
        limit: 1,
        total: 2,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });

      // Query page=2
      const page2Res = await fetch(
        `${authzBaseUrl}/api/v1/invoices?status=issued&sort=total&order=desc&page=2&limit=1`,
        {
          headers: { Authorization: `Bearer ${userBToken}` },
        }
      );
      assert.equal(page2Res.status, 200);
      const page2Json = await page2Res.json();
      assert.equal(page2Json.data.length, 1);
      assert.equal(page2Json.data[0].total, 200.0);
      assert.deepEqual(page2Json.pagination, {
        page: 2,
        limit: 1,
        total: 2,
        totalPages: 2,
        hasNextPage: false,
        hasPreviousPage: true,
      });
    });
  });

  describe('8. Test Database Isolation & Non-Destructive Development DB Verification (Phase 8)', () => {
    it('proves that destructive test database resets (billing_system_test) never touch persistent development data (billing_system)', async () => {
      const devDatabaseUrl = 'postgresql://postgres@localhost:5432/billing_system';
      assertSafeTestDatabaseUrl(TEST_DATABASE_URL, devDatabaseUrl);

      await runMigrations(devDatabaseUrl);
      const devPool = new Pool({ connectionString: devDatabaseUrl });

      try {
        // Seed a persistent account and customer in the development database
        await devPool.query(
          `INSERT INTO accounts (id, email, password_hash, role, created_at, updated_at)
           VALUES ('acc_dev_persistent', 'dev_owner@billing.local', 'scrypt$N=16384,r=8,p=1$00$00', 'user', NOW(), NOW())
           ON CONFLICT (id) DO NOTHING;`
        );
        await devPool.query(
          `INSERT INTO customers (id, account_id, name, email, currency, created_at, updated_at)
           VALUES ('cus_dev_persistent', 'acc_dev_persistent', 'Persistent Dev Customer', 'persistent@dev-billing.local', 'USD', NOW(), NOW())
           ON CONFLICT (id) DO NOTHING;`
        );

        // Perform a full TRUNCATE reset on the test database (testPool)
        await testPool.query('TRUNCATE TABLE invoice_items, invoices, customers, accounts CASCADE;');

        // Verify test database is now empty
        const testCount = await testPool.query('SELECT COUNT(*)::int AS cnt FROM customers;');
        assert.equal(testCount.rows[0].cnt, 0);

        // Verify development database record is 100% intact and uncorrupted
        const devCustomer = await devPool.query(
          `SELECT id, name, email FROM customers WHERE id = 'cus_dev_persistent';`
        );
        assert.equal(devCustomer.rows.length, 1);
        assert.equal(devCustomer.rows[0].name, 'Persistent Dev Customer');
      } finally {
        await devPool.end();
      }
    });
  });
});
