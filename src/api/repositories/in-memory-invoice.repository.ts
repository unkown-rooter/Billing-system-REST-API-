import { Invoice, InvoiceItem, isValidInvoiceStatus } from '../models/invoice.model.js';
import {
  InvoiceListQuery,
  InvoiceItemListQuery,
  PaginatedResult,
  buildPaginationMeta,
} from '../models/pagination.model.js';
import { IInvoiceRepository, InvoiceUpdatePersistenceData } from './invoice.repository.interface.js';
import { ICustomerRepository } from './customer.repository.interface.js';
import {
  DuplicateResourceError,
  NotFoundError,
  ValidationError,
} from '../services/errors.js';

/**
 * In-Memory Invoice Repository
 * Enforces relational invariants (foreign keys, unique invoice_number, atomic item creation,
 * cascade deletion of invoice_items) matching the PostgreSQL repository semantics.
 */
export class InMemoryInvoiceRepository implements IInvoiceRepository {
  private readonly invoices: Map<string, Omit<Invoice, 'items'>> = new Map();
  private readonly itemsByInvoiceId: Map<string, InvoiceItem[]> = new Map();

  constructor(private readonly customerRepo?: ICustomerRepository) {}

  private cloneItem(item: InvoiceItem): InvoiceItem {
    return { ...item };
  }

  private hydrateInvoice(header: Omit<Invoice, 'items'>): Invoice {
    const items = (this.itemsByInvoiceId.get(header.id) || []).map((i) => this.cloneItem(i));
    return {
      ...header,
      items,
    };
  }

  async findAll(): Promise<Invoice[]> {
    return Array.from(this.invoices.values()).map((inv) => this.hydrateInvoice(inv));
  }

  async findByAccountId(accountId: string): Promise<Invoice[]> {
    if (!this.customerRepo) {
      return [];
    }
    const ownedCustomers = await this.customerRepo.findByAccountId(accountId);
    const ownedCustomerIds = new Set(ownedCustomers.map((c) => c.id));
    return Array.from(this.invoices.values())
      .filter((inv) => ownedCustomerIds.has(inv.customerId))
      .map((inv) => this.hydrateInvoice(inv));
  }

  async findByCustomerId(customerId: string): Promise<Invoice[]> {
    return Array.from(this.invoices.values())
      .filter((inv) => inv.customerId === customerId)
      .map((inv) => this.hydrateInvoice(inv));
  }

  async findPaginated(query: InvoiceListQuery): Promise<PaginatedResult<Invoice>> {
    let headers = Array.from(this.invoices.values());

    // 1. Authorization Scope First (via parent Customer ownership)
    if (query.accountId !== undefined) {
      if (!this.customerRepo) {
        headers = [];
      } else {
        const ownedCustomers = await this.customerRepo.findByAccountId(query.accountId);
        const ownedIds = new Set(ownedCustomers.map((c) => c.id));
        headers = headers.filter((inv) => ownedIds.has(inv.customerId));
      }
    }

    // 2. Domain Filtering
    if (query.customerId !== undefined) {
      headers = headers.filter((inv) => inv.customerId === query.customerId);
    }

    if (query.status !== undefined) {
      headers = headers.filter((inv) => inv.status === query.status);
    }

    if (query.currency !== undefined) {
      const targetCurrency = query.currency.toUpperCase();
      headers = headers.filter((inv) => inv.currency.toUpperCase() === targetCurrency);
    }

    if (query.issueDate !== undefined) {
      const targetTime = new Date(query.issueDate).getTime();
      headers = headers.filter((inv) => new Date(inv.issueDate).getTime() === targetTime);
    }

    if (query.issueDateFrom !== undefined) {
      const fromTime = new Date(query.issueDateFrom).getTime();
      headers = headers.filter((inv) => new Date(inv.issueDate).getTime() >= fromTime);
    }

    if (query.issueDateTo !== undefined) {
      const toTime = new Date(query.issueDateTo).getTime();
      headers = headers.filter((inv) => new Date(inv.issueDate).getTime() <= toTime);
    }

    if (query.dueDate !== undefined) {
      const targetTime = new Date(query.dueDate).getTime();
      headers = headers.filter((inv) => new Date(inv.dueDate).getTime() === targetTime);
    }

    if (query.dueDateFrom !== undefined) {
      const fromTime = new Date(query.dueDateFrom).getTime();
      headers = headers.filter((inv) => new Date(inv.dueDate).getTime() >= fromTime);
    }

    if (query.dueDateTo !== undefined) {
      const toTime = new Date(query.dueDateTo).getTime();
      headers = headers.filter((inv) => new Date(inv.dueDate).getTime() <= toTime);
    }

    // 3. Authoritative Filtered Total
    const total = headers.length;

    // 4. Deterministic Sorting (with ID tie-breaker)
    const dir = query.order === 'desc' ? -1 : 1;
    headers.sort((a, b) => {
      const valA = a[query.sort];
      const valB = b[query.sort];
      if (valA < valB) return -1 * dir;
      if (valA > valB) return 1 * dir;
      return a.id.localeCompare(b.id) * dir;
    });

    // 5. Offset Pagination & Item Hydration
    const offset = (query.page - 1) * query.limit;
    const paged = headers
      .slice(offset, offset + query.limit)
      .map((inv) => this.hydrateInvoice(inv));

    return {
      items: paged,
      pagination: buildPaginationMeta(query.page, query.limit, total),
    };
  }

  async findById(id: string): Promise<Invoice | null> {
    const header = this.invoices.get(id);
    if (!header) {
      return null;
    }
    return this.hydrateInvoice(header);
  }

  async findByInvoiceNumber(invoiceNumber: string): Promise<Invoice | null> {
    const normalized = invoiceNumber.trim().toUpperCase();
    for (const inv of this.invoices.values()) {
      if (inv.invoiceNumber.toUpperCase() === normalized) {
        return this.hydrateInvoice(inv);
      }
    }
    return null;
  }

  async findItemsByInvoiceId(invoiceId: string): Promise<InvoiceItem[]> {
    const items = this.itemsByInvoiceId.get(invoiceId);
    if (!items) {
      return [];
    }
    return items.map((i) => this.cloneItem(i));
  }

  async findItemsPaginated(
    invoiceId: string,
    query: InvoiceItemListQuery
  ): Promise<PaginatedResult<InvoiceItem>> {
    let items = (this.itemsByInvoiceId.get(invoiceId) || []).map((i) => this.cloneItem(i));

    if (query.description !== undefined) {
      const needle = query.description.toLowerCase();
      items = items.filter((item) => item.description.toLowerCase().includes(needle));
    }

    const total = items.length;

    const dir = query.order === 'desc' ? -1 : 1;
    items.sort((a, b) => {
      const valA = a[query.sort];
      const valB = b[query.sort];
      if (valA < valB) return -1 * dir;
      if (valA > valB) return 1 * dir;
      return a.id.localeCompare(b.id) * dir;
    });

    const offset = (query.page - 1) * query.limit;
    const paged = items.slice(offset, offset + query.limit);

    return {
      items: paged,
      pagination: buildPaginationMeta(query.page, query.limit, total),
    };
  }

  async create(invoice: Invoice): Promise<Invoice> {
    if (!isValidInvoiceStatus(invoice.status)) {
      throw new ValidationError(`Invalid invoice status '${String(invoice.status)}'`);
    }

    if (!invoice.items || invoice.items.length === 0) {
      throw new ValidationError('Invoice must contain at least one invoice item');
    }

    // Foreign key check against customers if customerRepo is wired
    if (this.customerRepo) {
      const customer = await this.customerRepo.findById(invoice.customerId);
      if (!customer) {
        throw new NotFoundError(`Customer with ID '${invoice.customerId}' not found`);
      }
    }

    // Unique invoiceNumber constraint
    for (const existing of this.invoices.values()) {
      if (existing.invoiceNumber.toUpperCase() === invoice.invoiceNumber.toUpperCase()) {
        throw new DuplicateResourceError(
          `An invoice with invoice number '${invoice.invoiceNumber}' already exists`
        );
      }
    }

    // Validate item constraints before committing anything (atomic semantics)
    const clonedItems: InvoiceItem[] = [];
    for (const item of invoice.items) {
      if (!item.description || item.description.trim().length === 0) {
        throw new ValidationError('Invoice item description cannot be empty');
      }
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new ValidationError('Invoice item quantity must be a positive integer');
      }
      if (typeof item.unitPrice !== 'number' || item.unitPrice < 0) {
        throw new ValidationError('Invoice item unitPrice must be a non-negative number');
      }
      clonedItems.push({
        ...item,
        invoiceId: invoice.id,
      });
    }

    const { items: _items, ...header } = invoice;
    this.invoices.set(invoice.id, { ...header });
    this.itemsByInvoiceId.set(invoice.id, clonedItems);

    return this.hydrateInvoice(header);
  }

  async update(id: string, updates: InvoiceUpdatePersistenceData): Promise<Invoice | null> {
    const existing = this.invoices.get(id);
    if (!existing) {
      return null;
    }

    if (updates.status !== undefined && !isValidInvoiceStatus(updates.status)) {
      throw new ValidationError(`Invalid invoice status '${String(updates.status)}'`);
    }

    const updatedHeader: Omit<Invoice, 'items'> = {
      ...existing,
      status: updates.status ?? existing.status,
      subtotal: updates.subtotal ?? existing.subtotal,
      tax: updates.tax ?? existing.tax,
      discount: updates.discount ?? existing.discount,
      total: updates.total ?? existing.total,
      dueDate: updates.dueDate ?? existing.dueDate,
      notes: updates.notes !== undefined ? updates.notes : existing.notes,
      updatedAt: updates.updatedAt,
      // Immutable fields strictly preserved
      id: existing.id,
      customerId: existing.customerId,
      invoiceNumber: existing.invoiceNumber,
      currency: existing.currency,
      issueDate: existing.issueDate,
      createdAt: existing.createdAt,
    };

    if (updates.items !== undefined) {
      if (updates.items.length === 0) {
        throw new ValidationError('Invoice must contain at least one invoice item');
      }
      const clonedItems = updates.items.map((item) => ({
        ...item,
        invoiceId: id,
      }));
      this.itemsByInvoiceId.set(id, clonedItems);
    }

    this.invoices.set(id, updatedHeader);
    return this.hydrateInvoice(updatedHeader);
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.invoices.delete(id);
    if (existed) {
      // ON DELETE CASCADE for invoice_items
      this.itemsByInvoiceId.delete(id);
    }
    return existed;
  }

  async countByCustomerId(customerId: string): Promise<number> {
    let count = 0;
    for (const inv of this.invoices.values()) {
      if (inv.customerId === customerId) {
        count++;
      }
    }
    return count;
  }
}
