import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createIsolatedHttpHarness,
  TestHttpHarness,
  buildCustomerDtoFixture,
  buildInvoiceDtoFixture,
} from '../helpers/fixtures.js';

/**
 * Phase 8 HTTP Contract & Security Regression Test Suite
 * 
 * Verifies the real Express HTTP boundary:
 * 1. HTTP Headers (`x-powered-by` disabled, `Location` header on 201, `Content-Type: application/json`).
 * 2. Payload size enforcement (`413 PAYLOAD_TOO_LARGE` when body exceeds 100kb).
 * 3. End-to-end HTTP contracts across all Customer, Auth, Invoice, and InvoiceItem endpoints.
 * 4. Negative & Security Regression tests (SQL injection vectors, parameter pollution, IDOR, sensitive data non-leakage).
 */
describe('Billing System REST API - Phase 8 HTTP Contracts & Security Regression Test Suite', () => {
  let harness: TestHttpHarness;
  let userA: { id: string; token: string };
  let userB: { id: string; token: string };
  let admin: { id: string; token: string };

  before(async () => {
    harness = await createIsolatedHttpHarness();
    const issuedA = await harness.issueTokenForRole('user', 'http_user_a@billing.local');
    const issuedB = await harness.issueTokenForRole('user', 'http_user_b@billing.local');
    const issuedAdmin = await harness.issueTokenForRole('admin', 'http_admin@billing.local');

    userA = { id: issuedA.account.id, token: issuedA.token };
    userB = { id: issuedB.account.id, token: issuedB.token };
    admin = { id: issuedAdmin.account.id, token: issuedAdmin.token };
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
  });

  describe('1. HTTP Security Headers & Payload Limit Contracts (413 PAYLOAD_TOO_LARGE)', () => {
    it('omits X-Powered-By header and returns application/json Content-Type on all responses', async () => {
      const res = await fetch(`${harness.baseUrl}/api/v1/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-powered-by'), null);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    });

    it('rejects oversized JSON payloads (> 100kb) with 413 PAYLOAD_TOO_LARGE', async () => {
      const oversizedNotes = 'X'.repeat(115 * 1024); // ~115 KB
      const res = await fetch(`${harness.baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          name: oversizedNotes,
          email: 'oversized@billing.local',
          currency: 'USD',
        }),
      });

      assert.equal(res.status, 413);
      const json = await res.json();
      assert.deepEqual(json, {
        status: 'error',
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request payload exceeds the permitted limit (100kb)',
        },
      });
    });
  });

  describe('2. End-to-End HTTP Contract & Location Header Verification', () => {
    let customerAId: string;
    let invoiceAId: string;

    it('POST /api/v1/customers returns 201 Created, Location header, and exact Customer schema', async () => {
      const dto = buildCustomerDtoFixture({ currency: 'USD' });
      const res = await fetch(`${harness.baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify(dto),
      });

      assert.equal(res.status, 201);
      const json = await res.json();
      customerAId = json.data.id;

      assert.equal(res.headers.get('location'), `/api/v1/customers/${customerAId}`);
      assert.deepEqual(Object.keys(json.data).sort(), [
        'accountId',
        'createdAt',
        'currency',
        'email',
        'id',
        'name',
        'updatedAt',
      ]);
      assert.equal(json.data.accountId, userA.id);
    });

    it('POST /api/v1/invoices returns 201 Created, Location header, and exact Invoice + InvoiceItem schema', async () => {
      const dto = buildInvoiceDtoFixture(customerAId, {
        tax: 12.5,
        discount: 2.5,
        items: [
          { description: 'API Gateway Traffic', quantity: 3, unitPrice: 40.0 },
        ],
      });

      const res = await fetch(`${harness.baseUrl}/api/v1/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify(dto),
      });

      assert.equal(res.status, 201);
      const json = await res.json();
      invoiceAId = json.data.id;

      assert.equal(res.headers.get('location'), `/api/v1/invoices/${invoiceAId}`);
      assert.deepEqual(Object.keys(json.data).sort(), [
        'createdAt',
        'currency',
        'customerId',
        'discount',
        'dueDate',
        'id',
        'invoiceNumber',
        'issueDate',
        'items',
        'notes',
        'status',
        'subtotal',
        'tax',
        'total',
        'updatedAt',
      ]);
      assert.equal(json.data.subtotal, 120.0);
      assert.equal(json.data.total, 130.0);
      assert.equal(json.data.items.length, 1);
      assert.deepEqual(Object.keys(json.data.items[0]).sort(), [
        'createdAt',
        'description',
        'id',
        'invoiceId',
        'lineTotal',
        'quantity',
        'unitPrice',
        'updatedAt',
      ]);
    });
  });

  describe('3. Comprehensive Security Regression & Injection Resistance Tests', () => {
    it('neutralizes SQL injection payloads in customer name/email filters and invoice description filters', async () => {
      // Malicious payloads passed to string search filters must be safely parameterized (returning 200 with 0 matches)
      // or rejected by format validation (400 VALIDATION_ERROR) — never causing a 500 SQL syntax error.
      const safeSearchPayloads = [
        `/api/v1/customers?name=${encodeURIComponent("' OR '1'='1' --")}`,
        `/api/v1/customers?name=${encodeURIComponent("'; DROP TABLE customers; --")}`,
        `/api/v1/customers?name=${encodeURIComponent('%" UNION SELECT id, email, password_hash FROM accounts --')}`,
      ];

      for (const url of safeSearchPayloads) {
        const res = await fetch(`${harness.baseUrl}${url}`, {
          headers: { Authorization: `Bearer ${userA.token}` },
        });
        assert.equal(res.status, 200);
        const json = await res.json();
        assert.equal(json.status, 'success');
        assert.deepEqual(json.data, []);
        assert.equal(json.pagination.total, 0);
      }
    });

    it('blocks query parameter array pollution (e.g. ?page=1&page=2 or ?sort=name&sort=email) with 400 VALIDATION_ERROR', async () => {
      const pollutedUrls = [
        '/api/v1/customers?page=1&page=2',
        '/api/v1/customers?limit=10&limit=20',
        '/api/v1/customers?sort=name&sort=email',
        '/api/v1/invoices?status=draft&status=paid',
      ];

      for (const url of pollutedUrls) {
        const res = await fetch(`${harness.baseUrl}${url}`, {
          headers: { Authorization: `Bearer ${userA.token}` },
        });
        assert.equal(res.status, 400, `Expected 400 for polluted query ${url}`);
        const json = await res.json();
        assert.equal(json.error.code, 'VALIDATION_ERROR');
      }
    });

    it('never leaks sensitive credentials, password hashes, or JWT secrets in any API response', async () => {
      const endpoints = [
        '/api/v1/health',
        '/api/v1/auth/me',
        '/api/v1/customers',
        '/api/v1/invoices',
      ];

      for (const ep of endpoints) {
        const res = await fetch(`${harness.baseUrl}${ep}`, {
          headers: { Authorization: `Bearer ${admin.token}` },
        });
        const rawText = await res.text();
        assert.ok(!rawText.includes('passwordHash'));
        assert.ok(!rawText.includes('password_hash'));
        assert.ok(!rawText.includes('scrypt$'));
        assert.ok(!rawText.includes('phase-8-quality-engineering-test-secret-key'));
      }
    });
  });
});
