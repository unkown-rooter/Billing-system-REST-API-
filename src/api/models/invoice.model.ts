/**
 * Invoice & InvoiceItem Relational Domain Models
 * 
 * Relational Hierarchy:
 * Account (1) ──> (0..N) Customer (1) ──> (0..N) Invoice (1) ──> (1..N) InvoiceItem
 * 
 * Domain & Financial Invariants:
 * - Internal ID (`id`): `inv_<uuidv4>` for invoices, `item_<uuidv4>` for line items.
 * - Human-Readable Number (`invoiceNumber`): Unique sequential/structured identifier (`INV-YYYY-XXXXXX`).
 * - Status (`status`): Restricted to `'draft' | 'issued' | 'paid' | 'overdue' | 'cancelled'`.
 * - Authoritative Financial Math:
 *   - `lineTotal = quantity * unitPrice` (computed server-side in integer cents)
 *   - `subtotal = sum(items.lineTotal)` (computed server-side in integer cents)
 *   - `total = subtotal + tax - discount` (computed server-side in integer cents, must be >= 0)
 *   - Clients may NEVER supply pre-computed `lineTotal`, `subtotal`, or `total`.
 */

export const VALID_INVOICE_STATUSES = [
  'draft',
  'issued',
  'paid',
  'overdue',
  'cancelled',
] as const;

export type InvoiceStatus = (typeof VALID_INVOICE_STATUSES)[number];

export const DEFAULT_INVOICE_STATUS: InvoiceStatus = 'draft';

export function isValidInvoiceStatus(value: unknown): value is InvoiceStatus {
  return (
    typeof value === 'string' &&
    (VALID_INVOICE_STATUSES as readonly string[]).includes(value)
  );
}

export interface InvoiceItem {
  id: string; // item_<uuidv4>
  invoiceId: string; // inv_<uuidv4>
  description: string;
  quantity: number; // integer > 0
  unitPrice: number; // monetary amount >= 0 (2 decimal precision)
  lineTotal: number; // authoritative server-computed: quantity * unitPrice
  createdAt: string;
  updatedAt: string;
}

export interface Invoice {
  id: string; // inv_<uuidv4>
  customerId: string; // cus_<uuidv4>
  invoiceNumber: string; // INV-YYYY-XXXXXX (unique)
  status: InvoiceStatus;
  currency: string; // 3-letter ISO 4217 (matches customer currency)
  subtotal: number; // authoritative server-computed sum of item lineTotals
  tax: number; // >= 0
  discount: number; // >= 0
  total: number; // authoritative server-computed: subtotal + tax - discount
  issueDate: string; // ISO 8601 timestamp
  dueDate: string; // ISO 8601 timestamp
  notes: string | null;
  items: InvoiceItem[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateInvoiceItemDTO {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateInvoiceDTO {
  customerId?: string; // Required on POST /api/v1/invoices, inferred from :id on POST /api/v1/customers/:id/invoices
  currency?: string;
  status?: InvoiceStatus;
  tax?: number;
  discount?: number;
  issueDate?: string;
  dueDate?: string;
  notes?: string | null;
  items: CreateInvoiceItemDTO[];
}

export interface UpdateInvoiceDTO {
  status?: InvoiceStatus;
  tax?: number;
  discount?: number;
  dueDate?: string;
  notes?: string | null;
  items?: CreateInvoiceItemDTO[];
}
