import { Customer } from '../models/customer.model.js';

/**
 * Customer Repository Interface
 * Defines the contract for customer persistence.
 * In Phase 1: Implemented in-memory.
 * In Phase 2: Implemented via PostgreSQL without altering service or controller layers.
 */
export interface ICustomerRepository {
  findAll(): Promise<Customer[]>;
  findById(id: string): Promise<Customer | null>;
  findByEmail(email: string): Promise<Customer | null>;
  create(customer: Customer): Promise<Customer>;
  update(id: string, updates: Partial<Omit<Customer, 'id' | 'createdAt'>>): Promise<Customer | null>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
}
