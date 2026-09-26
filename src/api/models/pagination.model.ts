import { InvoiceStatus } from './invoice.model.js';

/**
 * Pagination, Filtering & Sorting Domain Contracts (Phase 7)
 * 
 * Strategy: Offset / Page Pagination
 * - `page`: 1-indexed page number (default: 1, min: 1)
 * - `limit`: Maximum records returned per page (default: 20, min: 1, max: 100)
 * - `offset`: Derived server-side as `(page - 1) * limit`
 */

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MIN_PAGE = 1;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 100;

export type SortOrder = 'asc' | 'desc';

export const VALID_SORT_ORDERS = ['asc', 'desc'] as const;

export const CUSTOMER_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'email'] as const;
export type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

export const INVOICE_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'issueDate',
  'dueDate',
  'total',
  'subtotal',
  'invoiceNumber',
  'status',
] as const;
export type InvoiceSortField = (typeof INVOICE_SORT_FIELDS)[number];

export const INVOICE_ITEM_SORT_FIELDS = [
  'createdAt',
  'quantity',
  'unitPrice',
  'lineTotal',
  'description',
] as const;
export type InvoiceItemSortField = (typeof INVOICE_ITEM_SORT_FIELDS)[number];

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
}

export interface CustomerListQuery extends PaginationParams {
  accountId?: string; // Injected server-side by service authorization scope (never from client query)
  currency?: string;
  email?: string;
  name?: string;
  sort: CustomerSortField;
  order: SortOrder;
}

export interface InvoiceListQuery extends PaginationParams {
  accountId?: string; // Injected server-side by service authorization scope (never from client query)
  customerId?: string;
  status?: InvoiceStatus;
  currency?: string;
  issueDate?: string;
  issueDateFrom?: string;
  issueDateTo?: string;
  dueDate?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  sort: InvoiceSortField;
  order: SortOrder;
}

export interface InvoiceItemListQuery extends PaginationParams {
  description?: string;
  sort: InvoiceItemSortField;
  order: SortOrder;
}

/**
 * Computes consistent pagination metadata from `page`, `limit`, and authoritative `total`.
 */
export function buildPaginationMeta(page: number, limit: number, total: number): PaginationMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}
