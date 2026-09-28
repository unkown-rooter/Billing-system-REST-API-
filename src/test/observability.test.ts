import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { createApp } from '../api/app.js';
import { InMemoryCustomerRepository } from '../api/repositories/in-memory-customer.repository.js';
import { InMemoryAccountRepository } from '../api/repositories/in-memory-account.repository.js';
import { PasswordService } from '../api/services/password.service.js';
import { TokenService } from '../api/services/token.service.js';
import { AuthService } from '../api/services/auth.service.js';
import { HealthController } from '../api/controllers/health.controller.js';
import { closePool } from '../api/db/pool.js';
import {
  clearRecentStructuredLogs,
  getRecentStructuredLogs,
  logger,
  resolveConfiguredLogLevel,
  StructuredLogEntry,
} from '../api/observability/logger.js';
import {
  metricsCollector,
  normalizeRouteMetricKey,
} from '../api/observability/metrics.js';
import {
  getCurrentRequestId,
  resolveSafeRequestId,
  runWithRequestContext,
} from '../api/observability/request-context.js';
import { ICustomerRepository } from '../api/repositories/customer.repository.interface.js';
import { Customer } from '../api/models/customer.model.js';

describe('Billing System REST API - Phase 12 Monitoring, Structured Logging & Observability Test Suite', () => {
  let server: Server;
  let baseUrl: string;
  let accountRepo: InMemoryAccountRepository;
  let customerRepo: InMemoryCustomerRepository;
  let passwordService: PasswordService;
  let tokenService: TokenService;

  const JWT_SECRET = 'phase-12-observability-test-secret-key-min-32-chars!!';

  before(async () => {
    accountRepo = new InMemoryAccountRepository();
    customerRepo = new InMemoryCustomerRepository();
    passwordService = new PasswordService();
    tokenService = new TokenService({
      secret: JWT_SECRET,
      expiresInSeconds: 3600,
    });
    const authService = new AuthService(accountRepo, passwordService, tokenService);

    const app = createApp({
      accountRepository: accountRepo,
      customerRepository: customerRepo,
      passwordService,
      tokenService,
      authService,
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

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await closePool();
  });

  beforeEach(() => {
    clearRecentStructuredLogs();
    metricsCollector.reset();
  });

  describe('1. Request Correlation IDs & Injection Hardening', () => {
    it('generates a collision-resistant server-side req_<uuid> correlation ID when X-Request-Id is absent', async () => {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      assert.equal(res.status, 200);

      const headerRequestId = res.headers.get('x-request-id');
      assert.ok(headerRequestId);
      assert.match(headerRequestId, /^req_[0-9a-f-]{36}$/);

      const logs = getRecentStructuredLogs();
      const reqLog = logs.find((l) => l.event === 'http_request' && l.requestId === headerRequestId);
      assert.ok(reqLog, 'Expected structured http_request log correlated with generated requestId');
      assert.equal(reqLog.method, 'GET');
      assert.equal(reqLog.path, '/api/v1/health');
      assert.equal(reqLog.status, 200);
      assert.equal(typeof reqLog.durationMs, 'number');
    });

    it('preserves a trusted, well-formed client X-Request-Id across headers, logs, and error responses', async () => {
      const customReqId = 'trace-client-checkout-2026-00042';
      const res = await fetch(`${baseUrl}/api/v1/customers/invalid_id`, {
        headers: {
          'X-Request-Id': customReqId,
        },
      });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('x-request-id'), customReqId);

      const json = await res.json();
      assert.equal(json.status, 'error');
      assert.equal(json.error.code, 'AUTHENTICATION_REQUIRED');
      assert.equal(json.error.requestId, customReqId);

      const logs = getRecentStructuredLogs();
      const correlatedLogs = logs.filter((l) => l.requestId === customReqId);
      assert.ok(correlatedLogs.length >= 2, 'Expected both error log and http_request log to carry customReqId');
    });

    it('rejects malicious or oversized X-Request-Id values containing CRLF or control characters to prevent header/log injection', async () => {
      assert.match(
        resolveSafeRequestId('bad\r\nSet-Cookie: session=compromised'),
        /^req_[0-9a-f-]{36}$/
      );
      assert.match(resolveSafeRequestId('spaces not allowed'), /^req_[0-9a-f-]{36}$/);
      assert.match(resolveSafeRequestId('x'.repeat(100)), /^req_[0-9a-f-]{36}$/);
      assert.match(resolveSafeRequestId(''), /^req_[0-9a-f-]{36}$/);

      const res = await fetch(`${baseUrl}/api/v1/unknown-route`, {
        headers: {
          'X-Request-Id': 'malicious<script>alert(1)</script>',
        },
      });
      assert.equal(res.status, 404);
      const assignedId = res.headers.get('x-request-id');
      assert.ok(assignedId);
      assert.match(assignedId, /^req_[0-9a-f-]{36}$/);

      const json = await res.json();
      assert.equal(json.error.code, 'ROUTE_NOT_FOUND');
      assert.equal(json.error.requestId, assignedId);
    });

    it('propagates requestId across asynchronous boundaries via AsyncLocalStorage without leaking across concurrent requests', async () => {
      const results = await Promise.all(
        ['req_concurrent_alpha', 'req_concurrent_beta', 'req_concurrent_gamma'].map((id) =>
          runWithRequestContext(
            { requestId: id, method: 'GET', path: '/test', startTimeMs: Date.now() },
            async () => {
              await new Promise((r) => setTimeout(r, 15));
              return getCurrentRequestId();
            }
          )
        )
      );
      assert.deepEqual(results, [
        'req_concurrent_alpha',
        'req_concurrent_beta',
        'req_concurrent_gamma',
      ]);
    });
  });

  describe('2. Structured JSON Logging, Severity Levels & Sensitive Data Redaction', () => {
    it('emits machine-parsable JSON logs with ISO timestamps, levels, event names, and deep secret redaction', () => {
      const entry = logger.warn(
        'diagnostic_test_event',
        'Failed connection to postgresql://admin:MyTopSecretPass123@db.internal:5432/prod with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
        {
          password: 'PlaintextUserPassword99!',
          passwordHash: 'scrypt$N=16384,r=8,p=1$salt$hash',
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb',
          nested: {
            jwtSecret: JWT_SECRET,
            safeField: 'visible-value',
          },
        }
      );

      assert.ok(entry);
      assert.equal(entry.level, 'warn');
      assert.equal(entry.event, 'diagnostic_test_event');
      assert.ok(Date.parse(entry.timestamp) > 0);

      const serialized = JSON.stringify(entry);
      assert.ok(!serialized.includes('MyTopSecretPass123'));
      assert.ok(!serialized.includes('PlaintextUserPassword99!'));
      assert.ok(!serialized.includes(JWT_SECRET));
      assert.ok(!serialized.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
      assert.equal(entry.password, '[REDACTED]');
      assert.equal(entry.passwordHash, '[REDACTED]');
      assert.equal(entry.token, '[REDACTED]');
      assert.equal((entry.nested as Record<string, unknown>).jwtSecret, '[REDACTED]');
      assert.equal((entry.nested as Record<string, unknown>).safeField, 'visible-value');
    });

    it('clamps LOG_LEVEL=debug to info when NODE_ENV=production to prevent debug log leakage in production', () => {
      const prevEnv = process.env.NODE_ENV;
      const prevLevel = process.env.LOG_LEVEL;
      try {
        process.env.NODE_ENV = 'production';
        process.env.LOG_LEVEL = 'debug';
        assert.equal(resolveConfiguredLogLevel(), 'info');

        const suppressed = logger.debug('debug_only_event', 'Should not emit in production');
        assert.equal(suppressed, null);
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevLevel === undefined) {
          delete process.env.LOG_LEVEL;
        } else {
          process.env.LOG_LEVEL = prevLevel;
        }
      }
    });
  });

  describe('3. Security, Authentication, Authorization & Database Error Correlation', () => {
    it('logs and counts registration, login success, login failure, invalid tokens, expired tokens, and 403 IDOR/RBAC denials', async () => {
      // 1. Register User 1 & User 2
      const reg1 = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-obs-reg-1' },
        body: JSON.stringify({ email: 'obs_user1@billing.local', password: 'ObsPassword123!' }),
      });
      assert.equal(reg1.status, 201);

      const reg2 = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-obs-reg-2' },
        body: JSON.stringify({ email: 'obs_user2@billing.local', password: 'ObsPassword123!' }),
      });
      assert.equal(reg2.status, 201);

      // 2. Failed login (wrong password)
      const badLogin = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-obs-login-fail' },
        body: JSON.stringify({ email: 'obs_user1@billing.local', password: 'WrongPassword999!' }),
      });
      assert.equal(badLogin.status, 401);

      // 3. Successful logins
      const login1 = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-obs-login-ok' },
        body: JSON.stringify({ email: 'obs_user1@billing.local', password: 'ObsPassword123!' }),
      });
      assert.equal(login1.status, 200);
      const token1 = (await login1.json()).data.token;

      const login2 = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'obs_user2@billing.local', password: 'ObsPassword123!' }),
      });
      const token2 = (await login2.json()).data.token;

      // 4. User 1 creates a customer
      const createCust = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token1}`,
        },
        body: JSON.stringify({
          name: 'Observability Tenant 1',
          email: 'tenant1@obs.local',
          currency: 'USD',
        }),
      });
      assert.equal(createCust.status, 201);
      const cust1Id = (await createCust.json()).data.id;

      // 5. User 2 attempts cross-account IDOR access on User 1's customer -> 403 FORBIDDEN
      const idorRes = await fetch(`${baseUrl}/api/v1/customers/${cust1Id}`, {
        headers: {
          Authorization: `Bearer ${token2}`,
          'X-Request-Id': 'req-obs-idor-403',
        },
      });
      assert.equal(idorRes.status, 403);
      const idorBody = await idorRes.json();
      assert.equal(idorBody.error.requestId, 'req-obs-idor-403');

      // 6. Invalid Bearer token -> 401 INVALID_TOKEN
      const invalidTokRes = await fetch(`${baseUrl}/api/v1/customers`, {
        headers: {
          Authorization: 'Bearer forged.jwt.token',
          'X-Request-Id': 'req-obs-invalid-token',
        },
      });
      assert.equal(invalidTokRes.status, 401);

      // Verify structured security logs and correlation
      const logs = getRecentStructuredLogs();
      assert.ok(logs.some((l) => l.event === 'auth_register_success' && l.requestId === 'req-obs-reg-1'));
      assert.ok(logs.some((l) => l.event === 'auth_login_failed' && l.requestId === 'req-obs-login-fail'));
      assert.ok(logs.some((l) => l.event === 'auth_login_success' && l.requestId === 'req-obs-login-ok'));
      assert.ok(logs.some((l) => l.event === 'authz_forbidden' && l.requestId === 'req-obs-idor-403'));
      assert.ok(logs.some((l) => l.event === 'auth_token_invalid' && l.requestId === 'req-obs-invalid-token'));

      // Verify zero password or token leakage across all structured logs
      const rawLogsDump = JSON.stringify(logs);
      assert.ok(!rawLogsDump.includes('ObsPassword123!'));
      assert.ok(!rawLogsDump.includes('WrongPassword999!'));
      assert.ok(!rawLogsDump.includes(token1));
      assert.ok(!rawLogsDump.includes(token2));

      // Verify security counters in metrics snapshot
      const snapshot = metricsCollector.getSnapshot();
      assert.equal(snapshot.securityEvents.authLoginFailure, 1);
      assert.equal(snapshot.securityEvents.authLoginSuccess, 2);
      assert.equal(snapshot.securityEvents.authzForbidden, 1);
      assert.equal(snapshot.securityEvents.authTokenInvalid, 1);
    });

    it('correlates unexpected 500 server errors with requestId in both structured error logs and sanitized HTTP 500 responses', async () => {
      const failingRepo: ICustomerRepository = {
        async findAll(): Promise<Customer[]> {
          throw new Error('Fatal DB failure on postgresql://postgres:SecretPass@127.0.0.1:5432/prod');
        },
        async findByAccountId(): Promise<Customer[]> {
          throw new Error('Fatal DB failure on postgresql://postgres:SecretPass@127.0.0.1:5432/prod');
        },
        async findById(): Promise<Customer | null> {
          return null;
        },
        async findByEmail(): Promise<Customer | null> {
          return null;
        },
        async create(): Promise<Customer> {
          throw new Error('fail');
        },
        async update(): Promise<Customer | null> {
          return null;
        },
        async delete(): Promise<boolean> {
          return false;
        },
        async count(): Promise<number> {
          return 0;
        },
      };

      const adminToken = tokenService.generateToken({
        id: 'acc_obs_admin',
        email: 'admin@obs.local',
        role: 'admin',
      });

      const failApp = createApp({
        customerRepository: failingRepo,
        tokenService,
      });

      let failServer!: Server;
      let failUrl = '';
      await new Promise<void>((resolve) => {
        failServer = failApp.listen(0, '127.0.0.1', () => {
          const addr = failServer.address();
          if (addr && typeof addr === 'object') {
            failUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });

      try {
        const res = await fetch(`${failUrl}/api/v1/customers`, {
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'X-Request-Id': 'req-obs-500-correlation',
          },
        });
        assert.equal(res.status, 500);
        assert.equal(res.headers.get('x-request-id'), 'req-obs-500-correlation');

        const body = await res.json();
        assert.deepEqual(body, {
          status: 'error',
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected internal error occurred',
            requestId: 'req-obs-500-correlation',
          },
        });

        const logs = getRecentStructuredLogs();
        const unhandledLog = logs.find(
          (l: StructuredLogEntry) =>
            l.event === 'unhandled_server_error' && l.requestId === 'req-obs-500-correlation'
        );
        assert.ok(unhandledLog, 'Expected unhandled_server_error log entry correlated by requestId');
        assert.equal(unhandledLog.level, 'error');
        assert.ok(!JSON.stringify(unhandledLog).includes('SecretPass'));
      } finally {
        await new Promise<void>((resolve) => failServer.close(() => resolve()));
      }
    });
  });

  describe('4. Health, Liveness, Readiness & Low-Cardinality Metrics Endpoints', () => {
    it('GET /api/v1/health, /api/v1/health/live, and /api/v1/health/ready report operational status and DB latency', async () => {
      const healthRes = await fetch(`${baseUrl}/api/v1/health`);
      assert.equal(healthRes.status, 200);
      const healthJson = await healthRes.json();
      assert.equal(healthJson.status, 'success');
      assert.equal(healthJson.data.status, 'healthy');
      assert.equal(healthJson.data.database.status, 'healthy');
      assert.equal(typeof healthJson.data.database.latencyMs, 'number');

      const liveRes = await fetch(`${baseUrl}/api/v1/health/live`);
      assert.equal(liveRes.status, 200);
      const liveJson = await liveRes.json();
      assert.equal(liveJson.status, 'success');
      assert.equal(liveJson.data.status, 'alive');

      const readyRes = await fetch(`${baseUrl}/api/v1/health/ready`);
      assert.equal(readyRes.status, 200);
      const readyJson = await readyRes.json();
      assert.equal(readyJson.status, 'success');
      assert.equal(readyJson.data.database.status, 'healthy');

      // Verify 503 degraded behavior on /health/ready when database check fails
      const degradedApp = createApp({
        customerRepository: customerRepo,
        healthController: new HealthController(async () => false),
      });
      let degServer!: Server;
      let degUrl = '';
      await new Promise<void>((resolve) => {
        degServer = degradedApp.listen(0, '127.0.0.1', () => {
          const addr = degServer.address();
          if (addr && typeof addr === 'object') {
            degUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });

      try {
        const degReady = await fetch(`${degUrl}/api/v1/health/ready`);
        assert.equal(degReady.status, 503);
        const degJson = await degReady.json();
        assert.equal(degJson.status, 'error');
        assert.equal(degJson.data.status, 'degraded');
        assert.equal(degJson.data.database.status, 'unhealthy');

        // Liveness still returns 200 alive when process is up even if DB readiness is degraded
        const degLive = await fetch(`${degUrl}/api/v1/health/live`);
        assert.equal(degLive.status, 200);
      } finally {
        await new Promise<void>((resolve) => degServer.close(() => resolve()));
      }
    });

    it('normalizes dynamic route parameters into low-cardinality route keys and exposes bounded metrics at GET /api/v1/metrics', async () => {
      assert.equal(
        normalizeRouteMetricKey('GET', '/api/v1/customers/cus_12345678-abcd-1234-ef00-112233445566?page=1'),
        'GET /api/v1/customers/:id'
      );
      assert.equal(
        normalizeRouteMetricKey('GET', '/api/v1/customers/cus_abc/invoices'),
        'GET /api/v1/customers/:id/invoices'
      );
      assert.equal(
        normalizeRouteMetricKey('PATCH', '/api/v1/invoices/inv_999'),
        'PATCH /api/v1/invoices/:id'
      );
      assert.equal(
        normalizeRouteMetricKey('GET', '/api/v1/invoices/inv_999/items'),
        'GET /api/v1/invoices/:id/items'
      );
      assert.equal(
        normalizeRouteMetricKey('GET', '/api/v1/random-probe-scan-9999', 404),
        'GET /api/unmatched'
      );

      await fetch(`${baseUrl}/api/v1/health`);
      await fetch(`${baseUrl}/api/v1/nonexistent-1`);
      await fetch(`${baseUrl}/api/v1/nonexistent-2`);

      const metricsRes = await fetch(`${baseUrl}/api/v1/metrics`);
      assert.equal(metricsRes.status, 200);
      const metricsJson = await metricsRes.json();
      assert.equal(metricsJson.status, 'success');
      assert.ok(metricsJson.data.totalRequests >= 3);
      assert.equal(metricsJson.data.clientErrors4xx, 2);
      assert.equal(metricsJson.data.routes['GET /api/v1/health'].count, 1);
      assert.equal(metricsJson.data.routes['GET /api/unmatched'].count, 2);

      // Verify 405 Method Not Allowed on POST /api/v1/metrics and POST /api/v1/health/live
      const postMetrics = await fetch(`${baseUrl}/api/v1/metrics`, { method: 'POST' });
      assert.equal(postMetrics.status, 405);
      assert.equal(postMetrics.headers.get('allow'), 'GET');

      const postLive = await fetch(`${baseUrl}/api/v1/health/live`, { method: 'POST' });
      assert.equal(postLive.status, 405);
      assert.equal(postLive.headers.get('allow'), 'GET');
    });
  });
});
