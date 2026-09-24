import pg from 'pg';
import { Customer } from '../models/customer.model.js';
import { ICustomerRepository } from './customer.repository.interface.js';
import { DuplicateResourceError, DatabaseError } from '../services/errors.js';

interface CustomerRow {
  id: string;
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
    }
    console.error('[POSTGRES REPOSITORY] Operational query failure:', err instanceof Error ? err.message : String(err));
    throw new DatabaseError(defaultMessage);
  }

  async findAll(): Promise<Customer[]> {
    try {
      const result = await this.pool.query<CustomerRow>(
        'SELECT id, name, email, currency, created_at, updated_at FROM customers ORDER BY created_at ASC;'
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to retrieve customers from database');
    }
  }

  async findById(id: string): Promise<Customer | null> {
    try {
      const result = await this.pool.query<CustomerRow>(
        'SELECT id, name, email, currency, created_at, updated_at FROM customers WHERE id = $1;',
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
        'SELECT id, name, email, currency, created_at, updated_at FROM customers WHERE LOWER(email) = LOWER($1);',
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
        `INSERT INTO customers (id, name, email, currency, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, email, currency, created_at, updated_at;`,
        [
          customer.id,
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
    updates: Partial<Omit<Customer, 'id' | 'createdAt'>>
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
      RETURNING id, name, email, currency, created_at, updated_at;
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
