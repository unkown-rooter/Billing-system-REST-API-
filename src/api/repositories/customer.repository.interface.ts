import { Customer } from '../models/customer.model.js';
import { CustomerListQuery, PaginatedResult } from '../models/pagination.model.js';

/**
 * Customer Repository Interface
 * Defines the contract for customer persistence.
 * In Phase 1: Implemented in-memory.
 * In Phase 2: Implemented via PostgreSQL without altering service or controller layers.
 * In Phase 7: Extended with parameterized pagination, filtering, and deterministic sorting.
 */
export interface ICustomerRepository {
  findAll(): Promise<Customer[]>;
  findByAccountId(accountId: string): Promise<Customer[]>;
  findPaginated?(query: CustomerListQuery): Promise<PaginatedResult<Customer>>;
  findById(id: string): Promise<Customer | null>;
  findByEmail(email: string): Promise<Customer | null>;
  create(customer: Customer): Promise<Customer>;
  update(id: string, updates: Partial<Omit<Customer, 'id' | 'accountId' | 'createdAt'>>): Promise<Customer | null>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
}
