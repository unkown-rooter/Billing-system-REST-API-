import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Server } from 'node:http';
import { createApp } from '../api/app.js';
import { InMemoryCustomerRepository } from '../api/repositories/in-memory-customer.repository.js';
import { InMemoryAccountRepository } from '../api/repositories/in-memory-account.repository.js';
import { PasswordService } from '../api/services/password.service.js';
import { TokenService } from '../api/services/token.service.js';
import { AuthService } from '../api/services/auth.service.js';
import { closePool } from '../api/db/pool.js';
import { AccountDTO } from '../api/models/account.model.js';
import { Customer } from '../api/models/customer.model.js';

describe('Billing System REST API - Phase 5 Authorization & Access Control Test Suite', () => {
  let server: Server;
  let baseUrl: string;
  let accountRepo: InMemoryAccountRepository;
  let customerRepo: InMemoryCustomerRepository;
  let passwordService: PasswordService;
  let tokenService: TokenService;
  let authService: AuthService;

  const JWT_SECRET = 'phase-5-authorization-test-secret-key-min-32-chars!!';

  // Identities established for testing
  let userAAccount: AccountDTO;
  let userAToken: string;

  let userBAccount: AccountDTO;
  let userBToken: string;

  let adminAccountId: string;
  let adminToken: string;

  // Resources owned by User A and User B
  let customerA: Customer;
  let customerB: Customer;

  before(async () => {
    accountRepo = new InMemoryAccountRepository();
    customerRepo = new InMemoryCustomerRepository();
    passwordService = new PasswordService();
    tokenService = new TokenService({
      secret: JWT_SECRET,
      expiresInSeconds: 3600,
    });
    authService = new AuthService(accountRepo, passwordService, tokenService);

    const app = createApp({
      accountRepository: accountRepo,
      customerRepository: customerRepo,
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

    // Provision User A via standard registration + login
    const regARes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@tenant-a.com',
        password: 'AliceSecurePassword123!',
      }),
    });
    assert.equal(regARes.status, 201);
    userAAccount = (await regARes.json()).data;

    const loginARes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@tenant-a.com',
        password: 'AliceSecurePassword123!',
      }),
    });
    assert.equal(loginARes.status, 200);
    userAToken = (await loginARes.json()).data.token;

    // Provision User B via standard registration + login
    const regBRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'bob@tenant-b.com',
        password: 'BobSecurePassword123!',
      }),
    });
    assert.equal(regBRes.status, 201);
    userBAccount = (await regBRes.json()).data;

    const loginBRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'bob@tenant-b.com',
        password: 'BobSecurePassword123!',
      }),
    });
    assert.equal(loginBRes.status, 200);
    userBToken = (await loginBRes.json()).data.token;

    // Provision Admin account via controlled out-of-band repository fixture (never via public registration)
    const now = new Date().toISOString();
    adminAccountId = 'acc_controlled_test_admin';
    await accountRepo.create({
      id: adminAccountId,
      email: 'admin@billing-system.internal',
      passwordHash: await passwordService.hashPassword('AdminControlledPassword123!'),
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });

    const loginAdminRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@billing-system.internal',
        password: 'AdminControlledPassword123!',
      }),
    });
    assert.equal(loginAdminRes.status, 200);
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

  describe('1. Role Model & Least-Privilege Default Assignment', () => {
    it('assigns least-privileged default role ("user") on public registration', async () => {
      assert.equal(userAAccount.role, 'user');
      assert.equal(userBAccount.role, 'user');

      const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(meRes.status, 200);
      const meJson = await meRes.json();
      assert.equal(meJson.data.role, 'user');
    });

    it('returns "admin" role in /api/v1/auth/me for out-of-band provisioned admin account', async () => {
      const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(meRes.status, 200);
      const meJson = await meRes.json();
      assert.equal(meJson.data.id, adminAccountId);
      assert.equal(meJson.data.role, 'admin');
    });

    it('rejects invalid speculative roles at the repository boundary', async () => {
      const now = new Date().toISOString();
      await assert.rejects(
        accountRepo.create({
          id: 'acc_invalid_role',
          email: 'invalidrole@test.com',
          passwordHash: 'scrypt$N=16384,r=8,p=1$00$00',
          role: 'superadmin' as any,
          createdAt: now,
          updatedAt: now,
        }),
        (err: any) => err.code === 'VALIDATION_ERROR'
      );
    });

    it('rejects JWT tokens carrying an unrecognized or forged role claim (401 INVALID_TOKEN)', async () => {
      // Craft a token signed with the secret but containing an invalid role "superadmin"
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: userAAccount.id,
          email: userAAccount.email,
          role: 'superadmin',
          iat: now,
          exp: now + 3600,
        })
      ).toString('base64url');
      const sig = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest('base64url');
      const forgedRoleToken = `${header}.${payload}.${sig}`;

      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: { Authorization: `Bearer ${forgedRoleToken}` },
      });
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.error.code, 'INVALID_TOKEN');
    });
  });

  describe('2. Strict 401 (Unauthenticated) vs 403 (Forbidden) Distinction', () => {
    it('returns 401 AUTHENTICATION_REQUIRED for all customer endpoints when unauthenticated', async () => {
      const endpoints: Array<{ method: string; path: string; body?: object }> = [
        { method: 'POST', path: '/api/v1/customers', body: { name: 'Test', email: 't@test.com', currency: 'USD' } },
        { method: 'GET', path: '/api/v1/customers' },
        { method: 'GET', path: '/api/v1/customers/cus_12345' },
        { method: 'PATCH', path: '/api/v1/customers/cus_12345', body: { name: 'Updated' } },
        { method: 'DELETE', path: '/api/v1/customers/cus_12345' },
      ];

      for (const ep of endpoints) {
        const res = await fetch(`${baseUrl}${ep.path}`, {
          method: ep.method,
          headers: ep.body ? { 'Content-Type': 'application/json' } : undefined,
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        });
        assert.equal(res.status, 401, `Expected 401 for unauthenticated ${ep.method} ${ep.path}`);
        const json = await res.json();
        assert.equal(json.status, 'error');
        assert.equal(json.error.code, 'AUTHENTICATION_REQUIRED');
      }
    });

    it('returns 401 INVALID_TOKEN when token is invalid on protected customer endpoints', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: { Authorization: 'Bearer malformed.jwt.token' },
      });
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'INVALID_TOKEN');
    });
  });

  describe('3. Resource Ownership & IDOR Protection (Account A vs Account B)', () => {
    it('binds customer ownership (accountId) to the authenticated creator on POST /api/v1/customers', async () => {
      // Account A creates Customer A
      const resA = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          name: 'Tenant A Corp',
          email: 'billing@tenant-a-corp.com',
          currency: 'USD',
        }),
      });
      assert.equal(resA.status, 201);
      const jsonA = await resA.json();
      customerA = jsonA.data;
      assert.equal(customerA.accountId, userAAccount.id);

      // Account B creates Customer B
      const resB = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userBToken}`,
        },
        body: JSON.stringify({
          name: 'Tenant B Holdings',
          email: 'billing@tenant-b-holdings.com',
          currency: 'EUR',
        }),
      });
      assert.equal(resB.status, 201);
      const jsonB = await resB.json();
      customerB = jsonB.data;
      assert.equal(customerB.accountId, userBAccount.id);
    });

    it('allows Account A to retrieve its own customer (Account A -> Customer A -> 200 OK)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.id, customerA.id);
      assert.equal(json.data.accountId, userAAccount.id);
      assert.equal(json.data.name, 'Tenant A Corp');
    });

    it('denies Account A from retrieving Account B customer (IDOR: Account A -> Customer B -> 403 FORBIDDEN)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerB.id}`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.deepEqual(json, {
        status: 'error',
        error: {
          code: 'FORBIDDEN',
          message: 'You are not authorized to perform this action',
          requestId: res.headers.get('x-request-id'),
        },
      });

      // Verify zero data leakage from Customer B
      const serialized = JSON.stringify(json);
      assert.ok(!serialized.includes('Tenant B Holdings'));
      assert.ok(!serialized.includes('billing@tenant-b-holdings.com'));
      assert.ok(!serialized.includes(userBAccount.id));
    });

    it('denies Account B from retrieving Account A customer (IDOR: Account B -> Customer A -> 403 FORBIDDEN)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}`, {
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.deepEqual(json, {
        status: 'error',
        error: {
          code: 'FORBIDDEN',
          message: 'You are not authorized to perform this action',
          requestId: res.headers.get('x-request-id'),
        },
      });

      // Verify zero data leakage from Customer A
      const serialized = JSON.stringify(json);
      assert.ok(!serialized.includes('Tenant A Corp'));
      assert.ok(!serialized.includes('billing@tenant-a-corp.com'));
      assert.ok(!serialized.includes(userAAccount.id));
    });

    it('scopes GET /api/v1/customers to only return the authenticated user own customers', async () => {
      const resA = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(resA.status, 200);
      const jsonA = await resA.json();
      assert.equal(jsonA.data.length, 1);
      assert.equal(jsonA.data[0].id, customerA.id);

      const resB = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      assert.equal(resB.status, 200);
      const jsonB = await resB.json();
      assert.equal(jsonB.data.length, 1);
      assert.equal(jsonB.data[0].id, customerB.id);
    });

    it('allows Account A to update its own customer (Account A -> PATCH Customer A -> 200 OK)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          name: 'Tenant A Global Corp',
        }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.name, 'Tenant A Global Corp');
      assert.equal(json.data.accountId, userAAccount.id);
    });

    it('denies Account A from updating Account B customer (IDOR: Account A -> PATCH Customer B -> 403 FORBIDDEN)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerB.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          name: 'Hijacked By A',
        }),
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error.code, 'FORBIDDEN');
      assert.equal(json.error.message, 'You are not authorized to perform this action');

      // Verify Customer B was NOT modified in the repository
      const storedB = await customerRepo.findById(customerB.id);
      assert.ok(storedB);
      assert.equal(storedB.name, 'Tenant B Holdings');
    });

    it('denies Account B from updating Account A customer (IDOR: Account B -> PATCH Customer A -> 403 FORBIDDEN)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userBToken}`,
        },
        body: JSON.stringify({
          name: 'Hijacked By B',
        }),
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error.code, 'FORBIDDEN');

      // Verify Customer A was NOT modified
      const storedA = await customerRepo.findById(customerA.id);
      assert.ok(storedA);
      assert.equal(storedA.name, 'Tenant A Global Corp');
    });
  });

  describe('4. Role-Based Access Control (User vs Admin Capabilities)', () => {
    it('allows admin to list all customers across all accounts on GET /api/v1/customers', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.data.length, 2);
      const ids = json.data.map((c: Customer) => c.id);
      assert.ok(ids.includes(customerA.id));
      assert.ok(ids.includes(customerB.id));
    });

    it('allows admin to inspect and update any customer while preserving original account ownership', async () => {
      const getRes = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(getRes.status, 200);

      const patchRes = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ currency: 'GBP' }),
      });
      assert.equal(patchRes.status, 200);
      const patchJson = await patchRes.json();
      assert.equal(patchJson.data.currency, 'GBP');
      // Ownership remains with User A even when updated by Admin
      assert.equal(patchJson.data.accountId, userAAccount.id);
    });

    it('denies regular user from deleting even their own customer (User A -> DELETE Customer A -> 403 FORBIDDEN)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.deepEqual(json, {
        status: 'error',
        error: {
          code: 'FORBIDDEN',
          message: 'You are not authorized to perform this action',
          requestId: res.headers.get('x-request-id'),
        },
      });

      // Verify Customer A still exists
      const exists = await customerRepo.findById(customerA.id);
      assert.ok(exists);
    });

    it('denies regular user from deleting another user customer (User B -> DELETE Customer A -> 403 FORBIDDEN)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error.code, 'FORBIDDEN');
    });

    it('allows admin to delete a customer record (Admin -> DELETE Customer B -> 204 No Content)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerB.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 204);
      assert.equal(await res.text(), '');

      const deleted = await customerRepo.findById(customerB.id);
      assert.equal(deleted, null);
    });
  });

  describe('5. Privilege Escalation & Client-Supplied Identity Prevention', () => {
    it('blocks self-promotion to admin during registration (POST /api/v1/auth/register with role: "admin" -> 400)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'escalate@attacker.com',
          password: 'ValidPassword123!',
          role: 'admin',
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(json.error.fields.some((f: { field: string }) => f.field === 'role'));
    });

    it('enforces default "user" role in AuthService.register even if caller bypasses HTTP validation', async () => {
      const dtoWithInjectedRole = {
        email: 'service-bypass@attacker.com',
        password: 'ValidPassword123!',
        role: 'admin',
      };
      const created = await authService.register(dtoWithInjectedRole as any);
      assert.equal(created.role, 'user');
    });

    it('blocks client-supplied ownership fields (accountId, userId, ownerId) on POST /api/v1/customers', async () => {
      const injectionPayloads = [
        { name: 'Spoof 1', email: 'spoof1@test.com', currency: 'USD', accountId: userBAccount.id },
        { name: 'Spoof 2', email: 'spoof2@test.com', currency: 'USD', userId: userBAccount.id },
        { name: 'Spoof 3', email: 'spoof3@test.com', currency: 'USD', ownerId: userBAccount.id },
      ];

      for (const payload of injectionPayloads) {
        const res = await fetch(`${baseUrl}/api/v1/customers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userAToken}`,
          },
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400);
        const json = await res.json();
        assert.equal(json.error.code, 'VALIDATION_ERROR');
      }
    });

    it('blocks ownership transfer (accountId modification) on PATCH /api/v1/customers/:id', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          accountId: userBAccount.id,
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      assert.ok(
        json.error.fields.some(
          (f: { field: string; message: string }) =>
            f.field === 'accountId' && f.message.includes('immutable')
        )
      );

      // Confirm ownership was NOT altered
      const stored = await customerRepo.findById(customerA.id);
      assert.ok(stored);
      assert.equal(stored.accountId, userAAccount.id);
    });

    it('blocks protected authorization attributes (role, permissions, authorizationStatus) on PATCH /api/v1/customers/:id', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerA.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAToken}`,
        },
        body: JSON.stringify({
          name: 'Attempted Escalation',
          role: 'admin',
          permissions: ['customers:delete'],
          authorizationStatus: 'approved',
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'VALIDATION_ERROR');
      const fields = json.error.fields.map((f: { field: string }) => f.field);
      assert.ok(fields.includes('role'));
      assert.ok(fields.includes('permissions'));
      assert.ok(fields.includes('authorizationStatus'));
    });
  });
});
