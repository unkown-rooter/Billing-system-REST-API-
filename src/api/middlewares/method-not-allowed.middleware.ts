import { Request, Response, NextFunction } from 'express';
import { MethodNotAllowedError } from '../services/errors.js';

/**
 * HTTP Method Hardening Middleware (Phase 9)
 *
 * Rejects unsupported HTTP verbs (e.g. PUT, DELETE, TRACE, PATCH) on known route paths
 * with a deterministic 405 Method Not Allowed response and an RFC 9110 `Allow` header.
 */
export function methodNotAllowed(allowedMethods: string[]) {
  const normalizedAllowed = allowedMethods.map((m) => m.toUpperCase());

  return function handleMethodNotAllowed(req: Request, _res: Response, next: NextFunction): void {
    const cleanPath = (req.originalUrl || req.url).split('?')[0];
    next(new MethodNotAllowedError(req.method.toUpperCase(), cleanPath, normalizedAllowed));
  };
}
