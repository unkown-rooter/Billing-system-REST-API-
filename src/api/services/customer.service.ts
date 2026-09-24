import { randomUUID } from 'node:crypto';
import {
  Customer,
  CreateCustomerDTO,
  UpdateCustomerDTO,
} from '../models/customer.model.js';
import { ICustomerRepository } from '../repositories/customer.repository.interface.js';
import {
  ValidationError,
  DuplicateResourceError,
  NotFoundError,
} from './errors.js';

export class CustomerService {
  constructor(private readonly customerRepo: ICustomerRepository) {}

  /**
   * Generates a collision-resistant, domain-prefixed ID.
   * Format: `cus_<uuidv4>`
   */
  private generateId(): string {
    return `cus_${randomUUID()}`;
  }

  async getAllCustomers(): Promise<Customer[]> {
    return this.customerRepo.findAll();
  }

  async getCustomerById(id: string): Promise<Customer> {
    const customer = await this.customerRepo.findById(id);
    if (!customer) {
      throw new NotFoundError(`Customer with ID '${id}' not found`);
    }
    return customer;
  }

  async createCustomer(dto: CreateCustomerDTO): Promise<Customer> {
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const name = dto.name?.trim();
    if (!name) {
      throw new ValidationError("Field 'name' is required and must be a non-empty string");
    }

    const email = dto.email?.trim().toLowerCase();
    if (!email) {
      throw new ValidationError("Field 'email' is required and must be a valid email address");
    }

    const currency = (dto.currency?.trim().toUpperCase()) || 'USD';

    // Business Rule: Email uniqueness across customers
    const existing = await this.customerRepo.findByEmail(email);
    if (existing) {
      throw new DuplicateResourceError(`A customer with email '${email}' already exists`);
    }

    // Server-managed entity creation
    const now = new Date().toISOString();
    const newCustomer: Customer = {
      id: this.generateId(),
      name,
      email,
      currency,
      createdAt: now,
      updatedAt: now,
    };

    return this.customerRepo.create(newCustomer);
  }

  async updateCustomer(id: string, dto: UpdateCustomerDTO): Promise<Customer> {
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const existing = await this.customerRepo.findById(id);
    if (!existing) {
      throw new NotFoundError(`Customer with ID '${id}' not found`);
    }

    const updates: Partial<Omit<Customer, 'id' | 'createdAt'>> = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name.length === 0) {
        throw new ValidationError("Field 'name' must be a non-empty string");
      }
      updates.name = name;
    }

    if (dto.email !== undefined) {
      const email = dto.email.trim().toLowerCase();
      // Business Rule: Check if another customer is using this email
      const customerWithEmail = await this.customerRepo.findByEmail(email);
      if (customerWithEmail && customerWithEmail.id !== id) {
        throw new DuplicateResourceError(`A customer with email '${email}' already exists`);
      }
      updates.email = email;
    }

    if (dto.currency !== undefined) {
      updates.currency = dto.currency.trim().toUpperCase();
    }

    if (Object.keys(updates).length === 0) {
      throw new ValidationError('No valid fields provided for update');
    }

    updates.updatedAt = new Date().toISOString();

    const updated = await this.customerRepo.update(id, updates);
    if (!updated) {
      throw new NotFoundError(`Customer with ID '${id}' not found`);
    }

    return updated;
  }

  async deleteCustomer(id: string): Promise<void> {
    const existing = await this.customerRepo.findById(id);
    if (!existing) {
      throw new NotFoundError(`Customer with ID '${id}' not found`);
    }

    await this.customerRepo.delete(id);
  }
}
