import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Request Correlation Context (Phase 12)
 *
 * Propagates a safe, unique `requestId` across asynchronous boundaries
 * (Middleware -> Controller -> Service -> Repository -> Database Pool -> Error Handler)
 * without requiring every internal method signature to be rewritten.
 */

export interface RequestCorrelationContext {
  requestId: string;
  method: string;
  path: string;
  startTimeMs: number;
}

const SAFE_REQUEST_ID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

const requestContextStorage = new AsyncLocalStorage<RequestCorrelationContext>();

/**
 * Validates an incoming `X-Request-Id` header or generates a collision-resistant
 * server-side `req_<uuidv4>` correlation ID.
 * Rejects control characters, whitespace, or oversized strings to prevent header/log injection.
 */
export function resolveSafeRequestId(incomingHeader?: string | string[]): string {
  const candidate = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (SAFE_REQUEST_ID_REGEX.test(trimmed)) {
      return trimmed;
    }
  }
  return `req_${randomUUID()}`;
}

export function runWithRequestContext<T>(
  context: RequestCorrelationContext,
  fn: () => T
): T {
  return requestContextStorage.run(context, fn);
}

export function getRequestContext(): RequestCorrelationContext | undefined {
  return requestContextStorage.getStore();
}

export function getCurrentRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
