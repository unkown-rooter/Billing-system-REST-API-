import { Router, RequestHandler } from 'express';
import { CustomerController } from '../controllers/customer.controller.js';
import { InvoiceController } from '../controllers/invoice.controller.js';
import { HealthController } from '../controllers/health.controller.js';
import { AuthController } from '../controllers/auth.controller.js';
import { AuthenticateMiddleware, createAuthMiddleware } from '../middlewares/auth.middleware.js';
import { TokenService } from '../services/token.service.js';
import { createCustomerRouter } from './customer.routes.js';
import { createInvoiceRouter } from './invoice.routes.js';
import { createHealthRouter } from './health.routes.js';
import { createAuthRouter } from './auth.routes.js';

export interface V1RouterDependencies {
  customerController: CustomerController;
  invoiceController?: InvoiceController;
  healthController?: HealthController;
  authController?: AuthController;
  authenticate: AuthenticateMiddleware;
  authRateLimiter?: RequestHandler;
}

export function createV1Router(
  customerControllerOrDeps: CustomerController | V1RouterDependencies,
  healthController?: HealthController,
  authController?: AuthController,
  authenticate?: AuthenticateMiddleware
): Router {
  const router = Router();

  let customerCtrl: CustomerController;
  let invoiceCtrl: InvoiceController | undefined;
  let healthCtrl: HealthController | undefined;
  let authCtrl: AuthController | undefined;
  let authMiddleware: AuthenticateMiddleware;
  let authRateLimiter: RequestHandler | undefined;

  if (
    customerControllerOrDeps &&
    typeof customerControllerOrDeps === 'object' &&
    'customerController' in customerControllerOrDeps
  ) {
    customerCtrl = customerControllerOrDeps.customerController;
    invoiceCtrl = customerControllerOrDeps.invoiceController;
    healthCtrl = customerControllerOrDeps.healthController;
    authCtrl = customerControllerOrDeps.authController;
    authMiddleware = customerControllerOrDeps.authenticate;
    authRateLimiter = customerControllerOrDeps.authRateLimiter;
  } else {
    customerCtrl = customerControllerOrDeps as CustomerController;
    healthCtrl = healthController;
    authCtrl = authController;
    authMiddleware = authenticate || createAuthMiddleware(new TokenService());
  }

  router.use(createHealthRouter(healthCtrl));
  router.use('/customers', createCustomerRouter(customerCtrl, authMiddleware, invoiceCtrl));

  if (invoiceCtrl) {
    router.use('/invoices', createInvoiceRouter(invoiceCtrl, authMiddleware));
  }

  if (authCtrl) {
    router.use('/auth', createAuthRouter(authCtrl, authMiddleware, authRateLimiter));
  }

  return router;
}
