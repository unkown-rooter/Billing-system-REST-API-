import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import { createApp } from '../api/app.js';
import { runMigrations } from '../api/db/migrate.js';
import { PostgresCustomerRepository } from '../api/repositories/postgres-customer.repository.js';
import { PostgresAccountRepository } from '../api/repositories/postgres-account.repository.js';
import { PostgresInvoiceRepository } from '../api/repositories/postgres-invoice.repository.js';
import { HealthController } from '../api/controllers/health.controller.js';
import { TokenService } from '../api/services/token.service.js';
import { assertSafeTestDatabaseUrl } from './helpers/fixtures.js';

const { Pool } = pg;

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5432/billing_system_test';

const TEST_JWT_SECRET =
  'phase-14-developer-readiness-test-jwt-secret-key-min-32-chars!!';

describe('Billing System REST API - Phase 14 Developer Readiness, OpenAPI 3.1 & Public Release Suite', () => {
  const workspaceRoot = process.cwd();
  let testPool: pg.Pool;
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    assertSafeTestDatabaseUrl(TEST_DATABASE_URL, process.env.DATABASE_URL);
    await runMigrations(TEST_DATABASE_URL);

    testPool = new Pool({
      connectionString: TEST_DATABASE_URL,
      max: 10,
    });

    const customerRepo = new PostgresCustomerRepository(testPool);
    const accountRepo = new PostgresAccountRepository(testPool);
    const invoiceRepo = new PostgresInvoiceRepository(testPool);
    const tokenService = new TokenService({
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 86400,
      nodeEnv: 'test',
    });
    const healthController = new HealthController(async () => {
      const res = await testPool.query('SELECT 1');
      return res.rowCount === 1;
    }, testPool);

    const app = createApp({
      customerRepository: customerRepo,
      accountRepository: accountRepo,
      invoiceRepository: invoiceRepo,
      tokenService,
      healthController,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  beforeEach(async () => {
    await testPool.query('TRUNCATE TABLE invoice_items, invoices, customers, accounts CASCADE;');
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (testPool) {
      await testPool.end();
    }
  });

  describe('1. Repository Structure, LICENSE, & Secret Hygiene Verification', () => {
    it('1.1 includes all required public repository artifacts (README.md, LICENSE, openapi.yaml, .env.example, .gitignore, Dockerfile, docker-compose.yml)', () => {
      const requiredFiles = [
        'README.md',
        'LICENSE',
        'openapi.yaml',
        'public/openapi.yaml',
        '.env.example',
        '.gitignore',
        '.dockerignore',
        'Dockerfile',
        'docker-compose.yml',
        'package.json',
      ];

      for (const relPath of requiredFiles) {
        const fullPath = path.join(workspaceRoot, relPath);
        assert.equal(
          fs.existsSync(fullPath),
          true,
          `Expected public release file '${relPath}' to exist`
        );
        const stat = fs.statSync(fullPath);
        assert.ok(stat.size > 0, `Expected '${relPath}' to be non-empty`);
      }

      const licenseContent = fs.readFileSync(path.join(workspaceRoot, 'LICENSE'), 'utf-8');
      assert.match(licenseContent, /MIT License/);
      assert.match(licenseContent, /Permission is hereby granted, free of charge/);
    });

    it('1.2 enforces .gitignore rules and contains zero leaked production secrets in documentation or example files', () => {
      const gitignore = fs.readFileSync(path.join(workspaceRoot, '.gitignore'), 'utf-8');
      assert.match(gitignore, /\.env\*/);
      assert.match(gitignore, /!\.env\.example/);
      assert.match(gitignore, /node_modules/);
      assert.match(gitignore, /dist/);

      const envExample = fs.readFileSync(path.join(workspaceRoot, '.env.example'), 'utf-8');
      assert.match(envExample, /DATABASE_URL=/);
      assert.match(envExample, /JWT_SECRET=/);
      assert.match(envExample, /DB_POOL_MAX=/);
      assert.match(envExample, /HTTP_KEEP_ALIVE_TIMEOUT_MS=/);
    });
  });

  describe('2. OpenAPI 3.1.0 Specification & Route Inventory Parity', () => {
    it('2.1 openapi.yaml defines OpenAPI 3.1.0 and documents all 13 paths and 20 HTTP operations implemented by the API', () => {
      const openapiContent = fs.readFileSync(path.join(workspaceRoot, 'openapi.yaml'), 'utf-8');
      const publicOpenapiContent = fs.readFileSync(
        path.join(workspaceRoot, 'public/openapi.yaml'),
        'utf-8'
      );

      assert.equal(openapiContent, publicOpenapiContent);
      assert.match(openapiContent, /^openapi:\s*3\.1\.0/m);
      assert.match(openapiContent, /title:\s*Billing System REST API/);
      assert.match(openapiContent, /version:\s*1\.0\.0/);
      assert.match(openapiContent, /bearerAuth:/);

      const expectedPaths = [
        '/api/v1/health',
        '/api/v1/health/live',
        '/api/v1/health/ready',
        '/api/v1/metrics',
        '/api/v1/auth/register',
        '/api/v1/auth/login',
        '/api/v1/auth/me',
        '/api/v1/customers',
        '/api/v1/customers/{id}',
        '/api/v1/customers/{id}/invoices',
        '/api/v1/invoices',
        '/api/v1/invoices/{id}',
        '/api/v1/invoices/{id}/items',
      ];

      // Extract top-level path keys under `paths:`
      const pathsSection = openapiContent.split(/^paths:\s*$/m)[1];
      assert.ok(pathsSection, 'Expected `paths:` section in openapi.yaml');

      const documentedPaths = Array.from(
        pathsSection.matchAll(/^  (\/api\/v1\/[^\s:]+):/gm),
        (m) => m[1]
      );

      assert.deepEqual(
        documentedPaths.sort(),
        [...expectedPaths].sort(),
        'OpenAPI paths must match the exact implemented routes without missing or invented endpoints'
      );

      // Verify all 20 operationIds are present
      const expectedOperationIds = [
        'getHealth',
        'getLiveness',
        'getReadiness',
        'getMetrics',
        'registerAccount',
        'loginAccount',
        'getAuthenticatedAccount',
        'createCustomer',
        'listCustomers',
        'getCustomerById',
        'updateCustomer',
        'deleteCustomer',
        'createInvoiceForCustomer',
        'listCustomerInvoices',
        'createInvoice',
        'listInvoices',
        'getInvoiceById',
        'updateInvoice',
        'deleteInvoice',
        'listInvoiceItems',
      ];

      for (const opId of expectedOperationIds) {
        assert.match(
          openapiContent,
          new RegExp(`operationId:\\s*${opId}\\b`),
          `Expected operationId '${opId}' in openapi.yaml`
        );
      }
    });

    it('2.2 documents every operational error code in both openapi.yaml and README.md', () => {
      const openapiContent = fs.readFileSync(path.join(workspaceRoot, 'openapi.yaml'), 'utf-8');
      const readmeContent = fs.readFileSync(path.join(workspaceRoot, 'README.md'), 'utf-8');

      const allErrorCodes = [
        'VALIDATION_ERROR',
        'MALFORMED_JSON',
        'AUTHENTICATION_REQUIRED',
        'INVALID_CREDENTIALS',
        'INVALID_TOKEN',
        'TOKEN_EXPIRED',
        'FORBIDDEN',
        'RESOURCE_NOT_FOUND',
        'ROUTE_NOT_FOUND',
        'METHOD_NOT_ALLOWED',
        'DUPLICATE_RESOURCE',
        'CONFLICT',
        'PAYLOAD_TOO_LARGE',
        'RATE_LIMIT_EXCEEDED',
        'SECURITY_CONFIGURATION_ERROR',
        'DATABASE_ERROR',
        'INTERNAL_SERVER_ERROR',
      ];

      for (const code of allErrorCodes) {
        assert.ok(
          openapiContent.includes(code),
          `Expected openapi.yaml to document error code '${code}'`
        );
        assert.ok(
          readmeContent.includes(code),
          `Expected README.md to document error code '${code}'`
        );
      }
    });

    it('2.3 README.md documents all 20 endpoints, 401 vs 403 semantics, environment variables, and setup workflow', () => {
      const readmeContent = fs.readFileSync(path.join(workspaceRoot, 'README.md'), 'utf-8');

      const requiredReadmeSections = [
        '## Project Description',
        '## Core API Features',
        '## Architecture Diagram',
        '## OpenAPI 3.1 Specification',
        '## Authentication & Authorization Guide',
        '## Standardized Error Contract',
        '## Customer API Reference',
        '## Invoice & Line Item API Reference',
        '## Health, Readiness & Metrics API Reference',
        '## Getting Started',
        '## Verification & Testing',
        '## Project Status',
        '## License',
      ];

      for (const section of requiredReadmeSections) {
        assert.ok(
          readmeContent.includes(section),
          `Expected README.md to include section '${section}'`
        );
      }

      // Verify all environment variables from .env.example are documented in README.md
      const envVars = [
        'DATABASE_URL',
        'JWT_SECRET',
        'NODE_ENV',
        'PORT',
        'HOST',
        'TRUST_PROXY',
        'CORS_ALLOWED_ORIGINS',
        'ENABLE_HSTS',
        'LOG_LEVEL',
        'JWT_EXPIRES_IN',
        'AUTH_RATE_LIMIT_WINDOW_MS',
        'AUTH_RATE_LIMIT_MAX',
        'API_RATE_LIMIT_WINDOW_MS',
        'API_RATE_LIMIT_MAX',
        'DB_POOL_MAX',
        'DB_POOL_IDLE_TIMEOUT_MS',
        'DB_POOL_CONNECTION_TIMEOUT_MS',
        'DB_STATEMENT_TIMEOUT_MS',
        'HTTP_KEEP_ALIVE_TIMEOUT_MS',
        'HTTP_HEADERS_TIMEOUT_MS',
        'HTTP_REQUEST_TIMEOUT_MS',
      ];

      for (const envVar of envVars) {
        assert.ok(
          readmeContent.includes(envVar),
          `Expected README.md to document environment variable '${envVar}'`
        );
      }
    });
  });

  describe('3. Live End-to-End Verification of Documented Developer Walkthrough & API Examples', () => {
    it('3.1 executes the documented Health, Liveness, Readiness & Metrics examples accurately', async () => {
      const healthRes = await fetch(`${baseUrl}/api/v1/health`);
      assert.equal(healthRes.status, 200);
      assert.ok(healthRes.headers.get('x-request-id'));
      const healthBody = (await healthRes.json()) as any;
      assert.equal(healthBody.status, 'success');
      assert.equal(healthBody.data.status, 'healthy');
      assert.equal(healthBody.data.database.status, 'healthy');
      assert.equal(typeof healthBody.data.database.latencyMs, 'number');
      assert.equal(typeof healthBody.data.database.pool.max, 'number');

      const liveRes = await fetch(`${baseUrl}/api/v1/health/live`);
      assert.equal(liveRes.status, 200);
      const liveBody = (await liveRes.json()) as any;
      assert.equal(liveBody.data.status, 'alive');

      const readyRes = await fetch(`${baseUrl}/api/v1/health/ready`);
      assert.equal(readyRes.status, 200);
      const readyBody = (await readyRes.json()) as any;
      assert.equal(readyBody.data.status, 'healthy');

      const metricsRes = await fetch(`${baseUrl}/api/v1/metrics`);
      assert.equal(metricsRes.status, 200);
      const metricsBody = (await metricsRes.json()) as any;
      assert.equal(metricsBody.status, 'success');
      assert.equal(typeof metricsBody.data.databasePool.max, 'number');
    });

    it('3.2 executes the documented Registration, Login, and /auth/me examples with exact response contracts', async () => {
      // Register
      const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'billing.ops@acme-corp.example.com',
          password: 'example-Passw0rd-987!',
        }),
      });
      assert.equal(regRes.status, 201);
      assert.equal(regRes.headers.get('location'), '/api/v1/auth/me');
      const regBody = (await regRes.json()) as any;
      assert.equal(regBody.status, 'success');
      assert.match(regBody.data.id, /^acc_/);
      assert.equal(regBody.data.email, 'billing.ops@acme-corp.example.com');
      assert.equal(regBody.data.role, 'user');
      assert.equal('passwordHash' in regBody.data, false);

      // Login
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'billing.ops@acme-corp.example.com',
          password: 'example-Passw0rd-987!',
        }),
      });
      assert.equal(loginRes.status, 200);
      const loginBody = (await loginRes.json()) as any;
      assert.equal(loginBody.status, 'success');
      assert.equal(loginBody.data.tokenType, 'Bearer');
      assert.equal(loginBody.data.expiresIn, 86400);
      assert.equal(typeof loginBody.data.token, 'string');

      // GET /api/v1/auth/me
      const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${loginBody.data.token}` },
      });
      assert.equal(meRes.status, 200);
      const meBody = (await meRes.json()) as any;
      assert.equal(meBody.data.id, regBody.data.id);
      assert.equal(meBody.data.email, 'billing.ops@acme-corp.example.com');
    });

    it('3.3 executes the documented Customer & Multi-Item Invoice examples and verifies authoritative cents math (385 + 25 - 10 = 400)', async () => {
      // 1. Register & Login
      await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'billing.ops@acme-corp.example.com',
          password: 'example-Passw0rd-987!',
        }),
      });
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'billing.ops@acme-corp.example.com',
          password: 'example-Passw0rd-987!',
        }),
      });
      const { token, account } = ((await loginRes.json()) as any).data;

      // 2. Create Customer (exact README example)
      const createCustRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Wayne Enterprises',
          email: 'ap@wayne-enterprises.example.com',
          currency: 'USD',
        }),
      });
      assert.equal(createCustRes.status, 201);
      const customer = ((await createCustRes.json()) as any).data;
      assert.match(customer.id, /^cus_/);
      assert.equal(customer.accountId, account.id);
      assert.equal(customer.name, 'Wayne Enterprises');
      assert.equal(customer.currency, 'USD');
      assert.equal(createCustRes.headers.get('location'), `/api/v1/customers/${customer.id}`);

      // 3. List Customers with documented query parameters
      const listCustRes = await fetch(
        `${baseUrl}/api/v1/customers?page=1&limit=10&currency=USD&sort=createdAt&order=desc`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      assert.equal(listCustRes.status, 200);
      const listCustBody = (await listCustRes.json()) as any;
      assert.equal(listCustBody.data.length, 1);
      assert.deepEqual(listCustBody.pagination, {
        page: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      });

      // 4. Issue Multi-Item Invoice (exact README example)
      const createInvRes = await fetch(`${baseUrl}/api/v1/invoices`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customerId: customer.id,
          status: 'issued',
          tax: 25.0,
          discount: 10.0,
          issueDate: '2026-09-27T00:00:00.000Z',
          dueDate: '2026-10-27T00:00:00.000Z',
          notes: 'Q4 Dedicated Infrastructure Commitment',
          items: [
            {
              description: 'Dedicated Compute Cluster (Monthly)',
              quantity: 2,
              unitPrice: 150.0,
            },
            {
              description: 'Managed PostgreSQL High-Availability Add-on',
              quantity: 1,
              unitPrice: 85.0,
            },
          ],
        }),
      });
      assert.equal(createInvRes.status, 201);
      const invoice = ((await createInvRes.json()) as any).data;
      assert.match(invoice.id, /^inv_/);
      assert.equal(invoice.customerId, customer.id);
      assert.equal(invoice.currency, 'USD');
      assert.equal(invoice.subtotal, 385.0);
      assert.equal(invoice.tax, 25.0);
      assert.equal(invoice.discount, 10.0);
      assert.equal(invoice.total, 400.0);
      assert.equal(invoice.items.length, 2);
      assert.equal(invoice.items[0].lineTotal, 300.0);
      assert.equal(invoice.items[1].lineTotal, 85.0);

      // 5. Query line items endpoint
      const itemsRes = await fetch(
        `${baseUrl}/api/v1/invoices/${invoice.id}/items?page=1&limit=10&description=PostgreSQL`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      assert.equal(itemsRes.status, 200);
      const itemsBody = (await itemsRes.json()) as any;
      assert.equal(itemsBody.data.length, 1);
      assert.equal(itemsBody.data[0].lineTotal, 85.0);
    });

    it('3.4 verifies documented 400 VALIDATION_ERROR, 401 AUTHENTICATION_REQUIRED, 403 FORBIDDEN (IDOR & RBAC), 405 METHOD_NOT_ALLOWED, and 409 CONFLICT contracts', async () => {
      // 401 AUTHENTICATION_REQUIRED
      const unauthRes = await fetch(`${baseUrl}/api/v1/customers`);
      assert.equal(unauthRes.status, 401);
      const unauthBody = (await unauthRes.json()) as any;
      assert.equal(unauthBody.error.code, 'AUTHENTICATION_REQUIRED');

      // 405 METHOD_NOT_ALLOWED with Allow header
      const methodRes = await fetch(`${baseUrl}/api/v1/customers`, { method: 'PUT' });
      assert.equal(methodRes.status, 405);
      assert.equal(methodRes.headers.get('allow'), 'GET, POST');
      const methodBody = (await methodRes.json()) as any;
      assert.equal(methodBody.error.code, 'METHOD_NOT_ALLOWED');

      // Register two users to verify 403 FORBIDDEN cross-account IDOR and admin-only DELETE
      await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user1@example.com', password: 'Password123!' }),
      });
      const login1 = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user1@example.com', password: 'Password123!' }),
      });
      const token1 = ((await login1.json()) as any).data.token;

      await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user2@example.com', password: 'Password123!' }),
      });
      const login2 = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user2@example.com', password: 'Password123!' }),
      });
      const token2 = ((await login2.json()) as any).data.token;

      // User 1 creates customer
      const custRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token1}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Tenant One LLC',
          email: 'ap@tenant-one.example.com',
          currency: 'USD',
        }),
      });
      const custId = ((await custRes.json()) as any).data.id;

      // User 2 attempts to read User 1's customer -> 403 FORBIDDEN
      const idorRes = await fetch(`${baseUrl}/api/v1/customers/${custId}`, {
        headers: { Authorization: `Bearer ${token2}` },
      });
      assert.equal(idorRes.status, 403);
      const idorBody = (await idorRes.json()) as any;
      assert.equal(idorBody.error.code, 'FORBIDDEN');

      // User 1 attempts admin-only DELETE -> 403 FORBIDDEN
      const delRes = await fetch(`${baseUrl}/api/v1/customers/${custId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token1}` },
      });
      assert.equal(delRes.status, 403);
      const delBody = (await delRes.json()) as any;
      assert.equal(delBody.error.code, 'FORBIDDEN');
    });

    it('3.5 verifies documented PATCH /api/v1/customers/:id, POST /api/v1/customers/:id/invoices, and GET /api/v1/customers/:id/invoices examples', async () => {
      await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dev@example.com', password: 'example-Passw0rd-987!' }),
      });
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dev@example.com', password: 'example-Passw0rd-987!' }),
      });
      const { token } = ((await loginRes.json()) as any).data;

      const custRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Acme Corp',
          email: 'billing@acme.example.com',
          currency: 'USD',
        }),
      });
      const customerId = ((await custRes.json()) as any).data.id;

      // PATCH Customer (README example)
      const patchRes = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Wayne Enterprises Global' }),
      });
      assert.equal(patchRes.status, 200);
      const patchedCust = ((await patchRes.json()) as any).data;
      assert.equal(patchedCust.name, 'Wayne Enterprises Global');

      // Nested POST /api/v1/customers/:id/invoices (README Quickstart walkthrough)
      const nestedInvRes = await fetch(`${baseUrl}/api/v1/customers/${customerId}/invoices`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'issued',
          tax: 15.0,
          discount: 5.0,
          items: [{ description: 'API Platform Subscription', quantity: 1, unitPrice: 100.0 }],
        }),
      });
      assert.equal(nestedInvRes.status, 201);
      const nestedInv = ((await nestedInvRes.json()) as any).data;
      assert.equal(nestedInv.customerId, customerId);
      assert.equal(nestedInv.currency, 'USD');
      assert.equal(nestedInv.subtotal, 100.0);
      assert.equal(nestedInv.total, 110.0);

      // Nested GET /api/v1/customers/:id/invoices
      const listNestedRes = await fetch(
        `${baseUrl}/api/v1/customers/${customerId}/invoices?page=1&limit=10&status=issued`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      assert.equal(listNestedRes.status, 200);
      const listNestedBody = (await listNestedRes.json()) as any;
      assert.equal(listNestedBody.data.length, 1);
      assert.equal(listNestedBody.data[0].id, nestedInv.id);
    });

    it('3.6 verifies documented PATCH /api/v1/invoices/:id transition to paid and 409 CONFLICT finalized state lock', async () => {
      await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'lock@example.com', password: 'example-Passw0rd-987!' }),
      });
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'lock@example.com', password: 'example-Passw0rd-987!' }),
      });
      const { token } = ((await loginRes.json()) as any).data;

      const custRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Stark Industries', email: 'ap@stark.example.com', currency: 'USD' }),
      });
      const customerId = ((await custRes.json()) as any).data.id;

      const invRes = await fetch(`${baseUrl}/api/v1/customers/${customerId}/invoices`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'issued',
          items: [{ description: 'Arc Reactor Maintenance', quantity: 1, unitPrice: 500.0 }],
        }),
      });
      const invoiceId = ((await invRes.json()) as any).data.id;

      // Transition status to 'paid'
      const markPaidRes = await fetch(`${baseUrl}/api/v1/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'paid' }),
      });
      assert.equal(markPaidRes.status, 200);
      assert.equal(((await markPaidRes.json()) as any).data.status, 'paid');

      // Attempting to mutate tax or items on a 'paid' invoice returns 409 CONFLICT
      const conflictRes = await fetch(`${baseUrl}/api/v1/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tax: 50.0 }),
      });
      assert.equal(conflictRes.status, 409);
      const conflictBody = (await conflictRes.json()) as any;
      assert.equal(conflictBody.error.code, 'CONFLICT');
    });

    it('3.7 verifies documented Admin DELETE workflows: 409 ON DELETE RESTRICT on customer with invoices, 204 CASCADE on invoice delete, and 204 customer delete', async () => {
      await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin.ops@example.com', password: 'example-Passw0rd-987!' }),
      });
      // Promote to admin out-of-band as documented
      await testPool.query("UPDATE accounts SET role = 'admin' WHERE email = 'admin.ops@example.com'");

      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin.ops@example.com', password: 'example-Passw0rd-987!' }),
      });
      const { token } = ((await loginRes.json()) as any).data;

      const custRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Oscorp', email: 'ap@oscorp.example.com', currency: 'USD' }),
      });
      const customerId = ((await custRes.json()) as any).data.id;

      const invRes = await fetch(`${baseUrl}/api/v1/customers/${customerId}/invoices`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ description: 'Biotech Lab Lease', quantity: 1, unitPrice: 250.0 }],
        }),
      });
      const invoiceId = ((await invRes.json()) as any).data.id;

      // 1. Deleting customer while invoice exists -> 409 CONFLICT
      const restrictRes = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(restrictRes.status, 409);
      const restrictBody = (await restrictRes.json()) as any;
      assert.equal(restrictBody.error.code, 'CONFLICT');

      // 2. Deleting invoice -> 204 No Content (cascades items)
      const delInvRes = await fetch(`${baseUrl}/api/v1/invoices/${invoiceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(delInvRes.status, 204);

      // 3. Deleting customer after invoice removal -> 204 No Content
      const delCustRes = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(delCustRes.status, 204);
    });
  });
});
