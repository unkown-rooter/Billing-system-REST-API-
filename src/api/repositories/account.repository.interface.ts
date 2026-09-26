import { Account } from '../models/account.model.js';

/**
 * Account Repository Interface
 * Defines the persistence contract for authentication accounts.
 * Decouples identity storage from database engines (PostgreSQL vs In-Memory).
 */
export interface IAccountRepository {
  findById(id: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  create(account: Account): Promise<Account>;
  count(): Promise<number>;
}
