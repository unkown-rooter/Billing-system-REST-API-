import pg from 'pg';
import { Invoice, InvoiceItem, InvoiceStatus } from '../models/invoice.model.js';
import {
  InvoiceListQuery,
  InvoiceItemListQuery,
  InvoiceSortField,
  InvoiceItemSortField,
  PaginatedResult,
  buildPaginationMeta,
} from '../models/pagination.model.js';
import { IInvoiceRepository, InvoiceUpdatePersistenceData } from './invoice.repository.interface.js';
import {
  DuplicateResourceError,
  NotFoundError,
  ValidationError,
  DatabaseError,
} from '../services/errors.js';
import { redactSensitiveText } from '../security/redaction.js';

const INVOICE_SORT_COLUMN_MAP: Record<InvoiceSortField, string> = {
  createdAt: 'i.created_at',
  updatedAt: 'i.updated_at',
  issueDate: 'i.issue_date',
  dueDate: 'i.due_date',
  total: 'i.total',
  subtotal: 'i.subtotal',
  invoiceNumber: 'i.invoice_number',
  status: 'i.status',
};

const INVOICE_ITEM_SORT_COLUMN_MAP: Record<InvoiceItemSortField, string> = {
  createdAt: 'created_at',
  quantity: 'quantity',
  unitPrice: 'unit_price',
  lineTotal: 'line_total',
  description: 'description',
};

interface InvoiceRow {
  id: string;
  customer_id: string;
  invoice_number: string;
  status: InvoiceStatus;
  currency: string;
  subtotal: string | number;
  tax: string | number;
  discount: string | number;
  total: string | number;
  issue_date: Date | string;
  due_date: Date | string;
  notes: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface InvoiceItemRow {
  id: string;
  invoice_id: string;
  description: string;
  quantity: number | string;
  unit_price: string | number;
  line_total: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * PostgreSQL Implementation of IInvoiceRepository.
 * 
 * Relational & Transaction Guarantees:
 * - Uses explicit SQL transactions (`BEGIN ... COMMIT / ROLLBACK`) when creating or updating
 *   invoices and their line items so partial/itemless invoices can never be persisted.
 * - Uses parameterized SQL queries (`$1, $2, ...`) exclusively.
 * - Executes relational JOINs (`invoices JOIN customers`) to scope queries by owning account.
 * - Translates PostgreSQL error codes (`23505` unique violation, `23503` FK violation, `23514` check violation)
 *   into standardized domain errors without leaking internal SQL details.
 */
export class PostgresInvoiceRepository implements IInvoiceRepository {
  constructor(private readonly pool: pg.Pool) {}

  private toIsoString(val: Date | string): string {
    return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
  }

  private toMoneyNumber(val: string | number): number {
    const num = typeof val === 'number' ? val : parseFloat(val);
    return Number(num.toFixed(2));
  }

  private mapItemRow(row: InvoiceItemRow): InvoiceItem {
    return {
      id: row.id,
      invoiceId: row.invoice_id,
      description: row.description,
      quantity: typeof row.quantity === 'number' ? row.quantity : parseInt(row.quantity, 10),
      unitPrice: this.toMoneyNumber(row.unit_price),
      lineTotal: this.toMoneyNumber(row.line_total),
      createdAt: this.toIsoString(row.created_at),
      updatedAt: this.toIsoString(row.updated_at),
    };
  }

  private mapInvoiceRow(row: InvoiceRow, items: InvoiceItem[]): Invoice {
    return {
      id: row.id,
      customerId: row.customer_id,
      invoiceNumber: row.invoice_number,
      status: row.status,
      currency: row.currency,
      subtotal: this.toMoneyNumber(row.subtotal),
      tax: this.toMoneyNumber(row.tax),
      discount: this.toMoneyNumber(row.discount),
      total: this.toMoneyNumber(row.total),
      issueDate: this.toIsoString(row.issue_date),
      dueDate: this.toIsoString(row.due_date),
      notes: row.notes ?? null,
      items,
      createdAt: this.toIsoString(row.created_at),
      updatedAt: this.toIsoString(row.updated_at),
    };
  }

  private handleDatabaseError(err: unknown, defaultMessage: string = 'Database operation failed'): never {
    if (err instanceof DuplicateResourceError || err instanceof NotFoundError || err instanceof ValidationError) {
      throw err;
    }
    if (err && typeof err === 'object' && 'code' in err) {
      const pgErr = err as { code: string; constraint?: string };
      if (pgErr.code === '23505') {
        throw new DuplicateResourceError('An invoice with this identifier or invoice number already exists');
      }
      if (pgErr.code === '23503') {
        if (pgErr.constraint === 'fk_invoices_customer_id') {
          throw new NotFoundError('Referenced customer does not exist');
        }
        throw new ValidationError('Referenced relational resource does not exist');
      }
      if (pgErr.code === '23514') {
        throw new ValidationError('Invoice or line item failed database integrity constraint check');
      }
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    console.error('[POSTGRES INVOICE REPOSITORY] Operational query failure:', redactSensitiveText(rawMsg));
    throw new DatabaseError(defaultMessage);
  }

  private async attachItemsToInvoices(invoiceRows: InvoiceRow[]): Promise<Invoice[]> {
    if (invoiceRows.length === 0) {
      return [];
    }

    const invoiceIds = invoiceRows.map((r) => r.id);
    const itemsResult = await this.pool.query<InvoiceItemRow>(
      `SELECT id, invoice_id, description, quantity, unit_price, line_total, created_at, updated_at
       FROM invoice_items
       WHERE invoice_id = ANY($1::text[])
       ORDER BY created_at ASC, id ASC;`,
      [invoiceIds]
    );

    const itemsMap = new Map<string, InvoiceItem[]>();
    for (const itemRow of itemsResult.rows) {
      const item = this.mapItemRow(itemRow);
      const list = itemsMap.get(item.invoiceId) || [];
      list.push(item);
      itemsMap.set(item.invoiceId, list);
    }

    return invoiceRows.map((row) => this.mapInvoiceRow(row, itemsMap.get(row.id) || []));
  }

  async findAll(): Promise<Invoice[]> {
    try {
      const result = await this.pool.query<InvoiceRow>(
        `SELECT id, customer_id, invoice_number, status, currency, subtotal, tax, discount, total,
                issue_date, due_date, notes, created_at, updated_at
         FROM invoices
         ORDER BY created_at ASC, id ASC;`
      );
      return await this.attachItemsToInvoices(result.rows);
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to retrieve invoices from database');
    }
  }

  async findByAccountId(accountId: string): Promise<Invoice[]> {
    try {
      const result = await this.pool.query<InvoiceRow>(
        `SELECT i.id, i.customer_id, i.invoice_number, i.status, i.currency, i.subtotal, i.tax, i.discount, i.total,
                i.issue_date, i.due_date, i.notes, i.created_at, i.updated_at
         FROM invoices i
         INNER JOIN customers c ON c.id = i.customer_id
         WHERE c.account_id = $1
         ORDER BY i.created_at ASC, i.id ASC;`,
        [accountId]
      );
      return await this.attachItemsToInvoices(result.rows);
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to retrieve account invoices from database');
    }
  }

  async findByCustomerId(customerId: string): Promise<Invoice[]> {
    try {
      const result = await this.pool.query<InvoiceRow>(
        `SELECT id, customer_id, invoice_number, status, currency, subtotal, tax, discount, total,
                issue_date, due_date, notes, created_at, updated_at
         FROM invoices
         WHERE customer_id = $1
         ORDER BY created_at ASC, id ASC;`,
        [customerId]
      );
      return await this.attachItemsToInvoices(result.rows);
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to retrieve customer invoices from database');
    }
  }

  async findPaginated(query: InvoiceListQuery): Promise<PaginatedResult<Invoice>> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // 1. Authorization Scope First (via INNER JOIN customers c ON c.id = i.customer_id)
    const joinClause =
      query.accountId !== undefined ? 'INNER JOIN customers c ON c.id = i.customer_id' : '';
    if (query.accountId !== undefined) {
      conditions.push(`c.account_id = $${paramIndex++}`);
      params.push(query.accountId);
    }

    // 2. Parameterized Domain Filters
    if (query.customerId !== undefined) {
      conditions.push(`i.customer_id = $${paramIndex++}`);
      params.push(query.customerId);
    }

    if (query.status !== undefined) {
      conditions.push(`i.status = $${paramIndex++}`);
      params.push(query.status);
    }

    if (query.currency !== undefined) {
      conditions.push(`i.currency = $${paramIndex++}`);
      params.push(query.currency.toUpperCase());
    }

    if (query.issueDate !== undefined) {
      conditions.push(`i.issue_date = $${paramIndex++}`);
      params.push(query.issueDate);
    }

    if (query.issueDateFrom !== undefined) {
      conditions.push(`i.issue_date >= $${paramIndex++}`);
      params.push(query.issueDateFrom);
    }

    if (query.issueDateTo !== undefined) {
      conditions.push(`i.issue_date <= $${paramIndex++}`);
      params.push(query.issueDateTo);
    }

    if (query.dueDate !== undefined) {
      conditions.push(`i.due_date = $${paramIndex++}`);
      params.push(query.dueDate);
    }

    if (query.dueDateFrom !== undefined) {
      conditions.push(`i.due_date >= $${paramIndex++}`);
      params.push(query.dueDateFrom);
    }

    if (query.dueDateTo !== undefined) {
      conditions.push(`i.due_date <= $${paramIndex++}`);
      params.push(query.dueDateTo);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // 3. Strictly Whitelisted Deterministic Sorting (with i.id tie-breaker)
    const sortColumn = INVOICE_SORT_COLUMN_MAP[query.sort] || 'i.created_at';
    const sortDirection = query.order === 'desc' ? 'DESC' : 'ASC';

    const offset = (query.page - 1) * query.limit;

    try {
      const countSql = `
        SELECT COUNT(*)::text AS count
        FROM invoices i
        ${joinClause}
        ${whereClause};
      `;
      const countResult = await this.pool.query<{ count: string }>(countSql, params);
      const total = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);

      const dataParams = [...params, query.limit, offset];
      const limitParam = `$${paramIndex++}`;
      const offsetParam = `$${paramIndex++}`;

      const dataSql = `
        SELECT i.id, i.customer_id, i.invoice_number, i.status, i.currency,
               i.subtotal, i.tax, i.discount, i.total,
               i.issue_date, i.due_date, i.notes, i.created_at, i.updated_at
        FROM invoices i
        ${joinClause}
        ${whereClause}
        ORDER BY ${sortColumn} ${sortDirection}, i.id ${sortDirection}
        LIMIT ${limitParam} OFFSET ${offsetParam};
      `;

      const dataResult = await this.pool.query<InvoiceRow>(dataSql, dataParams);
      const items = await this.attachItemsToInvoices(dataResult.rows);

      return {
        items,
        pagination: buildPaginationMeta(query.page, query.limit, total),
      };
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to query paginated invoices from database');
    }
  }

  async findById(id: string): Promise<Invoice | null> {
    try {
      const result = await this.pool.query<InvoiceRow>(
        `SELECT id, customer_id, invoice_number, status, currency, subtotal, tax, discount, total,
                issue_date, due_date, notes, created_at, updated_at
         FROM invoices
         WHERE id = $1;`,
        [id]
      );
      if (result.rows.length === 0) {
        return null;
      }
      const hydrated = await this.attachItemsToInvoices(result.rows);
      return hydrated[0];
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to retrieve invoice from database');
    }
  }

  async findByInvoiceNumber(invoiceNumber: string): Promise<Invoice | null> {
    try {
      const result = await this.pool.query<InvoiceRow>(
        `SELECT id, customer_id, invoice_number, status, currency, subtotal, tax, discount, total,
                issue_date, due_date, notes, created_at, updated_at
         FROM invoices
         WHERE UPPER(invoice_number) = UPPER($1);`,
        [invoiceNumber.trim()]
      );
      if (result.rows.length === 0) {
        return null;
      }
      const hydrated = await this.attachItemsToInvoices(result.rows);
      return hydrated[0];
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to query invoice by invoice number from database');
    }
  }

  async findItemsByInvoiceId(invoiceId: string): Promise<InvoiceItem[]> {
    try {
      const result = await this.pool.query<InvoiceItemRow>(
        `SELECT id, invoice_id, description, quantity, unit_price, line_total, created_at, updated_at
         FROM invoice_items
         WHERE invoice_id = $1
         ORDER BY created_at ASC, id ASC;`,
        [invoiceId]
      );
      return result.rows.map((r) => this.mapItemRow(r));
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to retrieve invoice items from database');
    }
  }

  async findItemsPaginated(
    invoiceId: string,
    query: InvoiceItemListQuery
  ): Promise<PaginatedResult<InvoiceItem>> {
    const conditions: string[] = ['invoice_id = $1'];
    const params: unknown[] = [invoiceId];
    let paramIndex = 2;

    if (query.description !== undefined) {
      conditions.push(`description ILIKE $${paramIndex++}`);
      params.push(`%${query.description}%`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sortColumn = INVOICE_ITEM_SORT_COLUMN_MAP[query.sort] || 'created_at';
    const sortDirection = query.order === 'desc' ? 'DESC' : 'ASC';
    const offset = (query.page - 1) * query.limit;

    try {
      const countSql = `SELECT COUNT(*)::text AS count FROM invoice_items ${whereClause};`;
      const countResult = await this.pool.query<{ count: string }>(countSql, params);
      const total = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);

      const dataParams = [...params, query.limit, offset];
      const limitParam = `$${paramIndex++}`;
      const offsetParam = `$${paramIndex++}`;

      const dataSql = `
        SELECT id, invoice_id, description, quantity, unit_price, line_total, created_at, updated_at
        FROM invoice_items
        ${whereClause}
        ORDER BY ${sortColumn} ${sortDirection}, id ${sortDirection}
        LIMIT ${limitParam} OFFSET ${offsetParam};
      `;

      const dataResult = await this.pool.query<InvoiceItemRow>(dataSql, dataParams);
      const items = dataResult.rows.map((r) => this.mapItemRow(r));

      return {
        items,
        pagination: buildPaginationMeta(query.page, query.limit, total),
      };
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to query paginated invoice items from database');
    }
  }

  /**
   * Persists an Invoice and all of its InvoiceItems atomically inside a single database transaction.
   * If any item fails validation or constraint checks, the entire transaction is rolled back.
   */
  async create(invoice: Invoice): Promise<Invoice> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const invResult = await client.query<InvoiceRow>(
        `INSERT INTO invoices (
           id, customer_id, invoice_number, status, currency,
           subtotal, tax, discount, total,
           issue_date, due_date, notes, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, customer_id, invoice_number, status, currency,
                   subtotal, tax, discount, total,
                   issue_date, due_date, notes, created_at, updated_at;`,
        [
          invoice.id,
          invoice.customerId,
          invoice.invoiceNumber,
          invoice.status,
          invoice.currency,
          invoice.subtotal.toFixed(2),
          invoice.tax.toFixed(2),
          invoice.discount.toFixed(2),
          invoice.total.toFixed(2),
          invoice.issueDate,
          invoice.dueDate,
          invoice.notes,
          invoice.createdAt,
          invoice.updatedAt,
        ]
      );

      const insertedItems: InvoiceItem[] = [];
      for (const item of invoice.items) {
        const itemResult = await client.query<InvoiceItemRow>(
          `INSERT INTO invoice_items (
             id, invoice_id, description, quantity, unit_price, line_total, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, invoice_id, description, quantity, unit_price, line_total, created_at, updated_at;`,
          [
            item.id,
            invoice.id,
            item.description,
            item.quantity,
            item.unitPrice.toFixed(2),
            item.lineTotal.toFixed(2),
            item.createdAt,
            item.updatedAt,
          ]
        );
        insertedItems.push(this.mapItemRow(itemResult.rows[0]));
      }

      await client.query('COMMIT');
      return this.mapInvoiceRow(invResult.rows[0], insertedItems);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      this.handleDatabaseError(err, 'Failed to persist invoice and line items to database');
    } finally {
      client.release();
    }
  }

  async update(id: string, updates: InvoiceUpdatePersistenceData): Promise<Invoice | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const setClauses: string[] = [];
      const values: (string | number | null)[] = [];
      let paramIdx = 1;

      if (updates.status !== undefined) {
        setClauses.push(`status = $${paramIdx++}`);
        values.push(updates.status);
      }
      if (updates.subtotal !== undefined) {
        setClauses.push(`subtotal = $${paramIdx++}`);
        values.push(updates.subtotal.toFixed(2));
      }
      if (updates.tax !== undefined) {
        setClauses.push(`tax = $${paramIdx++}`);
        values.push(updates.tax.toFixed(2));
      }
      if (updates.discount !== undefined) {
        setClauses.push(`discount = $${paramIdx++}`);
        values.push(updates.discount.toFixed(2));
      }
      if (updates.total !== undefined) {
        setClauses.push(`total = $${paramIdx++}`);
        values.push(updates.total.toFixed(2));
      }
      if (updates.dueDate !== undefined) {
        setClauses.push(`due_date = $${paramIdx++}`);
        values.push(updates.dueDate);
      }
      if (updates.notes !== undefined) {
        setClauses.push(`notes = $${paramIdx++}`);
        values.push(updates.notes);
      }
      setClauses.push(`updated_at = $${paramIdx++}`);
      values.push(updates.updatedAt);

      values.push(id);

      const invResult = await client.query<InvoiceRow>(
        `UPDATE invoices
         SET ${setClauses.join(', ')}
         WHERE id = $${paramIdx}
         RETURNING id, customer_id, invoice_number, status, currency,
                   subtotal, tax, discount, total,
                   issue_date, due_date, notes, created_at, updated_at;`,
        values
      );

      if (invResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      let finalItems: InvoiceItem[];
      if (updates.items !== undefined) {
        await client.query('DELETE FROM invoice_items WHERE invoice_id = $1;', [id]);
        finalItems = [];
        for (const item of updates.items) {
          const itemResult = await client.query<InvoiceItemRow>(
            `INSERT INTO invoice_items (
               id, invoice_id, description, quantity, unit_price, line_total, created_at, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, invoice_id, description, quantity, unit_price, line_total, created_at, updated_at;`,
            [
              item.id,
              id,
              item.description,
              item.quantity,
              item.unitPrice.toFixed(2),
              item.lineTotal.toFixed(2),
              item.createdAt,
              item.updatedAt,
            ]
          );
          finalItems.push(this.mapItemRow(itemResult.rows[0]));
        }
      } else {
        const itemsRes = await client.query<InvoiceItemRow>(
          `SELECT id, invoice_id, description, quantity, unit_price, line_total, created_at, updated_at
           FROM invoice_items
           WHERE invoice_id = $1
           ORDER BY created_at ASC, id ASC;`,
          [id]
        );
        finalItems = itemsRes.rows.map((r) => this.mapItemRow(r));
      }

      await client.query('COMMIT');
      return this.mapInvoiceRow(invResult.rows[0], finalItems);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      this.handleDatabaseError(err, 'Failed to update invoice in database');
    } finally {
      client.release();
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const result = await this.pool.query('DELETE FROM invoices WHERE id = $1;', [id]);
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to delete invoice from database');
    }
  }

  async countByCustomerId(customerId: string): Promise<number> {
    try {
      const result = await this.pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM invoices WHERE customer_id = $1;',
        [customerId]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to count customer invoices');
    }
  }
}
