import { ValidationError, ValidationErrorField } from '../services/errors.js';
import {
  CreateInvoiceDTO,
  CreateInvoiceItemDTO,
  UpdateInvoiceDTO,
  VALID_INVOICE_STATUSES,
  isValidInvoiceStatus,
} from '../models/invoice.model.js';
import { CURRENCY_REGEX, CUSTOMER_ID_REGEX } from './customer.schema.js';

export const INVOICE_ID_REGEX = /^inv_[a-zA-Z0-9_-]+$/;
export const MAX_ITEM_DESCRIPTION_LENGTH = 500;
export const MAX_NOTES_LENGTH = 1000;
export const MAX_INVOICE_ITEMS = 100;
export const MAX_MONETARY_AMOUNT = 9_999_999_999.99;

const ALLOWED_CREATE_INVOICE_FIELDS = new Set([
  'customerId',
  'currency',
  'status',
  'tax',
  'discount',
  'issueDate',
  'dueDate',
  'notes',
  'items',
]);

const COMPUTED_OR_IMMUTABLE_CREATE_FIELDS = new Set([
  'id',
  'invoiceNumber',
  'subtotal',
  'total',
  'createdAt',
  'updatedAt',
  'accountId',
]);

const ALLOWED_INVOICE_ITEM_FIELDS = new Set([
  'description',
  'quantity',
  'unitPrice',
]);

const COMPUTED_OR_IMMUTABLE_ITEM_FIELDS = new Set([
  'id',
  'invoiceId',
  'lineTotal',
  'amount',
  'total',
  'createdAt',
  'updatedAt',
]);

const ALLOWED_UPDATE_INVOICE_FIELDS = new Set([
  'status',
  'tax',
  'discount',
  'dueDate',
  'notes',
  'items',
]);

const IMMUTABLE_UPDATE_INVOICE_FIELDS = new Set([
  'id',
  'customerId',
  'invoiceNumber',
  'currency',
  'subtotal',
  'total',
  'issueDate',
  'createdAt',
  'updatedAt',
  'accountId',
]);

const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function containsNullByte(val: string): boolean {
  return val.includes('\u0000');
}

function hasValidCentsPrecision(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const scaled = value * 100;
  return Math.abs(Math.round(scaled) - scaled) < 1e-6;
}

function isValidIsoDate(value: string): boolean {
  if (value.trim().length === 0) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}

function validateInvoiceItemsArray(
  rawItems: unknown,
  fieldErrors: ValidationErrorField[]
): CreateInvoiceItemDTO[] {
  if (rawItems === undefined || rawItems === null) {
    fieldErrors.push({
      field: 'items',
      message: "Field 'items' is required and must contain at least one line item",
    });
    return [];
  }

  if (!Array.isArray(rawItems)) {
    fieldErrors.push({
      field: 'items',
      message: "Field 'items' must be an array of invoice line items",
    });
    return [];
  }

  if (rawItems.length === 0) {
    fieldErrors.push({
      field: 'items',
      message: "Field 'items' must contain at least one line item",
    });
    return [];
  }

  if (rawItems.length > MAX_INVOICE_ITEMS) {
    fieldErrors.push({
      field: 'items',
      message: `Field 'items' cannot exceed ${MAX_INVOICE_ITEMS} line items`,
    });
    return [];
  }

  const sanitizedItems: CreateInvoiceItemDTO[] = [];

  rawItems.forEach((rawItem, idx) => {
    const prefix = `items[${idx}]`;
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      fieldErrors.push({
        field: prefix,
        message: `Each entry in 'items' must be a JSON object`,
      });
      return;
    }

    const itemRecord = rawItem as Record<string, unknown>;

    for (const key of Object.getOwnPropertyNames(itemRecord)) {
      if (COMPUTED_OR_IMMUTABLE_ITEM_FIELDS.has(key)) {
        fieldErrors.push({
          field: `${prefix}.${key}`,
          message: `Field '${key}' is server-computed or immutable and cannot be supplied by the client`,
        });
      } else if (FORBIDDEN_PROTO_KEYS.has(key) || !ALLOWED_INVOICE_ITEM_FIELDS.has(key)) {
        fieldErrors.push({
          field: `${prefix}.${key}`,
          message: `Unknown field '${key}' is not permitted in invoice line item`,
        });
      }
    }

    // description
    if (itemRecord.description === undefined || itemRecord.description === null) {
      fieldErrors.push({
        field: `${prefix}.description`,
        message: "Line item 'description' is required",
      });
    } else if (typeof itemRecord.description !== 'string') {
      fieldErrors.push({
        field: `${prefix}.description`,
        message: "Line item 'description' must be a string",
      });
    } else if (containsNullByte(itemRecord.description)) {
      fieldErrors.push({
        field: `${prefix}.description`,
        message: "Line item 'description' contains invalid control characters",
      });
    } else if (itemRecord.description.trim().length === 0) {
      fieldErrors.push({
        field: `${prefix}.description`,
        message: "Line item 'description' must be a non-empty string",
      });
    } else if (itemRecord.description.trim().length > MAX_ITEM_DESCRIPTION_LENGTH) {
      fieldErrors.push({
        field: `${prefix}.description`,
        message: `Line item 'description' cannot exceed ${MAX_ITEM_DESCRIPTION_LENGTH} characters`,
      });
    }

    // quantity
    if (itemRecord.quantity === undefined || itemRecord.quantity === null) {
      fieldErrors.push({
        field: `${prefix}.quantity`,
        message: "Line item 'quantity' is required",
      });
    } else if (
      typeof itemRecord.quantity !== 'number' ||
      !Number.isInteger(itemRecord.quantity) ||
      itemRecord.quantity <= 0 ||
      itemRecord.quantity > 1_000_000
    ) {
      fieldErrors.push({
        field: `${prefix}.quantity`,
        message: "Line item 'quantity' must be a positive integer between 1 and 1000000",
      });
    }

    // unitPrice
    if (itemRecord.unitPrice === undefined || itemRecord.unitPrice === null) {
      fieldErrors.push({
        field: `${prefix}.unitPrice`,
        message: "Line item 'unitPrice' is required",
      });
    } else if (
      typeof itemRecord.unitPrice !== 'number' ||
      !Number.isFinite(itemRecord.unitPrice) ||
      itemRecord.unitPrice < 0 ||
      itemRecord.unitPrice > MAX_MONETARY_AMOUNT
    ) {
      fieldErrors.push({
        field: `${prefix}.unitPrice`,
        message: "Line item 'unitPrice' must be a non-negative number",
      });
    } else if (!hasValidCentsPrecision(itemRecord.unitPrice)) {
      fieldErrors.push({
        field: `${prefix}.unitPrice`,
        message: "Line item 'unitPrice' can have at most 2 decimal places",
      });
    }

    if (
      typeof itemRecord.description === 'string' &&
      !containsNullByte(itemRecord.description) &&
      itemRecord.description.trim().length > 0 &&
      typeof itemRecord.quantity === 'number' &&
      Number.isInteger(itemRecord.quantity) &&
      itemRecord.quantity > 0 &&
      typeof itemRecord.unitPrice === 'number' &&
      itemRecord.unitPrice >= 0 &&
      hasValidCentsPrecision(itemRecord.unitPrice)
    ) {
      sanitizedItems.push({
        description: itemRecord.description.trim(),
        quantity: itemRecord.quantity,
        unitPrice: Number(itemRecord.unitPrice.toFixed(2)),
      });
    }
  });

  return sanitizedItems;
}

export function validateCreateInvoiceBody(
  body: unknown,
  options: { requireCustomerId?: boolean } = { requireCustomerId: true }
): CreateInvoiceDTO {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const fieldErrors: ValidationErrorField[] = [];

  for (const key of Object.getOwnPropertyNames(record)) {
    if (COMPUTED_OR_IMMUTABLE_CREATE_FIELDS.has(key)) {
      fieldErrors.push({
        field: key,
        message: `Field '${key}' is server-computed or immutable and cannot be supplied by the client`,
      });
    } else if (FORBIDDEN_PROTO_KEYS.has(key) || !ALLOWED_CREATE_INVOICE_FIELDS.has(key)) {
      fieldErrors.push({
        field: key,
        message: `Unknown field '${key}' is not permitted`,
      });
    }
  }

  // customerId
  if (options.requireCustomerId) {
    if (record.customerId === undefined || record.customerId === null) {
      fieldErrors.push({
        field: 'customerId',
        message: "Field 'customerId' is required",
      });
    } else if (typeof record.customerId !== 'string' || !CUSTOMER_ID_REGEX.test(record.customerId.trim())) {
      fieldErrors.push({
        field: 'customerId',
        message: "Field 'customerId' must be a valid customer ID starting with 'cus_'",
      });
    }
  } else if (record.customerId !== undefined) {
    if (typeof record.customerId !== 'string' || !CUSTOMER_ID_REGEX.test(record.customerId.trim())) {
      fieldErrors.push({
        field: 'customerId',
        message: "Field 'customerId' must be a valid customer ID starting with 'cus_'",
      });
    }
  }

  // currency (optional on create; if supplied must be valid 3-letter uppercase ISO code)
  if (record.currency !== undefined && record.currency !== null) {
    if (typeof record.currency !== 'string' || !CURRENCY_REGEX.test(record.currency.trim())) {
      fieldErrors.push({
        field: 'currency',
        message: "Field 'currency' must be a valid 3-letter uppercase ISO code (e.g. USD, EUR, KES)",
      });
    }
  }

  // status (optional on create; defaults to 'draft')
  if (record.status !== undefined && record.status !== null) {
    if (!isValidInvoiceStatus(record.status)) {
      fieldErrors.push({
        field: 'status',
        message: `Field 'status' must be one of: ${VALID_INVOICE_STATUSES.join(', ')}`,
      });
    }
  }

  // tax (optional on create; defaults to 0)
  if (record.tax !== undefined && record.tax !== null) {
    if (
      typeof record.tax !== 'number' ||
      !Number.isFinite(record.tax) ||
      record.tax < 0 ||
      record.tax > MAX_MONETARY_AMOUNT
    ) {
      fieldErrors.push({
        field: 'tax',
        message: "Field 'tax' must be a non-negative number",
      });
    } else if (!hasValidCentsPrecision(record.tax)) {
      fieldErrors.push({
        field: 'tax',
        message: "Field 'tax' can have at most 2 decimal places",
      });
    }
  }

  // discount (optional on create; defaults to 0)
  if (record.discount !== undefined && record.discount !== null) {
    if (
      typeof record.discount !== 'number' ||
      !Number.isFinite(record.discount) ||
      record.discount < 0 ||
      record.discount > MAX_MONETARY_AMOUNT
    ) {
      fieldErrors.push({
        field: 'discount',
        message: "Field 'discount' must be a non-negative number",
      });
    } else if (!hasValidCentsPrecision(record.discount)) {
      fieldErrors.push({
        field: 'discount',
        message: "Field 'discount' can have at most 2 decimal places",
      });
    }
  }

  // issueDate & dueDate
  if (record.issueDate !== undefined && record.issueDate !== null) {
    if (typeof record.issueDate !== 'string' || !isValidIsoDate(record.issueDate)) {
      fieldErrors.push({
        field: 'issueDate',
        message: "Field 'issueDate' must be a valid ISO 8601 date string",
      });
    }
  }

  if (record.dueDate !== undefined && record.dueDate !== null) {
    if (typeof record.dueDate !== 'string' || !isValidIsoDate(record.dueDate)) {
      fieldErrors.push({
        field: 'dueDate',
        message: "Field 'dueDate' must be a valid ISO 8601 date string",
      });
    }
  }

  // notes
  if (record.notes !== undefined && record.notes !== null) {
    if (typeof record.notes !== 'string') {
      fieldErrors.push({
        field: 'notes',
        message: "Field 'notes' must be a string or null",
      });
    } else if (containsNullByte(record.notes)) {
      fieldErrors.push({
        field: 'notes',
        message: "Field 'notes' contains invalid control characters",
      });
    } else if (record.notes.trim().length > MAX_NOTES_LENGTH) {
      fieldErrors.push({
        field: 'notes',
        message: `Field 'notes' cannot exceed ${MAX_NOTES_LENGTH} characters`,
      });
    }
  }

  // items
  const items = validateInvoiceItemsArray(record.items, fieldErrors);

  if (fieldErrors.length > 0) {
    throw new ValidationError('Request validation failed', fieldErrors);
  }

  const dto: CreateInvoiceDTO = {
    items,
  };

  if (typeof record.customerId === 'string') {
    dto.customerId = record.customerId.trim();
  }
  if (typeof record.currency === 'string') {
    dto.currency = record.currency.trim().toUpperCase();
  }
  if (isValidInvoiceStatus(record.status)) {
    dto.status = record.status;
  }
  if (typeof record.tax === 'number') {
    dto.tax = Number(record.tax.toFixed(2));
  }
  if (typeof record.discount === 'number') {
    dto.discount = Number(record.discount.toFixed(2));
  }
  if (typeof record.issueDate === 'string') {
    dto.issueDate = new Date(record.issueDate).toISOString();
  }
  if (typeof record.dueDate === 'string') {
    dto.dueDate = new Date(record.dueDate).toISOString();
  }
  if (record.notes !== undefined) {
    dto.notes = record.notes === null ? null : (record.notes as string).trim();
  }

  return dto;
}

export function validateUpdateInvoiceBody(body: unknown): UpdateInvoiceDTO {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const keys = Object.getOwnPropertyNames(record);

  if (keys.length === 0) {
    throw new ValidationError('Update payload cannot be empty. At least one mutable field must be provided');
  }

  const fieldErrors: ValidationErrorField[] = [];

  for (const key of keys) {
    if (IMMUTABLE_UPDATE_INVOICE_FIELDS.has(key)) {
      fieldErrors.push({
        field: key,
        message: `Field '${key}' is immutable or server-computed and cannot be updated`,
      });
    } else if (FORBIDDEN_PROTO_KEYS.has(key) || !ALLOWED_UPDATE_INVOICE_FIELDS.has(key)) {
      fieldErrors.push({
        field: key,
        message: `Unknown field '${key}' is not permitted`,
      });
    }
  }

  if (record.status !== undefined) {
    if (!isValidInvoiceStatus(record.status)) {
      fieldErrors.push({
        field: 'status',
        message: `Field 'status' must be one of: ${VALID_INVOICE_STATUSES.join(', ')}`,
      });
    }
  }

  if (record.tax !== undefined) {
    if (
      typeof record.tax !== 'number' ||
      !Number.isFinite(record.tax) ||
      record.tax < 0 ||
      record.tax > MAX_MONETARY_AMOUNT
    ) {
      fieldErrors.push({
        field: 'tax',
        message: "Field 'tax' must be a non-negative number",
      });
    } else if (!hasValidCentsPrecision(record.tax)) {
      fieldErrors.push({
        field: 'tax',
        message: "Field 'tax' can have at most 2 decimal places",
      });
    }
  }

  if (record.discount !== undefined) {
    if (
      typeof record.discount !== 'number' ||
      !Number.isFinite(record.discount) ||
      record.discount < 0 ||
      record.discount > MAX_MONETARY_AMOUNT
    ) {
      fieldErrors.push({
        field: 'discount',
        message: "Field 'discount' must be a non-negative number",
      });
    } else if (!hasValidCentsPrecision(record.discount)) {
      fieldErrors.push({
        field: 'discount',
        message: "Field 'discount' can have at most 2 decimal places",
      });
    }
  }

  if (record.dueDate !== undefined) {
    if (typeof record.dueDate !== 'string' || !isValidIsoDate(record.dueDate)) {
      fieldErrors.push({
        field: 'dueDate',
        message: "Field 'dueDate' must be a valid ISO 8601 date string",
      });
    }
  }

  if (record.notes !== undefined && record.notes !== null) {
    if (typeof record.notes !== 'string') {
      fieldErrors.push({
        field: 'notes',
        message: "Field 'notes' must be a string or null",
      });
    } else if (record.notes.trim().length > MAX_NOTES_LENGTH) {
      fieldErrors.push({
        field: 'notes',
        message: `Field 'notes' cannot exceed ${MAX_NOTES_LENGTH} characters`,
      });
    }
  }

  let items: CreateInvoiceItemDTO[] | undefined;
  if (record.items !== undefined) {
    items = validateInvoiceItemsArray(record.items, fieldErrors);
  }

  if (fieldErrors.length > 0) {
    throw new ValidationError('Request validation failed', fieldErrors);
  }

  const dto: UpdateInvoiceDTO = {};
  if (isValidInvoiceStatus(record.status)) {
    dto.status = record.status;
  }
  if (typeof record.tax === 'number') {
    dto.tax = Number(record.tax.toFixed(2));
  }
  if (typeof record.discount === 'number') {
    dto.discount = Number(record.discount.toFixed(2));
  }
  if (typeof record.dueDate === 'string') {
    dto.dueDate = new Date(record.dueDate).toISOString();
  }
  if (record.notes !== undefined) {
    dto.notes = record.notes === null ? null : (record.notes as string).trim();
  }
  if (items !== undefined) {
    dto.items = items;
  }

  return dto;
}

export function validateInvoiceIdParam(id: unknown): string {
  if (typeof id !== 'string' || !INVOICE_ID_REGEX.test(id)) {
    throw new ValidationError(
      "Invalid invoice ID format. Invoice ID must start with 'inv_' and contain valid characters",
      [
        {
          field: 'id',
          message:
            "Invoice ID must start with 'inv_' followed by alphanumeric characters, dashes, or underscores",
        },
      ]
    );
  }
  return id;
}
