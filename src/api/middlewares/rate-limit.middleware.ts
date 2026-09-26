import { Request, Response, NextFunction } from 'express';
import { RateLimitExceededError } from '../services/errors.js';

/**
 * Process-Local Request Rate Limiting Middleware (Phase 9)
 *
 * Threat Mitigated:
 * - Credential stuffing and brute-force password guessing against POST /api/v1/auth/login
 * - Automated account-creation floods against POST /api/v1/auth/register
 * - High-frequency request floods / resource exhaustion against API endpoints
 *
 * Architectural Note:
 * - Uses a bounded in-memory sliding/fixed window store per Node.js process.
 * - Includes automatic expired-bucket eviction and a hard cap on tracked keys
 *   (MAX_TRACKED_KEYS = 10,000) to prevent memory exhaustion from spoofed client keys.
 * - For multi-instance horizontal deployments (Phase 13), this should be paired with
 *   an edge/reverse-proxy limiter or shared store.
 */

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  keyPrefix?: string;
  keyGenerator?: (req: Request) => string;
}

interface RateLimitBucket {
  count: number;
  resetTimeMs: number;
}

const MAX_TRACKED_KEYS = 10_000;

export function createRateLimiter(options: RateLimitOptions) {
  const windowMs = Math.max(100, options.windowMs);
  const max = Math.max(1, options.max);
  const keyPrefix = options.keyPrefix ?? 'rl';
  const message =
    options.message ?? 'Too many requests from this client. Please wait before retrying';

  const store = new Map<string, RateLimitBucket>();

  function evictExpired(now: number): void {
    for (const [key, bucket] of store.entries()) {
      if (now >= bucket.resetTimeMs) {
        store.delete(key);
      }
    }
    // If store still exceeds MAX_TRACKED_KEYS, evict oldest inserted entry
    if (store.size >= MAX_TRACKED_KEYS) {
      const oldestKey = store.keys().next().value;
      if (oldestKey !== undefined) {
        store.delete(oldestKey);
      }
    }
  }

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    try {
      const now = Date.now();

      if (store.size >= MAX_TRACKED_KEYS / 2) {
        evictExpired(now);
      }

      const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
      const customKey = options.keyGenerator
        ? options.keyGenerator(req)
        : `${clientIp}:${req.baseUrl}${req.path}`;
      const bucketKey = `${keyPrefix}:${customKey}`;

      let bucket = store.get(bucketKey);
      if (!bucket || now >= bucket.resetTimeMs) {
        bucket = {
          count: 0,
          resetTimeMs: now + windowMs,
        };
        store.set(bucketKey, bucket);
      }

      bucket.count += 1;

      const remaining = Math.max(0, max - bucket.count);
      const resetSeconds = Math.ceil(bucket.resetTimeMs / 1000);
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetTimeMs - now) / 1000));

      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(resetSeconds));

      if (bucket.count > max) {
        throw new RateLimitExceededError(message, retryAfterSeconds);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Creates a stricter rate limiter specifically for authentication endpoints
 * (POST /api/v1/auth/login and POST /api/v1/auth/register).
 */
export function createAuthRateLimiter(overrides?: Partial<RateLimitOptions>) {
  const envWindow = process.env.AUTH_RATE_LIMIT_WINDOW_MS
    ? parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 10)
    : undefined;
  const envMax = process.env.AUTH_RATE_LIMIT_MAX
    ? parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10)
    : undefined;

  return createRateLimiter({
    windowMs:
      overrides?.windowMs ??
      (envWindow && Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 60_000),
    max:
      overrides?.max ??
      (envMax && Number.isFinite(envMax) && envMax > 0 ? envMax : 30),
    keyPrefix: overrides?.keyPrefix ?? 'auth',
    message:
      overrides?.message ??
      'Too many authentication attempts. Please wait before trying again',
    keyGenerator: overrides?.keyGenerator,
  });
}

/**
 * Creates a general API rate limiter for /api/v1/* endpoints to guard against
 * high-rate automated floods while permitting normal authenticated API traffic.
 */
export function createApiRateLimiter(overrides?: Partial<RateLimitOptions>) {
  const envWindow = process.env.API_RATE_LIMIT_WINDOW_MS
    ? parseInt(process.env.API_RATE_LIMIT_WINDOW_MS, 10)
    : undefined;
  const envMax = process.env.API_RATE_LIMIT_MAX
    ? parseInt(process.env.API_RATE_LIMIT_MAX, 10)
    : undefined;

  return createRateLimiter({
    windowMs:
      overrides?.windowMs ??
      (envWindow && Number.isFinite(envWindow) && envWindow > 0 ? envWindow : 60_000),
    max:
      overrides?.max ??
      (envMax && Number.isFinite(envMax) && envMax > 0 ? envMax : 300),
    keyPrefix: overrides?.keyPrefix ?? 'api',
    message:
      overrides?.message ??
      'API rate limit exceeded. Please slow down request frequency',
    keyGenerator:
      overrides?.keyGenerator ??
      ((req: Request) => req.ip || req.socket?.remoteAddress || 'unknown'),
  });
}
