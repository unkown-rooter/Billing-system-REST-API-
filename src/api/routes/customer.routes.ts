import { Router } from 'express';
import { CustomerController } from '../controllers/customer.controller.js';
import {
  validateCreateCustomer,
  validateUpdateCustomer,
  validateCustomerId,
} from '../middlewares/validation.middleware.js';

export function createCustomerRouter(customerController: CustomerController): Router {
  const router = Router();

  router.post('/', validateCreateCustomer, customerController.create);
  router.get('/', customerController.getAll);
  router.get('/:id', validateCustomerId, customerController.getById);
  router.patch('/:id', validateCustomerId, validateUpdateCustomer, customerController.update);
  router.delete('/:id', validateCustomerId, customerController.delete);

  return router;
}
