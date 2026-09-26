import pg from 'pg';
import { Account, AccountRole, DEFAULT_ACCOUNT_ROLE, isValidAccountRole } from '../models/account.model.js';
import { IAccountRepository } from './account.repository.interface.js';
import { DuplicateResourceError, DatabaseError, ValidationError } from '../services/errors.js';
import { redactSensitiveText } from '../security/redaction.js';

interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  role: AccountRole;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * PostgreSQL Implementation of IAccountRepository.
 * Provides durable, ACID-compliant storage for authentication accounts.
 * Uses positional parameterized queries ($1, $2, ...) exclusively.
 */
export class PostgresAccountRepository implements IAccountRepository {
  constructor(private readonly pool: pg.Pool) {}

  private mapRowToEntity(row: AccountRow): Account {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      role: isValidAccountRole(row.role) ? row.role : DEFAULT_ACCOUNT_ROLE,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString(),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : new Date(row.updated_at).toISOString(),
    };
  }

  private handleDatabaseError(err: unknown, defaultMessage: string = 'Database operation failed'): never {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code: string }).code;
      if (code === '23505') {
        throw new DuplicateResourceError('An account with this email already exists');
      }
      if (code === '23514') {
        throw new ValidationError('Invalid account constraint value');
      }
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    console.error('[POSTGRES ACCOUNT REPO] Operational query failure:', redactSensitiveText(rawMsg));
    throw new DatabaseError(defaultMessage);
  }

  async findById(id: string): Promise<Account | null> {
    try {
      const result = await this.pool.query<AccountRow>(
        'SELECT id, email, password_hash, role, created_at, updated_at FROM accounts WHERE id = $1;',
        [id]
      );
      if (result.rows.length === 0) {
        return null;
      }
      return this.mapRowToEntity(result.rows[0]);
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to retrieve account from database');
    }
  }

  async findByEmail(email: string): Promise<Account | null> {
    try {
      const normalized = email.trim().toLowerCase();
      const result = await this.pool.query<AccountRow>(
        'SELECT id, email, password_hash, role, created_at, updated_at FROM accounts WHERE LOWER(email) = LOWER($1);',
        [normalized]
      );
      if (result.rows.length === 0) {
        return null;
      }
      return this.mapRowToEntity(result.rows[0]);
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to query account by email from database');
    }
  }

  async create(account: Account): Promise<Account> {
    const role = account.role ?? DEFAULT_ACCOUNT_ROLE;
    if (!isValidAccountRole(role)) {
      throw new ValidationError(`Invalid account role '${String(role)}'`);
    }

    try {
      const normalizedEmail = account.email.trim().toLowerCase();
      const result = await this.pool.query<AccountRow>(
        `INSERT INTO accounts (id, email, password_hash, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, password_hash, role, created_at, updated_at;`,
        [
          account.id,
          normalizedEmail,
          account.passwordHash,
          role,
          account.createdAt,
          account.updatedAt,
        ]
      );
      return this.mapRowToEntity(result.rows[0]);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
        throw new DuplicateResourceError('An account with this email already exists');
      }
      this.handleDatabaseError(err, 'Failed to persist account to database');
    }
  }

  async count(): Promise<number> {
    try {
      const result = await this.pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM accounts;'
      );
      return parseInt(result.rows[0].count, 10);
    } catch (err) {
      this.handleDatabaseError(err, 'Failed to count account records');
    }
  }
}
