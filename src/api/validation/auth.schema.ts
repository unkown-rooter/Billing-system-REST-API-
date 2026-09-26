import { ValidationError, ValidationErrorField } from '../services/errors.js';
import { RegisterDTO, LoginDTO } from '../models/account.model.js';
import { EMAIL_REGEX, MAX_EMAIL_LENGTH } from './customer.schema.js';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

const ALLOWED_REGISTER_FIELDS = new Set(['email', 'password']);
const ALLOWED_LOGIN_FIELDS = new Set(['email', 'password']);
const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function containsNullByte(val: string): boolean {
  return val.includes('\u0000');
}

/**
 * Validates registration request body.
 * Enforces:
 * - JSON object shape
 * - Required fields: email, password
 * - Rejection of unknown properties and prototype-pollution keys
 * - Email format and length limits (max 254), no null bytes
 * - Password policy: string, 8-128 characters, non-whitespace, no null bytes
 */
export function validateRegisterBody(body: unknown): RegisterDTO {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const fieldErrors: ValidationErrorField[] = [];

  // 1. Detect unknown fields & prototype pollution keys
  for (const key of Object.getOwnPropertyNames(record)) {
    if (FORBIDDEN_PROTO_KEYS.has(key) || !ALLOWED_REGISTER_FIELDS.has(key)) {
      fieldErrors.push({
        field: key,
        message: `Unknown field '${key}' is not permitted`,
      });
    }
  }

  // 2. Validate 'email'
  if (record.email === undefined || record.email === null) {
    fieldErrors.push({
      field: 'email',
      message: "Field 'email' is required",
    });
  } else if (typeof record.email !== 'string') {
    fieldErrors.push({
      field: 'email',
      message: "Field 'email' must be a string",
    });
  } else if (containsNullByte(record.email)) {
    fieldErrors.push({
      field: 'email',
      message: "Field 'email' contains invalid control characters",
    });
  } else {
    const trimmedEmail = record.email.trim();
    if (trimmedEmail.length === 0) {
      fieldErrors.push({
        field: 'email',
        message: "Field 'email' cannot be empty",
      });
    } else if (trimmedEmail.length > MAX_EMAIL_LENGTH) {
      fieldErrors.push({
        field: 'email',
        message: `Field 'email' cannot exceed ${MAX_EMAIL_LENGTH} characters`,
      });
    } else if (!EMAIL_REGEX.test(trimmedEmail)) {
      fieldErrors.push({
        field: 'email',
        message: "Field 'email' must be a valid email address",
      });
    }
  }

  // 3. Validate 'password'
  if (record.password === undefined || record.password === null) {
    fieldErrors.push({
      field: 'password',
      message: "Field 'password' is required",
    });
  } else if (typeof record.password !== 'string') {
    fieldErrors.push({
      field: 'password',
      message: "Field 'password' must be a string",
    });
  } else if (containsNullByte(record.password)) {
    fieldErrors.push({
      field: 'password',
      message: "Field 'password' contains invalid control characters",
    });
  } else if (record.password.length < MIN_PASSWORD_LENGTH) {
    fieldErrors.push({
      field: 'password',
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
    });
  } else if (record.password.length > MAX_PASSWORD_LENGTH) {
    fieldErrors.push({
      field: 'password',
      message: `Password cannot exceed ${MAX_PASSWORD_LENGTH} characters`,
    });
  } else if (record.password.trim().length === 0) {
    fieldErrors.push({
      field: 'password',
      message: 'Password cannot consist solely of whitespace characters',
    });
  }

  if (fieldErrors.length > 0) {
    throw new ValidationError('Request validation failed', fieldErrors);
  }

  return {
    email: (record.email as string).trim().toLowerCase(),
    password: record.password as string,
  };
}

/**
 * Validates login request body.
 * Enforces:
 * - JSON object shape
 * - Required fields: email, password
 * - Rejection of unknown properties
 */
export function validateLoginBody(body: unknown): LoginDTO {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const fieldErrors: ValidationErrorField[] = [];

  // 1. Detect unknown fields & prototype pollution keys
  for (const key of Object.getOwnPropertyNames(record)) {
    if (FORBIDDEN_PROTO_KEYS.has(key) || !ALLOWED_LOGIN_FIELDS.has(key)) {
      fieldErrors.push({
        field: key,
        message: `Unknown field '${key}' is not permitted`,
      });
    }
  }

  // 2. Validate 'email'
  if (record.email === undefined || record.email === null) {
    fieldErrors.push({
      field: 'email',
      message: "Field 'email' is required",
    });
  } else if (typeof record.email !== 'string') {
    fieldErrors.push({
      field: 'email',
      message: "Field 'email' must be a string",
    });
  } else if (containsNullByte(record.email)) {
    fieldErrors.push({
      field: 'email',
      message: "Field 'email' contains invalid control characters",
    });
  } else if ((record.email as string).trim().length === 0) {
    fieldErrors.push({
      field: 'email',
      message: "Field 'email' cannot be empty",
    });
  } else if ((record.email as string).trim().length > MAX_EMAIL_LENGTH) {
    fieldErrors.push({
      field: 'email',
      message: `Field 'email' cannot exceed ${MAX_EMAIL_LENGTH} characters`,
    });
  } else if (!EMAIL_REGEX.test((record.email as string).trim())) {
    fieldErrors.push({
      field: 'email',
      message: "Field 'email' must be a valid email address",
    });
  }

  // 3. Validate 'password'
  if (record.password === undefined || record.password === null) {
    fieldErrors.push({
      field: 'password',
      message: "Field 'password' is required",
    });
  } else if (typeof record.password !== 'string') {
    fieldErrors.push({
      field: 'password',
      message: "Field 'password' must be a string",
    });
  } else if (containsNullByte(record.password)) {
    fieldErrors.push({
      field: 'password',
      message: "Field 'password' contains invalid control characters",
    });
  } else if ((record.password as string).length === 0) {
    fieldErrors.push({
      field: 'password',
      message: "Field 'password' cannot be empty",
    });
  } else if ((record.password as string).length > MAX_PASSWORD_LENGTH) {
    fieldErrors.push({
      field: 'password',
      message: `Password cannot exceed ${MAX_PASSWORD_LENGTH} characters`,
    });
  }

  if (fieldErrors.length > 0) {
    throw new ValidationError('Request validation failed', fieldErrors);
  }

  return {
    email: (record.email as string).trim().toLowerCase(),
    password: record.password as string,
  };
}
