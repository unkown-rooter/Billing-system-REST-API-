import pg from 'pg';
import { Customer } from '../models/customer.model.js';
import {
  CustomerListQuery,
  CustomerSortField,
  PaginatedResult,
  buildPaginationMeta,
} from '../models/pagination.model.js';
import { ICustomerRepository } from './customer.repository.interface.js';
import { DuplicateResourceError, ConflictError, DatabaseError } from '../services/errors.js';
import { redactSensitiveText } from '../security/redaction.js';

const CUSTOMER_SORT_COLUMN_MAP: Record<CustomerSortField, string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  name: 'name',
  email: 'email',
};

interface CustomerRow {
  id: string;
  account_id: string;
  name: string;
  email: string;
  currency: string;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * PostgreSQL Implementation of ICustomerRepository.
 * Provides durable, ACID-compliant persistence for Customer records.
 * Uses strictly parameterized SQL queries to prevent SQL injection.
 * Translates PostgreSQL error codes into typed application errors.
 */
export class PostgresCustomerRepository implements ICustomerRepository {
  constructor(private readonly pool: pg.Pool) {}

  private mapRowToEntity(row: CustomerRow): Customer {
    return {
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      email: row.email,
      currency: row.currency,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    };
  }

  private handleDatabaseError(err: unknown, defaultMessage: string = 'Database operation failed'): never {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code: string }).code;
      if (code === '23505') {
        throw new DuplicateResourceError('A customer with this email already exists');
      }
      if (code === '23503') {
        throw new ConflictError('Cannot delete customer with existing billing invoices');
      }
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    console.error('[POSTGRES REPOSITORY] Operational query failure:', redactSensitiveText(rawMsg));
    throw new DatabaseError(defaultMessage);
  }

  async findAll(): Promise<Customer[]> {
    try {
      const result = await this.pool.query<CustomerRow>(
        'SELECT id, account_id, name, email, currency, created_at, updated_at FROM customers ORDER BY created_at ASC;'
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to retrieve customers from database');
    }
  }

  async findByAccountId(accountId: string): Promise<Customer[]> {
    try {
      const result = await this.pool.query<CustomerRow>(
        'SELECT id, account_id, name, email, currency, created_at, updated_at FROM customers WHERE account_id = $1 ORDER BY created_at ASC;',
        [accountId]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to retrieve customers by account ID from database');
    }
  }

  async findPaginated(query: CustomerListQuery): Promise<PaginatedResult<Customer>> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // 1. Authorization Scope First
    if (query.accountId !== undefined) {
      conditions.push(`account_id = $${paramIndex++}`);
      params.push(query.accountId);
    }

    // 2. Parameterized Filters
    if (query.currency !== undefined) {
      conditions.push(`currency = $${paramIndex++}`);
      params.push(query.currency.toUpperCase());
    }

    if (query.email !== undefined) {
      conditions.push(`LOWER(email) = LOWER($${paramIndex++})`);
      params.push(query.email.trim().toLowerCase());
    }

    if (query.name !== undefined) {
      conditions.push(`name ILIKE $${paramIndex++}`);
      params.push(`%${query.name}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // 3. Strictly Whitelisted Deterministic Sorting
    const sortColumn = CUSTOMER_SORT_COLUMN_MAP[query.sort] || 'created_at';
    const sortDirection = query.order === 'desc' ? 'DESC' : 'ASC';

    const offset = (query.page - 1) * query.limit;

    try {
      // Execute COUNT(*) with identical authorization and filter predicates
      const countSql = `SELECT COUNT(*)::text AS count FROM customers ${whereClause};`;
      const countResult = await this.pool.query<{ count: string }>(countSql, params);
      const total = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);

      // Execute paginated data query with LIMIT and OFFSET parameters
      const dataParams = [...params, query.limit, offset];
      const limitParam = `$${paramIndex++}`;
      const offsetParam = `$${paramIndex++}`;

      const dataSql = `
        SELECT id, account_id, name, email, currency, created_at, updated_at
        FROM customers
        ${whereClause}
        ORDER BY ${sortColumn} ${sortDirection}, id ${sortDirection}
        LIMIT ${limitParam} OFFSET ${offsetParam};
      `;

      const dataResult = await this.pool.query<CustomerRow>(dataSql, dataParams);
      const items = dataResult.rows.map((row) => this.mapRowToEntity(row));

      return {
        items,
        pagination: buildPaginationMeta(query.page, query.limit, total),
      };
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to query paginated customers from database');
    }
  }

  async findById(id: string): Promise<Customer | null> {
    try {
      const result = await this.pool.query<CustomerRow>(
        'SELECT id, account_id, name, email, currency, created_at, updated_at FROM customers WHERE id = $1;',
        [id]
      );
      if (result.rows.length === 0) {
        return null;
      }
      return this.mapRowToEntity(result.rows[0]);
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to retrieve customer from database');
    }
  }

  async findByEmail(email: string): Promise<Customer | null> {
    try {
      const normalized = email.trim().toLowerCase();
      const result = await this.pool.query<CustomerRow>(
        'SELECT id, account_id, name, email, currency, created_at, updated_at FROM customers WHERE LOWER(email) = LOWER($1);',
        [normalized]
      );
      if (result.rows.length === 0) {
        return null;
      }
      return this.mapRowToEntity(result.rows[0]);
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to query customer by email from database');
    }
  }

  async create(customer: Customer): Promise<Customer> {
    try {
      const result = await this.pool.query<CustomerRow>(
        `INSERT INTO customers (id, account_id, name, email, currency, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, account_id, name, email, currency, created_at, updated_at;`,
        [
          customer.id,
          customer.accountId,
          customer.name,
          customer.email.toLowerCase().trim(),
          customer.currency,
          customer.createdAt,
          customer.updatedAt,
        ]
      );
      return this.mapRowToEntity(result.rows[0]);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
        throw new DuplicateResourceError(`A customer with email '${customer.email.toLowerCase().trim()}' already exists`);
      }
      this.handleDatabaseError(err, 'Failed to persist customer to database');
    }
  }

  async update(
    id: string,
    updates: Partial<Omit<Customer, 'id' | 'accountId' | 'createdAt'>>
  ): Promise<Customer | null> {
    const setClauses: string[] = [];
    const values: (string | Date)[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }

    if (updates.email !== undefined) {
      setClauses.push(`email = $${paramIndex++}`);
      values.push(updates.email.toLowerCase().trim());
    }

    if (updates.currency !== undefined) {
      setClauses.push(`currency = $${paramIndex++}`);
      values.push(updates.currency);
    }

    if (updates.updatedAt !== undefined) {
      setClauses.push(`updated_at = $${paramIndex++}`);
      values.push(updates.updatedAt);
    }

    if (setClauses.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const query = `
      UPDATE customers
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, account_id, name, email, currency, created_at, updated_at;
    `;

    try {
      const result = await this.pool.query<CustomerRow>(query, values);
      if (result.rows.length === 0) {
        return null;
      }
      return this.mapRowToEntity(result.rows[0]);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
        throw new DuplicateResourceError(`A customer with email '${updates.email?.toLowerCase().trim()}' already exists`);
      }
      this.handleDatabaseError(err, 'Failed to update customer in database');
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'DELETE FROM customers WHERE id = $1;',
        [id]
      );
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to delete customer from database');
    }
  }

  async count(): Promise<number> {
    try {
      const result = await this.pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM customers;'
      );
      return parseInt(result.rows[0].count, 10);
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to count customer records');
    }
  }
}
