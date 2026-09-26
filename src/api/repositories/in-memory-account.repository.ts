import { Account, DEFAULT_ACCOUNT_ROLE, isValidAccountRole } from '../models/account.model.js';
import { IAccountRepository } from './account.repository.interface.js';
import { ValidationError } from '../services/errors.js';

/**
 * In-Memory Account Repository
 * Ephemeral store fulfilling IAccountRepository for unit tests and isolated sandbox execution.
 */
export class InMemoryAccountRepository implements IAccountRepository {
  private readonly store: Map<string, Account> = new Map();

  async findById(id: string): Promise<Account | null> {
    const account = this.store.get(id);
    if (!account) return null;
    return { ...account };
  }

  async findByEmail(email: string): Promise<Account | null> {
    const normalized = email.toLowerCase().trim();
    for (const account of this.store.values()) {
      if (account.email.toLowerCase().trim() === normalized) {
        return { ...account };
      }
    }
    return null;
  }

  async create(account: Account): Promise<Account> {
    const role = account.role ?? DEFAULT_ACCOUNT_ROLE;
    if (!isValidAccountRole(role)) {
      throw new ValidationError(`Invalid account role '${String(role)}'`);
    }
    const cloned: Account = { ...account, role };
    this.store.set(cloned.id, cloned);
    return { ...cloned };
  }

  async count(): Promise<number> {
    return this.store.size;
  }
}
