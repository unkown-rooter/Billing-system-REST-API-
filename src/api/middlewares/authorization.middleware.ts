import { Request, Response, NextFunction } from 'express';
import { AccountRole, isValidAccountRole } from '../models/account.model.js';
import { AuthenticationRequiredError, ForbiddenError } from '../services/errors.js';

export interface AuthorizeMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
}

/**
 * Creates role-based authorization middleware.
 * 
 * Architectural Separation:
 * - Authentication (`authenticate` middleware) runs first and answers: "WHO is making the request?"
 *   by establishing `req.user` (401 Unauthorized on failure).
 * - Authorization (`authorize` middleware) runs second and answers: "IS this identity allowed to invoke this route?"
 *   by checking `req.user.role` against the required roles (403 Forbidden on failure).
 * - Contains zero business logic and zero SQL queries.
 */
export function authorize(...allowedRoles: AccountRole[]): AuthorizeMiddleware {
  const roleSet = new Set<AccountRole>(allowedRoles);

  return function authorizeMiddleware(req: Request, _res: Response, next: NextFunction): void {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication is required');
      }

      if (!isValidAccountRole(req.user.role) || !roleSet.has(req.user.role)) {
        throw new ForbiddenError('You are not authorized to perform this action');
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
