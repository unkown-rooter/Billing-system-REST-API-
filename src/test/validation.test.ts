import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { createApp } from '../api/app.js';
import { InMemoryCustomerRepository } from '../api/repositories/in-memory-customer.repository.js';
import { InMemoryAccountRepository } from '../api/repositories/in-memory-account.repository.js';
import { TokenService } from '../api/services/token.service.js';
import { closePool } from '../api/db/pool.js';
import { Customer } from '../api/models/customer.model.js';
import { ICustomerRepository } from '../api/repositories/customer.repository.interface.js';

describe('Billing System REST API - Phase 3 Schema Validation & Error Architecture Test Suite', () => {
  let server: Server;
  let baseUrl: string;
  let inMemoryRepo: InMemoryCustomerRepository;
  let tokenService: TokenService;
  let authHeader: Record<string, string>;

  before(async () => {
    inMemoryRepo = new InMemoryCustomerRepository();
    const accountRepo = new InMemoryAccountRepository();
    tokenService = new TokenService();
    const now = new Date().toISOString();

    await accountRepo.create({
      id: 'acc_validation_test_user',
      email: 'validator@billing.com',
      passwordHash: 'scrypt$N=16384,r=8,p=1$00000000000000000000000000000000$00',
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });

    const token = tokenService.generateToken({
      id: 'acc_validation_test_user',
      email: 'validator@billing.com',
      role: 'admin',
    });
    authHeader = { Authorization: `Bearer ${token}` };

    const app = createApp({
      customerRepository: inMemoryRepo,
      accountRepository: accountRepo,
      tokenService,
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
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await closePool();
  });

  describe('1. Customer Create Schema Validation (POST /api/v1/customers)', () => {
    it('succeeds with a strictly valid request contract', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          name: 'Acme Corporation',
          email: 'billing@acme.com',
          currency: 'USD',
        }),
      });

      assert.equal(res.status, 201);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.match(json.data.id, /^cus_/);
      assert.equal(json.data.name, 'Acme Corporation');
      assert.equal(json.data.email, 'billing@acme.com');
      assert.equal(json.data.currency, 'USD');
    });

    it('rejects invalid body shapes: null, array, string, number', async () => {
      const invalidShapes = [
        'null',
        '[]',
        '"customer string"',
        '12345',
        'true',
      ];

      for (const shape of invalidShapes) {
        const res = await fetch(`${baseUrl}/api/v1/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: shape,
        });

        assert.equal(res.status, 400, `Expected 400 for shape: ${shape}`);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'VALIDATION_ERROR');
        assert.equal(json.error.message, 'Request body must be a JSON object');
      }
    });

    it('rejects missing required fields (name, email, currency) and reports all failed fields', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(json.error.fields));
      assert.equal(json.error.fields.length, 3);

      const fieldMap = Object.fromEntries(json.error.fields.map((f: { field: string; message: string }) => [f.field, f.message]));
      assert.ok(fieldMap.name.includes('required'));
      assert.ok(fieldMap.email.includes('required'));
      assert.ok(fieldMap.currency.includes('required'));
    });

    it('rejects missing name', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ email: 'test@name.com', currency: 'EUR' }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.ok(json.error.fields.some((f: { field: string }) => f.field === 'name'));
    });

    it('rejects missing email', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ name: 'Valid Name', currency: 'EUR' }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.ok(json.error.fields.some((f: { field: string }) => f.field === 'email'));
    });

    it('rejects missing currency', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ name: 'Valid Name', email: 'valid@example.com' }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.ok(json.error.fields.some((f: { field: string }) => f.field === 'currency'));
    });

    it('rejects invalid email formats', async () => {
      const invalidEmails = [
        'plainaddress',
        '@missinguser.com',
        'missingdomain@.com',
        'missing-tld@domain',
        'spaces in@email.com',
      ];

      for (const email of invalidEmails) {
        const res = await fetch(`${baseUrl}/api/v1/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ name: 'User', email, currency: 'USD' }),
        });
        assert.equal(res.status, 400, `Expected 400 for email: ${email}`);
        const json = await res.json();
        assert.equal(json.error.code, 'VALIDATION_ERROR');
        assert.ok(json.error.fields.some((f: { field: string }) => f.field === 'email'));
      }
    });

    it('rejects invalid currency representations (lowercase, wrong length, digits, symbols)', async () => {
      const invalidCurrencies = [
        'usd', // lowercase
        'US', // 2 chars
        'USDT', // 4 chars
        '123', // digits
        'U$D', // symbol
        '   ', // whitespace
      ];

      for (const currency of invalidCurrencies) {
        const res = await fetch(`${baseUrl}/api/v1/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ name: 'User', email: 'user@curr.com', currency }),
        });
        assert.equal(res.status, 400, `Expected 400 for currency: ${currency}`);
        const json = await res.json();
        assert.equal(json.error.code, 'VALIDATION_ERROR');
        assert.ok(json.error.fields.some((f: { field: string }) => f.field === 'currency'));
      }
    });

    it('rejects wrong field types (numbers, booleans, objects)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          name: 12345,
          email: true,
          currency: { code: 'USD' },
        }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      const fields = json.error.fields.map((f: { field: string }) => f.field);
      assert.ok(fields.includes('name'));
      assert.ok(fields.includes('email'));
      assert.ok(fields.includes('currency'));
    });

    it('rejects oversized name (> 255 characters)', async () => {
      const longName = 'A'.repeat(256);
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ name: longName, email: 'long@example.com', currency: 'USD' }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(json.error.fields.some((f: { field: string; message: string }) => f.field === 'name' && f.message.includes('255')));
    });

    it('rejects oversized email (> 254 characters)', async () => {
      const longLocal = 'a'.repeat(245);
      const longEmail = `${longLocal}@example.com`; // 257 chars
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ name: 'Oversized Email', email: longEmail, currency: 'USD' }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(json.error.fields.some((f: { field: string; message: string }) => f.field === 'email' && f.message.includes('254')));
    });

    it('rejects unknown fields (e.g. isAdmin, roles) and does not silently accept them', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          name: 'Hacker',
          email: 'hacker@safe.com',
          currency: 'USD',
          isAdmin: true,
          role: 'superuser',
        }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(json.error.fields));
      const unknownFields = json.error.fields.map((f: { field: string }) => f.field);
      assert.ok(unknownFields.includes('isAdmin'));
      assert.ok(unknownFields.includes('role'));
    });
  });

  describe('2. Customer Update Schema Validation (PATCH /api/v1/customers/:id)', () => {
    let customerId: string;

    before(async () => {
      const createRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          name: 'Original Entity',
          email: 'original@entity.com',
          currency: 'USD',
        }),
      });
      const createJson = await createRes.json();
      customerId = createJson.data.id;
    });

    it('allows valid partial updates: name only', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ name: 'Updated Entity Name' }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.name, 'Updated Entity Name');
      assert.equal(json.data.email, 'original@entity.com');
      assert.equal(json.data.currency, 'USD');
    });

    it('allows valid partial updates: email only', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ email: 'newemail@entity.com' }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.email, 'newemail@entity.com');
    });

    it('allows valid partial updates: currency only', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ currency: 'KES' }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.currency, 'KES');
    });

    it('rejects empty update payloads ({})', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(json.error.message.includes('empty'));
    });

    it('rejects modification attempts on immutable fields (id, createdAt)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          id: 'cus_new_fake_id',
          createdAt: '2020-01-01T00:00:00.000Z',
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      const fields = json.error.fields.map((f: { field: string }) => f.field);
      assert.ok(fields.includes('id'));
      assert.ok(fields.includes('createdAt'));
    });

    it('rejects unknown fields in update payload', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          name: 'Legit Name',
          balance: 10000,
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(json.error.fields.some((f: { field: string }) => f.field === 'balance'));
    });

    it('rejects invalid field formats on update (invalid email, invalid currency)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          email: 'not-an-email',
          currency: 'toolong',
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      const fields = json.error.fields.map((f: { field: string }) => f.field);
      assert.ok(fields.includes('email'));
      assert.ok(fields.includes('currency'));
    });
  });

  describe('3. Path Parameter Validation (:id)', () => {
    it('rejects malformed ID formats with 400 VALIDATION_ERROR', async () => {
      const malformedIds = [
        '12345',
        'not_cus_id',
        'customer_123',
        'cus!',
      ];

      for (const id of malformedIds) {
        const res = await fetch(`${baseUrl}/api/v1/customers/${id}`, {
          headers: authHeader,
        });
        assert.equal(res.status, 400, `Expected 400 for ID: ${id}`);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'VALIDATION_ERROR');
        assert.ok(json.error.fields.some((f: { field: string }) => f.field === 'id'));
      }
    });

    it('returns 404 RESOURCE_NOT_FOUND for validly formatted IDs that do not exist', async () => {
      const validFormatNonexistent = 'cus_99999999-9999-9999-9999-999999999999';
      const res = await fetch(`${baseUrl}/api/v1/customers/${validFormatNonexistent}`, {
        headers: authHeader,
      });
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'RESOURCE_NOT_FOUND');
    });
  });

  describe('4. Request Parsing & Malformed JSON', () => {
    it('returns 400 with MALFORMED_JSON when JSON body is invalid', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: '{"name": "broken syntax',
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'MALFORMED_JSON');
      assert.equal(json.error.message, 'Invalid JSON payload received in request body');
    });
  });

  describe('5. Controlled Error Sanitization & Failure Injection', () => {
    it('sanitizes unexpected internal exceptions without leaking stack trace, paths, or secrets', async () => {
      // Create a mock repository that throws an unexpected error containing simulated secrets
      const failingRepo: ICustomerRepository = {
        async findAll(): Promise<Customer[]> {
          throw new Error('FATAL: Connection to postgres://secret_user:secret_password@db.internal:5432/db failed at /var/app/secret/path.ts:42');
        },
        async findByAccountId(): Promise<Customer[]> {
          throw new Error('FATAL: Connection to postgres://secret_user:secret_password@db.internal:5432/db failed at /var/app/secret/path.ts:42');
        },
        async findById(): Promise<Customer | null> { return null; },
        async findByEmail(): Promise<Customer | null> { return null; },
        async create(): Promise<Customer> { throw new Error('fail'); },
        async update(): Promise<Customer | null> { return null; },
        async delete(): Promise<boolean> { return false; },
        async count(): Promise<number> { return 0; },
      };

      const failureApp = createApp({
        customerRepository: failingRepo,
        tokenService,
      });
      let failServer: Server;
      let failBaseUrl = '';

      await new Promise<void>((resolve) => {
        failServer = failureApp.listen(0, '127.0.0.1', () => {
          const address = failServer.address();
          if (address && typeof address === 'object') {
            failBaseUrl = `http://127.0.0.1:${address.port}`;
          }
          resolve();
        });
      });

      try {
        const res = await fetch(`${failBaseUrl}/api/v1/customers`, {
          headers: authHeader,
        });
        assert.equal(res.status, 500);

        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'INTERNAL_SERVER_ERROR');
        assert.equal(json.error.message, 'An unexpected internal error occurred');

        // Confirm ZERO leaked secrets or internal paths
        const serialized = JSON.stringify(json);
        assert.ok(!serialized.includes('secret_user'));
        assert.ok(!serialized.includes('secret_password'));
        assert.ok(!serialized.includes('/var/app'));
        assert.ok(!serialized.includes('.ts:'));
        assert.ok(!serialized.includes('stack'));
      } finally {
        await new Promise<void>((resolve) => failServer.close(() => resolve()));
      }
    });
  });
});
