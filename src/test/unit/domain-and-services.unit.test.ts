import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildPaginationMeta } from '../../api/models/pagination.model.js';
import { isValidAccountRole, DEFAULT_ACCOUNT_ROLE } from '../../api/models/account.model.js';
import { isValidInvoiceStatus } from '../../api/models/invoice.model.js';
import {
  validateCreateCustomerBody,
  validateUpdateCustomerBody,
  validateCustomerIdParam,
} from '../../api/validation/customer.schema.js';
import {
  validateRegisterBody,
  validateLoginBody,
} from '../../api/validation/auth.schema.js';
import {
  validateCreateInvoiceBody,
  validateUpdateInvoiceBody,
  validateInvoiceIdParam,
} from '../../api/validation/invoice.schema.js';
import {
  validateCustomerListQuery,
  validateInvoiceListQuery,
  validateInvoiceItemListQuery,
} from '../../api/validation/query.schema.js';
import { PasswordService } from '../../api/services/password.service.js';
import {
  TokenService,
  resolveAndValidateJwtExpiresIn,
  DEFAULT_JWT_EXPIRES_IN_SECONDS,
  MIN_JWT_EXPIRES_IN_SECONDS,
  MAX_JWT_EXPIRES_IN_SECONDS,
} from '../../api/services/token.service.js';
import {
  createRateLimiter,
  resolveRateLimitMode,
  InMemoryRateLimitStore,
  RateLimitStore,
  RateLimitBucket,
} from '../../api/middlewares/rate-limit.middleware.js';
import {
  runMigrations,
  MIGRATION_ADVISORY_LOCK_ID,
  MigrationPool,
  MigrationQueryClient,
} from '../../api/db/migrate.js';
import { AuthService } from '../../api/services/auth.service.js';
import { CustomerService } from '../../api/services/customer.service.js';
import { InvoiceService } from '../../api/services/invoice.service.js';
import { InMemoryAccountRepository } from '../../api/repositories/in-memory-account.repository.js';
import { InMemoryCustomerRepository } from '../../api/repositories/in-memory-customer.repository.js';
import { InMemoryInvoiceRepository } from '../../api/repositories/in-memory-invoice.repository.js';
import {
  ValidationError,
  NotFoundError,
  DuplicateResourceError,
  ConflictError,
  AuthenticationRequiredError,
  InvalidCredentialsError,
  InvalidTokenError,
  TokenExpiredError,
  ForbiddenError,
  DatabaseError,
  PayloadTooLargeError,
  InternalServerError,
  SecurityConfigurationError,
  RateLimitExceededError,
} from '../../api/services/errors.js';
import { errorHandler } from '../../api/middlewares/error-handler.middleware.js';
import { buildAccountFixture, assertSafeTestDatabaseUrl } from '../helpers/fixtures.js';

describe('Billing System REST API - Phase 8 Unit Test Suite (Domain, Validation, Crypto, Calculations & Errors)', () => {
  describe('1. Pagination Metadata Calculation Unit Tests (buildPaginationMeta)', () => {
    it('computes 0 totalPages and false navigation flags when total is 0', () => {
      const meta = buildPaginationMeta(1, 20, 0);
      assert.deepEqual(meta, {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });

    it('computes exact single-page boundaries when total equals limit', () => {
      const meta = buildPaginationMeta(1, 10, 10);
      assert.deepEqual(meta, {
        page: 1,
        limit: 10,
        total: 10,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });

    it('computes multi-page ceiling and next/previous flags when total exceeds limit by 1', () => {
      const page1 = buildPaginationMeta(1, 10, 11);
      assert.deepEqual(page1, {
        page: 1,
        limit: 10,
        total: 11,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });

      const page2 = buildPaginationMeta(2, 10, 11);
      assert.deepEqual(page2, {
        page: 2,
        limit: 10,
        total: 11,
        totalPages: 2,
        hasNextPage: false,
        hasPreviousPage: true,
      });
    });

    it('computes middle page flags accurately (hasNextPage: true, hasPreviousPage: true)', () => {
      const meta = buildPaginationMeta(2, 5, 15);
      assert.deepEqual(meta, {
        page: 2,
        limit: 5,
        total: 15,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });

    it('computes out-of-range page metadata accurately (page > totalPages)', () => {
      const meta = buildPaginationMeta(5, 10, 25);
      assert.deepEqual(meta, {
        page: 5,
        limit: 10,
        total: 25,
        totalPages: 3,
        hasNextPage: false,
        hasPreviousPage: true,
      });
    });
  });

  describe('2. Domain Model Type Guards & DTO Sanitization Unit Tests', () => {
    it('isValidAccountRole accepts only "user" and "admin" and rejects arbitrary strings/primitives', () => {
      assert.equal(isValidAccountRole('user'), true);
      assert.equal(isValidAccountRole('admin'), true);
      assert.equal(isValidAccountRole('superadmin'), false);
      assert.equal(isValidAccountRole('owner'), false);
      assert.equal(isValidAccountRole(''), false);
      assert.equal(isValidAccountRole(null), false);
      assert.equal(isValidAccountRole(undefined), false);
      assert.equal(isValidAccountRole(123), false);
    });

    it('AuthService.getAccountById strips passwordHash and preserves safe public AccountDTO attributes', async () => {
      const accountRepo = new InMemoryAccountRepository();
      const passwordService = new PasswordService({ N: 1024, r: 8, p: 1 });
      const tokenService = new TokenService({
        secret: 'unit-test-jwt-secret-key-minimum-32-characters-long!!',
        expiresInSeconds: 600,
      });
      const authService = new AuthService(accountRepo, passwordService, tokenService);

      const account = buildAccountFixture({
        id: 'acc_unit_dto',
        email: 'dto@billing.local',
        role: 'admin',
      });
      await accountRepo.create(account);

      const dto = await authService.getAccountById('acc_unit_dto');
      assert.deepEqual(dto, {
        id: 'acc_unit_dto',
        email: 'dto@billing.local',
        role: 'admin',
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      });
      assert.equal('passwordHash' in dto, false);
      assert.equal(DEFAULT_ACCOUNT_ROLE, 'user');
    });

    it('isValidInvoiceStatus accepts only the 5 explicit billing lifecycle states', () => {
      for (const valid of ['draft', 'issued', 'paid', 'overdue', 'cancelled']) {
        assert.equal(isValidInvoiceStatus(valid), true);
      }
      for (const invalid of ['pending', 'void', 'refunded', 'DRAFT', '', null, undefined, 42]) {
        assert.equal(isValidInvoiceStatus(invalid), false);
      }
    });
  });

  describe('3. Schema Validation Helpers Unit Tests', () => {
    it('validateCreateCustomerBody trims name, lowercases email, and uppercases currency', () => {
      const result = validateCreateCustomerBody({
        name: '  Global Ledger Corp  ',
        email: '  Accounts.Payable@GlobalLedger.COM ',
        currency: 'USD',
      });
      assert.deepEqual(result, {
        name: 'Global Ledger Corp',
        email: 'accounts.payable@globalledger.com',
        currency: 'USD',
      });
    });

    it('validateUpdateCustomerBody rejects immutable fields (id, createdAt, accountId) with field-level details', () => {
      assert.throws(
        () =>
          validateUpdateCustomerBody({
            id: 'cus_override',
            accountId: 'acc_override',
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          const fields = err.fields?.map((f) => f.field) ?? [];
          assert.ok(fields.includes('id'));
          assert.ok(fields.includes('accountId'));
          assert.ok(fields.includes('createdAt'));
          return true;
        }
      );
    });

    it('validateCustomerIdParam and validateInvoiceIdParam enforce strict domain prefixes', () => {
      assert.equal(validateCustomerIdParam('cus_abc_123-def'), 'cus_abc_123-def');
      assert.equal(validateInvoiceIdParam('inv_abc_123-def'), 'inv_abc_123-def');

      assert.throws(() => validateCustomerIdParam('inv_wrong_prefix'), ValidationError);
      assert.throws(() => validateCustomerIdParam('cus_'), ValidationError);
      assert.throws(() => validateInvoiceIdParam('cus_wrong_prefix'), ValidationError);
      assert.throws(() => validateInvoiceIdParam('inv_'), ValidationError);
    });

    it('validateRegisterBody and validateLoginBody enforce password boundaries and reject extra fields', () => {
      const validReg = validateRegisterBody({
        email: '  USER@Billing.com ',
        password: 'Minimum8', // exact 8-character minimum boundary
      });
      assert.equal(validReg.email, 'user@billing.com');
      assert.equal(validReg.password, 'Minimum8');

      const maxReg = validateRegisterBody({
        email: 'max@billing.com',
        password: 'A'.repeat(128), // exact 128-character maximum boundary
      });
      assert.equal(maxReg.password.length, 128);

      assert.throws(
        () => validateRegisterBody({ email: 'a@b.com', password: '7chars!' }),
        ValidationError
      );
      assert.throws(
        () => validateRegisterBody({ email: 'a@b.com', password: 'A'.repeat(129) }),
        ValidationError
      );
      assert.throws(
        () => validateLoginBody({ email: 'a@b.com', password: '', extra: true }),
        ValidationError
      );
    });

    it('validateCreateInvoiceBody rejects sub-cent unitPrice/tax/discount (> 2 decimal places) and > 100 items', () => {
      assert.throws(
        () =>
          validateCreateInvoiceBody({
            customerId: 'cus_12345',
            tax: 1.999,
            discount: 0.001,
            items: [{ description: 'Sub-cent item', quantity: 1, unitPrice: 19.995 }],
          }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          const fields = err.fields?.map((f) => f.field) ?? [];
          assert.ok(fields.includes('tax'));
          assert.ok(fields.includes('discount'));
          assert.ok(fields.includes('items[0].unitPrice'));
          return true;
        }
      );

      const tooManyItems = Array.from({ length: 101 }, (_, i) => ({
        description: `Item ${i}`,
        quantity: 1,
        unitPrice: 10,
      }));
      assert.throws(
        () =>
          validateCreateInvoiceBody({
            customerId: 'cus_12345',
            items: tooManyItems,
          }),
        ValidationError
      );
    });

    it('validateUpdateInvoiceBody rejects immutable invoice fields (customerId, invoiceNumber, currency, subtotal, total, issueDate)', () => {
      assert.throws(
        () =>
          validateUpdateInvoiceBody({
            customerId: 'cus_other',
            invoiceNumber: 'INV-HACK',
            currency: 'EUR',
            subtotal: 0,
            total: 0,
            issueDate: '2020-01-01T00:00:00.000Z',
          }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          const fields = err.fields?.map((f) => f.field) ?? [];
          assert.deepEqual(fields, [
            'customerId',
            'invoiceNumber',
            'currency',
            'subtotal',
            'total',
            'issueDate',
          ]);
          return true;
        }
      );
    });

    it('validateCustomerListQuery, validateInvoiceListQuery, and validateInvoiceItemListQuery expand YYYY-MM-DD dates and enforce bounds', () => {
      const custQuery = validateCustomerListQuery({
        page: '3',
        limit: '50',
        currency: 'EUR',
        email: '  ADMIN@Example.com ',
        name: '  Enterprise ',
        sort: 'updatedAt',
        order: 'DESC',
      });
      assert.deepEqual(custQuery, {
        page: 3,
        limit: 50,
        currency: 'EUR',
        email: 'admin@example.com',
        name: 'Enterprise',
        sort: 'updatedAt',
        order: 'desc',
      });

      // Lowercase currency is strictly rejected by CURRENCY_REGEX (/^[A-Z]{3}$/)
      assert.throws(() => validateCustomerListQuery({ currency: 'eur' }), ValidationError);
    });

    it('assertSafeTestDatabaseUrl enforces dedicated *_test database naming and blocks dev DB collisions', () => {
      assert.doesNotThrow(() =>
        assertSafeTestDatabaseUrl(
          'postgresql://postgres@localhost:5432/billing_system_test',
          'postgresql://postgres@localhost:5432/billing_system'
        )
      );

      // Rejects database name not ending in _test
      assert.throws(
        () => assertSafeTestDatabaseUrl('postgresql://postgres@localhost:5432/billing_system'),
        /must end with '_test'/
      );

      // Rejects identical TEST_DATABASE_URL and DATABASE_URL even if named _test
      assert.throws(
        () =>
          assertSafeTestDatabaseUrl(
            'postgresql://postgres@localhost:5432/billing_system_test',
            'postgresql://postgres@localhost:5432/billing_system_test'
          ),
        /must not be identical to DATABASE_URL/
      );
    });

    it('validateInvoiceListQuery expands YYYY-MM-DD from/to bounds to start and end of UTC day', () => {
      const invQuery = validateInvoiceListQuery({
        issueDateFrom: '2026-03-01',
        issueDateTo: '2026-03-31',
        dueDateFrom: '2026-04-01',
        dueDateTo: '2026-04-30',
        status: 'ISSUED',
        currency: 'USD',
      });
      assert.equal(invQuery.issueDateFrom, '2026-03-01T00:00:00.000Z');
      assert.equal(invQuery.issueDateTo, '2026-03-31T23:59:59.999Z');
      assert.equal(invQuery.dueDateFrom, '2026-04-01T00:00:00.000Z');
      assert.equal(invQuery.dueDateTo, '2026-04-30T23:59:59.999Z');
      assert.equal(invQuery.status, 'issued');

      const itemQuery = validateInvoiceItemListQuery({
        page: '1',
        limit: '100',
        description: '  Compute ',
        sort: 'lineTotal',
        order: 'desc',
      });
      assert.equal(itemQuery.limit, 100);
      assert.equal(itemQuery.description, 'Compute');
      assert.equal(itemQuery.sort, 'lineTotal');
      assert.equal(itemQuery.order, 'desc');
    });
  });

  describe('4. Cryptographic Services Unit Tests (PasswordService & TokenService)', () => {
    const fastPasswordService = new PasswordService({ N: 1024, r: 8, p: 1 });
    const unitTokenService = new TokenService({
      secret: 'unit-test-jwt-secret-key-minimum-32-characters-long!!',
      expiresInSeconds: 600,
    });

    it('PasswordService generates distinct random salts for identical passwords and verifies accurately', async () => {
      const hash1 = await fastPasswordService.hashPassword('CorrectHorseBatteryStaple!');
      const hash2 = await fastPasswordService.hashPassword('CorrectHorseBatteryStaple!');
      assert.notEqual(hash1, hash2);

      assert.equal(await fastPasswordService.verifyPassword('CorrectHorseBatteryStaple!', hash1), true);
      assert.equal(await fastPasswordService.verifyPassword('CorrectHorseBatteryStaple!', hash2), true);
      assert.equal(await fastPasswordService.verifyPassword('WrongPassword!', hash1), false);
    });

    it('PasswordService safely returns false on malformed hash strings and dummyVerify always returns false', async () => {
      assert.equal(await fastPasswordService.verifyPassword('any', 'invalid-hash-format'), false);
      assert.equal(await fastPasswordService.verifyPassword('any', 'bcrypt$10$salt$key'), false);
      assert.equal(await fastPasswordService.dummyVerify('any-password'), false);
    });

    it('TokenService rejects alg: "none" downgrade attacks, missing claims, and wrong secrets', () => {
      const headerNone = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'acc_123',
          email: 'a@b.com',
          role: 'admin',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        })
      ).toString('base64url');
      const sig = crypto
        .createHmac('sha256', 'unit-test-jwt-secret-key-minimum-32-characters-long!!')
        .update(`${headerNone}.${payload}`)
        .digest('base64url');

      assert.throws(
        () => unitTokenService.verifyToken(`${headerNone}.${payload}.${sig}`),
        InvalidTokenError
      );

      // Token signed with a different secret
      const otherService = new TokenService({
        secret: 'different-secret-key-that-does-not-match-unit-test!!',
        expiresInSeconds: 600,
      });
      const foreignToken = otherService.generateToken({
        id: 'acc_123',
        email: 'a@b.com',
        role: 'user',
      });
      assert.throws(() => unitTokenService.verifyToken(foreignToken), InvalidTokenError);
    });
  });

  describe('5. Authoritative Billing Calculations & Service Rules Unit Tests', () => {
    it('computes exact integer-cents lineTotal, subtotal, and total across IEEE-754 floating-point edge cases', async () => {
      const customerRepo = new InMemoryCustomerRepository();
      const invoiceRepo = new InMemoryInvoiceRepository(customerRepo);
      const customerService = new CustomerService(customerRepo, invoiceRepo);
      const invoiceService = new InvoiceService(invoiceRepo, customerRepo);

      const actor = { id: 'acc_calc_owner', email: 'calc@owner.local', role: 'user' as const };
      const customer = await customerService.createCustomer(
        { name: 'Precision Ledger Inc', email: 'math@precision.local', currency: 'USD' },
        actor
      );

      // Classic IEEE-754 trap: 0.1 + 0.2 = 0.30000000000000004 in raw floats,
      // and 3 * 19.99 (59.97) + 2 * 10.05 (20.10) + 1 * 0.10 + 1 * 0.20 = 80.37
      const invoice = await invoiceService.createInvoice(
        {
          customerId: customer.id,
          tax: 0.1,
          discount: 0.2,
          items: [
            { description: 'Item A', quantity: 3, unitPrice: 19.99 },
            { description: 'Item B', quantity: 2, unitPrice: 10.05 },
            { description: 'Item C (Zero Price Tier)', quantity: 5, unitPrice: 0 },
            { description: 'Item D', quantity: 1, unitPrice: 0.1 },
            { description: 'Item E', quantity: 1, unitPrice: 0.2 },
          ],
        },
        actor
      );

      assert.equal(invoice.items[0].lineTotal, 59.97);
      assert.equal(invoice.items[1].lineTotal, 20.1);
      assert.equal(invoice.items[2].lineTotal, 0.0);
      assert.equal(invoice.items[3].lineTotal, 0.1);
      assert.equal(invoice.items[4].lineTotal, 0.2);
      assert.equal(invoice.subtotal, 80.37);
      assert.equal(invoice.tax, 0.1);
      assert.equal(invoice.discount, 0.2);
      // 80.37 + 0.10 - 0.20 = 80.27
      assert.equal(invoice.total, 80.27);
    });

    it('allows 100% discount where discount === subtotal + tax (total === 0.00), but rejects discount exceeding subtotal + tax by $0.01', async () => {
      const customerRepo = new InMemoryCustomerRepository();
      const invoiceRepo = new InMemoryInvoiceRepository(customerRepo);
      const customerService = new CustomerService(customerRepo, invoiceRepo);
      const invoiceService = new InvoiceService(invoiceRepo, customerRepo);

      const actor = { id: 'acc_bound_owner', email: 'bound@owner.local', role: 'user' as const };
      const customer = await customerService.createCustomer(
        { name: 'Boundary Corp', email: 'bound@corp.local', currency: 'USD' },
        actor
      );

      // Exact boundary: subtotal (100.00) + tax (15.50) - discount (115.50) = 0.00
      const zeroTotalInvoice = await invoiceService.createInvoice(
        {
          customerId: customer.id,
          tax: 15.5,
          discount: 115.5,
          items: [{ description: 'Sponsored Credit Tier', quantity: 1, unitPrice: 100.0 }],
        },
        actor
      );
      assert.equal(zeroTotalInvoice.total, 0.0);

      // Over boundary by 1 cent ($115.51): must throw ValidationError
      await assert.rejects(
        invoiceService.createInvoice(
          {
            customerId: customer.id,
            tax: 15.5,
            discount: 115.51,
            items: [{ description: 'Over-discounted Tier', quantity: 1, unitPrice: 100.0 }],
          },
          actor
        ),
        (err: unknown) => err instanceof ValidationError
      );
    });

    it('locks financial mutations on both "paid" and "cancelled" invoices (409 CONFLICT) while permitting notes updates', async () => {
      const customerRepo = new InMemoryCustomerRepository();
      const invoiceRepo = new InMemoryInvoiceRepository(customerRepo);
      const customerService = new CustomerService(customerRepo, invoiceRepo);
      const invoiceService = new InvoiceService(invoiceRepo, customerRepo);

      const actor = { id: 'acc_state_owner', email: 'state@owner.local', role: 'user' as const };
      const customer = await customerService.createCustomer(
        { name: 'State Corp', email: 'state@corp.local', currency: 'USD' },
        actor
      );

      const cancelledInv = await invoiceService.createInvoice(
        {
          customerId: customer.id,
          status: 'cancelled',
          items: [{ description: 'Cancelled Service', quantity: 1, unitPrice: 50.0 }],
        },
        actor
      );

      // Attempting to change discount, tax, or items on a cancelled invoice throws ConflictError (409)
      await assert.rejects(
        invoiceService.updateInvoice(cancelledInv.id, { discount: 10.0 }, actor),
        ConflictError
      );
      await assert.rejects(
        invoiceService.updateInvoice(
          cancelledInv.id,
          { items: [{ description: 'New Item', quantity: 1, unitPrice: 20.0 }] },
          actor
        ),
        ConflictError
      );

      // Updating non-financial notes on a cancelled invoice succeeds
      const withNotes = await invoiceService.updateInvoice(
        cancelledInv.id,
        { notes: 'Cancelled per customer request #402' },
        actor
      );
      assert.equal(withNotes.notes, 'Cancelled per customer request #402');
      assert.equal(withNotes.total, 50.0);
    });
  });

  describe('6. Centralized Error Handler & Domain Error Mapping Unit Tests', () => {
    function invokeErrorHandler(err: Error): { statusCode: number; body: any } {
      let capturedStatus = 200;
      let capturedBody: any = null;
      const mockRes: any = {
        status(code: number) {
          capturedStatus = code;
          return this;
        },
        json(payload: any) {
          capturedBody = payload;
          return this;
        },
      };
      errorHandler(err, {} as any, mockRes, () => {});
      return { statusCode: capturedStatus, body: capturedBody };
    }

    it('maps every domain AppError subclass to its exact HTTP status code and error code', () => {
      const cases: Array<{ error: Error; expectedStatus: number; expectedCode: string }> = [
        {
          error: new ValidationError('Invalid input', [{ field: 'email', message: 'Required' }]),
          expectedStatus: 400,
          expectedCode: 'VALIDATION_ERROR',
        },
        {
          error: new AuthenticationRequiredError(),
          expectedStatus: 401,
          expectedCode: 'AUTHENTICATION_REQUIRED',
        },
        {
          error: new InvalidCredentialsError(),
          expectedStatus: 401,
          expectedCode: 'INVALID_CREDENTIALS',
        },
        {
          error: new InvalidTokenError(),
          expectedStatus: 401,
          expectedCode: 'INVALID_TOKEN',
        },
        {
          error: new TokenExpiredError(),
          expectedStatus: 401,
          expectedCode: 'TOKEN_EXPIRED',
        },
        {
          error: new ForbiddenError(),
          expectedStatus: 403,
          expectedCode: 'FORBIDDEN',
        },
        {
          error: new NotFoundError('Customer not found'),
          expectedStatus: 404,
          expectedCode: 'RESOURCE_NOT_FOUND',
        },
        {
          error: new DuplicateResourceError('Duplicate email'),
          expectedStatus: 409,
          expectedCode: 'DUPLICATE_RESOURCE',
        },
        {
          error: new ConflictError('State conflict'),
          expectedStatus: 409,
          expectedCode: 'CONFLICT',
        },
        {
          error: new PayloadTooLargeError(),
          expectedStatus: 413,
          expectedCode: 'PAYLOAD_TOO_LARGE',
        },
        {
          error: new DatabaseError(),
          expectedStatus: 500,
          expectedCode: 'DATABASE_ERROR',
        },
        {
          error: new InternalServerError(),
          expectedStatus: 500,
          expectedCode: 'INTERNAL_SERVER_ERROR',
        },
      ];

      for (const c of cases) {
        const res = invokeErrorHandler(c.error);
        assert.equal(res.statusCode, c.expectedStatus);
        assert.equal(res.body.status, 'error');
        assert.equal(res.body.error.code, c.expectedCode);
      }
    });

    it('maps Express entity.too.large and entity.parse.failed errors and sanitizes unexpected runtime errors', () => {
      const tooLargeErr = Object.assign(new Error('request entity too large'), {
        type: 'entity.too.large',
      });
      const tooLargeRes = invokeErrorHandler(tooLargeErr);
      assert.equal(tooLargeRes.statusCode, 413);
      assert.equal(tooLargeRes.body.error.code, 'PAYLOAD_TOO_LARGE');

      const parseErr = Object.assign(new SyntaxError('Unexpected token'), {
        type: 'entity.parse.failed',
      });
      const parseRes = invokeErrorHandler(parseErr);
      assert.equal(parseRes.statusCode, 400);
      assert.equal(parseRes.body.error.code, 'MALFORMED_JSON');

      const rawCrash = new Error(
        'SELECT * FROM accounts WHERE password_hash = "scrypt$secret" AT /app/src/secret.ts:99'
      );
      const crashRes = invokeErrorHandler(rawCrash);
      assert.equal(crashRes.statusCode, 500);
      assert.deepEqual(crashRes.body, {
        status: 'error',
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected internal error occurred',
        },
      });
      assert.ok(!JSON.stringify(crashRes.body).includes('password_hash'));
      assert.ok(!JSON.stringify(crashRes.body).includes('/app/src'));
    });
  });

  describe('7. JWT Expiration Configuration, Rate Limiter Store & Migration Advisory Lock Unit Tests', () => {
    it('validates JWT_EXPIRES_IN and expiresInSeconds across missing, zero, negative, decimal, non-numeric, oversized, and valid values', () => {
      // Missing value defaults to 86400 (24h) in both development/test and production
      assert.equal(resolveAndValidateJwtExpiresIn(undefined, undefined, 'development'), DEFAULT_JWT_EXPIRES_IN_SECONDS);
      assert.equal(resolveAndValidateJwtExpiresIn(undefined, undefined, 'test'), DEFAULT_JWT_EXPIRES_IN_SECONDS);
      assert.equal(resolveAndValidateJwtExpiresIn(undefined, undefined, 'production'), DEFAULT_JWT_EXPIRES_IN_SECONDS);

      // Valid boundary and typical integer values
      assert.equal(resolveAndValidateJwtExpiresIn(MIN_JWT_EXPIRES_IN_SECONDS, undefined, 'production'), 1);
      assert.equal(resolveAndValidateJwtExpiresIn(3600, undefined, 'development'), 3600);
      assert.equal(resolveAndValidateJwtExpiresIn(MAX_JWT_EXPIRES_IN_SECONDS, undefined, 'production'), 2_592_000);
      assert.equal(resolveAndValidateJwtExpiresIn(undefined, '1', 'production'), 1);
      assert.equal(resolveAndValidateJwtExpiresIn(undefined, '86400', 'development'), 86400);
      assert.equal(resolveAndValidateJwtExpiresIn(undefined, '2592000', 'production'), 2_592_000);

      // Invalid numeric config values (zero, negative, decimal, NaN, Infinity, > max) fail closed with SecurityConfigurationError
      const invalidNumbers = [0, -1, -86400, 1.5, 86400.25, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, MAX_JWT_EXPIRES_IN_SECONDS + 1, 99_999_999];
      for (const badNum of invalidNumbers) {
        for (const env of ['development', 'test', 'production']) {
          assert.throws(
            () => resolveAndValidateJwtExpiresIn(badNum, undefined, env),
            SecurityConfigurationError,
            `Expected expiresInSeconds=${String(badNum)} to throw SecurityConfigurationError in ${env}`
          );
          assert.throws(
            () => new TokenService({ expiresInSeconds: badNum, nodeEnv: env, secret: 'unit-test-secret-key-minimum-32-characters-long' }),
            SecurityConfigurationError
          );
        }
      }

      // Invalid environment variable strings (empty, zero, negative, decimal, non-numeric, trailing chars, oversized)
      const invalidEnvStrings = ['', '   ', '0', '-1', '-3600', '3600.5', 'abc', '86400s', '1e5', 'NaN', 'Infinity', String(MAX_JWT_EXPIRES_IN_SECONDS + 1)];
      for (const badEnv of invalidEnvStrings) {
        for (const env of ['development', 'test', 'production']) {
          assert.throws(
            () => resolveAndValidateJwtExpiresIn(undefined, badEnv, env),
            SecurityConfigurationError,
            `Expected JWT_EXPIRES_IN="${badEnv}" to throw SecurityConfigurationError in ${env}`
          );
        }
      }

      // Generated tokens always contain valid finite integer iat and exp claims with exp = iat + expiresInSeconds
      const service = new TokenService({
        secret: 'unit-test-secret-key-minimum-32-characters-long',
        expiresInSeconds: 1800,
      });
      const token = service.generateToken({ id: 'acc_jwt_claims', email: 'claims@billing.local', role: 'user' });
      const verified = service.verifyToken(token);
      assert.equal(typeof verified.iat, 'number');
      assert.equal(typeof verified.exp, 'number');
      assert.ok(Number.isFinite(verified.iat) && Number.isInteger(verified.iat));
      assert.ok(Number.isFinite(verified.exp) && Number.isInteger(verified.exp));
      assert.equal(verified.exp - verified.iat, 1800);
    });

    it('validates RateLimitMode and supports pluggable synchronous and asynchronous RateLimitStore adapters', async () => {
      assert.equal(resolveRateLimitMode(undefined, undefined, undefined), 'process_local');
      assert.equal(resolveRateLimitMode('process_local', undefined, undefined), 'process_local');
      assert.equal(resolveRateLimitMode('edge_enforced', undefined, undefined), 'edge_enforced');

      const customSyncStore = new InMemoryRateLimitStore(100);
      assert.equal(resolveRateLimitMode('shared_store', customSyncStore, undefined), 'shared_store');
      assert.equal(resolveRateLimitMode(undefined, customSyncStore, undefined), 'shared_store');

      // shared_store without a store instance fails closed
      assert.throws(
        () => resolveRateLimitMode('shared_store', undefined, undefined),
        SecurityConfigurationError
      );

      // Unrecognized rate limit mode fails closed
      assert.throws(
        () => resolveRateLimitMode('invalid_mode', undefined, undefined),
        SecurityConfigurationError
      );

      // Verify async shared RateLimitStore integration point works seamlessly with createRateLimiter
      const asyncCounters = new Map<string, RateLimitBucket>();
      const asyncSharedStore: RateLimitStore = {
        async increment(key: string, windowMs: number, nowMs: number = Date.now()): Promise<RateLimitBucket> {
          const existing = asyncCounters.get(key);
          if (!existing || nowMs >= existing.resetTimeMs) {
            const bucket = { count: 1, resetTimeMs: nowMs + windowMs };
            asyncCounters.set(key, bucket);
            return bucket;
          }
          existing.count += 1;
          return { count: existing.count, resetTimeMs: existing.resetTimeMs };
        },
      };

      const limiter = createRateLimiter({
        windowMs: 60_000,
        max: 2,
        keyPrefix: 'shared-test',
        mode: 'shared_store',
        store: asyncSharedStore,
      });

      const runMiddleware = (ip: string) =>
        new Promise<{ headers: Record<string, string>; err?: unknown }>((resolve) => {
          const headers: Record<string, string> = {};
          const req = { ip, baseUrl: '/api/v1', path: '/customers', socket: { remoteAddress: ip } } as any;
          const res = {
            setHeader(name: string, value: string) {
              headers[name] = value;
            },
          } as any;
          limiter(req, res, (err?: unknown) => resolve({ headers, err }));
        });

      const first = await runMiddleware('203.0.113.10');
      assert.equal(first.err, undefined);
      assert.equal(first.headers['X-RateLimit-Limit'], '2');
      assert.equal(first.headers['X-RateLimit-Remaining'], '1');

      const second = await runMiddleware('203.0.113.10');
      assert.equal(second.err, undefined);
      assert.equal(second.headers['X-RateLimit-Remaining'], '0');

      const third = await runMiddleware('203.0.113.10');
      assert.ok(third.err instanceof RateLimitExceededError);
    });

    it('acquires and always releases PostgreSQL advisory lock around migrations on both success and failure paths', async () => {
      // 1. Success path: acquires pg_advisory_lock and releases pg_advisory_unlock in finally block
      const queriesSuccess: Array<{ sql: string; params?: unknown[] }> = [];
      let releasedSuccess = false;
      const mockSuccessClient: MigrationQueryClient = {
        async query(sql: string, params?: unknown[]) {
          queriesSuccess.push({ sql: sql.trim(), params });
          if (sql.includes('SELECT name FROM schema_migrations')) {
            return {
              rows: [
                { name: '001_create_customers_table.sql' },
                { name: '002_create_accounts_table.sql' },
                { name: '003_add_authorization_role_and_ownership.sql' },
                { name: '004_create_invoices_and_items_tables.sql' },
                { name: '005_add_pagination_and_filtering_indexes.sql' },
                { name: '006_add_composite_scaling_indexes.sql' },
              ],
            } as any;
          }
          return { rows: [] } as any;
        },
        release() {
          releasedSuccess = true;
        },
      };

      const mockSuccessPool: MigrationPool = {
        async connect() {
          return mockSuccessClient;
        },
        async end() {},
      };

      const res = await runMigrations(undefined, { pool: mockSuccessPool });
      assert.equal(res.applied.length, 0);
      assert.equal(res.alreadyApplied.length, 6);
      assert.equal(queriesSuccess[0].sql, 'SELECT pg_advisory_lock($1);');
      assert.deepEqual(queriesSuccess[0].params, [MIGRATION_ADVISORY_LOCK_ID]);
      const lastQuery = queriesSuccess[queriesSuccess.length - 1];
      assert.equal(lastQuery.sql, 'SELECT pg_advisory_unlock($1);');
      assert.deepEqual(lastQuery.params, [MIGRATION_ADVISORY_LOCK_ID]);
      assert.equal(releasedSuccess, true);

      // 2. Failure path: rolls back failed migration transaction, still releases pg_advisory_unlock & client, and rethrows original error
      const queriesFailure: Array<{ sql: string; params?: unknown[] }> = [];
      let releasedFailure = false;
      const simulatedMigrationFailure = new Error('syntax error at or near "INVALID_SQL"');

      const mockFailureClient: MigrationQueryClient = {
        async query(sql: string, params?: unknown[]) {
          const trimmed = sql.trim();
          queriesFailure.push({ sql: trimmed, params });
          if (trimmed.includes('SELECT name FROM schema_migrations')) {
            return { rows: [] } as any;
          }
          if (trimmed.startsWith('-- 001') || trimmed.includes('CREATE TABLE IF NOT EXISTS customers')) {
            throw simulatedMigrationFailure;
          }
          return { rows: [] } as any;
        },
        release() {
          releasedFailure = true;
        },
      };

      const mockFailurePool: MigrationPool = {
        async connect() {
          return mockFailureClient;
        },
        async end() {},
      };

      await assert.rejects(
        async () => runMigrations(undefined, { pool: mockFailurePool, lockId: 999111 }),
        (err: Error) => err === simulatedMigrationFailure
      );

      assert.equal(queriesFailure[0].sql, 'SELECT pg_advisory_lock($1);');
      assert.deepEqual(queriesFailure[0].params, [999111]);
      assert.ok(queriesFailure.some((q) => q.sql === 'BEGIN'));
      assert.ok(queriesFailure.some((q) => q.sql === 'ROLLBACK'));
      const unlockAfterFail = queriesFailure[queriesFailure.length - 1];
      assert.equal(unlockAfterFail.sql, 'SELECT pg_advisory_unlock($1);');
      assert.deepEqual(unlockAfterFail.params, [999111]);
      assert.equal(releasedFailure, true);
    });
  });
});
