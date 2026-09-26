import { ValidationError, ValidationErrorField } from '../services/errors.js';
import {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MIN_PAGE,
  MIN_LIMIT,
  MAX_LIMIT,
  CUSTOMER_SORT_FIELDS,
  CustomerSortField,
  INVOICE_SORT_FIELDS,
  InvoiceSortField,
  INVOICE_ITEM_SORT_FIELDS,
  InvoiceItemSortField,
  SortOrder,
  CustomerListQuery,
  InvoiceListQuery,
  InvoiceItemListQuery,
} from '../models/pagination.model.js';
import { VALID_INVOICE_STATUSES, isValidInvoiceStatus, InvoiceStatus } from '../models/invoice.model.js';
import {
  CURRENCY_REGEX,
  CUSTOMER_ID_REGEX,
  EMAIL_REGEX,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
} from './customer.schema.js';
import { MAX_ITEM_DESCRIPTION_LENGTH } from './invoice.schema.js';

const POSITIVE_INT_REGEX = /^\d+$/;
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const ALLOWED_CUSTOMER_QUERY_KEYS = new Set([
  'page',
  'limit',
  'currency',
  'email',
  'name',
  'sort',
  'order',
]);

const ALLOWED_INVOICE_QUERY_KEYS = new Set([
  'page',
  'limit',
  'customerId',
  'status',
  'currency',
  'issueDate',
  'issueDateFrom',
  'issueDateTo',
  'dueDate',
  'dueDateFrom',
  'dueDateTo',
  'sort',
  'order',
]);

const ALLOWED_CUSTOMER_INVOICE_QUERY_KEYS = new Set([
  'page',
  'limit',
  'status',
  'currency',
  'issueDate',
  'issueDateFrom',
  'issueDateTo',
  'dueDate',
  'dueDateFrom',
  'dueDateTo',
  'sort',
  'order',
]);

const ALLOWED_INVOICE_ITEM_QUERY_KEYS = new Set([
  'page',
  'limit',
  'description',
  'sort',
  'order',
]);

function parsePaginationParams(
  record: Record<string, unknown>,
  fieldErrors: ValidationErrorField[]
): { page: number; limit: number } {
  let page = DEFAULT_PAGE;
  let limit = DEFAULT_LIMIT;

  if (record.page !== undefined) {
    if (typeof record.page !== 'string' || !POSITIVE_INT_REGEX.test(record.page.trim())) {
      fieldErrors.push({
        field: 'page',
        message: "Query parameter 'page' must be a positive integer (>= 1)",
      });
    } else {
      const parsedPage = Number.parseInt(record.page.trim(), 10);
      if (!Number.isSafeInteger(parsedPage) || parsedPage < MIN_PAGE || parsedPage > 1_000_000) {
        fieldErrors.push({
          field: 'page',
          message: "Query parameter 'page' must be an integer between 1 and 1000000",
        });
      } else {
        page = parsedPage;
      }
    }
  }

  if (record.limit !== undefined) {
    if (typeof record.limit !== 'string' || !POSITIVE_INT_REGEX.test(record.limit.trim())) {
      fieldErrors.push({
        field: 'limit',
        message: `Query parameter 'limit' must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`,
      });
    } else {
      const parsedLimit = Number.parseInt(record.limit.trim(), 10);
      if (!Number.isSafeInteger(parsedLimit) || parsedLimit < MIN_LIMIT || parsedLimit > MAX_LIMIT) {
        fieldErrors.push({
          field: 'limit',
          message: `Query parameter 'limit' must be between ${MIN_LIMIT} and ${MAX_LIMIT}`,
        });
      } else {
        limit = parsedLimit;
      }
    }
  }

  return { page, limit };
}

function parseSortOrder(
  rawOrder: unknown,
  fieldErrors: ValidationErrorField[],
  defaultOrder: SortOrder = 'asc'
): SortOrder {
  if (rawOrder === undefined) {
    return defaultOrder;
  }
  if (typeof rawOrder !== 'string') {
    fieldErrors.push({
      field: 'order',
      message: "Query parameter 'order' must be 'asc' or 'desc'",
    });
    return defaultOrder;
  }
  const normalized = rawOrder.trim().toLowerCase();
  if (normalized !== 'asc' && normalized !== 'desc') {
    fieldErrors.push({
      field: 'order',
      message: "Query parameter 'order' must be 'asc' or 'desc'",
    });
    return defaultOrder;
  }
  return normalized;
}

function parseIsoDateBound(
  rawDate: unknown,
  fieldName: string,
  boundType: 'exact' | 'from' | 'to',
  fieldErrors: ValidationErrorField[]
): string | undefined {
  if (rawDate === undefined) {
    return undefined;
  }
  if (typeof rawDate !== 'string' || rawDate.trim().length === 0) {
    fieldErrors.push({
      field: fieldName,
      message: `Query parameter '${fieldName}' must be a valid ISO 8601 date string`,
    });
    return undefined;
  }

  const trimmed = rawDate.trim();
  if (DATE_ONLY_REGEX.test(trimmed)) {
    const isoExpanded =
      boundType === 'to' ? `${trimmed}T23:59:59.999Z` : `${trimmed}T00:00:00.000Z`;
    const ts = Date.parse(isoExpanded);
    if (Number.isNaN(ts)) {
      fieldErrors.push({
        field: fieldName,
        message: `Query parameter '${fieldName}' must be a valid calendar date (YYYY-MM-DD)`,
      });
      return undefined;
    }
    return new Date(ts).toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    fieldErrors.push({
      field: fieldName,
      message: `Query parameter '${fieldName}' must be a valid ISO 8601 date string`,
    });
    return undefined;
  }

  return new Date(parsed).toISOString();
}

/**
 * Validates query parameters for GET /api/v1/customers.
 */
export function validateCustomerListQuery(query: unknown): CustomerListQuery {
  const record = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  const fieldErrors: ValidationErrorField[] = [];

  for (const key of Object.keys(record)) {
    if (!ALLOWED_CUSTOMER_QUERY_KEYS.has(key)) {
      fieldErrors.push({
        field: key,
        message: `Unknown query parameter '${key}' is not permitted`,
      });
    }
  }

  const { page, limit } = parsePaginationParams(record, fieldErrors);

  // sort whitelist
  let sort: CustomerSortField = 'createdAt';
  if (record.sort !== undefined) {
    if (
      typeof record.sort !== 'string' ||
      !(CUSTOMER_SORT_FIELDS as readonly string[]).includes(record.sort.trim())
    ) {
      fieldErrors.push({
        field: 'sort',
        message: `Query parameter 'sort' must be one of: ${CUSTOMER_SORT_FIELDS.join(', ')}`,
      });
    } else {
      sort = record.sort.trim() as CustomerSortField;
    }
  }

  const order = parseSortOrder(record.order, fieldErrors, 'asc');

  // currency filter
  let currency: string | undefined;
  if (record.currency !== undefined) {
    if (typeof record.currency !== 'string' || !CURRENCY_REGEX.test(record.currency.trim())) {
      fieldErrors.push({
        field: 'currency',
        message: "Query parameter 'currency' must be a valid 3-letter uppercase ISO code (e.g. USD, EUR, KES)",
      });
    } else {
      currency = record.currency.trim();
    }
  }

  // email filter
  let email: string | undefined;
  if (record.email !== undefined) {
    if (typeof record.email !== 'string') {
      fieldErrors.push({
        field: 'email',
        message: "Query parameter 'email' must be a valid email address",
      });
    } else {
      const trimmedEmail = record.email.trim();
      if (
        trimmedEmail.length === 0 ||
        trimmedEmail.length > MAX_EMAIL_LENGTH ||
        !EMAIL_REGEX.test(trimmedEmail)
      ) {
        fieldErrors.push({
          field: 'email',
          message: "Query parameter 'email' must be a valid email address",
        });
      } else {
        email = trimmedEmail.toLowerCase();
      }
    }
  }

  // name filter
  let name: string | undefined;
  if (record.name !== undefined) {
    if (typeof record.name !== 'string' || record.name.trim().length === 0) {
      fieldErrors.push({
        field: 'name',
        message: "Query parameter 'name' must be a non-empty string",
      });
    } else if (record.name.trim().length > MAX_NAME_LENGTH) {
      fieldErrors.push({
        field: 'name',
        message: `Query parameter 'name' cannot exceed ${MAX_NAME_LENGTH} characters`,
      });
    } else {
      name = record.name.trim();
    }
  }

  if (fieldErrors.length > 0) {
    throw new ValidationError('Request validation failed', fieldErrors);
  }

  return {
    page,
    limit,
    currency,
    email,
    name,
    sort,
    order,
  };
}

/**
 * Validates query parameters for GET /api/v1/invoices and GET /api/v1/customers/:id/invoices.
 */
export function validateInvoiceListQuery(
  query: unknown,
  options: { allowCustomerIdParam?: boolean } = { allowCustomerIdParam: true }
): InvoiceListQuery {
  const record = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  const fieldErrors: ValidationErrorField[] = [];
  const allowedKeys = options.allowCustomerIdParam
    ? ALLOWED_INVOICE_QUERY_KEYS
    : ALLOWED_CUSTOMER_INVOICE_QUERY_KEYS;

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      fieldErrors.push({
        field: key,
        message: `Unknown query parameter '${key}' is not permitted`,
      });
    }
  }

  const { page, limit } = parsePaginationParams(record, fieldErrors);

  // sort whitelist
  let sort: InvoiceSortField = 'createdAt';
  if (record.sort !== undefined) {
    if (
      typeof record.sort !== 'string' ||
      !(INVOICE_SORT_FIELDS as readonly string[]).includes(record.sort.trim())
    ) {
      fieldErrors.push({
        field: 'sort',
        message: `Query parameter 'sort' must be one of: ${INVOICE_SORT_FIELDS.join(', ')}`,
      });
    } else {
      sort = record.sort.trim() as InvoiceSortField;
    }
  }

  const order = parseSortOrder(record.order, fieldErrors, 'asc');

  // customerId filter
  let customerId: string | undefined;
  if (options.allowCustomerIdParam && record.customerId !== undefined) {
    if (
      typeof record.customerId !== 'string' ||
      !CUSTOMER_ID_REGEX.test(record.customerId.trim())
    ) {
      fieldErrors.push({
        field: 'customerId',
        message: "Query parameter 'customerId' must be a valid customer ID starting with 'cus_'",
      });
    } else {
      customerId = record.customerId.trim();
    }
  }

  // status filter (case-insensitive input normalized to lowercase valid status)
  let status: InvoiceStatus | undefined;
  if (record.status !== undefined) {
    if (typeof record.status !== 'string') {
      fieldErrors.push({
        field: 'status',
        message: `Query parameter 'status' must be one of: ${VALID_INVOICE_STATUSES.join(', ')}`,
      });
    } else {
      const normalizedStatus = record.status.trim().toLowerCase();
      if (!isValidInvoiceStatus(normalizedStatus)) {
        fieldErrors.push({
          field: 'status',
          message: `Query parameter 'status' must be one of: ${VALID_INVOICE_STATUSES.join(', ')}`,
        });
      } else {
        status = normalizedStatus;
      }
    }
  }

  // currency filter
  let currency: string | undefined;
  if (record.currency !== undefined) {
    if (typeof record.currency !== 'string' || !CURRENCY_REGEX.test(record.currency.trim())) {
      fieldErrors.push({
        field: 'currency',
        message: "Query parameter 'currency' must be a valid 3-letter uppercase ISO code (e.g. USD, EUR, KES)",
      });
    } else {
      currency = record.currency.trim();
    }
  }

  // Date filters
  const issueDate = parseIsoDateBound(record.issueDate, 'issueDate', 'exact', fieldErrors);
  const issueDateFrom = parseIsoDateBound(record.issueDateFrom, 'issueDateFrom', 'from', fieldErrors);
  const issueDateTo = parseIsoDateBound(record.issueDateTo, 'issueDateTo', 'to', fieldErrors);
  const dueDate = parseIsoDateBound(record.dueDate, 'dueDate', 'exact', fieldErrors);
  const dueDateFrom = parseIsoDateBound(record.dueDateFrom, 'dueDateFrom', 'from', fieldErrors);
  const dueDateTo = parseIsoDateBound(record.dueDateTo, 'dueDateTo', 'to', fieldErrors);

  if (issueDateFrom && issueDateTo && new Date(issueDateFrom).getTime() > new Date(issueDateTo).getTime()) {
    fieldErrors.push({
      field: 'issueDateFrom',
      message: "Query parameter 'issueDateFrom' cannot be later than 'issueDateTo'",
    });
  }

  if (dueDateFrom && dueDateTo && new Date(dueDateFrom).getTime() > new Date(dueDateTo).getTime()) {
    fieldErrors.push({
      field: 'dueDateFrom',
      message: "Query parameter 'dueDateFrom' cannot be later than 'dueDateTo'",
    });
  }

  if (fieldErrors.length > 0) {
    throw new ValidationError('Request validation failed', fieldErrors);
  }

  return {
    page,
    limit,
    customerId,
    status,
    currency,
    issueDate,
    issueDateFrom,
    issueDateTo,
    dueDate,
    dueDateFrom,
    dueDateTo,
    sort,
    order,
  };
}

/**
 * Validates query parameters for GET /api/v1/invoices/:id/items.
 */
export function validateInvoiceItemListQuery(query: unknown): InvoiceItemListQuery {
  const record = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  const fieldErrors: ValidationErrorField[] = [];

  for (const key of Object.keys(record)) {
    if (!ALLOWED_INVOICE_ITEM_QUERY_KEYS.has(key)) {
      fieldErrors.push({
        field: key,
        message: `Unknown query parameter '${key}' is not permitted`,
      });
    }
  }

  const { page, limit } = parsePaginationParams(record, fieldErrors);

  let sort: InvoiceItemSortField = 'createdAt';
  if (record.sort !== undefined) {
    if (
      typeof record.sort !== 'string' ||
      !(INVOICE_ITEM_SORT_FIELDS as readonly string[]).includes(record.sort.trim())
    ) {
      fieldErrors.push({
        field: 'sort',
        message: `Query parameter 'sort' must be one of: ${INVOICE_ITEM_SORT_FIELDS.join(', ')}`,
      });
    } else {
      sort = record.sort.trim() as InvoiceItemSortField;
    }
  }

  const order = parseSortOrder(record.order, fieldErrors, 'asc');

  let description: string | undefined;
  if (record.description !== undefined) {
    if (typeof record.description !== 'string' || record.description.trim().length === 0) {
      fieldErrors.push({
        field: 'description',
        message: "Query parameter 'description' must be a non-empty string",
      });
    } else if (record.description.trim().length > MAX_ITEM_DESCRIPTION_LENGTH) {
      fieldErrors.push({
        field: 'description',
        message: `Query parameter 'description' cannot exceed ${MAX_ITEM_DESCRIPTION_LENGTH} characters`,
      });
    } else {
      description = record.description.trim();
    }
  }

  if (fieldErrors.length > 0) {
    throw new ValidationError('Request validation failed', fieldErrors);
  }

  return {
    page,
    limit,
    description,
    sort,
    order,
  };
}
