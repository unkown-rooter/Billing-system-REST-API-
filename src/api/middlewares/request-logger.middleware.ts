import { Request, Response, NextFunction } from 'express';
import { redactSensitiveUrl, stripControlChars } from '../security/redaction.js';
import {
  resolveSafeRequestId,
  runWithRequestContext,
} from '../observability/request-context.js';
import { logger } from '../observability/logger.js';
import { metricsCollector } from '../observability/metrics.js';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTimeMs = Date.now();
  const safeMethod = stripControlChars(req.method || 'GET');
  const safeUrl = redactSensitiveUrl(req.originalUrl || req.url || '/');
  const requestId = resolveSafeRequestId(req.headers['x-request-id']);

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const durationMs = Math.max(0, Date.now() - startTimeMs);
    const status = res.statusCode;

    metricsCollector.recordRequest(safeMethod, safeUrl, status, durationMs);

    const logMeta: Record<string, unknown> = {
      requestId,
      method: safeMethod,
      path: safeUrl,
      status,
      durationMs,
      ...(req.user?.id ? { accountId: req.user.id, role: req.user.role } : {}),
    };

    const message = `${safeMethod} ${safeUrl} ${status} (${durationMs}ms)`;

    if (status >= 500) {
      logger.error('http_request', message, logMeta);
    } else if (status >= 400) {
      logger.warn('http_request', message, logMeta);
    } else {
      logger.info('http_request', message, logMeta);
    }
  });

  runWithRequestContext(
    {
      requestId,
      method: safeMethod,
      path: safeUrl,
      startTimeMs,
    },
    () => {
      next();
    }
  );
}
