import express, { Express, Request, Response } from 'express';
import { errorHandler } from './middlewares/error-handler.middleware.js';
import { requestLogger } from './middlewares/request-logger.middleware.js';
import { ICustomerRepository } from './repositories/customer.repository.interface.js';
import { PostgresCustomerRepository } from './repositories/postgres-customer.repository.js';
import { getPool } from './db/pool.js';
import { CustomerService } from './services/customer.service.js';
import { CustomerController } from './controllers/customer.controller.js';
import { HealthController } from './controllers/health.controller.js';
import { createV1Router } from './routes/index.js';

export interface AppDependencies {
  customerRepository?: ICustomerRepository;
  healthController?: HealthController;
}

export function createApp(deps: AppDependencies = {}): Express {
  const app = express();

  // 1. Security Hardening
  app.disable('x-powered-by');

  // 2. Global Middleware
  app.use(express.json({ limit: '100kb', strict: false }));
  app.use(requestLogger);

  // 3. Dependency Wiring (Inversion of Control)
  // Production default: PostgresCustomerRepository backed by the PostgreSQL connection pool.
  const customerRepo = deps.customerRepository || new PostgresCustomerRepository(getPool());
  const customerService = new CustomerService(customerRepo);
  const customerController = new CustomerController(customerService);
  const healthController = deps.healthController || new HealthController();

  // 4. API Versioning Router: /api/v1
  const v1Router = createV1Router(customerController, healthController);
  app.use('/api/v1', v1Router);

  // 5. API 404 Handler for undefined API routes
  app.all(['/api', '/api/*'], (req: Request, res: Response) => {
    res.status(404).json({
      status: 'error',
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `Endpoint ${req.method} ${req.originalUrl} not found`,
      },
    });
  });

  // 6. Global Error Handling Middleware (must be registered last)
  app.use(errorHandler);

  return app;
}
