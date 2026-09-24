import { Request, Response, NextFunction } from 'express';
import {
  validateCreateCustomerBody,
  validateUpdateCustomerBody,
  validateCustomerIdParam,
} from '../validation/customer.schema.js';

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
