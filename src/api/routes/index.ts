import { Router } from 'express';
import { CustomerController } from '../controllers/customer.controller.js';
import { HealthController } from '../controllers/health.controller.js';
import { createCustomerRouter } from './customer.routes.js';
import { createHealthRouter } from './health.routes.js';

export function createV1Router(
  customerController: CustomerController,
  healthController?: HealthController
): Router {
  const router = Router();

  router.use(createHealthRouter(healthController));
  router.use('/customers', createCustomerRouter(customerController));

  return router;
}
