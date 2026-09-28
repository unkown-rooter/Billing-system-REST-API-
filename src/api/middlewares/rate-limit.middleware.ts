import { Request, Response, NextFunction, RequestHandler } from 'express';
import { RateLimitExceededError, SecurityConfigurationError } from '../services/errors.js';

/**
 * Request Rate Limiting Middleware & Production Global Limiter Integration (Phase 9 / Phase 13)
 *
 * Threat Mitigated:
 * - Credential stuffing and brute-force password guessing against POST /api/v1/auth/login
 * - Automated account-creation floods against POST /api/v1/auth/register
 * - High-frequency request floods / resource exhaustion against API endpoints
 *
 * IMPORTANT — Multi-Instance Deployment Scope:
 * - The default `InMemoryRateLimitStore` is **process-local** (scoped to a single Node.js
 *   process) and is **NOT a global rate limiter** across multi-instance horizontal deployments.
 *   Across `N` container instances behind a load balancer, a client IP can issue up to
 *   `N * max` requests per window unless global enforcement is configured.
 * - Includes automatic expired-bucket eviction and a hard cap on tracked keys
 *   (`MAX_TRACKED_KEYS = 10,000`) to prevent per-process memory exhaustion from spoofed keys.
 *
 * Production Global Enforcement Integration Points:
 * 1. Edge / API Gateway Enforcement (`RATE_LIMIT_MODE=edge_enforced`):
 *    Recommended for Google Cloud Run deployments behind Google Cloud Armor, Cloud API Gateway,
 *    or an upstream WAF/CDN that enforces global rate limits at the network edge while this
 *    middleware provides a per-instance safety ceiling.
 * 2. Pluggable Shared Store (`RATE_LIMIT_MODE=shared_store` + `RateLimitStore`):
 *    Inject a shared `RateLimitStore` implementation (e.g., Redis / Cloud Memorystore / PostgreSQL
 *    adapter) via `RateLimitOptions.store` or `AppDependencies.rateLimitStore` for strict global
 *    counting across all instances without introducing an external dependency for local dev/tests.
 */

export type RateLimitMode = 'process_local' | 'edge_enforced' | 'shared_store';

const VALID_RATE_LIMIT_MODES = new Set<RateLimitMode>([
  'process_local',
  'edge_enforced',
  'shared_store',
]);

export interface RateLimitBucket {
  count: number;
  resetTimeMs: number;
}

/**
 * Production-safe extension point for synchronous (in-memory) or asynchronous
 * (Redis, Cloud Memorystore, PostgreSQL) rate-limit state stores.
 */
export interface RateLimitStore {
  increment(
    key: string,
    windowMs: number,
    nowMs?: number
  ): RateLimitBucket | Promise<RateLimitBucket>;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  keyPrefix?: string;
  keyGenerator?: (req: Request) => string;
  store?: RateLimitStore;
  mode?: RateLimitMode;
}

export const MAX_TRACKED_KEYS = 10_000;

/**
 * Resolves and validates the configured rate-limiting enforcement mode.
 * Fails closed with `SecurityConfigurationError` if an unrecognized mode is configured
 * or if `shared_store` mode is selected without providing a shared `RateLimitStore`.
 */
export function resolveRateLimitMode(
  configuredMode?: string,
  store?: RateLimitStore,
  envMode: string | undefined = process.env.RATE_LIMIT_MODE
): RateLimitMode {
  const rawMode = configuredMode ?? envMode;
  if (rawMode === undefined || rawMode.trim() === '') {
    return store ? 'shared_store' : 'process_local';
  }

  const normalized = rawMode.trim().toLowerCase() as RateLimitMode;
  if (!VALID_RATE_LIMIT_MODES.has(normalized)) {
    throw new SecurityConfigurationError(
      `Invalid RATE_LIMIT_MODE '${rawMode}': must be one of 'process_local', 'edge_enforced', or 'shared_store'`
    );
  }

  if (normalized === 'shared_store' && !store) {
    throw new SecurityConfigurationError(
      'Rate limit configuration error: RATE_LIMIT_MODE="shared_store" requires a shared RateLimitStore instance'
    );
  }

  return normalized;
}

/**
 * Default bounded process-local rate limit store for local development, automated tests,
 * and per-instance fallback protection.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly store = new Map<string, RateLimitBucket>();
  private readonly maxTrackedKeys: number;

  constructor(maxTrackedKeys: number = MAX_TRACKED_KEYS) {
    this.maxTrackedKeys = Math.max(10, maxTrackedKeys);
  }

  private evictExpired(now: number): void {
    for (const [key, bucket] of this.store.entries()) {
      if (now >= bucket.resetTimeMs) {
        this.store.delete(key);
      }
    }
    if (this.store.size >= this.maxTrackedKeys) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
  }

  increment(key: string, windowMs: number, nowMs: number = Date.now()): RateLimitBucket {
    if (this.store.size >= this.maxTrackedKeys / 2) {
      this.evictExpired(nowMs);
    }

    let bucket = this.store.get(key);
    if (!bucket || nowMs >= bucket.resetTimeMs) {
      bucket = {
        count: 0,
        resetTimeMs: nowMs + windowMs,
      };
      this.store.set(key, bucket);
    }

    bucket.count += 1;
    return {
      count: bucket.count,
      resetTimeMs: bucket.resetTimeMs,
    };
  }

  size(): number {
    return this.store.size;
  }
}

function applyBucketDecision(
  res: Response,
  next: NextFunction,
  bucket: RateLimitBucket,
  max: number,
  now: number,
  message: string
): void {
  const remaining = Math.max(0, max - bucket.count);
  const resetSeconds = Math.ceil(bucket.resetTimeMs / 1000);
  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetTimeMs - now) / 1000));

  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(resetSeconds));

  if (bucket.count > max) {
    next(new RateLimitExceededError(message, retryAfterSeconds));
    return;
  }

  next();
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const windowMs = Math.max(100, options.windowMs);
  const max = Math.max(1, options.max);
  const keyPrefix = options.keyPrefix ?? 'rl';
  const message =
    options.message ?? 'Too many requests from this client. Please wait before retrying';

  // Validate mode and initialize backing store (custom shared store or process-local default)
  resolveRateLimitMode(options.mode, options.store);
  const backingStore: RateLimitStore = options.store ?? new InMemoryRateLimitStore();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    try {
      const now = Date.now();
      const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
      const customKey = options.keyGenerator
        ? options.keyGenerator(req)
        : `${clientIp}:${req.baseUrl}${req.path}`;
      const bucketKey = `${keyPrefix}:${customKey}`;

      const result = backingStore.increment(bucketKey, windowMs, now);
      if (result instanceof Promise) {
        result
          .then((bucket) => {
            applyBucketDecision(res, next, bucket, max, now, message);
          })
          .catch(next);
        return;
      }

      applyBucketDecision(res, next, result, max, now, message);
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Creates a stricter rate limiter specifically for authentication endpoints
 * (POST /api/v1/auth/login and POST /api/v1/auth/register).
 */
export function createAuthRateLimiter(overrides?: Partial<RateLimitOptions>): RequestHandler {
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
    store: overrides?.store,
    mode: overrides?.mode,
  });
}

/**
 * Creates a general API rate limiter for /api/v1/* endpoints to guard against
 * high-rate automated floods while permitting normal authenticated API traffic.
 */
export function createApiRateLimiter(overrides?: Partial<RateLimitOptions>): RequestHandler {
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
    store: overrides?.store,
    mode: overrides?.mode,
  });
}
