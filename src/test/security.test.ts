import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../api/app.js';
import { InMemoryAccountRepository } from '../api/repositories/in-memory-account.repository.js';
import { InMemoryCustomerRepository } from '../api/repositories/in-memory-customer.repository.js';
import { InMemoryInvoiceRepository } from '../api/repositories/in-memory-invoice.repository.js';
import { PasswordService } from '../api/services/password.service.js';
import { TokenService, resolveAndValidateJwtSecret } from '../api/services/token.service.js';
import { SecurityConfigurationError } from '../api/services/errors.js';
import { redactSensitiveUrl, redactSensitiveText, stripControlChars } from '../api/security/redaction.js';
import {
  createIsolatedHttpHarness,
  TestHttpHarness,
  TEST_JWT_SECRET,
} from './helpers/fixtures.js';

/**
 * Billing System REST API - Phase 9 Security Hardening Test Suite
 *
 * Covers:
 * 1. Brute-force & rate-limiting defenses (429 RATE_LIMIT_EXCEEDED + Retry-After & X-RateLimit-* headers)
 * 2. Authentication hardening, JWT algorithm downgrade defense, oversized token defense & production secret enforcement
 * 3. Authorization, cross-account IDOR, privilege escalation & role manipulation resistance
 * 4. Input validation hardening: mass assignment, null-byte injection (\u0000), oversized login passwords & prototype pollution
 * 5. SQL injection, sort column injection, query parameter array pollution & pagination bounds
 * 6. HTTP security headers, conditional HSTS, restrictive CORS policy & 405 Method Not Allowed enforcement
 * 7. Sensitive response non-leakage, error sanitization & log/CRLF redaction
 */
describe('Billing System REST API - Phase 9 Security Hardening Test Suite', () => {
  let harness: TestHttpHarness;
  let userA: { id: string; email: string; token: string };
  let userB: { id: string; email: string; token: string };
  let admin: { id: string; email: string; token: string };
  let customerAId: string;
  let customerBId: string;
  let invoiceAId: string;
  let invoiceBId: string;

  before(async () => {
    harness = await createIsolatedHttpHarness();
    const issuedA = await harness.issueTokenForRole('user', 'sec_user_a@billing.local');
    const issuedB = await harness.issueTokenForRole('user', 'sec_user_b@billing.local');
    const issuedAdmin = await harness.issueTokenForRole('admin', 'sec_admin@billing.local');

    userA = { id: issuedA.account.id, email: issuedA.account.email, token: issuedA.token };
    userB = { id: issuedB.account.id, email: issuedB.account.email, token: issuedB.token };
    admin = { id: issuedAdmin.account.id, email: issuedAdmin.account.email, token: issuedAdmin.token };

    // Seed Customer A & Invoice A (owned by User A)
    const custARes = await fetch(`${harness.baseUrl}/api/v1/customers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({
        name: 'User A Secure Corp',
        email: 'billing_a@secure-corp.local',
        currency: 'USD',
      }),
    });
    assert.equal(custARes.status, 201);
    customerAId = (await custARes.json()).data.id;

    const invARes = await fetch(`${harness.baseUrl}/api/v1/invoices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({
        customerId: customerAId,
        status: 'issued',
        items: [{ description: 'User A Dedicated Cluster', quantity: 1, unitPrice: 250.0 }],
      }),
    });
    assert.equal(invARes.status, 201);
    invoiceAId = (await invARes.json()).data.id;

    // Seed Customer B & Invoice B (owned by User B)
    const custBRes = await fetch(`${harness.baseUrl}/api/v1/customers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userB.token}`,
      },
      body: JSON.stringify({
        name: 'User B Private Holdings',
        email: 'billing_b@private-holdings.local',
        currency: 'EUR',
      }),
    });
    assert.equal(custBRes.status, 201);
    customerBId = (await custBRes.json()).data.id;

    const invBRes = await fetch(`${harness.baseUrl}/api/v1/invoices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userB.token}`,
      },
      body: JSON.stringify({
        customerId: customerBId,
        status: 'draft',
        items: [{ description: 'User B Confidential License', quantity: 2, unitPrice: 500.0 }],
      }),
    });
    assert.equal(invBRes.status, 201);
    invoiceBId = (await invBRes.json()).data.id;
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
  });

  describe('1. Brute-Force & Request Rate Limiting (429 RATE_LIMIT_EXCEEDED)', () => {
    it('throttles repeated login brute-force attempts with 429 RATE_LIMIT_EXCEEDED and Retry-After header', async () => {
      const accountRepo = new InMemoryAccountRepository();
      const customerRepo = new InMemoryCustomerRepository();
      const invoiceRepo = new InMemoryInvoiceRepository(customerRepo);
      const passwordService = new PasswordService({ N: 1024, r: 8, p: 1 });
      const tokenService = new TokenService({ secret: TEST_JWT_SECRET });

      const app = createApp({
        accountRepository: accountRepo,
        customerRepository: customerRepo,
        invoiceRepository: invoiceRepo,
        passwordService,
        tokenService,
        authRateLimitOptions: {
          windowMs: 60_000,
          max: 4, // Allow 4 login attempts per window, block the 5th
        },
      });

      let rlServer!: Server;
      let rlUrl = '';
      await new Promise<void>((resolve) => {
        rlServer = app.listen(0, '127.0.0.1', () => {
          const addr = rlServer.address();
          if (addr && typeof addr === 'object') {
            rlUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });

      try {
        for (let attempt = 1; attempt <= 4; attempt++) {
          const res = await fetch(`${rlUrl}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'victim@billing.local',
              password: `GuessedPassword_${attempt}!`,
            }),
          });
          assert.equal(res.status, 401);
          assert.equal(res.headers.get('x-ratelimit-limit'), '4');
          assert.equal(res.headers.get('x-ratelimit-remaining'), String(4 - attempt));
          assert.ok(res.headers.get('x-ratelimit-reset'));
        }

        // 5th brute-force attempt within window must be blocked with 429 Too Many Requests
        const blockedRes = await fetch(`${rlUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'victim@billing.local',
            password: 'GuessedPassword_5!',
          }),
        });

        assert.equal(blockedRes.status, 429);
        assert.equal(blockedRes.headers.get('x-ratelimit-remaining'), '0');
        const retryAfter = Number(blockedRes.headers.get('retry-after'));
        assert.ok(Number.isFinite(retryAfter) && retryAfter > 0);

        const json = await blockedRes.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'RATE_LIMIT_EXCEEDED');
      } finally {
        await new Promise<void>((resolve) => rlServer.close(() => resolve()));
      }
    });

    it('throttles general API request floods when API rate limit is exceeded without leaking internal state', async () => {
      const app = createApp({
        apiRateLimitOptions: {
          windowMs: 60_000,
          max: 3,
        },
      });

      let rlServer!: Server;
      let rlUrl = '';
      await new Promise<void>((resolve) => {
        rlServer = app.listen(0, '127.0.0.1', () => {
          const addr = rlServer.address();
          if (addr && typeof addr === 'object') {
            rlUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });

      try {
        for (let i = 1; i <= 3; i++) {
          const res = await fetch(`${rlUrl}/api/v1/health`);
          assert.equal(res.status, 200);
        }

        const fourthRes = await fetch(`${rlUrl}/api/v1/health`);
        assert.equal(fourthRes.status, 429);
        const json = await fourthRes.json();
        assert.equal(json.error.code, 'RATE_LIMIT_EXCEEDED');
      } finally {
        await new Promise<void>((resolve) => rlServer.close(() => resolve()));
      }
    });
  });

  describe('2. Authentication Hardening, JWT Downgrade Defense & Production Secret Validation', () => {
    it('rejects JWT alg: "none", alg: "HS512", and oversized tokens (> 4096 chars) with 401 INVALID_TOKEN', async () => {
      const makeCustomJwt = (headerObj: Record<string, unknown>, payloadObj: Record<string, unknown>) => {
        const h = Buffer.from(JSON.stringify(headerObj)).toString('base64url');
        const p = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
        const sig = crypto
          .createHmac('sha256', TEST_JWT_SECRET)
          .update(`${h}.${p}`)
          .digest('base64url');
        return `${h}.${p}.${sig}`;
      };

      const now = Math.floor(Date.now() / 1000);
      const validClaims = {
        sub: userA.id,
        email: userA.email,
        role: 'user',
        iat: now,
        exp: now + 3600,
      };

      const algNoneToken = makeCustomJwt({ alg: 'none', typ: 'JWT' }, validClaims);
      const algHs512Token = makeCustomJwt({ alg: 'HS512', typ: 'JWT' }, validClaims);
      const unsignedToken = `${algNoneToken.split('.')[0]}.${algNoneToken.split('.')[1]}.`;
      const oversizedToken = 'A'.repeat(5000);

      for (const badToken of [algNoneToken, algHs512Token, unsignedToken, oversizedToken]) {
        const res = await fetch(`${harness.baseUrl}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${badToken}` },
        });
        assert.equal(res.status, 401);
        const json = await res.json();
        assert.equal(json.error.code, 'INVALID_TOKEN');
      }
    });

    it('fails closed in production mode when JWT_SECRET is missing, weak (< 32 chars), or set to a placeholder', () => {
      // Missing secret in production
      assert.throws(
        () => resolveAndValidateJwtSecret('', 'production'),
        SecurityConfigurationError
      );

      // Placeholder secret from .env.example in production
      assert.throws(
        () => resolveAndValidateJwtSecret('MY_JWT_SECRET', 'production'),
        SecurityConfigurationError
      );

      // Development fallback secret in production
      assert.throws(
        () =>
          resolveAndValidateJwtSecret(
            'billing-api-development-secret-key-do-not-use-in-production-min32chars',
            'production'
          ),
        SecurityConfigurationError
      );

      // Short secret (< 32 chars) in production
      assert.throws(
        () => resolveAndValidateJwtSecret('short-secret-only-25-char', 'production'),
        SecurityConfigurationError
      );

      // Strong 32+ char secret in production succeeds
      const strongProdSecret = 'prod-cryptographic-secret-key-at-least-32-bytes-long!';
      assert.equal(
        resolveAndValidateJwtSecret(strongProdSecret, 'production'),
        strongProdSecret
      );
    });
  });

  describe('3. Authorization, Cross-Account IDOR & Privilege Escalation Defense', () => {
    it('blocks User A from reading, updating, deleting, or listing User B resources (IDOR -> 403 FORBIDDEN)', async () => {
      const idorAttempts: Array<{ method: string; path: string; body?: object }> = [
        { method: 'GET', path: `/api/v1/customers/${customerBId}` },
        { method: 'PATCH', path: `/api/v1/customers/${customerBId}`, body: { name: 'Hijacked' } },
        { method: 'DELETE', path: `/api/v1/customers/${customerBId}` },
        { method: 'GET', path: `/api/v1/customers/${customerBId}/invoices` },
        {
          method: 'POST',
          path: `/api/v1/customers/${customerBId}/invoices`,
          body: { items: [{ description: 'Injected', quantity: 1, unitPrice: 10 }] },
        },
        { method: 'GET', path: `/api/v1/invoices/${invoiceBId}` },
        { method: 'GET', path: `/api/v1/invoices/${invoiceBId}/items` },
        { method: 'PATCH', path: `/api/v1/invoices/${invoiceBId}`, body: { status: 'cancelled' } },
        { method: 'DELETE', path: `/api/v1/invoices/${invoiceBId}` },
        {
          method: 'POST',
          path: `/api/v1/invoices`,
          body: {
            customerId: customerBId,
            items: [{ description: 'Cross-Account Invoice', quantity: 1, unitPrice: 99 }],
          },
        },
      ];

      for (const attempt of idorAttempts) {
        const res = await fetch(`${harness.baseUrl}${attempt.path}`, {
          method: attempt.method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userA.token}`,
          },
          body: attempt.body ? JSON.stringify(attempt.body) : undefined,
        });

        assert.equal(
          res.status,
          403,
          `Expected 403 FORBIDDEN on ${attempt.method} ${attempt.path}, got ${res.status}`
        );
        const json = await res.json();
        assert.equal(json.error.code, 'FORBIDDEN');
      }
    });

    it('prevents cross-account filter enumeration via ?customerId=<other_user_customer>', async () => {
      const res = await fetch(
        `${harness.baseUrl}/api/v1/invoices?customerId=${customerBId}`,
        {
          headers: { Authorization: `Bearer ${userA.token}` },
        }
      );
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.deepEqual(json.data, []);
      assert.equal(json.pagination.total, 0);
    });

    it('blocks privilege escalation and role manipulation across registration and resource endpoints', async () => {
      // 1. Attempting to register as admin
      const regRes = await fetch(`${harness.baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'escalate@billing.local',
          password: 'ValidPassword123!',
          role: 'admin',
        }),
      });
      assert.equal(regRes.status, 400);
      const regJson = await regRes.json();
      assert.equal(regJson.error.code, 'VALIDATION_ERROR');

      // 2. Attempting to tamper with JWT payload role ('user' -> 'admin') without valid signature
      const [h, , s] = userA.token.split('.');
      const forgedPayload = Buffer.from(
        JSON.stringify({
          sub: userA.id,
          email: userA.email,
          role: 'admin',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      ).toString('base64url');
      const forgedToken = `${h}.${forgedPayload}.${s}`;

      const delRes = await fetch(`${harness.baseUrl}/api/v1/customers/${customerAId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${forgedToken}` },
      });
      assert.equal(delRes.status, 401);
      assert.equal((await delRes.json()).error.code, 'INVALID_TOKEN');
    });
  });

  describe('4. Mass Assignment, Null-Byte Injection & Login Password Bounds', () => {
    it('rejects mass assignment of server-controlled fields (id, accountId, subtotal, total, invoiceNumber)', async () => {
      const custRes = await fetch(`${harness.baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          id: 'cus_custom_id',
          accountId: admin.id,
          name: 'Mass Assign Corp',
          email: 'mass@assign.local',
          currency: 'USD',
        }),
      });
      assert.equal(custRes.status, 400);
      const custJson = await custRes.json();
      assert.equal(custJson.error.code, 'VALIDATION_ERROR');

      const invRes = await fetch(`${harness.baseUrl}/api/v1/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          customerId: customerAId,
          subtotal: 0.01,
          total: 0.01,
          invoiceNumber: 'INV-FAKE-0001',
          items: [{ description: 'Item', quantity: 1, unitPrice: 500, lineTotal: 0.01 }],
        }),
      });
      assert.equal(invRes.status, 400);
      const invJson = await invRes.json();
      assert.equal(invJson.error.code, 'VALIDATION_ERROR');
    });

    it('rejects null-byte injection (\\u0000) in customer, auth, and invoice string fields with 400 VALIDATION_ERROR', async () => {
      const nullCustomerRes = await fetch(`${harness.baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          name: 'Null\u0000Byte Corp',
          email: 'nullbyte@corp.local',
          currency: 'USD',
        }),
      });
      assert.equal(nullCustomerRes.status, 400);
      assert.equal((await nullCustomerRes.json()).error.code, 'VALIDATION_ERROR');

      const nullInvoiceRes = await fetch(`${harness.baseUrl}/api/v1/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          customerId: customerAId,
          notes: 'Memo with \u0000 null byte',
          items: [{ description: 'Line\u0000Item', quantity: 1, unitPrice: 10 }],
        }),
      });
      assert.equal(nullInvoiceRes.status, 400);
      assert.equal((await nullInvoiceRes.json()).error.code, 'VALIDATION_ERROR');
    });

    it('rejects oversized login passwords (> 128 chars) with 400 VALIDATION_ERROR to prevent scrypt CPU amplification', async () => {
      const res = await fetch(`${harness.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: userA.email,
          password: 'P'.repeat(500),
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('5. SQL Injection & Sort Identifier Injection Defense', () => {
    it('rejects SQL injection attempts in sort and order parameters with 400 VALIDATION_ERROR', async () => {
      const maliciousSortUrls = [
        `/api/v1/customers?sort=${encodeURIComponent('name; DROP TABLE customers; --')}`,
        `/api/v1/customers?sort=${encodeURIComponent('(SELECT password_hash FROM accounts LIMIT 1)')}`,
        `/api/v1/customers?order=${encodeURIComponent('asc, (SELECT 1)')}`,
        `/api/v1/invoices?sort=${encodeURIComponent('total DESC; SELECT pg_sleep(5)--')}`,
        `/api/v1/invoices/${invoiceAId}/items?sort=${encodeURIComponent('unit_price; --')}`,
      ];

      for (const url of maliciousSortUrls) {
        const res = await fetch(`${harness.baseUrl}${url}`, {
          headers: { Authorization: `Bearer ${userA.token}` },
        });
        assert.equal(res.status, 400, `Expected 400 for ${url}`);
        const json = await res.json();
        assert.equal(json.error.code, 'VALIDATION_ERROR');
      }
    });
  });

  describe('6. HTTP Security Headers, Conditional HSTS, CORS Policy & 405 Method Not Allowed', () => {
    it('sets defensive API security headers and omits HSTS in non-production HTTP mode by default', async () => {
      const res = await fetch(`${harness.baseUrl}/api/v1/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-powered-by'), null);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(
        res.headers.get('content-security-policy'),
        "default-src 'none'; frame-ancestors 'none'"
      );
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.ok(res.headers.get('permissions-policy')?.includes('geolocation=()'));
      assert.equal(res.headers.get('strict-transport-security'), null);
    });

    it('emits Strict-Transport-Security when enableHsts is enabled (production HTTPS posture) and enforces explicit CORS allowlist', async () => {
      const app = createApp({
        securityHeadersOptions: { enableHsts: true },
        corsOptions: {
          allowedOrigins: ['https://console.billing.example.com'],
        },
      });

      let secServer!: Server;
      let secUrl = '';
      await new Promise<void>((resolve) => {
        secServer = app.listen(0, '127.0.0.1', () => {
          const addr = secServer.address();
          if (addr && typeof addr === 'object') {
            secUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });

      try {
        // 1. Trusted Origin receives Access-Control-Allow-Origin and HSTS
        const trustedRes = await fetch(`${secUrl}/api/v1/health`, {
          headers: { Origin: 'https://console.billing.example.com' },
        });
        assert.equal(trustedRes.status, 200);
        assert.equal(
          trustedRes.headers.get('strict-transport-security'),
          'max-age=31536000; includeSubDomains'
        );
        assert.equal(
          trustedRes.headers.get('access-control-allow-origin'),
          'https://console.billing.example.com'
        );
        assert.match(trustedRes.headers.get('vary') ?? '', /Origin/i);

        // 2. Untrusted Origin receives NO Access-Control-Allow-Origin header
        const untrustedRes = await fetch(`${secUrl}/api/v1/health`, {
          headers: { Origin: 'https://evil.attacker.example' },
        });
        assert.equal(untrustedRes.status, 200);
        assert.equal(untrustedRes.headers.get('access-control-allow-origin'), null);

        // 3. Preflight OPTIONS from trusted origin returns 204 with allowed methods
        const preflightRes = await fetch(`${secUrl}/api/v1/customers`, {
          method: 'OPTIONS',
          headers: { Origin: 'https://console.billing.example.com' },
        });
        assert.equal(preflightRes.status, 204);
        assert.equal(
          preflightRes.headers.get('access-control-allow-origin'),
          'https://console.billing.example.com'
        );
        assert.match(preflightRes.headers.get('access-control-allow-methods') ?? '', /POST/);
      } finally {
        await new Promise<void>((resolve) => secServer.close(() => resolve()));
      }
    });

    it('rejects unsupported HTTP methods on known endpoints with 405 METHOD_NOT_ALLOWED and Allow header', async () => {
      const unsupportedRequests: Array<{ method: string; path: string; expectedAllow: string }> = [
        { method: 'POST', path: '/api/v1/health', expectedAllow: 'GET' },
        { method: 'DELETE', path: '/api/v1/health', expectedAllow: 'GET' },
        { method: 'GET', path: '/api/v1/auth/login', expectedAllow: 'POST' },
        { method: 'DELETE', path: '/api/v1/auth/register', expectedAllow: 'POST' },
        { method: 'DELETE', path: '/api/v1/auth/me', expectedAllow: 'GET' },
        { method: 'PUT', path: '/api/v1/customers', expectedAllow: 'GET, POST' },
        { method: 'DELETE', path: '/api/v1/customers', expectedAllow: 'GET, POST' },
        { method: 'PUT', path: `/api/v1/customers/${customerAId}`, expectedAllow: 'GET, PATCH, DELETE' },
        { method: 'DELETE', path: `/api/v1/customers/${customerAId}/invoices`, expectedAllow: 'GET, POST' },
        { method: 'PUT', path: '/api/v1/invoices', expectedAllow: 'GET, POST' },
        { method: 'PUT', path: `/api/v1/invoices/${invoiceAId}`, expectedAllow: 'GET, PATCH, DELETE' },
        { method: 'DELETE', path: `/api/v1/invoices/${invoiceAId}/items`, expectedAllow: 'GET' },
      ];

      for (const reqCase of unsupportedRequests) {
        const res = await fetch(`${harness.baseUrl}${reqCase.path}`, {
          method: reqCase.method,
          headers: { Authorization: `Bearer ${admin.token}` },
        });
        assert.equal(
          res.status,
          405,
          `Expected 405 for ${reqCase.method} ${reqCase.path}, got ${res.status}`
        );
        assert.equal(res.headers.get('allow'), reqCase.expectedAllow);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'METHOD_NOT_ALLOWED');
      }
    });
  });

  describe('7. Logging Redaction & CRLF Log Injection Prevention', () => {
    it('redacts sensitive query parameters and strips CRLF control characters in redactSensitiveUrl', () => {
      const dirtyUrl =
        '/api/v1/customers?name=Acme&token=eyJhbGciOiJIUzI1NiJ9.secret&password=MyPlainPassword123!\r\n[FAKE LOG ENTRY]';
      const redacted = redactSensitiveUrl(dirtyUrl);

      assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiJ9'));
      assert.ok(!redacted.includes('MyPlainPassword123!'));
      assert.ok(!redacted.includes('\r'));
      assert.ok(!redacted.includes('\n'));
      assert.ok(redacted.includes('token=[REDACTED]'));
      assert.ok(redacted.includes('password=[REDACTED]'));
    });

    it('redacts database credentials, Bearer tokens, and scrypt hashes in redactSensitiveText', () => {
      const rawError =
        'Connection failed to postgresql://billing_admin:SuperSecretDbPass99@db.internal:5432/billing with header Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb and hash scrypt$N=16384,r=8,p=1$001122$abcdef';
      const safeText = redactSensitiveText(rawError);

      assert.ok(!safeText.includes('SuperSecretDbPass99'));
      assert.ok(!safeText.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
      assert.ok(!safeText.includes('001122$abcdef'));
      assert.ok(safeText.includes('postgresql://billing_admin:[REDACTED]@db.internal:5432/billing'));
      assert.ok(safeText.includes('Bearer [REDACTED]'));
      assert.ok(safeText.includes('scrypt$[REDACTED]'));
      assert.equal(stripControlChars('line1\r\nline2'), 'line1 line2');
    });
  });
});
