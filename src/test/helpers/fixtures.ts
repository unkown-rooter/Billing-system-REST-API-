import { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../api/app.js';
import { Account, AccountRole } from '../../api/models/account.model.js';
import { Customer, CreateCustomerDTO } from '../../api/models/customer.model.js';
import { CreateInvoiceDTO, Invoice, InvoiceItem } from '../../api/models/invoice.model.js';
import { InMemoryAccountRepository } from '../../api/repositories/in-memory-account.repository.js';
import { InMemoryCustomerRepository } from '../../api/repositories/in-memory-customer.repository.js';
import { InMemoryInvoiceRepository } from '../../api/repositories/in-memory-invoice.repository.js';
import { PasswordService } from '../../api/services/password.service.js';
import { TokenService } from '../../api/services/token.service.js';
import { AuthService } from '../../api/services/auth.service.js';

/**
 * Controlled Test Fixtures & Harness Factory (Phase 8)
 * 
 * Ensures every test suite creates isolated, deterministic test records
 * inside its own repository/database scope without shared mutable state
 * or production database contamination.
 */

export const TEST_JWT_SECRET = 'phase-8-quality-engineering-test-secret-key-min-32-chars!';

/**
 * Verifies that a test database connection string is strictly isolated from the
 * development/production database before any destructive test setup (e.g. TRUNCATE) runs.
 */
export function assertSafeTestDatabaseUrl(testDatabaseUrl: string, devDatabaseUrl?: string): void {
  if (!testDatabaseUrl || typeof testDatabaseUrl !== 'string') {
    throw new Error('Test isolation violation: TEST_DATABASE_URL must be a non-empty string.');
  }

  let parsedTestUrl: URL;
  try {
    parsedTestUrl = new URL(testDatabaseUrl);
  } catch {
    throw new Error(`Test isolation violation: Invalid TEST_DATABASE_URL format: ${testDatabaseUrl}`);
  }

  const dbName = parsedTestUrl.pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Test isolation violation: Test database name '${dbName}' must end with '_test' to prevent corrupting development data.`
    );
  }

  if (devDatabaseUrl && testDatabaseUrl.trim() === devDatabaseUrl.trim()) {
    throw new Error(
      'Test isolation violation: TEST_DATABASE_URL must not be identical to DATABASE_URL.'
    );
  }
}

export function buildAccountFixture(overrides: Partial<Account> = {}): Account {
  const id = overrides.id ?? `acc_${randomUUID()}`;
  const now = new Date().toISOString();
  return {
    id,
    email: overrides.email ?? `user_${id.slice(4, 12)}@test-billing.local`,
    passwordHash:
      overrides.passwordHash ??
      'scrypt$N=16384,r=8,p=1$00112233445566778899aabbccddeeff$' + 'a'.repeat(128),
    role: overrides.role ?? 'user',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

export function buildCustomerDtoFixture(
  overrides: Partial<CreateCustomerDTO> = {}
): CreateCustomerDTO {
  const suffix = randomUUID().slice(0, 8);
  return {
    name: overrides.name ?? `Test Corp ${suffix}`,
    email: overrides.email ?? `billing_${suffix}@test-corp.local`,
    currency: overrides.currency ?? 'USD',
  };
}

export function buildCustomerEntityFixture(overrides: Partial<Customer> = {}): Customer {
  const id = overrides.id ?? `cus_${randomUUID()}`;
  const now = new Date().toISOString();
  return {
    id,
    accountId: overrides.accountId ?? `acc_${randomUUID()}`,
    name: overrides.name ?? 'Fixture Enterprise LLC',
    email: overrides.email ?? `ap_${id.slice(4, 12)}@fixture.local`,
    currency: overrides.currency ?? 'USD',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

export function buildInvoiceDtoFixture(
  customerId: string,
  overrides: Partial<CreateInvoiceDTO> = {}
): CreateInvoiceDTO {
  return {
    customerId,
    currency: overrides.currency ?? 'USD',
    status: overrides.status ?? 'draft',
    tax: overrides.tax ?? 0,
    discount: overrides.discount ?? 0,
    issueDate: overrides.issueDate ?? '2026-05-01T00:00:00.000Z',
    dueDate: overrides.dueDate ?? '2026-05-31T00:00:00.000Z',
    notes: overrides.notes ?? 'Controlled test fixture invoice',
    items: overrides.items ?? [
      {
        description: 'Platform Core Subscription',
        quantity: 2,
        unitPrice: 150.0,
      },
    ],
  };
}

export function buildInvoiceEntityFixture(overrides: Partial<Invoice> = {}): Invoice {
  const id = overrides.id ?? `inv_${randomUUID()}`;
  const customerId = overrides.customerId ?? `cus_${randomUUID()}`;
  const now = new Date().toISOString();
  const defaultItem: InvoiceItem = {
    id: `item_0001_${randomUUID()}`,
    invoiceId: id,
    description: 'Standard Compute Unit',
    quantity: 2,
    unitPrice: 50.0,
    lineTotal: 100.0,
    createdAt: now,
    updatedAt: now,
  };

  return {
    id,
    customerId,
    invoiceNumber: overrides.invoiceNumber ?? `INV-2026-0001-${id.slice(4, 8).toUpperCase()}`,
    status: overrides.status ?? 'draft',
    currency: overrides.currency ?? 'USD',
    subtotal: overrides.subtotal ?? 100.0,
    tax: overrides.tax ?? 10.0,
    discount: overrides.discount ?? 5.0,
    total: overrides.total ?? 105.0,
    issueDate: overrides.issueDate ?? '2026-05-01T00:00:00.000Z',
    dueDate: overrides.dueDate ?? '2026-05-31T00:00:00.000Z',
    notes: overrides.notes !== undefined ? overrides.notes : null,
    items: overrides.items ?? [defaultItem],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

export interface TestHttpHarness {
  server: Server;
  baseUrl: string;
  accountRepo: InMemoryAccountRepository;
  customerRepo: InMemoryCustomerRepository;
  invoiceRepo: InMemoryInvoiceRepository;
  passwordService: PasswordService;
  tokenService: TokenService;
  authService: AuthService;
  issueTokenForRole: (role: AccountRole, email?: string) => Promise<{ account: Account; token: string }>;
  close: () => Promise<void>;
}

export async function createIsolatedHttpHarness(): Promise<TestHttpHarness> {
  const accountRepo = new InMemoryAccountRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const invoiceRepo = new InMemoryInvoiceRepository(customerRepo);
  // Use fast scrypt cost (N=1024) in isolated harness helpers while testing production N=16384 in crypto unit tests
  const passwordService = new PasswordService({ N: 1024, r: 8, p: 1 });
  const tokenService = new TokenService({
    secret: TEST_JWT_SECRET,
    expiresInSeconds: 3600,
  });
  const authService = new AuthService(accountRepo, passwordService, tokenService);

  const app = createApp({
    accountRepository: accountRepo,
    customerRepository: customerRepo,
    invoiceRepository: invoiceRepo,
    passwordService,
    tokenService,
    authService,
  });

  let server!: Server;
  let baseUrl = '';

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        baseUrl = `http://127.0.0.1:${address.port}`;
      }
      resolve();
    });
  });

  const issueTokenForRole = async (
    role: AccountRole,
    email?: string
  ): Promise<{ account: Account; token: string }> => {
    const account = buildAccountFixture({
      role,
      email: email ?? `${role}_${randomUUID().slice(0, 8)}@test-billing.local`,
    });
    await accountRepo.create(account);
    const token = tokenService.generateToken({
      id: account.id,
      email: account.email,
      role: account.role,
    });
    return { account, token };
  };

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    server,
    baseUrl,
    accountRepo,
    customerRepo,
    invoiceRepo,
    passwordService,
    tokenService,
    authService,
    issueTokenForRole,
    close,
  };
}
