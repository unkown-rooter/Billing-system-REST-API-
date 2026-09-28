import express, { Express, Request, Response } from 'express';
import { errorHandler } from './middlewares/error-handler.middleware.js';
import { requestLogger } from './middlewares/request-logger.middleware.js';
import {
  createSecurityHeadersMiddleware,
  SecurityHeadersOptions,
} from './middlewares/security-headers.middleware.js';
import {
  createCorsMiddleware,
  CorsPolicyOptions,
} from './middlewares/cors.middleware.js';
import {
  createAuthRateLimiter,
  createApiRateLimiter,
  RateLimitOptions,
  RateLimitStore,
} from './middlewares/rate-limit.middleware.js';
import { ICustomerRepository } from './repositories/customer.repository.interface.js';
import { PostgresCustomerRepository } from './repositories/postgres-customer.repository.js';
import { InMemoryCustomerRepository } from './repositories/in-memory-customer.repository.js';
import { IAccountRepository } from './repositories/account.repository.interface.js';
import { PostgresAccountRepository } from './repositories/postgres-account.repository.js';
import { InMemoryAccountRepository } from './repositories/in-memory-account.repository.js';
import { IInvoiceRepository } from './repositories/invoice.repository.interface.js';
import { PostgresInvoiceRepository } from './repositories/postgres-invoice.repository.js';
import { InMemoryInvoiceRepository } from './repositories/in-memory-invoice.repository.js';
import { getPool, assertSafeProductionDatabaseCredentials } from './db/pool.js';
import { CustomerService } from './services/customer.service.js';
import { CustomerController } from './controllers/customer.controller.js';
import { InvoiceService } from './services/invoice.service.js';
import { InvoiceController } from './controllers/invoice.controller.js';
import { HealthController } from './controllers/health.controller.js';
import { PasswordService } from './services/password.service.js';
import { TokenService } from './services/token.service.js';
import { AuthService } from './services/auth.service.js';
import { AuthController } from './controllers/auth.controller.js';
import { createAuthMiddleware } from './middlewares/auth.middleware.js';
import { createV1Router } from './routes/index.js';
import { SecurityConfigurationError } from './services/errors.js';
import { logger } from './observability/logger.js';
import { redactSensitiveUrl, stripControlChars } from './security/redaction.js';

export interface AppDependencies {
  customerRepository?: ICustomerRepository;
  accountRepository?: IAccountRepository;
  invoiceRepository?: IInvoiceRepository;
  healthController?: HealthController;
  authController?: AuthController;
  authService?: AuthService;
  passwordService?: PasswordService;
  tokenService?: TokenService;
  protectCustomerDelete?: boolean;
  securityHeadersOptions?: SecurityHeadersOptions;
  corsOptions?: CorsPolicyOptions;
  authRateLimitOptions?: Partial<RateLimitOptions>;
  apiRateLimitOptions?: Partial<RateLimitOptions>;
  rateLimitStore?: RateLimitStore;
}

export function createApp(deps: AppDependencies = {}): Express {
  const app = express();

  // 1. Reverse Proxy & Security Hardening
  app.disable('x-powered-by');
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.TRUST_PROXY === 'true' ||
    process.env.TRUST_PROXY === '1'
  ) {
    app.set('trust proxy', 1);
  }
  app.use(createSecurityHeadersMiddleware(deps.securityHeadersOptions));
  app.use(createCorsMiddleware(deps.corsOptions));

  // 2. Global Middleware (Request Correlation Logger & Bounded JSON Parser)
  app.use(requestLogger);
  app.use(express.json({ limit: '100kb', strict: false }));

  // 3. Dependency Wiring (Inversion of Control)
  const isPostgres = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0);
  if (process.env.NODE_ENV === 'production' && !deps.customerRepository) {
    if (!isPostgres) {
      throw new SecurityConfigurationError(
        'Production security error: DATABASE_URL environment variable must be explicitly set in production'
      );
    }
    assertSafeProductionDatabaseCredentials(process.env.DATABASE_URL!);
  }

  // Customer & Invoice Relational Persistence
  const customerRepo =
    deps.customerRepository ||
    (isPostgres ? new PostgresCustomerRepository(getPool()) : new InMemoryCustomerRepository());

  const invoiceRepo =
    deps.invoiceRepository ||
    (customerRepo instanceof InMemoryCustomerRepository
      ? new InMemoryInvoiceRepository(customerRepo)
      : isPostgres
        ? new PostgresInvoiceRepository(getPool())
        : new InMemoryInvoiceRepository(customerRepo));

  const customerService = new CustomerService(customerRepo, invoiceRepo);
  const customerController = new CustomerController(customerService);

  const invoiceService = new InvoiceService(invoiceRepo, customerRepo);
  const invoiceController = new InvoiceController(invoiceService);

  // Authentication & Identity Wiring
  const accountRepo =
    deps.accountRepository ||
    (isPostgres ? new PostgresAccountRepository(getPool()) : new InMemoryAccountRepository());
  const passwordService = deps.passwordService || new PasswordService();
  const tokenService = deps.tokenService || new TokenService();
  const authService = deps.authService || new AuthService(accountRepo, passwordService, tokenService);
  const authController = deps.authController || new AuthController(authService);
  const authenticate = createAuthMiddleware(tokenService);

  // Rate Limiters (Brute-Force Auth Limiter + General API Flood Limiter)
  const authRateLimiter = createAuthRateLimiter({
    ...(deps.rateLimitStore ? { store: deps.rateLimitStore } : {}),
    ...deps.authRateLimitOptions,
  });
  const apiRateLimiter = createApiRateLimiter({
    ...(deps.rateLimitStore ? { store: deps.rateLimitStore } : {}),
    ...deps.apiRateLimitOptions,
  });

  // Health Diagnostics
  const healthController =
    deps.healthController ||
    (customerRepo instanceof InMemoryCustomerRepository
      ? new HealthController(async () => true)
      : new HealthController());

  // 4. API Versioning Router: /api/v1
  const v1Router = createV1Router({
    customerController,
    invoiceController,
    healthController,
    authController,
    authenticate,
    authRateLimiter,
  });
  app.use('/api/v1', apiRateLimiter, v1Router);

  // 5. API 404 Handler for undefined API routes
  app.all(['/api', '/api/*'], (req: Request, res: Response) => {
    const safeMethod = stripControlChars(req.method || 'GET');
    const safePath = redactSensitiveUrl(req.originalUrl || req.url || '/api');
    logger.warn('route_not_found', `Endpoint ${safeMethod} ${safePath} not found`, {
      requestId: req.requestId,
      errorCode: 'ROUTE_NOT_FOUND',
      statusCode: 404,
      method: safeMethod,
      path: safePath,
    });
    res.status(404).json({
      status: 'error',
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `Endpoint ${req.method} ${req.originalUrl} not found`,
        ...(req.requestId ? { requestId: req.requestId } : {}),
      },
    });
  });

  // 6. Global Error Handling Middleware (must be registered last)
  app.use(errorHandler);

  return app;
}
