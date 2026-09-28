import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { createApp } from '../api/app.js';
import { InMemoryCustomerRepository } from '../api/repositories/in-memory-customer.repository.js';
import { InMemoryAccountRepository } from '../api/repositories/in-memory-account.repository.js';
import { PasswordService } from '../api/services/password.service.js';
import { TokenService } from '../api/services/token.service.js';
import { closePool } from '../api/db/pool.js';

describe('Billing System REST API - Phase 4 Authentication & Identity Test Suite', () => {
  let server: Server;
  let baseUrl: string;
  let accountRepo: InMemoryAccountRepository;
  let customerRepo: InMemoryCustomerRepository;
  let tokenService: TokenService;
  let passwordService: PasswordService;

  before(async () => {
    accountRepo = new InMemoryAccountRepository();
    customerRepo = new InMemoryCustomerRepository();
    passwordService = new PasswordService();
    // Use short-lived token service helper for expired token tests
    tokenService = new TokenService({
      secret: 'test-secret-key-for-auth-tests-must-be-at-least-32-chars!',
      expiresInSeconds: 3600,
    });

    const app = createApp({
      accountRepository: accountRepo,
      customerRepository: customerRepo,
      passwordService,
      tokenService,
      protectCustomerDelete: true,
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

  describe('1. Account Registration (POST /api/v1/auth/register)', () => {
    it('succeeds with valid credentials, returning 201 Created and safe account DTO', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'operator@billing.com',
          password: 'SuperSecurePassword123!',
        }),
      });

      assert.equal(res.status, 201);
      const location = res.headers.get('location');
      assert.ok(location);
      assert.equal(location, '/api/v1/auth/me');

      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.match(json.data.id, /^acc_[a-zA-Z0-9_-]+/);
      assert.equal(json.data.email, 'operator@billing.com');
      assert.equal(json.data.role, 'user');
      assert.ok(json.data.createdAt);
      assert.ok(json.data.updatedAt);

      // SECURITY CRITICAL: Ensure password and hash are NEVER returned
      assert.equal(json.data.password, undefined);
      assert.equal(json.data.passwordHash, undefined);
    });

    it('stores scrypt password hash with unique salt in repository, never plaintext', async () => {
      const account = await accountRepo.findByEmail('operator@billing.com');
      assert.ok(account);
      assert.notEqual(account.passwordHash, 'SuperSecurePassword123!');
      assert.match(account.passwordHash, /^scrypt\$N=16384,r=8,p=1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    });

    it('rejects registration with duplicate email (409 DUPLICATE_RESOURCE)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'operator@billing.com',
          password: 'AnotherPassword456!',
        }),
      });

      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'DUPLICATE_RESOURCE');
      assert.ok(json.error.message.includes('already exists'));
    });

    it('enforces case-insensitive email uniqueness (OPERATOR@BILLING.COM returns 409)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'OPERATOR@BILLING.COM',
          password: 'AnotherPassword456!',
        }),
      });

      assert.equal(res.status, 409);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'DUPLICATE_RESOURCE');
    });

    it('rejects registration when email or password is missing (400 VALIDATION_ERROR)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(json.error.fields));
      assert.equal(json.error.fields.length, 2);
    });

    it('rejects registration when password is shorter than 8 characters (400 VALIDATION_ERROR)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'short@billing.com',
          password: '1234567', // 7 chars
        }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(json.error.fields[0].message.includes('at least 8 characters'));
    });

    it('rejects registration when password exceeds 128 characters (400 VALIDATION_ERROR)', async () => {
      const longPassword = 'a'.repeat(129);
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'long@billing.com',
          password: longPassword,
        }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(json.error.fields[0].message.includes('cannot exceed 128'));
    });

    it('rejects registration when password consists solely of whitespace (400 VALIDATION_ERROR)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'spaces@billing.com',
          password: '        ', // 8 spaces
        }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });

    it('rejects registration with invalid email format (400 VALIDATION_ERROR)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'not-a-valid-email',
          password: 'ValidPassword123!',
        }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });

    it('rejects registration with unknown fields (400 VALIDATION_ERROR)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'unknown@billing.com',
          password: 'ValidPassword123!',
          role: 'admin',
          isAdmin: true,
        }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(json.error.fields.some((f: any) => f.field === 'role'));
      assert.ok(json.error.fields.some((f: any) => f.field === 'isAdmin'));
    });
  });

  describe('2. Account Login & Token Issuance (POST /api/v1/auth/login)', () => {
    let validToken: string;

    it('succeeds with valid credentials, issuing signed JWT Bearer token and safe account info', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'operator@billing.com',
          password: 'SuperSecurePassword123!',
        }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(json.data.token);
      assert.equal(json.data.tokenType, 'Bearer');
      assert.equal(typeof json.data.expiresIn, 'number');
      assert.equal(json.data.account.email, 'operator@billing.com');
      assert.match(json.data.account.id, /^acc_/);

      // Verify token format (3 parts: header.payload.signature)
      const parts = json.data.token.split('.');
      assert.equal(parts.length, 3);

      validToken = json.data.token;
    });

    it('rejects login with incorrect password (401 INVALID_CREDENTIALS)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'operator@billing.com',
          password: 'WrongPassword999!',
        }),
      });

      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'INVALID_CREDENTIALS');
      assert.equal(json.error.message, 'Invalid email or password');
    });

    it('rejects login with nonexistent account with identical error to prevent enumeration (401 INVALID_CREDENTIALS)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ghost_user@billing.com',
          password: 'SomePassword123!',
        }),
      });

      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'INVALID_CREDENTIALS');
      // Identical diagnostic contract prevents timing & message enumeration
      assert.equal(json.error.message, 'Invalid email or password');
    });

    it('rejects login with missing email or password (400 VALIDATION_ERROR)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'operator@billing.com' }), // missing password
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('3. Authentication Middleware & Protected Endpoint Verification', () => {
    let authToken: string;

    before(async () => {
      // Obtain fresh auth token
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'operator@billing.com',
          password: 'SuperSecurePassword123!',
        }),
      });
      const json = await res.json();
      authToken = json.data.token;
    });

    describe('GET /api/v1/auth/me (Current Authenticated Identity)', () => {
      it('rejects request with missing Authorization header (401 AUTHENTICATION_REQUIRED)', async () => {
        const res = await fetch(`${baseUrl}/api/v1/auth/me`);
        assert.equal(res.status, 401);

        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'AUTHENTICATION_REQUIRED');
        assert.ok(json.error.message.includes('Missing Authorization header'));
      });

      it('rejects request with malformed or non-Bearer scheme (401 INVALID_TOKEN)', async () => {
        const schemes = [
          'Basic dXNlcjpwYXNz',
          'Token my-api-token',
          'Bearer', // missing token
          'BearerToken xyz',
        ];

        for (const scheme of schemes) {
          const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
            headers: { Authorization: scheme },
          });

          assert.equal(res.status, 401);
          const json = await res.json();
          assert.equal(json.status, 'error');
          assert.equal(json.error.code, 'INVALID_TOKEN');
        }
      });

      it('rejects request with invalid or tampered token signature (401 INVALID_TOKEN)', async () => {
        const tamperedToken = authToken.slice(0, -6) + 'abcdef';
        const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${tamperedToken}` },
        });

        assert.equal(res.status, 401);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'INVALID_TOKEN');
      });

      it('rejects request with expired token (401 TOKEN_EXPIRED)', async () => {
        // Generate an already-expired token using a valid 60s window issued 120s in the past
        const expiredTokenService = new TokenService({
          secret: 'test-secret-key-for-auth-tests-must-be-at-least-32-chars!',
          expiresInSeconds: 60,
        });
        const expiredToken = expiredTokenService.generateToken(
          {
            id: 'acc_expired_user',
            email: 'expired@billing.com',
          },
          { issuedAtSeconds: Math.floor(Date.now() / 1000) - 120 }
        );

        const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${expiredToken}` },
        });

        assert.equal(res.status, 401);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'TOKEN_EXPIRED');
        assert.equal(json.error.message, 'Authentication token has expired');
      });

      it('succeeds with valid Bearer token, returning authenticated account profile', async () => {
        const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });

        assert.equal(res.status, 200);
        const json = await res.json();
        assert.equal(json.status, 'success');
        assert.equal(json.data.email, 'operator@billing.com');
        assert.match(json.data.id, /^acc_/);
        assert.ok(json.data.createdAt);
        assert.ok(json.data.updatedAt);
        assert.equal(json.data.passwordHash, undefined);
      });
    });

    describe('DELETE /api/v1/customers/:id (Protected Administrative Endpoint)', () => {
      let testCustomerId: string;
      let adminToken: string;

      before(async () => {
        const now = new Date().toISOString();
        await accountRepo.create({
          id: 'acc_auth_test_admin',
          email: 'admin@billing.com',
          passwordHash: await passwordService.hashPassword('AdminSecurePassword123!'),
          role: 'admin',
          createdAt: now,
          updatedAt: now,
        });

        adminToken = tokenService.generateToken({
          id: 'acc_auth_test_admin',
          email: 'admin@billing.com',
          role: 'admin',
        });

        // Create customer record to delete
        const customer = await customerRepo.create({
          id: 'cus_delete_auth_test_1',
          accountId: 'acc_auth_test_admin',
          name: 'Delete Auth Test',
          email: 'delete_test@billing.com',
          currency: 'USD',
          createdAt: now,
          updatedAt: now,
        });
        testCustomerId = customer.id;
      });

      it('rejects unauthenticated customer deletion (401 AUTHENTICATION_REQUIRED)', async () => {
        const res = await fetch(`${baseUrl}/api/v1/customers/${testCustomerId}`, {
          method: 'DELETE',
        });

        assert.equal(res.status, 401);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'AUTHENTICATION_REQUIRED');

        // Verify customer was NOT deleted
        const stillExists = await customerRepo.findById(testCustomerId);
        assert.ok(stillExists);
      });

      it('rejects deletion with invalid token (401 INVALID_TOKEN)', async () => {
        const res = await fetch(`${baseUrl}/api/v1/customers/${testCustomerId}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer fake.invalid.token' },
        });

        assert.equal(res.status, 401);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'INVALID_TOKEN');
      });

      it('rejects deletion by non-admin user account (403 FORBIDDEN)', async () => {
        const res = await fetch(`${baseUrl}/api/v1/customers/${testCustomerId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${authToken}` },
        });

        assert.equal(res.status, 403);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'FORBIDDEN');
        assert.equal(json.error.message, 'You are not authorized to perform this action');

        // Verify customer was NOT deleted
        const stillExists = await customerRepo.findById(testCustomerId);
        assert.ok(stillExists);
      });

      it('succeeds with valid admin Bearer token and returns 204 No Content', async () => {
        const res = await fetch(`${baseUrl}/api/v1/customers/${testCustomerId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });

        assert.equal(res.status, 204);
        const text = await res.text();
        assert.equal(text, '');

        // Verify customer was successfully deleted
        const deletedCustomer = await customerRepo.findById(testCustomerId);
        assert.equal(deletedCustomer, null);
      });
    });
  });
});
