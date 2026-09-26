import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { createApp } from '../api/app.js';
import { InMemoryCustomerRepository } from '../api/repositories/in-memory-customer.repository.js';
import { InMemoryAccountRepository } from '../api/repositories/in-memory-account.repository.js';
import { TokenService } from '../api/services/token.service.js';
import { closePool } from '../api/db/pool.js';

describe('Billing System REST API - Phase 1 Test Suite', () => {
  let server: Server;
  let baseUrl: string;
  let authHeader: Record<string, string>;
  const adminAccountId = 'acc_phase1_test_admin';

  before(async () => {
    const accountRepo = new InMemoryAccountRepository();
    const tokenService = new TokenService();
    const now = new Date().toISOString();

    await accountRepo.create({
      id: adminAccountId,
      email: 'admin@phase1test.com',
      passwordHash: 'scrypt$N=16384,r=8,p=1$00000000000000000000000000000000$00',
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });

    const token = tokenService.generateToken({
      id: adminAccountId,
      email: 'admin@phase1test.com',
      role: 'admin',
    });
    authHeader = { Authorization: `Bearer ${token}` };

    const app = createApp({
      customerRepository: new InMemoryCustomerRepository(),
      accountRepository: accountRepo,
      tokenService,
    });
    await new Promise<void>((resolve) => {
      // Listen on port 0 to bind to an available ephemeral port
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
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await closePool();
  });

  describe('1. Health Check', () => {
    it('GET /api/v1/health returns 200 OK and valid health payload', async () => {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.status, 'healthy');
      assert.ok(json.data.timestamp);
      assert.ok(typeof json.data.uptime === 'number');
    });
  });

  describe('2. Customer Listing (Initial Empty State)', () => {
    it('GET /api/v1/customers returns 200 with an empty array when no customers exist', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: authHeader,
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data));
      assert.equal(json.data.length, 0);
    });
  });

  describe('3. Customer Creation', () => {
    it('POST /api/v1/customers succeeds with valid payload and returns 201 with Location header', async () => {
      const payload = {
        name: 'Stark Enterprises',
        email: 'billing@starkenterprises.com',
        currency: 'USD',
      };

      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(payload),
      });

      assert.equal(res.status, 201);
      const location = res.headers.get('location');
      assert.ok(location);
      assert.match(location, /^\/api\/v1\/customers\/cus_/);

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.match(json.data.id, /^cus_/);
      assert.equal(json.data.accountId, adminAccountId);
      assert.equal(json.data.name, 'Stark Enterprises');
      assert.equal(json.data.email, 'billing@starkenterprises.com');
      assert.equal(json.data.currency, 'USD');
      assert.ok(json.data.createdAt);
      assert.ok(json.data.updatedAt);
      assert.equal(json.data.createdAt, json.data.updatedAt);
    });

    it('POST /api/v1/customers fails (400) when name is missing or whitespace only', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ name: '   ', email: 'test@example.com' }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });

    it('POST /api/v1/customers fails (400) when email format is invalid', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ name: 'Invalid Email Corp', email: 'not-an-email' }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });

    it('POST /api/v1/customers fails (400) when currency is not a 3-letter ISO code', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ name: 'Bad Currency LLC', email: 'currency@bad.com', currency: 'US' }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });

    it('POST /api/v1/customers fails (409) on duplicate email (case-insensitive)', async () => {
      // First customer was billing@starkenterprises.com
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          name: 'Stark Copy',
          email: 'BILLING@STARKENTERPRISES.COM',
          currency: 'USD',
        }),
      });

      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'DUPLICATE_RESOURCE');
    });
  });

  describe('4. Customer Retrieval', () => {
    it('GET /api/v1/customers/:id retrieves existing customer by ID', async () => {
      const listRes = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: authHeader,
      });
      const listJson = await listRes.json();
      const existingId = listJson.data[0].id;

      const res = await fetch(`${baseUrl}/api/v1/customers/${existingId}`, {
        headers: authHeader,
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.id, existingId);
      assert.equal(json.data.email, 'billing@starkenterprises.com');
    });

    it('GET /api/v1/customers/:id returns 404 for nonexistent customer', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/cus_nonexistent_id_999`, {
        headers: authHeader,
      });
      assert.equal(res.status, 404);

      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'RESOURCE_NOT_FOUND');
    });
  });

  describe('5. Customer Update (PATCH)', () => {
    it('PATCH /api/v1/customers/:id updates valid fields, refreshes updatedAt, and preserves createdAt & id', async () => {
      const listRes = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: authHeader,
      });
      const listJson = await listRes.json();
      const target = listJson.data[0];

      // Wait a few milliseconds to ensure timestamp divergence
      await new Promise((r) => setTimeout(r, 10));

      const res = await fetch(`${baseUrl}/api/v1/customers/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          name: 'Stark Global Enterprises',
          currency: 'EUR',
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.id, target.id); // Protected
      assert.equal(json.data.name, 'Stark Global Enterprises'); // Updated
      assert.equal(json.data.currency, 'EUR'); // Updated
      assert.equal(json.data.createdAt, target.createdAt); // Unchanged
      assert.notEqual(json.data.updatedAt, target.createdAt); // Advanced
    });

    it('PATCH /api/v1/customers/:id fails (400) when attempting to modify immutable fields (id, createdAt)', async () => {
      const listRes = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: authHeader,
      });
      const listJson = await listRes.json();
      const target = listJson.data[0];

      const res = await fetch(`${baseUrl}/api/v1/customers/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          name: 'Forbidden Update',
          id: 'cus_attempt_to_override_id',
          createdAt: '1970-01-01T00:00:00.000Z',
        }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(json.error.fields));
      const fieldNames = json.error.fields.map((f: { field: string }) => f.field);
      assert.ok(fieldNames.includes('id'));
      assert.ok(fieldNames.includes('createdAt'));
    });

    it('PATCH /api/v1/customers/:id fails (400) when unknown fields are provided', async () => {
      const listRes = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: authHeader,
      });
      const listJson = await listRes.json();
      const target = listJson.data[0];

      const res = await fetch(`${baseUrl}/api/v1/customers/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          name: 'Valid Name',
          isAdmin: true,
        }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(json.error.fields));
      assert.ok(json.error.fields.some((f: { field: string }) => f.field === 'isAdmin'));
    });

    it('PATCH /api/v1/customers/:id fails (400) if update payload is empty', async () => {
      const listRes = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: authHeader,
      });
      const listJson = await listRes.json();
      const target = listJson.data[0];

      const res = await fetch(`${baseUrl}/api/v1/customers/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });

    it('PATCH /api/v1/customers/:id returns 404 for nonexistent customer', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/cus_ghost_customer`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ name: 'Ghost' }),
      });

      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'RESOURCE_NOT_FOUND');
    });
  });

  describe('6. Customer Deletion', () => {
    it('DELETE /api/v1/customers/:id deletes existing customer and returns 204 No Content', async () => {
      const listRes = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: authHeader,
      });
      const listJson = await listRes.json();
      const target = listJson.data[0];

      const res = await fetch(`${baseUrl}/api/v1/customers/${target.id}`, {
        method: 'DELETE',
        headers: authHeader,
      });

      assert.equal(res.status, 204);
      const bodyText = await res.text();
      assert.equal(bodyText, ''); // 204 MUST have no body

      // Verify customer can no longer be retrieved
      const getRes = await fetch(`${baseUrl}/api/v1/customers/${target.id}`, {
        headers: authHeader,
      });
      assert.equal(getRes.status, 404);

      // Verify customer list is now empty again
      const verifyListRes = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: authHeader,
      });
      const verifyListJson = await verifyListRes.json();
      assert.equal(verifyListJson.data.length, 0);
    });

    it('DELETE /api/v1/customers/:id returns 404 for nonexistent customer', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/cus_nonexistent_delete`, {
        method: 'DELETE',
        headers: authHeader,
      });

      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'RESOURCE_NOT_FOUND');
    });
  });

  describe('7. Routing & Error Handling', () => {
    it('GET /api/v1/unknown-endpoint returns JSON 404 with ROUTE_NOT_FOUND code', async () => {
      const res = await fetch(`${baseUrl}/api/v1/unknown-endpoint`);
      assert.equal(res.status, 404);

      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'ROUTE_NOT_FOUND');
    });

    it('POST with malformed JSON body returns 400 with MALFORMED_JSON code', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: '{"name": "broken-json,',
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'MALFORMED_JSON');
    });
  });
});
