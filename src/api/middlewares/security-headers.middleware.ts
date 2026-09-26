import { Request, Response, NextFunction } from 'express';

/**
 * HTTP Security Headers Middleware (Phase 9)
 *
 * Applies defensive HTTP response headers tailored to a JSON REST API:
 * - X-Content-Type-Options: nosniff -> Prevents MIME-sniffing responses away from application/json.
 * - X-Frame-Options: DENY -> Prevents embedding API responses in <frame>/<iframe> (clickjacking).
 * - Referrer-Policy: no-referrer -> Prevents browser clients from leaking resource URLs in Referer headers.
 * - Permissions-Policy -> Disables sensitive browser hardware features.
 * - Content-Security-Policy (on /api routes) -> default-src 'none'; frame-ancestors 'none'.
 * - Cache-Control (on /api routes) -> no-store (prevents shared proxies/caches from storing tokens or billing records).
 * - Strict-Transport-Security (HSTS) -> Enabled ONLY when NODE_ENV === 'production' or explicitly configured,
 *   avoiding broken local HTTP development workflows.
 */

export interface SecurityHeadersOptions {
  enableHsts?: boolean;
  hstsMaxAgeSeconds?: number;
}

export function createSecurityHeadersMiddleware(options: SecurityHeadersOptions = {}) {
  const enableHsts =
    options.enableHsts !== undefined
      ? options.enableHsts
      : process.env.NODE_ENV === 'production' || process.env.ENABLE_HSTS === 'true';
  const hstsMaxAge = options.hstsMaxAgeSeconds ?? 31_536_000; // 1 year

  return function securityHeaders(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

    // Apply strict non-executable CSP and anti-caching headers to all API endpoints
    if (req.path.startsWith('/api') || req.originalUrl.startsWith('/api')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
    }

    // Only emit Strict-Transport-Security when HTTPS production assumptions hold
    if (enableHsts) {
      res.setHeader('Strict-Transport-Security', `max-age=${hstsMaxAge}; includeSubDomains`);
    }

    next();
  };
}
