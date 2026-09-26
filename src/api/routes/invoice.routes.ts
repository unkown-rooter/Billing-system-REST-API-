import { Router } from 'express';
import { InvoiceController } from '../controllers/invoice.controller.js';
import { AuthenticateMiddleware } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/authorization.middleware.js';
import { methodNotAllowed } from '../middlewares/method-not-allowed.middleware.js';
import {
  validateCreateInvoice,
  validateUpdateInvoice,
  validateInvoiceId,
  validateInvoiceQuery,
  validateInvoiceItemQuery,
} from '../middlewares/validation.middleware.js';

/**
 * Invoice Routes (/api/v1/invoices)
 * 
 * Request Pipeline Order:
 * 1. `authenticate`: Verifies JWT Bearer token and attaches `req.user` (401 on failure)
 * 2. `authorize(...)`: Verifies `req.user.role` against route policy (403 on failure)
 * 3. `validate*`: Validates path parameters (`inv_...`) and JSON request body (400 on failure)
 * 4. `invoiceController.*` -> `invoiceService.*`: Enforces relational existence (404),
 *    parent customer ownership (403 on IDOR), authoritative totals math, and persistence.
 */
export function createInvoiceRouter(
  invoiceController: InvoiceController,
  authenticate: AuthenticateMiddleware
): Router {
  const router = Router();

  router.post(
    '/',
    authenticate,
    authorize('user', 'admin'),
    validateCreateInvoice,
    invoiceController.create
  );

  router.get(
    '/',
    authenticate,
    authorize('user', 'admin'),
    validateInvoiceQuery,
    invoiceController.getAll
  );

  router.get(
    '/:id',
    authenticate,
    authorize('user', 'admin'),
    validateInvoiceId,
    invoiceController.getById
  );

  router.get(
    '/:id/items',
    authenticate,
    authorize('user', 'admin'),
    validateInvoiceId,
    validateInvoiceItemQuery,
    invoiceController.getItemsByInvoiceId
  );

  router.patch(
    '/:id',
    authenticate,
    authorize('user', 'admin'),
    validateInvoiceId,
    validateUpdateInvoice,
    invoiceController.update
  );

  // Destructive invoice deletion is restricted strictly to 'admin' accounts
  router.delete(
    '/:id',
    authenticate,
    authorize('admin'),
    validateInvoiceId,
    invoiceController.delete
  );

  router.all('/', methodNotAllowed(['GET', 'POST']));
  router.all('/:id', methodNotAllowed(['GET', 'PATCH', 'DELETE']));
  router.all('/:id/items', methodNotAllowed(['GET']));

  return router;
}
