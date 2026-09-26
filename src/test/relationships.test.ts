import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { createApp } from '../api/app.js';
import { InMemoryAccountRepository } from '../api/repositories/in-memory-account.repository.js';
import { InMemoryCustomerRepository } from '../api/repositories/in-memory-customer.repository.js';
import { InMemoryInvoiceRepository } from '../api/repositories/in-memory-invoice.repository.js';
import { PasswordService } from '../api/services/password.service.js';
import { TokenService } from '../api/services/token.service.js';
import { AuthService } from '../api/services/auth.service.js';
import { closePool } from '../api/db/pool.js';
import { Customer } from '../api/models/customer.model.js';
import { Invoice } from '../api/models/invoice.model.js';

describe('Billing System REST API - Phase 6 Relationships & Relational Domain Modeling Test Suite', () => {
  let server: Server;
  let baseUrl: string;
  let accountRepo: InMemoryAccountRepository;
  let customerRepo: InMemoryCustomerRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let passwordService: PasswordService;
  let tokenService: TokenService;
  let authService: AuthService;

  const JWT_SECRET = 'phase-6-relationships-test-secret-key-min-32-chars!!';

  let userAToken: string;
  let userBToken: string;
  let adminToken: string;

  let customerA: Customer;
  let customerB: Customer;
  let invoiceA1: Invoice;
  let invoiceA2: Invoice;
  let invoiceB1: Invoice;

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
        email: 'owner-a@billing.com',
        password: 'OwnerAPassword123!',
      }),
    });
    const loginARes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner-a@billing.com',
        password: 'OwnerAPassword123!',
      }),
    });
    userAToken = (await loginARes.json()).data.token;

    // Register & login User B
    await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner-b@billing.com',
        password: 'OwnerBPassword123!',
      }),
    });
    const loginBRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner-b@billing.com',
        password: 'OwnerBPassword123!',
      }),
    });
    userBToken = (await loginBRes.json()).data.token;

    // Provision Admin out-of-band
    const now = new Date().toISOString();
    await accountRepo.create({
      id: 'acc_phase6_admin',
      email: 'admin@billing.com',
      passwordHash: await passwordService.hashPassword('AdminPassword123!'),
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });
    const loginAdminRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@billing.com',
        password: 'AdminPassword123!',
      }),
    });
    adminToken = (await loginAdminRes.json()).data.token;

    // User A creates Customer A (USD)
    const custARes = await fetch(`${baseUrl}/api/v1/customers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userAToken}`,
      },
      body: JSON.stringify({
        name: 'Acme Cloud Solutions',
        email: 'ap@acmecloud.com',
        currency: 'USD',
      }),
    });
    assert.equal(custARes.status, 201);
    customerA = (await custARes.json()).data;

    // User B creates Customer B (EUR)
    const custBRes = await fetch(`${baseUrl}/api/v1/customers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userBToken}`,
      },
      body: JSON.stringify({
        name: 'EuroTech GmbH',
        email: 'finance@eurotech.de',
        currency: 'EUR',
      }),
    });
    assert.equal(custBRes.status, 201);
    customerB = (await custBRes.json()).data;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await closePool();
  });

  describe('1. Customer → Invoice → InvoiceItem Creation & Authoritative Financial Math', () => {
    it('creates an invoice with line items via nested POST /api/v1/customers/:id/invoices and computes exact cents totals', async () => {
      // 3 * 19.99 = 59.97
      // 2 * 10.05 = 20.10
      // subtotal = 80.07, tax = 6.41, discount = 5.00 => total = 81.48
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          tax: 6.41,
          discount: 5.0,
          notes: 'Q3 Infrastructure & Compute Usage',
          items: [
            {
              description: 'Dedicated Compute Node (vCPU x8)',
              quantity: 3,
              unitPrice: 19.99,
            },
            {
              description: 'Managed Block Storage (TB)',
              quantity: 2,
              unitPrice: 10.05,
            },
          ],
        }),
      });

      assert.equal(res.status, 201);
      const location = res.headers.get('location');
      assert.ok(location);
      assert.match(location, /^\/api\/v1\/invoices\/inv_/);

      const json = await res.json();
      assert.equal(json.status, 'success');
      invoiceA1 = json.data;

      assert.match(invoiceA1.id, /^inv_/);
      assert.equal(invoiceA1.customerId, customerA.id);
      assert.match(invoiceA1.invoiceNumber, /^INV-\d{4}-\d{4}-[A-F0-9]{4}$/);
      assert.equal(invoiceA1.status, 'draft');
      assert.equal(invoiceA1.currency, 'USD'); // Inherited from Customer A
      assert.equal(invoiceA1.subtotal, 80.07);
      assert.equal(invoiceA1.tax, 6.41);
      assert.equal(invoiceA1.discount, 5.0);
      assert.equal(invoiceA1.total, 81.48);
      assert.equal(invoiceA1.notes, 'Q3 Infrastructure & Compute Usage');
      assert.equal(invoiceA1.items.length, 2);

      assert.match(invoiceA1.items[0].id, /^item_/);
      assert.equal(invoiceA1.items[0].invoiceId, invoiceA1.id);
      assert.equal(invoiceA1.items[0].description, 'Dedicated Compute Node (vCPU x8)');
      assert.equal(invoiceA1.items[0].quantity, 3);
      assert.equal(invoiceA1.items[0].unitPrice, 19.99);
      assert.equal(invoiceA1.items[0].lineTotal, 59.97);

      assert.match(invoiceA1.items[1].id, /^item_/);
      assert.equal(invoiceA1.items[1].invoiceId, invoiceA1.id);
      assert.equal(invoiceA1.items[1].quantity, 2);
      assert.equal(invoiceA1.items[1].unitPrice, 10.05);
      assert.equal(invoiceA1.items[1].lineTotal, 20.1);
    });

    it('creates an invoice via top-level POST /api/v1/invoices with explicit customerId and unique invoiceNumber', async () => {
      const res = await fetch(`${baseUrl}/api/v1/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          customerId: customerA.id,
          currency: 'USD',
          status: 'issued',
          items: [
            {
              description: 'Enterprise Support Retainer',
              quantity: 1,
              unitPrice: 250.0,
            },
          ],
        }),
      });

      assert.equal(res.status, 201);
      const json = await res.json();
      invoiceA2 = json.data;

      assert.notEqual(invoiceA2.id, invoiceA1.id);
      assert.notEqual(invoiceA2.invoiceNumber, invoiceA1.invoiceNumber);
      assert.equal(invoiceA2.customerId, customerA.id);
      assert.equal(invoiceA2.status, 'issued');
      assert.equal(invoiceA2.subtotal, 250.0);
      assert.equal(invoiceA2.tax, 0);
      assert.equal(invoiceA2.discount, 0);
      assert.equal(invoiceA2.total, 250.0);
      assert.equal(invoiceA2.items.length, 1);
      assert.equal(invoiceA2.items[0].lineTotal, 250.0);
    });

    it('creates an invoice for Customer B (EUR) when authenticated as User B', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerB.id}/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userBToken}`,
        },
        body: JSON.stringify({
          items: [
            {
              description: 'EU Compliance Audit',
              quantity: 4,
              unitPrice: 125.5,
            },
          ],
        }),
      });

      assert.equal(res.status, 201);
      const json = await res.json();
      invoiceB1 = json.data;
      assert.equal(invoiceB1.customerId, customerB.id);
      assert.equal(invoiceB1.currency, 'EUR');
      assert.equal(invoiceB1.subtotal, 502.0);
      assert.equal(invoiceB1.total, 502.0);
    });
  });

  describe('2. Referential Integrity, Validation & Anti-Tampering Rules', () => {
    it('returns 404 RESOURCE_NOT_FOUND when creating an invoice for a nonexistent customer', async () => {
      const topLevelRes = await fetch(`${baseUrl}/api/v1/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          customerId: 'cus_nonexistent_customer_999',
          items: [{ description: 'Orphan Item', quantity: 1, unitPrice: 50 }],
        }),
      });
      assert.equal(topLevelRes.status, 404);
      const topLevelJson = await topLevelRes.json();
      assert.equal(topLevelJson.error.code, 'RESOURCE_NOT_FOUND');

      const nestedRes = await fetch(
        `${baseUrl}/api/v1/customers/cus_nonexistent_customer_999/invoices`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userAToken}`,
          },
          body: JSON.stringify({
            items: [{ description: 'Orphan Item', quantity: 1, unitPrice: 50 }],
          }),
        }
      );
      assert.equal(nestedRes.status, 404);
      const nestedJson = await nestedRes.json();
      assert.equal(nestedJson.error.code, 'RESOURCE_NOT_FOUND');
    });

    it('rejects client-supplied computed totals (subtotal, total, lineTotal, invoiceNumber) with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/v1/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          customerId: customerA.id,
          invoiceNumber: 'INV-FAKE-001',
          subtotal: 0.01,
          total: 0.01,
          items: [
            {
              description: 'Tampered Item',
              quantity: 10,
              unitPrice: 100,
              lineTotal: 0.01,
            },
          ],
        }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      const fields = json.error.fields.map((f: { field: string }) => f.field);
      assert.ok(fields.includes('invoiceNumber'));
      assert.ok(fields.includes('subtotal'));
      assert.ok(fields.includes('total'));
      assert.ok(fields.includes('items[0].lineTotal'));
    });

    it('rejects invoices with empty items array or invalid item quantity/unitPrice with 400 VALIDATION_ERROR', async () => {
      const emptyItemsRes = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ items: [] }),
      });
      assert.equal(emptyItemsRes.status, 400);

      const badItemRes = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          items: [
            {
              description: '   ',
              quantity: 0,
              unitPrice: -15.5,
            },
          ],
        }),
      });
      assert.equal(badItemRes.status, 400);
      const badItemJson = await badItemRes.json();
      assert.equal(badItemJson.error.code, 'VALIDATION_ERROR');
      const fieldNames = badItemJson.error.fields.map((f: { field: string }) => f.field);
      assert.ok(fieldNames.includes('items[0].description'));
      assert.ok(fieldNames.includes('items[0].quantity'));
      assert.ok(fieldNames.includes('items[0].unitPrice'));
    });

    it('rejects invoice currency that conflicts with parent customer currency (400 VALIDATION_ERROR)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          currency: 'EUR', // Customer A is USD
          items: [{ description: 'Mismatched Currency Item', quantity: 1, unitPrice: 100 }],
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });

    it('rejects discount exceeding subtotal + tax resulting in negative total (400 VALIDATION_ERROR)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          tax: 5,
          discount: 200, // subtotal is 100, so 100 + 5 - 200 = -95
          items: [{ description: 'Standard Item', quantity: 1, unitPrice: 100 }],
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('3. Relational Queries & Nested Resource Retrieval', () => {
    it('GET /api/v1/customers/:id/invoices lists all invoices with nested items for that customer', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}/invoices`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.length, 2);
      assert.equal(json.data[0].id, invoiceA1.id);
      assert.equal(json.data[0].items.length, 2);
      assert.equal(json.data[1].id, invoiceA2.id);
      assert.equal(json.data[1].items.length, 1);
    });

    it('GET /api/v1/invoices/:id retrieves a single invoice along with its line items', async () => {
      const res = await fetch(`${baseUrl}/api/v1/invoices/${invoiceA1.id}`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.id, invoiceA1.id);
      assert.equal(json.data.customerId, customerA.id);
      assert.equal(json.data.items.length, 2);
    });

    it('GET /api/v1/invoices/:id/items retrieves the ordered line items for an invoice', async () => {
      const res = await fetch(`${baseUrl}/api/v1/invoices/${invoiceA1.id}/items`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.length, 2);
      assert.equal(json.data[0].invoiceId, invoiceA1.id);
      assert.equal(json.data[0].lineTotal, 59.97);
      assert.equal(json.data[1].lineTotal, 20.1);
    });

    it('GET /api/v1/invoices scopes results by customer ownership for regular users and returns all for admin', async () => {
      const resA = await fetch(`${baseUrl}/api/v1/invoices`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(resA.status, 200);
      const jsonA = await resA.json();
      assert.equal(jsonA.data.length, 2);
      assert.ok(jsonA.data.every((inv: Invoice) => inv.customerId === customerA.id));

      const resB = await fetch(`${baseUrl}/api/v1/invoices`, {
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      assert.equal(resB.status, 200);
      const jsonB = await resB.json();
      assert.equal(jsonB.data.length, 1);
      assert.equal(jsonB.data[0].id, invoiceB1.id);

      const resAdmin = await fetch(`${baseUrl}/api/v1/invoices`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(resAdmin.status, 200);
      const jsonAdmin = await resAdmin.json();
      assert.equal(jsonAdmin.data.length, 3);
    });
  });

  describe('4. Transitive Relational Ownership & IDOR Protection (401 vs 403)', () => {
    it('returns 401 AUTHENTICATION_REQUIRED for unauthenticated requests to invoice routes', async () => {
      const endpoints = [
        { method: 'GET', path: '/api/v1/invoices' },
        { method: 'POST', path: '/api/v1/invoices' },
        { method: 'GET', path: `/api/v1/invoices/${invoiceA1.id}` },
        { method: 'GET', path: `/api/v1/invoices/${invoiceA1.id}/items` },
        { method: 'PATCH', path: `/api/v1/invoices/${invoiceA1.id}` },
        { method: 'DELETE', path: `/api/v1/invoices/${invoiceA1.id}` },
        { method: 'GET', path: `/api/v1/customers/${customerA.id}/invoices` },
        { method: 'POST', path: `/api/v1/customers/${customerA.id}/invoices` },
      ];

      for (const ep of endpoints) {
        const res = await fetch(`${baseUrl}${ep.path}`, { method: ep.method });
        assert.equal(res.status, 401, `Expected 401 for unauthenticated ${ep.method} ${ep.path}`);
      }
    });

    it('denies Account A from creating an invoice for Account B customer (403 FORBIDDEN)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerB.id}/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          items: [{ description: 'Cross-Tenant Injection', quantity: 1, unitPrice: 100 }],
        }),
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error.code, 'FORBIDDEN');
    });

    it('denies Account A from reading Account B customer invoices or invoice items (IDOR -> 403 FORBIDDEN)', async () => {
      const listRes = await fetch(`${baseUrl}/api/v1/customers/${customerB.id}/invoices`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(listRes.status, 403);

      const getRes = await fetch(`${baseUrl}/api/v1/invoices/${invoiceB1.id}`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(getRes.status, 403);
      const getJson = await getRes.json();
      assert.ok(!JSON.stringify(getJson).includes('EU Compliance Audit'));

      const itemsRes = await fetch(`${baseUrl}/api/v1/invoices/${invoiceB1.id}/items`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(itemsRes.status, 403);
    });

    it('denies Account A from updating Account B invoice (IDOR -> 403 FORBIDDEN)', async () => {
      const patchRes = await fetch(`${baseUrl}/api/v1/invoices/${invoiceB1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      assert.equal(patchRes.status, 403);
    });
  });

  describe('5. Invoice Lifecycle Updates & Finalized State Protection', () => {
    it('updates draft invoice items/tax/discount and recalculates authoritative totals', async () => {
      const res = await fetch(`${baseUrl}/api/v1/invoices/${invoiceA1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          tax: 10.0,
          discount: 20.0,
          items: [
            {
              description: 'Updated Compute Cluster',
              quantity: 2,
              unitPrice: 150.0,
            },
          ],
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.subtotal, 300.0);
      assert.equal(json.data.tax, 10.0);
      assert.equal(json.data.discount, 20.0);
      assert.equal(json.data.total, 290.0);
      assert.equal(json.data.items.length, 1);
      assert.equal(json.data.items[0].description, 'Updated Compute Cluster');
      assert.equal(json.data.items[0].lineTotal, 300.0);
    });

    it('prevents modifying financial amounts or items once an invoice is marked "paid" (409 CONFLICT)', async () => {
      const markPaid = await fetch(`${baseUrl}/api/v1/invoices/${invoiceA1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({ status: 'paid' }),
      });
      assert.equal(markPaid.status, 200);
      assert.equal((await markPaid.json()).data.status, 'paid');

      const modifyPaid = await fetch(`${baseUrl}/api/v1/invoices/${invoiceA1.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          tax: 50.0,
        }),
      });
      assert.equal(modifyPaid.status, 409);
      const modifyJson = await modifyPaid.json();
      assert.equal(modifyJson.error.code, 'CONFLICT');
    });
  });

  describe('6. Referential Delete Semantics: Customer ON DELETE RESTRICT & Invoice ON DELETE CASCADE', () => {
    it('prevents deleting a customer that has existing invoices (409 CONFLICT)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerB.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.error.code, 'CONFLICT');

      // Verify Customer B and its invoice still exist intact
      const checkCust = await fetch(`${baseUrl}/api/v1/customers/${customerB.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(checkCust.status, 200);
    });

    it('denies regular user from deleting an invoice (403 FORBIDDEN) and allows admin to delete invoice with item cascade (204)', async () => {
      const userDel = await fetch(`${baseUrl}/api/v1/invoices/${invoiceB1.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      assert.equal(userDel.status, 403);

      const adminDel = await fetch(`${baseUrl}/api/v1/invoices/${invoiceB1.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(adminDel.status, 204);

      // Verify invoice and its items are deleted
      const getDeleted = await fetch(`${baseUrl}/api/v1/invoices/${invoiceB1.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(getDeleted.status, 404);

      const cascadedItems = await invoiceRepo.findItemsByInvoiceId(invoiceB1.id);
      assert.equal(cascadedItems.length, 0);

      // Now that Customer B has 0 invoices, Admin can delete Customer B (204 No Content)
      const deleteCustB = await fetch(`${baseUrl}/api/v1/customers/${customerB.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(deleteCustB.status, 204);
    });
  });
});
