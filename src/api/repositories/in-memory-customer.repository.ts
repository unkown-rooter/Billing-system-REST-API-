import { Customer } from '../models/customer.model.js';
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
    updates: Partial<Omit<Customer, 'id' | 'createdAt'>>
  ): Promise<Customer | null> {
    const existing = this.store.get(id);
    if (!existing) {
      return null;
    }

    const updated: Customer = {
      ...existing,
      ...updates,
      id: existing.id,
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
