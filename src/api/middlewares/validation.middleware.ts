import { Request, Response, NextFunction } from 'express';
import {
  validateCreateCustomerBody,
  validateUpdateCustomerBody,
  validateCustomerIdParam,
} from '../validation/customer.schema.js';
import {
  validateRegisterBody,
  validateLoginBody,
} from '../validation/auth.schema.js';
import {
  validateCreateInvoiceBody,
  validateUpdateInvoiceBody,
  validateInvoiceIdParam,
} from '../validation/invoice.schema.js';
import {
  validateCustomerListQuery,
  validateInvoiceListQuery,
  validateInvoiceItemListQuery,
} from '../validation/query.schema.js';
import { ValidationError } from '../services/errors.js';

/**
 * Middleware: Validates customer creation request body.
 * Sanitizes and normalizes valid input directly on req.body.
 */
export function validateCreateCustomer(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    req.body = validateCreateCustomerBody(req.body);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: Validates customer update request body.
 * Rejects empty payloads, unknown fields, and immutable fields.
 */
export function validateUpdateCustomer(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    req.body = validateUpdateCustomerBody(req.body);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: Validates :id route parameter format.
 * Rejects malformed IDs that do not match the 'cus_' pattern before reaching controllers.
 */
export function validateCustomerId(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    req.params.id = validateCustomerIdParam(req.params.id);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: Validates top-level invoice creation body (POST /api/v1/invoices).
 */
export function validateCreateInvoice(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    req.body = validateCreateInvoiceBody(req.body, { requireCustomerId: true });
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: Validates nested customer invoice creation body (POST /api/v1/customers/:id/invoices).
 */
export function validateCreateCustomerInvoice(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    const dto = validateCreateInvoiceBody(req.body, { requireCustomerId: false });
    if (dto.customerId && dto.customerId !== req.params.id) {
      throw new ValidationError(
        `Body 'customerId' (${dto.customerId}) does not match URL customer ID (${req.params.id})`,
        [
          {
            field: 'customerId',
            message: 'Body customerId must match the customer ID in the URL path',
          },
        ]
      );
    }
    dto.customerId = req.params.id;
    req.body = dto;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: Validates invoice update request body (PATCH /api/v1/invoices/:id).
 */
export function validateUpdateInvoice(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    req.body = validateUpdateInvoiceBody(req.body);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: Validates :id route parameter format for invoices (inv_<string>).
 */
export function validateInvoiceId(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    req.params.id = validateInvoiceIdParam(req.params.id);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: Validates pagination, filtering, and sorting query parameters for GET /api/v1/customers.
 */
export function validateCustomerQuery(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    req.validatedCustomerQuery = validateCustomerListQuery(req.query);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: Validates pagination, filtering, and sorting query parameters for GET /api/v1/invoices.
 */
export function validateInvoiceQuery(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    req.validatedInvoiceQuery = validateInvoiceListQuery(req.query, { allowCustomerIdParam: true });
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: Validates pagination, filtering, and sorting query parameters for GET /api/v1/customers/:id/invoices.
 */
export function validateCustomerInvoiceQuery(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    req.validatedInvoiceQuery = validateInvoiceListQuery(req.query, { allowCustomerIdParam: false });
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: Validates pagination, filtering, and sorting query parameters for GET /api/v1/invoices/:id/items.
 */
export function validateInvoiceItemQuery(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    req.validatedInvoiceItemQuery = validateInvoiceItemListQuery(req.query);
    next();
  } catch (err) {
    next(err);
  }
}
