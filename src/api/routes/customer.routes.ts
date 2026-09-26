import { Router } from 'express';
import { CustomerController } from '../controllers/customer.controller.js';
import { InvoiceController } from '../controllers/invoice.controller.js';
import { AuthenticateMiddleware } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/authorization.middleware.js';
import { methodNotAllowed } from '../middlewares/method-not-allowed.middleware.js';
import {
  validateCreateCustomer,
  validateUpdateCustomer,
  validateCustomerId,
  validateCreateCustomerInvoice,
  validateCustomerQuery,
  validateCustomerInvoiceQuery,
} from '../middlewares/validation.middleware.js';

/**
 * Customer Routes (/api/v1/customers)
 * 
 * Request Pipeline Order:
 * 1. `authenticate`: Verifies JWT Bearer token and attaches `req.user` (401 on failure)
 * 2. `authorize(...)`: Verifies `req.user.role` against route policy (403 on failure)
 * 3. `validate*`: Validates path parameters and JSON request body (400 on failure)
 * 4. `customerController.*` -> `customerService.*`: Enforces resource ownership (403 on IDOR)
 *    and executes domain persistence (200 / 201 / 204 / 404 / 409).
 */
export function createCustomerRouter(
  customerController: CustomerController,
  authenticate: AuthenticateMiddleware,
  invoiceController?: InvoiceController
): Router {
  const router = Router();

  router.post(
    '/',
    authenticate,
    authorize('user', 'admin'),
    validateCreateCustomer,
    customerController.create
  );

  router.get(
    '/',
    authenticate,
    authorize('user', 'admin'),
    validateCustomerQuery,
    customerController.getAll
  );

  router.get(
    '/:id',
    authenticate,
    authorize('user', 'admin'),
    validateCustomerId,
    customerController.getById
  );

  router.patch(
    '/:id',
    authenticate,
    authorize('user', 'admin'),
    validateCustomerId,
    validateUpdateCustomer,
    customerController.update
  );

  // Destructive ledger deletion is restricted strictly to 'admin' accounts
  router.delete(
    '/:id',
    authenticate,
    authorize('admin'),
    validateCustomerId,
    customerController.delete
  );

  // Nested Customer → Invoice relational routes
  if (invoiceController) {
    router.post(
      '/:id/invoices',
      authenticate,
      authorize('user', 'admin'),
      validateCustomerId,
      validateCreateCustomerInvoice,
      invoiceController.createForCustomer
    );

    router.get(
      '/:id/invoices',
      authenticate,
      authorize('user', 'admin'),
      validateCustomerId,
      validateCustomerInvoiceQuery,
      invoiceController.getByCustomerId
    );

    router.all('/:id/invoices', methodNotAllowed(['GET', 'POST']));
  }

  router.all('/', methodNotAllowed(['GET', 'POST']));
  router.all('/:id', methodNotAllowed(['GET', 'PATCH', 'DELETE']));

  return router;
}
