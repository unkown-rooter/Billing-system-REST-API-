import { Request, Response, NextFunction } from 'express';
import {
  AppError,
  ValidationError,
  DatabaseError,
} from '../services/errors.js';

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

  // 2. Database Errors (500) - Ensure sanitized message and code
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

  // 3. Other Known Domain & Application Errors (404, 409, 413, 500)
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

  // 4. Express Body Parser Malformed JSON Syntax Errors
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

  // 5. Payload Too Large (Express Body Limit Exceeded)
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

  // 6. Unhandled Server Errors (500) - Never leak stack traces, SQL, or internal paths
  console.error('[UNHANDLED ERROR]', err);
  res.status(500).json({
    status: 'error',
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred',
    },
  });
}
