import { ValidationError, ValidationErrorField } from '../services/errors.js';
import { CreateCustomerDTO, UpdateCustomerDTO } from '../models/customer.model.js';

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CURRENCY_REGEX = /^[A-Z]{3}$/;
export const MAX_NAME_LENGTH = 255;
export const MAX_EMAIL_LENGTH = 254;
export const CUSTOMER_ID_REGEX = /^cus_[a-zA-Z0-9_-]+$/;

const ALLOWED_CREATE_FIELDS = new Set(['name', 'email', 'currency']);
const ALLOWED_UPDATE_FIELDS = new Set(['name', 'email', 'currency']);
const IMMUTABLE_UPDATE_FIELDS = new Set(['id', 'createdAt', 'accountId']);
const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function containsNullByte(val: string): boolean {
  return val.includes('\u0000');
}

/**
 * Validates and normalizes customer creation request bodies.
 * Strictly enforces schema contracts:
 * - Reject non-object shapes (null, array, primitive)
 * - Require name, email, currency
 * - Reject unknown properties (e.g. isAdmin) and prototype-pollution keys
 * - Enforce length, type, null-byte, and format constraints
 */
export function validateCreateCustomerBody(body: unknown): CreateCustomerDTO {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const fieldErrors: ValidationErrorField[] = [];

  // 1. Detect unknown / unrecognized fields & prototype pollution keys
  for (const key of Object.getOwnPropertyNames(record)) {
    if (FORBIDDEN_PROTO_KEYS.has(key) || !ALLOWED_CREATE_FIELDS.has(key)) {
      fieldErrors.push({
        field: key,
        message: `Unknown field '${key}' is not permitted`,
      });
    }
  }

  // 2. Validate 'name'
  if (record.name === undefined || record.name === null) {
    fieldErrors.push({
      field: 'name',
      message: "Field 'name' is required",
    });
  } else if (typeof record.name !== 'string') {
    fieldErrors.push({
      field: 'name',
      message: "Field 'name' must be a string",
    });
  } else if (containsNullByte(record.name)) {
    fieldErrors.push({
      field: 'name',
      message: "Field 'name' contains invalid control characters",
    });
  } else if (record.name.trim().length === 0) {
    fieldErrors.push({
      field: 'name',
      message: "Field 'name' must be a non-empty string",
    });
  } else if (record.name.trim().length > MAX_NAME_LENGTH) {
    fieldErrors.push({
      field: 'name',
      message: `Field 'name' cannot exceed ${MAX_NAME_LENGTH} characters`,
    });
  }

  // 3. Validate 'email'
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
    if (trimmedEmail.length > MAX_EMAIL_LENGTH) {
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

  // 4. Validate 'currency'
  if (record.currency === undefined || record.currency === null) {
    fieldErrors.push({
      field: 'currency',
      message: "Field 'currency' is required",
    });
  } else if (typeof record.currency !== 'string') {
    fieldErrors.push({
      field: 'currency',
      message: "Field 'currency' must be a string",
    });
  } else {
    const upperCurrency = record.currency.trim();
    if (!CURRENCY_REGEX.test(upperCurrency)) {
      fieldErrors.push({
        field: 'currency',
        message: "Field 'currency' must be a valid 3-letter uppercase ISO code (e.g. USD, EUR, KES)",
      });
    }
  }

  if (fieldErrors.length > 0) {
    throw new ValidationError('Request validation failed', fieldErrors);
  }

  return {
    name: (record.name as string).trim(),
    email: (record.email as string).trim().toLowerCase(),
    currency: (record.currency as string).trim().toUpperCase(),
  };
}

/**
 * Validates and normalizes customer update request bodies.
 * Strictly enforces schema contracts:
 * - Reject non-object shapes (null, array, primitive)
 * - Reject empty payloads ({})
 * - Reject immutable fields (id, createdAt)
 * - Reject unknown properties
 * - Validate types and constraints of any supplied fields
 */
export function validateUpdateCustomerBody(body: unknown): UpdateCustomerDTO {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const keys = Object.getOwnPropertyNames(record);

  if (keys.length === 0) {
    throw new ValidationError('Update payload cannot be empty. At least one mutable field must be provided');
  }

  const fieldErrors: ValidationErrorField[] = [];

  // 1. Check for immutable fields
  for (const immutableKey of IMMUTABLE_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, immutableKey)) {
      fieldErrors.push({
        field: immutableKey,
        message: `Field '${immutableKey}' is immutable and cannot be updated`,
      });
    }
  }

  // 2. Check for unknown fields & prototype pollution keys
  for (const key of keys) {
    if (
      FORBIDDEN_PROTO_KEYS.has(key) ||
      (!ALLOWED_UPDATE_FIELDS.has(key) && !IMMUTABLE_UPDATE_FIELDS.has(key))
    ) {
      fieldErrors.push({
        field: key,
        message: `Unknown field '${key}' is not permitted`,
      });
    }
  }

  // 3. Validate 'name' if provided
  if (record.name !== undefined) {
    if (typeof record.name !== 'string') {
      fieldErrors.push({
        field: 'name',
        message: "Field 'name' must be a string",
      });
    } else if (containsNullByte(record.name)) {
      fieldErrors.push({
        field: 'name',
        message: "Field 'name' contains invalid control characters",
      });
    } else if (record.name.trim().length === 0) {
      fieldErrors.push({
        field: 'name',
        message: "Field 'name' must be a non-empty string",
      });
    } else if (record.name.trim().length > MAX_NAME_LENGTH) {
      fieldErrors.push({
        field: 'name',
        message: `Field 'name' cannot exceed ${MAX_NAME_LENGTH} characters`,
      });
    }
  }

  // 4. Validate 'email' if provided
  if (record.email !== undefined) {
    if (typeof record.email !== 'string') {
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
      if (trimmedEmail.length > MAX_EMAIL_LENGTH) {
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
  }

  // 5. Validate 'currency' if provided
  if (record.currency !== undefined) {
    if (typeof record.currency !== 'string') {
      fieldErrors.push({
        field: 'currency',
        message: "Field 'currency' must be a string",
      });
    } else {
      const upperCurrency = record.currency.trim();
      if (!CURRENCY_REGEX.test(upperCurrency)) {
        fieldErrors.push({
          field: 'currency',
          message: "Field 'currency' must be a valid 3-letter uppercase ISO code (e.g. USD, EUR, KES)",
        });
      }
    }
  }

  if (fieldErrors.length > 0) {
    throw new ValidationError('Request validation failed', fieldErrors);
  }

  const dto: UpdateCustomerDTO = {};
  if (record.name !== undefined) {
    dto.name = (record.name as string).trim();
  }
  if (record.email !== undefined) {
    dto.email = (record.email as string).trim().toLowerCase();
  }
  if (record.currency !== undefined) {
    dto.currency = (record.currency as string).trim().toUpperCase();
  }

  return dto;
}

/**
 * Validates path parameters for Customer ID (cus_<uuid> or cus_<string> format).
 */
export function validateCustomerIdParam(id: unknown): string {
  if (typeof id !== 'string' || !CUSTOMER_ID_REGEX.test(id)) {
    throw new ValidationError(
      "Invalid customer ID format. Customer ID must start with 'cus_' and contain valid characters",
      [
        {
          field: 'id',
          message: "Customer ID must start with 'cus_' followed by alphanumeric characters, dashes, or underscores",
        },
      ]
    );
  }
  return id;
}
