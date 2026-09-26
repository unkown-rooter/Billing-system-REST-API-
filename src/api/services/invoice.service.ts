import { randomUUID, randomBytes } from 'node:crypto';
import {
  Invoice,
  InvoiceItem,
  CreateInvoiceDTO,
  CreateInvoiceItemDTO,
  UpdateInvoiceDTO,
  DEFAULT_INVOICE_STATUS,
  isValidInvoiceStatus,
} from '../models/invoice.model.js';
import { Customer } from '../models/customer.model.js';
import {
  InvoiceListQuery,
  InvoiceItemListQuery,
  PaginatedResult,
  buildPaginationMeta,
} from '../models/pagination.model.js';
import { AuthenticatedUser } from '../models/account.model.js';
import { IInvoiceRepository, InvoiceUpdatePersistenceData } from '../repositories/invoice.repository.interface.js';
import { ICustomerRepository } from '../repositories/customer.repository.interface.js';
import {
  ValidationError,
  NotFoundError,
  AuthenticationRequiredError,
  ForbiddenError,
  ConflictError,
} from './errors.js';

/**
 * Invoice Service
 * Orchestrates relational billing operations across Customer → Invoice → InvoiceItem.
 * 
 * Key Responsibilities:
 * 1. Referential Integrity: Verifies parent Customer exists (`404 RESOURCE_NOT_FOUND` if missing).
 * 2. Ownership & Authorization: Enforces that the authenticated actor owns the parent Customer
 *    (`customer.accountId === actor.id`) or holds the `'admin'` role (`403 FORBIDDEN` on IDOR).
 * 3. Authoritative Financial Calculation (Integer Cents Precision):
 *    - `lineTotal = fromCents(quantity * toCents(unitPrice))`
 *    - `subtotal = fromCents(sum(items.lineTotalCents))`
 *    - `total = fromCents(subtotalCents + taxCents - discountCents)`
 *    - Rejects any discount that exceeds `subtotal + tax` (`total` cannot be negative).
 * 4. Currency Consistency: Inherits `customer.currency` by default; rejects mismatched currencies.
 */
export class InvoiceService {
  private sequenceCounter = 0;

  constructor(
    private readonly invoiceRepo: IInvoiceRepository,
    private readonly customerRepo: ICustomerRepository
  ) {}

  private generateInvoiceId(): string {
    return `inv_${randomUUID()}`;
  }

  private generateItemId(index: number = 0): string {
    const seq = String(index + 1).padStart(4, '0');
    return `item_${seq}_${randomUUID()}`;
  }

  /**
   * Generates a unique human-readable invoice number.
   * Format: `INV-<YYYY>-<6-digit-seq>-<4-hex>`
   */
  private generateInvoiceNumber(issueDateIso: string): string {
    this.sequenceCounter += 1;
    const year = new Date(issueDateIso).getUTCFullYear();
    const seq = String(this.sequenceCounter).padStart(4, '0');
    const suffix = randomBytes(2).toString('hex').toUpperCase();
    return `INV-${year}-${seq}-${suffix}`;
  }

  private toCents(amount: number): number {
    return Math.round(amount * 100);
  }

  private fromCents(cents: number): number {
    return Number((cents / 100).toFixed(2));
  }

  private assertAuthenticated(actor?: AuthenticatedUser): asserts actor is AuthenticatedUser {
    if (!actor || !actor.id) {
      throw new AuthenticationRequiredError('Authentication is required');
    }
  }

  private assertCanAccessCustomer(actor: AuthenticatedUser, customer: Customer): void {
    if (actor.role === 'admin') {
      return;
    }
    if (customer.accountId !== actor.id) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }
  }

  private buildComputedItems(
    invoiceId: string,
    rawItems: CreateInvoiceItemDTO[],
    timestampIso: string
  ): { items: InvoiceItem[]; subtotalCents: number } {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new ValidationError('Invoice must contain at least one line item', [
        { field: 'items', message: "Field 'items' must contain at least one line item" },
      ]);
    }

    let subtotalCents = 0;
    const computedItems: InvoiceItem[] = rawItems.map((raw, idx) => {
      const description = raw.description?.trim();
      if (!description) {
        throw new ValidationError(`Line item ${idx} description cannot be empty`);
      }
      if (!Number.isInteger(raw.quantity) || raw.quantity <= 0) {
        throw new ValidationError(`Line item ${idx} quantity must be a positive integer`);
      }
      if (typeof raw.unitPrice !== 'number' || !Number.isFinite(raw.unitPrice) || raw.unitPrice < 0) {
        throw new ValidationError(`Line item ${idx} unitPrice must be a non-negative number`);
      }

      const unitPriceCents = this.toCents(raw.unitPrice);
      const lineTotalCents = raw.quantity * unitPriceCents;
      subtotalCents += lineTotalCents;

      return {
        id: this.generateItemId(idx),
        invoiceId,
        description,
        quantity: raw.quantity,
        unitPrice: this.fromCents(unitPriceCents),
        lineTotal: this.fromCents(lineTotalCents),
        createdAt: timestampIso,
        updatedAt: timestampIso,
      };
    });

    return { items: computedItems, subtotalCents };
  }

  async getAllInvoices(actor: AuthenticatedUser): Promise<Invoice[]> {
    this.assertAuthenticated(actor);
    if (actor.role === 'admin') {
      return this.invoiceRepo.findAll();
    }
    return this.invoiceRepo.findByAccountId(actor.id);
  }

  async listInvoices(
    query: InvoiceListQuery,
    actor: AuthenticatedUser
  ): Promise<PaginatedResult<Invoice>> {
    this.assertAuthenticated(actor);

    const scopedQuery: InvoiceListQuery = {
      ...query,
      accountId: actor.role === 'admin' ? undefined : actor.id,
    };

    if (this.invoiceRepo.findPaginated) {
      return this.invoiceRepo.findPaginated(scopedQuery);
    }

    const all = await this.getAllInvoices(actor);
    const offset = (scopedQuery.page - 1) * scopedQuery.limit;
    return {
      items: all.slice(offset, offset + scopedQuery.limit),
      pagination: buildPaginationMeta(scopedQuery.page, scopedQuery.limit, all.length),
    };
  }

  async getCustomerInvoices(customerId: string, actor: AuthenticatedUser): Promise<Invoice[]> {
    this.assertAuthenticated(actor);

    const customer = await this.customerRepo.findById(customerId);
    if (!customer) {
      throw new NotFoundError(`Customer with ID '${customerId}' not found`);
    }

    // Enforce customer ownership (IDOR protection)
    this.assertCanAccessCustomer(actor, customer);

    return this.invoiceRepo.findByCustomerId(customerId);
  }

  async listCustomerInvoices(
    customerId: string,
    query: InvoiceListQuery,
    actor: AuthenticatedUser
  ): Promise<PaginatedResult<Invoice>> {
    this.assertAuthenticated(actor);

    const customer = await this.customerRepo.findById(customerId);
    if (!customer) {
      throw new NotFoundError(`Customer with ID '${customerId}' not found`);
    }

    // Enforce customer ownership BEFORE executing query (IDOR protection -> 403 FORBIDDEN)
    this.assertCanAccessCustomer(actor, customer);

    const scopedQuery: InvoiceListQuery = {
      ...query,
      customerId,
      accountId: actor.role === 'admin' ? undefined : actor.id,
    };

    if (this.invoiceRepo.findPaginated) {
      return this.invoiceRepo.findPaginated(scopedQuery);
    }

    const all = await this.invoiceRepo.findByCustomerId(customerId);
    const offset = (scopedQuery.page - 1) * scopedQuery.limit;
    return {
      items: all.slice(offset, offset + scopedQuery.limit),
      pagination: buildPaginationMeta(scopedQuery.page, scopedQuery.limit, all.length),
    };
  }

  async getInvoiceById(id: string, actor: AuthenticatedUser): Promise<Invoice> {
    this.assertAuthenticated(actor);

    const invoice = await this.invoiceRepo.findById(id);
    if (!invoice) {
      throw new NotFoundError(`Invoice with ID '${id}' not found`);
    }

    const customer = await this.customerRepo.findById(invoice.customerId);
    if (!customer) {
      throw new NotFoundError(`Parent customer '${invoice.customerId}' not found`);
    }

    this.assertCanAccessCustomer(actor, customer);
    return invoice;
  }

  async getInvoiceItems(invoiceId: string, actor: AuthenticatedUser): Promise<InvoiceItem[]> {
    // Reuses getInvoiceById to verify invoice existence and parent customer ownership
    const invoice = await this.getInvoiceById(invoiceId, actor);
    return invoice.items;
  }

  async listInvoiceItems(
    invoiceId: string,
    query: InvoiceItemListQuery,
    actor: AuthenticatedUser
  ): Promise<PaginatedResult<InvoiceItem>> {
    // Verify invoice existence (404) and parent customer ownership (403) first
    const invoice = await this.getInvoiceById(invoiceId, actor);

    if (this.invoiceRepo.findItemsPaginated) {
      return this.invoiceRepo.findItemsPaginated(invoice.id, query);
    }

    const offset = (query.page - 1) * query.limit;
    return {
      items: invoice.items.slice(offset, offset + query.limit),
      pagination: buildPaginationMeta(query.page, query.limit, invoice.items.length),
    };
  }

  async createInvoice(dto: CreateInvoiceDTO, actor: AuthenticatedUser): Promise<Invoice> {
    this.assertAuthenticated(actor);

    const customerId = dto.customerId?.trim();
    if (!customerId) {
      throw new ValidationError("Field 'customerId' is required", [
        { field: 'customerId', message: "Field 'customerId' is required" },
      ]);
    }

    // 1. Verify parent Customer exists (Referential Integrity)
    const customer = await this.customerRepo.findById(customerId);
    if (!customer) {
      throw new NotFoundError(`Customer with ID '${customerId}' not found`);
    }

    // 2. Verify actor owns the parent Customer or is admin (IDOR Protection)
    this.assertCanAccessCustomer(actor, customer);

    // 3. Enforce currency consistency with Customer ledger currency
    const currency = dto.currency ? dto.currency.trim().toUpperCase() : customer.currency;
    if (currency !== customer.currency) {
      throw new ValidationError(
        `Invoice currency '${currency}' does not match customer currency '${customer.currency}'`,
        [
          {
            field: 'currency',
            message: `Invoice currency must match customer currency (${customer.currency})`,
          },
        ]
      );
    }

    // 4. Validate status
    const status = dto.status ?? DEFAULT_INVOICE_STATUS;
    if (!isValidInvoiceStatus(status)) {
      throw new ValidationError(`Invalid invoice status '${String(status)}'`);
    }

    // 5. Timestamps & Dates
    const nowIso = new Date().toISOString();
    const issueDateIso = dto.issueDate ? new Date(dto.issueDate).toISOString() : nowIso;
    const defaultDueDate = new Date(new Date(issueDateIso).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const dueDateIso = dto.dueDate ? new Date(dto.dueDate).toISOString() : defaultDueDate;

    if (new Date(dueDateIso).getTime() < new Date(issueDateIso).getTime()) {
      throw new ValidationError("Field 'dueDate' cannot be earlier than 'issueDate'", [
        { field: 'dueDate', message: "Field 'dueDate' must be on or after 'issueDate'" },
      ]);
    }

    // 6. Authoritative Financial Calculation in Integer Cents
    const invoiceId = this.generateInvoiceId();
    const { items, subtotalCents } = this.buildComputedItems(invoiceId, dto.items, nowIso);

    const taxCents = this.toCents(dto.tax ?? 0);
    const discountCents = this.toCents(dto.discount ?? 0);

    if (taxCents < 0) {
      throw new ValidationError("Field 'tax' must be non-negative");
    }
    if (discountCents < 0) {
      throw new ValidationError("Field 'discount' must be non-negative");
    }

    const totalCents = subtotalCents + taxCents - discountCents;
    if (totalCents < 0) {
      throw new ValidationError(
        'Invoice discount cannot exceed subtotal plus tax (total cannot be negative)',
        [
          {
            field: 'discount',
            message: 'Discount exceeds invoice subtotal plus tax',
          },
        ]
      );
    }

    const invoice: Invoice = {
      id: invoiceId,
      customerId: customer.id,
      invoiceNumber: this.generateInvoiceNumber(issueDateIso),
      status,
      currency,
      subtotal: this.fromCents(subtotalCents),
      tax: this.fromCents(taxCents),
      discount: this.fromCents(discountCents),
      total: this.fromCents(totalCents),
      issueDate: issueDateIso,
      dueDate: dueDateIso,
      notes: dto.notes ?? null,
      items,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    return this.invoiceRepo.create(invoice);
  }

  async updateInvoice(
    id: string,
    dto: UpdateInvoiceDTO,
    actor: AuthenticatedUser
  ): Promise<Invoice> {
    this.assertAuthenticated(actor);

    const existing = await this.invoiceRepo.findById(id);
    if (!existing) {
      throw new NotFoundError(`Invoice with ID '${id}' not found`);
    }

    const customer = await this.customerRepo.findById(existing.customerId);
    if (!customer) {
      throw new NotFoundError(`Parent customer '${existing.customerId}' not found`);
    }

    // Enforce ownership BEFORE applying any state or financial checks
    this.assertCanAccessCustomer(actor, customer);

    // Prevent modifying financial line items/amounts on finalized (paid/cancelled) invoices
    const isModifyingFinancials =
      dto.items !== undefined || dto.tax !== undefined || dto.discount !== undefined;
    if (
      isModifyingFinancials &&
      (existing.status === 'paid' || existing.status === 'cancelled')
    ) {
      throw new ConflictError(
        `Cannot modify line items or financial amounts of a '${existing.status}' invoice`
      );
    }

    const nowIso = new Date().toISOString();
    const updates: InvoiceUpdatePersistenceData = {
      updatedAt: nowIso,
    };

    if (dto.status !== undefined) {
      if (!isValidInvoiceStatus(dto.status)) {
        throw new ValidationError(`Invalid invoice status '${String(dto.status)}'`);
      }
      updates.status = dto.status;
    }

    if (dto.dueDate !== undefined) {
      const dueDateIso = new Date(dto.dueDate).toISOString();
      if (new Date(dueDateIso).getTime() < new Date(existing.issueDate).getTime()) {
        throw new ValidationError("Field 'dueDate' cannot be earlier than 'issueDate'", [
          { field: 'dueDate', message: "Field 'dueDate' must be on or after 'issueDate'" },
        ]);
      }
      updates.dueDate = dueDateIso;
    }

    if (dto.notes !== undefined) {
      updates.notes = dto.notes;
    }

    // Recalculate authoritative financials if items, tax, or discount changed
    if (isModifyingFinancials) {
      let subtotalCents: number;
      if (dto.items !== undefined) {
        const computed = this.buildComputedItems(existing.id, dto.items, nowIso);
        updates.items = computed.items;
        subtotalCents = computed.subtotalCents;
      } else {
        subtotalCents = this.toCents(existing.subtotal);
      }

      const taxCents = this.toCents(dto.tax !== undefined ? dto.tax : existing.tax);
      const discountCents = this.toCents(
        dto.discount !== undefined ? dto.discount : existing.discount
      );
      const totalCents = subtotalCents + taxCents - discountCents;

      if (totalCents < 0) {
        throw new ValidationError(
          'Invoice discount cannot exceed subtotal plus tax (total cannot be negative)',
          [
            {
              field: 'discount',
              message: 'Discount exceeds invoice subtotal plus tax',
            },
          ]
        );
      }

      updates.subtotal = this.fromCents(subtotalCents);
      updates.tax = this.fromCents(taxCents);
      updates.discount = this.fromCents(discountCents);
      updates.total = this.fromCents(totalCents);
    }

    const updated = await this.invoiceRepo.update(id, updates);
    if (!updated) {
      throw new NotFoundError(`Invoice with ID '${id}' not found`);
    }

    return updated;
  }

  async deleteInvoice(id: string, actor: AuthenticatedUser): Promise<void> {
    this.assertAuthenticated(actor);

    if (actor.role !== 'admin') {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    const existing = await this.invoiceRepo.findById(id);
    if (!existing) {
      throw new NotFoundError(`Invoice with ID '${id}' not found`);
    }

    await this.invoiceRepo.delete(id);
  }
}
