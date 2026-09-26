import { Invoice, InvoiceItem, InvoiceStatus } from '../models/invoice.model.js';
import {
  InvoiceListQuery,
  InvoiceItemListQuery,
  PaginatedResult,
} from '../models/pagination.model.js';

export interface InvoiceUpdatePersistenceData {
  status?: InvoiceStatus;
  subtotal?: number;
  tax?: number;
  discount?: number;
  total?: number;
  dueDate?: string;
  notes?: string | null;
  items?: InvoiceItem[];
  updatedAt: string;
}

/**
 * Invoice Repository Interface
 * Defines the persistence contract for Invoice and InvoiceItem relational aggregates.
 */
export interface IInvoiceRepository {
  findAll(): Promise<Invoice[]>;
  findByAccountId(accountId: string): Promise<Invoice[]>;
  findByCustomerId(customerId: string): Promise<Invoice[]>;
  findPaginated?(query: InvoiceListQuery): Promise<PaginatedResult<Invoice>>;
  findById(id: string): Promise<Invoice | null>;
  findByInvoiceNumber(invoiceNumber: string): Promise<Invoice | null>;
  findItemsByInvoiceId(invoiceId: string): Promise<InvoiceItem[]>;
  findItemsPaginated?(
    invoiceId: string,
    query: InvoiceItemListQuery
  ): Promise<PaginatedResult<InvoiceItem>>;
  create(invoice: Invoice): Promise<Invoice>;
  update(id: string, updates: InvoiceUpdatePersistenceData): Promise<Invoice | null>;
  delete(id: string): Promise<boolean>;
  countByCustomerId(customerId: string): Promise<number>;
}
