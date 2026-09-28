/**
 * Lightweight, Bounded In-Memory Request Metrics Collector (Phase 12)
 *
 * Tracks operational request counts, HTTP status distributions, security event counters,
 * and latency aggregates by low-cardinality route templates.
 *
 * Cardinality Safety Guarantee:
 * - Dynamic entity identifiers (`cus_...`, `inv_...`, `acc_...`, `item_...`, UUIDs, numeric IDs)
 *   are normalized to `:id` before indexing.
 * - Unrecognized 404 paths are collapsed into `<METHOD> /api/unmatched` so random path scans
 *   can never exhaust memory.
 * - Route buckets are hard-capped at `MAX_ROUTE_BUCKETS = 100`.
 */

export interface RouteMetricSummary {
  count: number;
  errorCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
}

export interface SecurityEventCounters {
  authLoginSuccess: number;
  authLoginFailure: number;
  authTokenInvalid: number;
  authTokenExpired: number;
  authzForbidden: number;
  rateLimitExceeded: number;
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  totalRequests: number;
  totalErrors: number;
  clientErrors4xx: number;
  serverErrors5xx: number;
  statusClasses: {
    '2xx': number;
    '3xx': number;
    '4xx': number;
    '5xx': number;
  };
  statusCodes: Record<string, number>;
  securityEvents: SecurityEventCounters;
  routes: Record<string, RouteMetricSummary>;
}

const MAX_ROUTE_BUCKETS = 100;

const KNOWN_NORMALIZED_PATHS = new Set([
  '/api/v1/health',
  '/api/v1/health/live',
  '/api/v1/health/ready',
  '/api/v1/metrics',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/me',
  '/api/v1/customers',
  '/api/v1/customers/:id',
  '/api/v1/customers/:id/invoices',
  '/api/v1/invoices',
  '/api/v1/invoices/:id',
  '/api/v1/invoices/:id/items',
]);

/**
 * Normalizes a request URL into a low-cardinality route pattern.
 * Never retains raw customer IDs, invoice IDs, account IDs, or query strings.
 */
export function normalizeRouteMetricKey(method: string, rawUrl: string, statusCode?: number): string {
  const safeMethod = (method || 'GET').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) || 'GET';
  const pathOnly = (rawUrl || '/').split('?')[0].replace(/\/+$/, '') || '/';

  // Replace domain-prefixed IDs, UUIDs, and numeric/malformed path segments on known prefixes
  const normalizedPath = pathOnly
    .replace(/^(\/api\/v1\/customers\/)[^/]+(\/invoices)$/, '$1:id$2')
    .replace(/^(\/api\/v1\/customers\/)[^/]+$/, '$1:id')
    .replace(/^(\/api\/v1\/invoices\/)[^/]+(\/items)$/, '$1:id$2')
    .replace(/^(\/api\/v1\/invoices\/)[^/]+$/, '$1:id')
    .replace(/\/(?:cus|inv|acc|item)_[a-zA-Z0-9_-]+/g, '/:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');

  if (KNOWN_NORMALIZED_PATHS.has(normalizedPath)) {
    return `${safeMethod} ${normalizedPath}`;
  }

  if (statusCode === 404 || normalizedPath.startsWith('/api')) {
    return `${safeMethod} /api/unmatched`;
  }

  return `${safeMethod} /static`;
}

class MetricsCollector {
  private totalRequests = 0;
  private totalErrors = 0;
  private clientErrors4xx = 0;
  private serverErrors5xx = 0;
  private statusClasses = {
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
  };
  private statusCodes = new Map<string, number>();
  private securityEvents: SecurityEventCounters = {
    authLoginSuccess: 0,
    authLoginFailure: 0,
    authTokenInvalid: 0,
    authTokenExpired: 0,
    authzForbidden: 0,
    rateLimitExceeded: 0,
  };
  private routes = new Map<
    string,
    { count: number; errorCount: number; totalDurationMs: number; maxDurationMs: number }
  >();

  recordRequest(method: string, rawUrl: string, statusCode: number, durationMs: number): string {
    const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    const routeKey = normalizeRouteMetricKey(method, rawUrl, statusCode);

    this.totalRequests += 1;

    if (statusCode >= 200 && statusCode < 300) {
      this.statusClasses['2xx'] += 1;
    } else if (statusCode >= 300 && statusCode < 400) {
      this.statusClasses['3xx'] += 1;
    } else if (statusCode >= 400 && statusCode < 500) {
      this.statusClasses['4xx'] += 1;
      this.clientErrors4xx += 1;
      this.totalErrors += 1;
    } else if (statusCode >= 500) {
      this.statusClasses['5xx'] += 1;
      this.serverErrors5xx += 1;
      this.totalErrors += 1;
    }

    const codeStr = String(statusCode);
    this.statusCodes.set(codeStr, (this.statusCodes.get(codeStr) ?? 0) + 1);

    let bucket = this.routes.get(routeKey);
    if (!bucket) {
      if (this.routes.size >= MAX_ROUTE_BUCKETS) {
        const oldestKey = this.routes.keys().next().value;
        if (oldestKey !== undefined) {
          this.routes.delete(oldestKey);
        }
      }
      bucket = { count: 0, errorCount: 0, totalDurationMs: 0, maxDurationMs: 0 };
      this.routes.set(routeKey, bucket);
    }

    bucket.count += 1;
    if (statusCode >= 400) {
      bucket.errorCount += 1;
    }
    bucket.totalDurationMs += safeDuration;
    if (safeDuration > bucket.maxDurationMs) {
      bucket.maxDurationMs = safeDuration;
    }

    return routeKey;
  }

  recordSecurityEvent(event: keyof SecurityEventCounters): void {
    this.securityEvents[event] += 1;
  }

  getSnapshot(): MetricsSnapshot {
    const routeSummaries: Record<string, RouteMetricSummary> = {};
    for (const [key, b] of this.routes.entries()) {
      routeSummaries[key] = {
        count: b.count,
        errorCount: b.errorCount,
        totalDurationMs: Math.round(b.totalDurationMs * 100) / 100,
        avgDurationMs: b.count > 0 ? Math.round((b.totalDurationMs / b.count) * 100) / 100 : 0,
        maxDurationMs: Math.round(b.maxDurationMs * 100) / 100,
      };
    }

    const statusCodesObj: Record<string, number> = {};
    for (const [code, count] of this.statusCodes.entries()) {
      statusCodesObj[code] = count;
    }

    return {
      uptimeSeconds: Math.round(process.uptime() * 100) / 100,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      clientErrors4xx: this.clientErrors4xx,
      serverErrors5xx: this.serverErrors5xx,
      statusClasses: { ...this.statusClasses },
      statusCodes: statusCodesObj,
      securityEvents: { ...this.securityEvents },
      routes: routeSummaries,
    };
  }

  reset(): void {
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.clientErrors4xx = 0;
    this.serverErrors5xx = 0;
    this.statusClasses = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    this.statusCodes.clear();
    this.securityEvents = {
      authLoginSuccess: 0,
      authLoginFailure: 0,
      authTokenInvalid: 0,
      authTokenExpired: 0,
      authzForbidden: 0,
      rateLimitExceeded: 0,
    };
    this.routes.clear();
  }
}

export const metricsCollector = new MetricsCollector();
