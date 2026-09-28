import { Request, Response, NextFunction } from 'express';
import {
  AppError,
  ValidationError,
  DatabaseError,
  ForbiddenError,
  MethodNotAllowedError,
  RateLimitExceededError,
} from '../services/errors.js';
import { redactSensitiveText, redactSensitiveUrl, stripControlChars } from '../security/redaction.js';
import { getCurrentRequestId } from '../observability/request-context.js';
import { logger } from '../observability/logger.js';
import { metricsCollector } from '../observability/metrics.js';

function attachRequestId<T extends Record<string, unknown>>(
  errorObj: T,
  requestId?: string
): T & { requestId?: string } {
  if (requestId) {
    return { ...errorObj, requestId };
  }
  return errorObj;
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req?.requestId || getCurrentRequestId();
  if (requestId && typeof res.getHeader === 'function' && !res.getHeader('X-Request-Id')) {
    res.setHeader('X-Request-Id', requestId);
  }

  const safeMethod = stripControlChars(req?.method || 'UNKNOWN');
  const safePath = redactSensitiveUrl(req?.originalUrl || req?.url || '/');

  // 1. Validation Errors (400) - Include field-level details if available
  if (err instanceof ValidationError) {
    logger.warn('request_validation_failed', err.message, {
      requestId,
      errorCode: err.code,
      statusCode: err.statusCode,
      method: safeMethod,
      path: safePath,
      fieldCount: err.fields?.length ?? 0,
    });

    const errorBody: Record<string, unknown> = {
      code: err.code,
      message: err.message,
    };
    if (err.fields && err.fields.length > 0) {
      errorBody.fields = err.fields;
    }
    res.status(err.statusCode).json({
      status: 'error',
      error: attachRequestId(errorBody, requestId),
    });
    return;
  }

  // 2. Method Not Allowed (405) - Include standard Allow header
  if (err instanceof MethodNotAllowedError) {
    logger.warn('method_not_allowed', err.message, {
      requestId,
      errorCode: err.code,
      statusCode: err.statusCode,
      method: safeMethod,
      path: safePath,
      allowedMethods: err.allowedMethods,
    });

    res.setHeader('Allow', err.allowedMethods.join(', '));
    res.status(err.statusCode).json({
      status: 'error',
      error: attachRequestId(
        {
          code: err.code,
          message: err.message,
        },
        requestId
      ),
    });
    return;
  }

  // 3. Rate Limit Exceeded (429) - Include standard Retry-After header
  if (err instanceof RateLimitExceededError) {
    metricsCollector.recordSecurityEvent('rateLimitExceeded');
    logger.warn('rate_limit_exceeded', err.message, {
      requestId,
      errorCode: err.code,
      statusCode: err.statusCode,
      retryAfterSeconds: err.retryAfterSeconds,
      method: safeMethod,
      path: safePath,
    });

    res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(err.statusCode).json({
      status: 'error',
      error: attachRequestId(
        {
          code: err.code,
          message: err.message,
        },
        requestId
      ),
    });
    return;
  }

  // 4. Database Errors (500) - Ensure sanitized message and code
  if (err instanceof DatabaseError) {
    logger.error('database_operational_error', err.message, {
      requestId,
      errorCode: err.code,
      statusCode: err.statusCode,
      method: safeMethod,
      path: safePath,
    });

    res.status(err.statusCode).json({
      status: 'error',
      error: attachRequestId(
        {
          code: err.code,
          message: err.message,
        },
        requestId
      ),
    });
    return;
  }

  // 5. Other Known Domain & Application Errors (401, 403, 404, 409, 413, 500)
  if (err instanceof AppError) {
    if (err instanceof ForbiddenError) {
      metricsCollector.recordSecurityEvent('authzForbidden');
      logger.warn('authz_forbidden', err.message, {
        requestId,
        errorCode: err.code,
        statusCode: err.statusCode,
        method: safeMethod,
        path: safePath,
        ...(req?.user ? { accountId: req.user.id, role: req.user.role } : {}),
      });
    } else if (err.statusCode >= 500) {
      logger.error('application_server_error', err.message, {
        requestId,
        errorCode: err.code,
        statusCode: err.statusCode,
        method: safeMethod,
        path: safePath,
      });
    } else {
      logger.warn('request_client_error', err.message, {
        requestId,
        errorCode: err.code,
        statusCode: err.statusCode,
        method: safeMethod,
        path: safePath,
      });
    }

    res.status(err.statusCode).json({
      status: 'error',
      error: attachRequestId(
        {
          code: err.code,
          message: err.message,
        },
        requestId
      ),
    });
    return;
  }

  // 6. Express Body Parser Malformed JSON Syntax Errors
  const isParseError =
    ('type' in err && (err as { type: string }).type === 'entity.parse.failed') ||
    (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400 && 'body' in err);

  if (isParseError) {
    logger.warn('malformed_json_payload', 'Invalid JSON payload received in request body', {
      requestId,
      errorCode: 'MALFORMED_JSON',
      statusCode: 400,
      method: safeMethod,
      path: safePath,
    });

    res.status(400).json({
      status: 'error',
      error: attachRequestId(
        {
          code: 'MALFORMED_JSON',
          message: 'Invalid JSON payload received in request body',
        },
        requestId
      ),
    });
    return;
  }

  // 7. Payload Too Large (Express Body Limit Exceeded)
  if ('type' in err && (err as { type: string }).type === 'entity.too.large') {
    logger.warn('payload_too_large', 'Request payload exceeds the permitted limit (100kb)', {
      requestId,
      errorCode: 'PAYLOAD_TOO_LARGE',
      statusCode: 413,
      method: safeMethod,
      path: safePath,
    });

    res.status(413).json({
      status: 'error',
      error: attachRequestId(
        {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request payload exceeds the permitted limit (100kb)',
        },
        requestId
      ),
    });
    return;
  }

  // 8. Unhandled Server Errors (500) - Redact sensitive tokens/credentials from server logs and never leak details in HTTP response
  const safeErrorLog = redactSensitiveText(err instanceof Error ? err.message : String(err));
  logger.error('unhandled_server_error', `[UNHANDLED ERROR] ${safeErrorLog}`, {
    requestId,
    errorCode: 'INTERNAL_SERVER_ERROR',
    statusCode: 500,
    errorName: err instanceof Error ? err.name : 'UnknownError',
    method: safeMethod,
    path: safePath,
  });

  res.status(500).json({
    status: 'error',
    error: attachRequestId(
      {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal error occurred',
      },
      requestId
    ),
  });
}
