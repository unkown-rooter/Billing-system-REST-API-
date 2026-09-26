import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { createApp } from '../api/app.js';
import { InMemoryAccountRepository } from '../api/repositories/in-memory-account.repository.js';
import { InMemoryCustomerRepository } from '../api/repositories/in-memory-customer.repository.js';
import { InMemoryInvoiceRepository } from '../api/repositories/in-memory-invoice.repository.js';
import { PostgresCustomerRepository } from '../api/repositories/postgres-customer.repository.js';
import { PostgresInvoiceRepository } from '../api/repositories/postgres-invoice.repository.js';
import { PasswordService } from '../api/services/password.service.js';
import { TokenService } from '../api/services/token.service.js';
import { AuthService } from '../api/services/auth.service.js';
import { closePool } from '../api/db/pool.js';
import { Customer } from '../api/models/customer.model.js';
import { Invoice } from '../api/models/invoice.model.js';

describe('Billing System REST API - Phase 7 Pagination, Filtering & Deterministic Sorting Test Suite', () => {
  let server: Server;
  let baseUrl: string;
  let accountRepo: InMemoryAccountRepository;
  let customerRepo: InMemoryCustomerRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let passwordService: PasswordService;
  let tokenService: TokenService;
  let authService: AuthService;

  const JWT_SECRET = 'phase-7-pagination-filtering-test-secret-key-32-chars!!';

  let userAToken: string;
  let userBToken: string;
  let adminToken: string;

  const customersA: Customer[] = [];
  let customerB: Customer;
  const invoicesA: Invoice[] = [];
  let invoiceB: Invoice;

  before(async () => {
    accountRepo = new InMemoryAccountRepository();
    customerRepo = new InMemoryCustomerRepository();
    invoiceRepo = new InMemoryInvoiceRepository(customerRepo);
    passwordService = new PasswordService();
    tokenService = new TokenService({
      secret: JWT_SECRET,
      expiresInSeconds: 3600,
    });
    authService = new AuthService(accountRepo, passwordService, tokenService);

    const app = createApp({
      accountRepository: accountRepo,
      customerRepository: customerRepo,
      invoiceRepository: invoiceRepo,
      passwordService,
      tokenService,
      authService,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });

    // Register & login User A
    await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'tenant-a@pagination.com',
        password: 'TenantAPassword123!',
      }),
    });
    const loginARes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'tenant-a@pagination.com',
        password: 'TenantAPassword123!',
      }),
    });
    userAToken = (await loginARes.json()).data.token;

    // Register & login User B
    await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'tenant-b@pagination.com',
        password: 'TenantBPassword123!',
      }),
    });
    const loginBRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'tenant-b@pagination.com',
        password: 'TenantBPassword123!',
      }),
    });
    userBToken = (await loginBRes.json()).data.token;

    // Out-of-band Admin account
    const now = new Date().toISOString();
    await accountRepo.create({
      id: 'acc_phase7_admin',
      email: 'admin@pagination.com',
      passwordHash: await passwordService.hashPassword('AdminPassword123!'),
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });
    const loginAdminRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@pagination.com',
        password: 'AdminPassword123!',
      }),
    });
    adminToken = (await loginAdminRes.json()).data.token;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await closePool();
  });

  describe('1. Empty Dataset & Default Pagination Metadata', () => {
    it('GET /api/v1/customers returns empty array with default pagination metadata when 0 records exist', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.deepEqual(json.data, []);
      assert.deepEqual(json.pagination, {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });

    it('GET /api/v1/invoices returns empty array with default pagination metadata when 0 records exist', async () => {
      const res = await fetch(`${baseUrl}/api/v1/invoices`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.deepEqual(json.data, []);
      assert.deepEqual(json.pagination, {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });
  });

  describe('2. Customer Pagination, Filtering & Deterministic Sorting', () => {
    before(async () => {
      // Seed 5 customers for User A and 1 customer for User B
      const fixturesA = [
        { name: 'Charlie Cloud Ltd', email: 'charlie@cloud.io', currency: 'USD' },
        { name: 'Alpha Systems Inc', email: 'alpha@systems.io', currency: 'USD' },
        { name: 'Echo FinTech Group', email: 'echo@fintech.eu', currency: 'EUR' },
        { name: 'Bravo Data Corp', email: 'bravo@data.io', currency: 'USD' },
        { name: 'Delta Nairobi Hub', email: 'delta@nairobi.ke', currency: 'KES' },
      ];

      for (const f of fixturesA) {
        const res = await fetch(`${baseUrl}/api/v1/customers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userAToken}`,
          },
          body: JSON.stringify(f),
        });
        assert.equal(res.status, 201);
        customersA.push((await res.json()).data);
        await new Promise((r) => setTimeout(r, 5));
      }

      const resB = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userBToken}`,
        },
        body: JSON.stringify({
          name: 'Zeta External Tenant',
          email: 'zeta@tenant-b.org',
          currency: 'EUR',
        }),
      });
      assert.equal(resB.status, 201);
      customerB = (await resB.json()).data;
    });

    it('paginates customers across pages (page=1&limit=2, page=2&limit=2, page=3&limit=2) without duplicates or missing records', async () => {
      const p1Res = await fetch(`${baseUrl}/api/v1/customers?page=1&limit=2`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(p1Res.status, 200);
      const p1 = await p1Res.json();
      assert.equal(p1.data.length, 2);
      assert.deepEqual(p1.pagination, {
        page: 1,
        limit: 2,
        total: 5,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: false,
      });

      const p2Res = await fetch(`${baseUrl}/api/v1/customers?page=2&limit=2`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      const p2 = await p2Res.json();
      assert.equal(p2.data.length, 2);
      assert.deepEqual(p2.pagination, {
        page: 2,
        limit: 2,
        total: 5,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });

      const p3Res = await fetch(`${baseUrl}/api/v1/customers?page=3&limit=2`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      const p3 = await p3Res.json();
      assert.equal(p3.data.length, 1);
      assert.deepEqual(p3.pagination, {
        page: 3,
        limit: 2,
        total: 5,
        totalPages: 3,
        hasNextPage: false,
        hasPreviousPage: true,
      });

      // Verify all 5 IDs are distinct and match creation order (default sort: createdAt asc)
      const collectedIds = [...p1.data, ...p2.data, ...p3.data].map((c: Customer) => c.id);
      assert.deepEqual(
        collectedIds,
        customersA.map((c) => c.id)
      );
    });

    it('returns empty data array and accurate metadata when requesting an out-of-range page', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers?page=10&limit=2`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.deepEqual(json.data, []);
      assert.deepEqual(json.pagination, {
        page: 10,
        limit: 2,
        total: 5,
        totalPages: 3,
        hasNextPage: false,
        hasPreviousPage: true,
      });
    });

    it('filters customers by currency, email, and case-insensitive name substring', async () => {
      // Filter by currency=USD (3 matches for User A)
      const usdRes = await fetch(`${baseUrl}/api/v1/customers?currency=USD`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(usdRes.status, 200);
      const usdJson = await usdRes.json();
      assert.equal(usdJson.data.length, 3);
      assert.equal(usdJson.pagination.total, 3);
      assert.ok(usdJson.data.every((c: Customer) => c.currency === 'USD'));

      // Filter by exact email (case-insensitive)
      const emailRes = await fetch(`${baseUrl}/api/v1/customers?email=ECHO@FINTECH.EU`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(emailRes.status, 200);
      const emailJson = await emailRes.json();
      assert.equal(emailJson.data.length, 1);
      assert.equal(emailJson.data[0].email, 'echo@fintech.eu');

      // Filter by partial name (case-insensitive)
      const nameRes = await fetch(`${baseUrl}/api/v1/customers?name=nairobi`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(nameRes.status, 200);
      const nameJson = await nameRes.json();
      assert.equal(nameJson.data.length, 1);
      assert.equal(nameJson.data[0].name, 'Delta Nairobi Hub');
    });

    it('sorts customers deterministically by name (asc and desc)', async () => {
      const ascRes = await fetch(`${baseUrl}/api/v1/customers?sort=name&order=asc`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      const ascJson = await ascRes.json();
      const ascNames = ascJson.data.map((c: Customer) => c.name);
      assert.deepEqual(ascNames, [
        'Alpha Systems Inc',
        'Bravo Data Corp',
        'Charlie Cloud Ltd',
        'Delta Nairobi Hub',
        'Echo FinTech Group',
      ]);

      const descRes = await fetch(`${baseUrl}/api/v1/customers?sort=name&order=desc`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      const descJson = await descRes.json();
      const descNames = descJson.data.map((c: Customer) => c.name);
      assert.deepEqual(descNames, [...ascNames].reverse());
    });
  });

  describe('3. Invoice & InvoiceItem Pagination, Filtering & Sorting', () => {
    before(async () => {
      // Create 4 invoices for User A (across USD and EUR customers, with distinct statuses and dates)
      // CustomerA[0]: Charlie Cloud (USD)
      // CustomerA[1]: Alpha Systems (USD)
      // CustomerA[2]: Echo FinTech (EUR)
      const invPayloads = [
        {
          customerId: customersA[0].id,
          status: 'draft',
          issueDate: '2026-01-10T00:00:00.000Z',
          dueDate: '2026-02-10T00:00:00.000Z',
          items: [
            { description: 'Core Compute Cluster', quantity: 2, unitPrice: 100.0 },
            { description: 'Object Storage Tier', quantity: 5, unitPrice: 20.0 },
            { description: 'Dedicated Load Balancer', quantity: 1, unitPrice: 50.0 },
          ],
        },
        {
          customerId: customersA[0].id,
          status: 'issued',
          issueDate: '2026-02-15T00:00:00.000Z',
          dueDate: '2026-03-15T00:00:00.000Z',
          tax: 25.0,
          items: [{ description: 'Managed Kubernetes Control Plane', quantity: 1, unitPrice: 500.0 }],
        },
        {
          customerId: customersA[1].id,
          status: 'paid',
          issueDate: '2026-03-01T00:00:00.000Z',
          dueDate: '2026-03-31T00:00:00.000Z',
          items: [{ description: 'Annual Security Audit', quantity: 1, unitPrice: 1200.0 }],
        },
        {
          customerId: customersA[2].id,
          status: 'issued',
          issueDate: '2026-04-05T00:00:00.000Z',
          dueDate: '2026-05-05T00:00:00.000Z',
          items: [{ description: 'SEPA Ledger Integration', quantity: 3, unitPrice: 150.0 }],
        },
      ];

      for (const payload of invPayloads) {
        const res = await fetch(`${baseUrl}/api/v1/invoices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userAToken}`,
          },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 201);
        invoicesA.push((await res.json()).data);
        await new Promise((r) => setTimeout(r, 5));
      }

      // Create 1 invoice for User B (Customer B - EUR)
      const resB = await fetch(`${baseUrl}/api/v1/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userBToken}`,
        },
        body: JSON.stringify({
          customerId: customerB.id,
          status: 'issued',
          issueDate: '2026-03-10T00:00:00.000Z',
          dueDate: '2026-04-10T00:00:00.000Z',
          items: [{ description: 'Tenant B Consulting', quantity: 2, unitPrice: 400.0 }],
        }),
      });
      assert.equal(resB.status, 201);
      invoiceB = (await resB.json()).data;
    });

    it('filters invoices by status, customerId, currency, and date ranges', async () => {
      // 1. Filter by status=issued (User A has 2 issued invoices: one USD, one EUR)
      const issuedRes = await fetch(`${baseUrl}/api/v1/invoices?status=issued`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(issuedRes.status, 200);
      const issuedJson = await issuedRes.json();
      assert.equal(issuedJson.data.length, 2);
      assert.equal(issuedJson.pagination.total, 2);
      assert.ok(issuedJson.data.every((inv: Invoice) => inv.status === 'issued'));

      // 2. Combined filter: status=issued & currency=USD (1 match)
      const issuedUsdRes = await fetch(
        `${baseUrl}/api/v1/invoices?status=issued&currency=USD`,
        {
          headers: { Authorization: `Bearer ${userAToken}` },
        }
      );
      const issuedUsdJson = await issuedUsdRes.json();
      assert.equal(issuedUsdJson.data.length, 1);
      assert.equal(issuedUsdJson.data[0].id, invoicesA[1].id);
      assert.equal(issuedUsdJson.pagination.total, 1);

      // 3. Filter by customerId
      const custRes = await fetch(
        `${baseUrl}/api/v1/invoices?customerId=${customersA[0].id}`,
        {
          headers: { Authorization: `Bearer ${userAToken}` },
        }
      );
      const custJson = await custRes.json();
      assert.equal(custJson.data.length, 2);
      assert.equal(custJson.pagination.total, 2);

      // 4. Filter by issueDateFrom & issueDateTo (YYYY-MM-DD calendar bounds)
      const dateRangeRes = await fetch(
        `${baseUrl}/api/v1/invoices?issueDateFrom=2026-02-01&issueDateTo=2026-03-15`,
        {
          headers: { Authorization: `Bearer ${userAToken}` },
        }
      );
      assert.equal(dateRangeRes.status, 200);
      const dateRangeJson = await dateRangeRes.json();
      assert.equal(dateRangeJson.data.length, 2);
      assert.deepEqual(
        dateRangeJson.data.map((i: Invoice) => i.id),
        [invoicesA[1].id, invoicesA[2].id]
      );
    });

    it('sorts invoices deterministically by total (desc) and dueDate (asc)', async () => {
      // Totals for User A:
      // invoicesA[0] = 350.00
      // invoicesA[1] = 525.00
      // invoicesA[2] = 1200.00
      // invoicesA[3] = 450.00
      const totalDescRes = await fetch(
        `${baseUrl}/api/v1/invoices?sort=total&order=desc&page=1&limit=2`,
        {
          headers: { Authorization: `Bearer ${userAToken}` },
        }
      );
      assert.equal(totalDescRes.status, 200);
      const totalDescJson = await totalDescRes.json();
      assert.equal(totalDescJson.data.length, 2);
      assert.equal(totalDescJson.data[0].total, 1200.0);
      assert.equal(totalDescJson.data[1].total, 525.0);
      assert.equal(totalDescJson.pagination.total, 4);
      assert.equal(totalDescJson.pagination.totalPages, 2);
      assert.equal(totalDescJson.pagination.hasNextPage, true);
    });

    it('supports pagination and filtering on nested GET /api/v1/customers/:id/invoices', async () => {
      const res = await fetch(
        `${baseUrl}/api/v1/customers/${customersA[0].id}/invoices?status=draft&page=1&limit=5`,
        {
          headers: { Authorization: `Bearer ${userAToken}` },
        }
      );
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.length, 1);
      assert.equal(json.data[0].id, invoicesA[0].id);
      assert.equal(json.pagination.total, 1);
    });

    it('supports pagination, description filtering, and sorting on GET /api/v1/invoices/:id/items', async () => {
      // invoicesA[0] has 3 items: 200.00, 100.00, 50.00
      const page1Res = await fetch(
        `${baseUrl}/api/v1/invoices/${invoicesA[0].id}/items?sort=lineTotal&order=asc&page=1&limit=2`,
        {
          headers: { Authorization: `Bearer ${userAToken}` },
        }
      );
      assert.equal(page1Res.status, 200);
      const page1Json = await page1Res.json();
      assert.equal(page1Json.data.length, 2);
      assert.equal(page1Json.data[0].lineTotal, 50.0);
      assert.equal(page1Json.data[1].lineTotal, 100.0);
      assert.deepEqual(page1Json.pagination, {
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });

      // Filter items by description
      const descFilterRes = await fetch(
        `${baseUrl}/api/v1/invoices/${invoicesA[0].id}/items?description=Storage`,
        {
          headers: { Authorization: `Bearer ${userAToken}` },
        }
      );
      const descFilterJson = await descFilterRes.json();
      assert.equal(descFilterJson.data.length, 1);
      assert.equal(descFilterJson.data[0].description, 'Object Storage Tier');
      assert.equal(descFilterJson.pagination.total, 1);
    });
  });

  describe('4. Query Parameter Validation & SQL Injection Defense (400 VALIDATION_ERROR)', () => {
    it('rejects invalid page and limit values with 400 VALIDATION_ERROR', async () => {
      const invalidQueries = [
        'page=0',
        'page=-1',
        'page=abc',
        'page=1.5',
        'limit=0',
        'limit=-10',
        'limit=101',
        'limit=abc',
      ];

      for (const q of invalidQueries) {
        const res = await fetch(`${baseUrl}/api/v1/customers?${q}`, {
          headers: { Authorization: `Bearer ${userAToken}` },
        });
        assert.equal(res.status, 400, `Expected 400 for query ?${q}`);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'VALIDATION_ERROR');
      }
    });

    it('rejects unwhitelisted sort fields, invalid order directions, and unknown query parameters', async () => {
      const badRequests = [
        '/api/v1/customers?sort=passwordHash',
        '/api/v1/customers?sort=created_at;DROP%20TABLE%20customers',
        '/api/v1/customers?order=random',
        '/api/v1/customers?accountId=acc_spoof',
        '/api/v1/customers?unknownParam=123',
        '/api/v1/invoices?status=invalid_status',
        '/api/v1/invoices?customerId=invalid_id_format',
        '/api/v1/invoices?currency=USDT',
        '/api/v1/invoices?issueDateFrom=2026-05-01&issueDateTo=2026-01-01',
        '/api/v1/invoices?dueDateFrom=not-a-date',
      ];

      for (const path of badRequests) {
        const res = await fetch(`${baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${userAToken}` },
        });
        assert.equal(res.status, 400, `Expected 400 for ${path}`);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'VALIDATION_ERROR');
        assert.ok(Array.isArray(json.error.fields));
      }
    });
  });

  describe('5. Authorization Scope Integrity Under Filtering & Pagination', () => {
    it('prevents regular user from leaking another user invoices via ?customerId=<other-users-customer>', async () => {
      const res = await fetch(
        `${baseUrl}/api/v1/invoices?customerId=${customerB.id}`,
        {
          headers: { Authorization: `Bearer ${userAToken}` },
        }
      );
      assert.equal(res.status, 200);
      const json = await res.json();
      // Must return 0 records and total: 0 for User A
      assert.deepEqual(json.data, []);
      assert.equal(json.pagination.total, 0);
    });

    it('ensures regular user total count reflects only their own authorized records, while admin sees global total', async () => {
      const userARes = await fetch(`${baseUrl}/api/v1/invoices?status=issued`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      const userAJson = await userARes.json();
      assert.equal(userAJson.pagination.total, 2);

      const adminRes = await fetch(`${baseUrl}/api/v1/invoices?status=issued`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const adminJson = await adminRes.json();
      // Admin sees User A's 2 issued invoices + User B's 1 issued invoice = 3
      assert.equal(adminJson.pagination.total, 3);
      assert.equal(adminJson.data.length, 3);
    });
  });

  describe('6. PostgreSQL Repository Parameterized SQL & Deterministic ORDER BY Verification', () => {
    it('PostgresCustomerRepository.findPaginated executes strictly parameterized COUNT(*) and SELECT ... ORDER BY ... LIMIT/OFFSET', async () => {
      const recordedQueries: Array<{ text: string; values: unknown[] }> = [];
      const mockPool = {
        async query(text: string, values: unknown[] = []) {
          recordedQueries.push({ text, values });
          if (text.includes('COUNT(*)')) {
            return { rows: [{ count: '5' }] };
          }
          return {
            rows: [
              {
                id: 'cus_pg_1',
                account_id: 'acc_owner_1',
                name: 'Acme PG',
                email: 'acme@pg.com',
                currency: 'USD',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
              },
            ],
          };
        },
      };

      const pgCustomerRepo = new PostgresCustomerRepository(mockPool as any);
      const result = await pgCustomerRepo.findPaginated({
        accountId: 'acc_owner_1',
        currency: 'USD',
        name: 'Acme',
        page: 2,
        limit: 2,
        sort: 'name',
        order: 'desc',
      });

      assert.equal(recordedQueries.length, 2);

      // 1. Verify COUNT(*) query uses identical WHERE clause and positional parameters
      assert.ok(recordedQueries[0].text.includes('SELECT COUNT(*)::text AS count FROM customers'));
      assert.ok(
        recordedQueries[0].text.includes(
          'WHERE account_id = $1 AND currency = $2 AND name ILIKE $3'
        )
      );
      assert.deepEqual(recordedQueries[0].values, ['acc_owner_1', 'USD', '%Acme%']);

      // 2. Verify data SELECT query uses whitelisted ORDER BY with id tie-breaker and parameterized LIMIT/OFFSET
      assert.ok(recordedQueries[1].text.includes('ORDER BY name DESC, id DESC'));
      assert.ok(recordedQueries[1].text.includes('LIMIT $4 OFFSET $5'));
      assert.deepEqual(recordedQueries[1].values, ['acc_owner_1', 'USD', '%Acme%', 2, 2]);

      assert.equal(result.items.length, 1);
      assert.deepEqual(result.pagination, {
        page: 2,
        limit: 2,
        total: 5,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });

    it('PostgresInvoiceRepository.findPaginated joins customers for authorization scope and parameterizes all filters and bounds', async () => {
      const recordedQueries: Array<{ text: string; values: unknown[] }> = [];
      const mockPool = {
        async query(text: string, values: unknown[] = []) {
          recordedQueries.push({ text, values });
          if (text.includes('COUNT(*)')) {
            return { rows: [{ count: '1' }] };
          }
          if (text.includes('FROM invoice_items')) {
            return {
              rows: [
                {
                  id: 'item_0001_pg',
                  invoice_id: 'inv_pg_1',
                  description: 'Dedicated Node',
                  quantity: 2,
                  unit_price: '150.00',
                  line_total: '300.00',
                  created_at: '2026-02-01T00:00:00.000Z',
                  updated_at: '2026-02-01T00:00:00.000Z',
                },
              ],
            };
          }
          return {
            rows: [
              {
                id: 'inv_pg_1',
                customer_id: 'cus_pg_1',
                invoice_number: 'INV-2026-0001-ABCD',
                status: 'issued',
                currency: 'USD',
                subtotal: '300.00',
                tax: '0.00',
                discount: '0.00',
                total: '300.00',
                issue_date: '2026-02-01T00:00:00.000Z',
                due_date: '2026-03-01T00:00:00.000Z',
                notes: null,
                created_at: '2026-02-01T00:00:00.000Z',
                updated_at: '2026-02-01T00:00:00.000Z',
              },
            ],
          };
        },
      };

      const pgInvoiceRepo = new PostgresInvoiceRepository(mockPool as any);
      const result = await pgInvoiceRepo.findPaginated({
        accountId: 'acc_owner_1',
        customerId: 'cus_pg_1',
        status: 'issued',
        currency: 'USD',
        page: 1,
        limit: 10,
        sort: 'total',
        order: 'desc',
      });

      assert.equal(recordedQueries.length, 3); // 1 COUNT + 1 SELECT invoices + 1 SELECT invoice_items
      assert.ok(recordedQueries[0].text.includes('INNER JOIN customers c ON c.id = i.customer_id'));
      assert.ok(
        recordedQueries[0].text.includes(
          'WHERE c.account_id = $1 AND i.customer_id = $2 AND i.status = $3 AND i.currency = $4'
        )
      );
      assert.deepEqual(recordedQueries[0].values, ['acc_owner_1', 'cus_pg_1', 'issued', 'USD']);

      assert.ok(recordedQueries[1].text.includes('ORDER BY i.total DESC, i.id DESC'));
      assert.ok(recordedQueries[1].text.includes('LIMIT $5 OFFSET $6'));
      assert.deepEqual(recordedQueries[1].values, [
        'acc_owner_1',
        'cus_pg_1',
        'issued',
        'USD',
        10,
        0,
      ]);

      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].items.length, 1);
      assert.equal(result.pagination.total, 1);
    });
  });
});
