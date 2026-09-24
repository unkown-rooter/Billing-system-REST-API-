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

export class PayloadTooLargeError extends AppError {
  constructor(message: string = 'Request payload exceeds the permitted limit') {
    super(413, 'PAYLOAD_TOO_LARGE', message);
    this.name = 'PayloadTooLargeError';
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
