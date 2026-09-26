import { Customer } from '../models/customer.model.js';
import {
  CustomerListQuery,
  PaginatedResult,
  buildPaginationMeta,
} from '../models/pagination.model.js';
import { ICustomerRepository } from './customer.repository.interface.js';

/**
 * In-Memory Customer Repository
 * Ephemeral store for Phase 1 that fulfills ICustomerRepository.
 * 
 * Rules:
 * 1. Starts empty (0 records)
 * 2. Immutable returns (clones object so external code cannot mutate the store directly)
 * 3. Asynchronous interface signatures matching future DB implementations
 */
export class InMemoryCustomerRepository implements ICustomerRepository {
  private readonly store: Map<string, Customer> = new Map();

  async findAll(): Promise<Customer[]> {
    return Array.from(this.store.values()).map((c) => ({ ...c }));
  }

  async findByAccountId(accountId: string): Promise<Customer[]> {
    return Array.from(this.store.values())
      .filter((c) => c.accountId === accountId)
      .map((c) => ({ ...c }));
  }

  async findPaginated(query: CustomerListQuery): Promise<PaginatedResult<Customer>> {
    let records = Array.from(this.store.values());

    // 1. Authorization Scope First
    if (query.accountId !== undefined) {
      records = records.filter((c) => c.accountId === query.accountId);
    }

    // 2. Domain Filtering
    if (query.currency !== undefined) {
      const targetCurrency = query.currency.toUpperCase();
      records = records.filter((c) => c.currency.toUpperCase() === targetCurrency);
    }
    if (query.email !== undefined) {
      const targetEmail = query.email.toLowerCase().trim();
      records = records.filter((c) => c.email.toLowerCase().trim() === targetEmail);
    }
    if (query.name !== undefined) {
      const targetName = query.name.toLowerCase();
      records = records.filter((c) => c.name.toLowerCase().includes(targetName));
    }

    // 3. Authoritative Filtered Count
    const total = records.length;

    // 4. Deterministic Sorting (with ID tie-breaker)
    const dir = query.order === 'desc' ? -1 : 1;
    records.sort((a, b) => {
      const valA = a[query.sort];
      const valB = b[query.sort];
      if (valA < valB) return -1 * dir;
      if (valA > valB) return 1 * dir;
      return a.id.localeCompare(b.id) * dir;
    });

    // 5. Offset Pagination
    const offset = (query.page - 1) * query.limit;
    const paged = records.slice(offset, offset + query.limit).map((c) => ({ ...c }));

    return {
      items: paged,
      pagination: buildPaginationMeta(query.page, query.limit, total),
    };
  }

  async findById(id: string): Promise<Customer | null> {
    const customer = this.store.get(id);
    if (!customer) {
      return null;
    }
    return { ...customer };
  }

  async findByEmail(email: string): Promise<Customer | null> {
    const normalized = email.toLowerCase().trim();
    for (const customer of this.store.values()) {
      if (customer.email.toLowerCase().trim() === normalized) {
        return { ...customer };
      }
    }
    return null;
  }

  async create(customer: Customer): Promise<Customer> {
    const cloned = { ...customer };
    this.store.set(cloned.id, cloned);
    return { ...cloned };
  }

  async update(
    id: string,
    updates: Partial<Omit<Customer, 'id' | 'accountId' | 'createdAt'>>
  ): Promise<Customer | null> {
    const existing = this.store.get(id);
    if (!existing) {
      return null;
    }

    const updated: Customer = {
      ...existing,
      ...updates,
      id: existing.id,
      accountId: existing.accountId,
      createdAt: existing.createdAt,
    };

    this.store.set(id, updated);
    return { ...updated };
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async count(): Promise<number> {
    return this.store.size;
  }
}
