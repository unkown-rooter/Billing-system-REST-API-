import { Request, Response, NextFunction } from 'express';
import {
  AppError,
  ValidationError,
  DatabaseError,
  MethodNotAllowedError,
  RateLimitExceededError,
} from '../services/errors.js';
import { redactSensitiveText } from '../security/redaction.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // 1. Validation Errors (400) - Include field-level details if available
  if (err instanceof ValidationError) {
    const errorBody: Record<string, unknown> = {
      code: err.code,
      message: err.message,
    };
    if (err.fields && err.fields.length > 0) {
      errorBody.fields = err.fields;
    }
    res.status(err.statusCode).json({
      status: 'error',
      error: errorBody,
    });
    return;
  }

  // 2. Method Not Allowed (405) - Include standard Allow header
  if (err instanceof MethodNotAllowedError) {
    res.setHeader('Allow', err.allowedMethods.join(', '));
    res.status(err.statusCode).json({
      status: 'error',
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // 3. Rate Limit Exceeded (429) - Include standard Retry-After header
  if (err instanceof RateLimitExceededError) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(err.statusCode).json({
      status: 'error',
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // 4. Database Errors (500) - Ensure sanitized message and code
  if (err instanceof DatabaseError) {
    res.status(err.statusCode).json({
      status: 'error',
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // 5. Other Known Domain & Application Errors (401, 403, 404, 409, 413, 500)
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      status: 'error',
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // 6. Express Body Parser Malformed JSON Syntax Errors
  const isParseError =
    ('type' in err && (err as { type: string }).type === 'entity.parse.failed') ||
    (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400 && 'body' in err);

  if (isParseError) {
    res.status(400).json({
      status: 'error',
      error: {
        code: 'MALFORMED_JSON',
        message: 'Invalid JSON payload received in request body',
      },
    });
    return;
  }

  // 7. Payload Too Large (Express Body Limit Exceeded)
  if ('type' in err && (err as { type: string }).type === 'entity.too.large') {
    res.status(413).json({
      status: 'error',
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request payload exceeds the permitted limit (100kb)',
      },
    });
    return;
  }

  // 8. Unhandled Server Errors (500) - Redact sensitive tokens/credentials from server logs and never leak details in HTTP response
  const safeErrorLog = redactSensitiveText(err instanceof Error ? err.message : String(err));
  console.error('[UNHANDLED ERROR]', safeErrorLog);
  res.status(500).json({
    status: 'error',
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred',
    },
  });
}
