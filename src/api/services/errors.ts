/**
 * Application & Domain Errors
 * Typed operational errors that map cleanly to standard HTTP semantics.
 */

export interface ValidationErrorField {
  field: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'RESOURCE_NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  public readonly fields?: ValidationErrorField[];

  constructor(message: string, fields?: ValidationErrorField[]) {
    super(400, 'VALIDATION_ERROR', message);
    this.name = 'ValidationError';
    this.fields = fields && fields.length > 0 ? fields : undefined;
  }
}

export class DuplicateResourceError extends AppError {
  constructor(message: string) {
    super(409, 'DUPLICATE_RESOURCE', message);
    this.name = 'DuplicateResourceError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: string = 'CONFLICT') {
    super(409, code, message);
    this.name = 'ConflictError';
  }
}

export class AuthenticationRequiredError extends AppError {
  constructor(message: string = 'Authentication is required') {
    super(401, 'AUTHENTICATION_REQUIRED', message);
    this.name = 'AuthenticationRequiredError';
  }
}

export class InvalidCredentialsError extends AppError {
  constructor(message: string = 'Invalid authentication credentials') {
    super(401, 'INVALID_CREDENTIALS', message);
    this.name = 'InvalidCredentialsError';
  }
}

export class InvalidTokenError extends AppError {
  constructor(message: string = 'Invalid authentication token') {
    super(401, 'INVALID_TOKEN', message);
    this.name = 'InvalidTokenError';
  }
}

export class TokenExpiredError extends AppError {
  constructor(message: string = 'Authentication token has expired') {
    super(401, 'TOKEN_EXPIRED', message);
    this.name = 'TokenExpiredError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'You are not authorized to perform this action') {
    super(403, 'FORBIDDEN', message);
    this.name = 'ForbiddenError';
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string = 'Request payload exceeds the permitted limit') {
    super(413, 'PAYLOAD_TOO_LARGE', message);
    this.name = 'PayloadTooLargeError';
  }
}

export class MethodNotAllowedError extends AppError {
  public readonly allowedMethods: string[];

  constructor(method: string, path: string, allowedMethods: string[]) {
    super(
      405,
      'METHOD_NOT_ALLOWED',
      `HTTP method ${method} is not allowed on ${path}. Allowed methods: ${allowedMethods.join(', ')}`
    );
    this.name = 'MethodNotAllowedError';
    this.allowedMethods = allowedMethods;
  }
}

export class RateLimitExceededError extends AppError {
  public readonly retryAfterSeconds: number;

  constructor(
    message: string = 'Too many requests. Please try again later',
    retryAfterSeconds: number = 60
  ) {
    super(429, 'RATE_LIMIT_EXCEEDED', message);
    this.name = 'RateLimitExceededError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class SecurityConfigurationError extends AppError {
  constructor(message: string = 'Invalid security configuration') {
    super(500, 'SECURITY_CONFIGURATION_ERROR', message);
    this.name = 'SecurityConfigurationError';
  }
}

export class DatabaseError extends AppError {
  constructor(message: string = 'A database error occurred') {
    super(500, 'DATABASE_ERROR', message);
    this.name = 'DatabaseError';
  }
}

export class InternalServerError extends AppError {
  constructor(message: string = 'An unexpected internal error occurred') {
    super(500, 'INTERNAL_SERVER_ERROR', message);
    this.name = 'InternalServerError';
  }
}
