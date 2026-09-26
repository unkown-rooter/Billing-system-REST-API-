import { Request, Response, NextFunction } from 'express';

/**
 * Explicit Cross-Origin Resource Sharing (CORS) Policy Middleware (Phase 9)
 *
 * Security Posture:
 * - Restrictive by default: when CORS_ALLOWED_ORIGINS is unset or empty, no cross-origin
 *   access headers are emitted (same-origin / server-to-server API posture).
 * - Explicit Origin Whitelist: only origins explicitly listed in CORS_ALLOWED_ORIGINS
 *   (or injected via options.allowedOrigins) receive Access-Control-Allow-Origin.
 * - Never reflects arbitrary untrusted Origin headers.
 * - Never combines wildcard '*' with Access-Control-Allow-Credentials: true.
 */

export interface CorsPolicyOptions {
  allowedOrigins?: string[];
  allowCredentials?: boolean;
}

export function parseAllowedOrigins(rawOrigins?: string | string[]): Set<string> {
  if (!rawOrigins) {
    return new Set();
  }
  const list = Array.isArray(rawOrigins) ? rawOrigins : rawOrigins.split(',');
  const normalized = list
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== '*'); // Never allow wildcard '*' in explicit whitelist
  return new Set(normalized);
}

export function createCorsMiddleware(options: CorsPolicyOptions = {}) {
  const allowedSet = parseAllowedOrigins(
    options.allowedOrigins ?? process.env.CORS_ALLOWED_ORIGINS
  );
  const allowCredentials = options.allowCredentials ?? false;

  return function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const requestOrigin = req.headers.origin;

    // Always advertise that responses vary by Origin when CORS is evaluated
    res.vary('Origin');

    if (requestOrigin && typeof requestOrigin === 'string' && allowedSet.has(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');

      if (allowCredentials) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    } else if (req.method === 'OPTIONS' && requestOrigin) {
      // Preflight from an unapproved cross-origin: do not grant CORS headers; end with 204/403 safely
      res.status(204).end();
      return;
    }

    next();
  };
}
