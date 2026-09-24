import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import pg from 'pg';
import { createApp } from '../api/app.js';
import { runMigrations } from '../api/db/migrate.js';
import { PostgresCustomerRepository } from '../api/repositories/postgres-customer.repository.js';
import { HealthController } from '../api/controllers/health.controller.js';

const { Pool } = pg;

// Dedicated test database connection string
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:5432/billing_system_test';

describe('Billing System REST API - Phase 2 PostgreSQL Integration Test Suite', () => {
  let testPool: pg.Pool;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    // 1. Run migrations against dedicated test database
    await runMigrations(TEST_DATABASE_URL);

    // 2. Setup connection pool for test operations
    testPool = new Pool({ connectionString: TEST_DATABASE_URL });

    // Clean test database table to start in pristine empty state
    await testPool.query('TRUNCATE TABLE customers CASCADE;');

    // 3. Create app wired directly to PostgresCustomerRepository with testPool
    const customerRepo = new PostgresCustomerRepository(testPool);
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
    });

    it('schema_migrations table tracks applied migrations', async () => {
      const res = await testPool.query('SELECT name FROM schema_migrations;');
      const names = res.rows.map((r) => r.name);
      assert.ok(names.includes('001_create_customers_table.sql'));
    });
  });

  describe('2. PostgreSQL Database Constraints Verification', () => {
    it('primary key constraint prevents duplicate IDs at SQL level', async () => {
      const id = 'cus_test_pk_123';
      await testPool.query(
        'INSERT INTO customers (id, name, email, currency) VALUES ($1, $2, $3, $4);',
        [id, 'First Entry', 'pk1@test.com', 'USD']
      );

      await assert.rejects(
        testPool.query(
          'INSERT INTO customers (id, name, email, currency) VALUES ($1, $2, $3, $4);',
          [id, 'Second Entry', 'pk2@test.com', 'USD']
        ),
        (err: Error & { code?: string }) => err.code === '23505'
      );

      await testPool.query('DELETE FROM customers WHERE id = $1;', [id]);
    });

    it('case-insensitive unique index prevents duplicate email variants at SQL level', async () => {
      const id1 = 'cus_email_test_1';
      const id2 = 'cus_email_test_2';

      await testPool.query(
        'INSERT INTO customers (id, name, email, currency) VALUES ($1, $2, $3, $4);',
        [id1, 'Case One', 'case.test@example.com', 'USD']
      );

      // Attempt insert with uppercase variant of the same email
      await assert.rejects(
        testPool.query(
          'INSERT INTO customers (id, name, email, currency) VALUES ($1, $2, $3, $4);',
          [id2, 'Case Two', 'CASE.TEST@EXAMPLE.COM', 'USD']
        ),
        (err: Error & { code?: string }) => err.code === '23505'
      );

      await testPool.query('DELETE FROM customers WHERE id IN ($1, $2);', [id1, id2]);
    });

    it('currency check constraint enforces 3 uppercase letters', async () => {
      const id = 'cus_curr_invalid';
      await assert.rejects(
        testPool.query(
          'INSERT INTO customers (id, name, email, currency) VALUES ($1, $2, $3, $4);',
          [id, 'Invalid Currency', 'curr@test.com', 'usd'] // lowercase is rejected
        ),
        (err: Error & { code?: string }) => err.code === '23514' // check_violation
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
      const res = await fetch(`${baseUrl}/api/v1/customers`);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      assert.equal(res.status, 201);
      assert.ok(res.headers.get('Location'));

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(json.data.id.startsWith('cus_'));
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
    });

    it('GET /api/v1/customers/:id retrieves persisted customer from PostgreSQL', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${createdId}`);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.id, createdId);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(duplicatePayload),
      });

      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'DUPLICATE_RESOURCE');
    });

    it('PATCH /api/v1/customers/:id updates customer in PostgreSQL and preserves immutable fields', async () => {
      const initialRes = await fetch(`${baseUrl}/api/v1/customers/${createdId}`);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.name, 'Wayne Enterprises Global');
      assert.equal(json.data.currency, 'EUR');
      assert.equal(json.data.createdAt, initialCreatedAt); // Immutable
      assert.notEqual(json.data.updatedAt, initialCreatedAt);
    });

    it('DELETE /api/v1/customers/:id deletes record from PostgreSQL and returns 204 No Content', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${createdId}`, {
        method: 'DELETE',
      });

      assert.equal(res.status, 204);
      assert.equal(await res.text(), ''); // Strict 204 has empty body

      // Verify deletion in database directly
      const dbRes = await testPool.query('SELECT * FROM customers WHERE id = $1;', [createdId]);
      assert.equal(dbRes.rows.length, 0);

      // Verify subsequent GET returns 404
      const lookupRes = await fetch(`${baseUrl}/api/v1/customers/${createdId}`);
      assert.equal(lookupRes.status, 404);
    });
  });

  describe('6. Durable Persistence Across Server Process Restart', () => {
    it('customer record survives complete server shutdown and restart', async () => {
      // 1. Create a customer on the running server
      const createRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const freshRepo = new PostgresCustomerRepository(testPool);
      const freshApp = createApp({ customerRepository: freshRepo });

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
        const queryRes = await fetch(`${newBaseUrl}/api/v1/customers/${customerId}`);
        assert.equal(queryRes.status, 200);

        const queryJson = await queryRes.json();
        assert.equal(queryJson.status, 'success');
        assert.equal(queryJson.data.id, customerId);
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
      const res = await fetch(`${brokenBaseUrl}/api/v1/customers`);
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
});
