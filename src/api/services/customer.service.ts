import { randomUUID } from 'node:crypto';
import {
  Customer,
  CreateCustomerDTO,
  UpdateCustomerDTO,
} from '../models/customer.model.js';
import {
  CustomerListQuery,
  PaginatedResult,
  buildPaginationMeta,
} from '../models/pagination.model.js';
import { AuthenticatedUser } from '../models/account.model.js';
import { ICustomerRepository } from '../repositories/customer.repository.interface.js';
import { IInvoiceRepository } from '../repositories/invoice.repository.interface.js';
import {
  ValidationError,
  DuplicateResourceError,
  ConflictError,
  NotFoundError,
  AuthenticationRequiredError,
  ForbiddenError,
} from './errors.js';

/**
 * Customer Service
 * Enforces business rules, resource-level ownership, and role-based access rules.
 * 
 * Authorization & Ownership Policy:
 * - `getAllCustomers(actor)`:
 *   - `admin`: returns all customers in the ledger.
 *   - `user`: returns only customers owned by `actor.id` (`customer.accountId === actor.id`).
 * - `getCustomerById(id, actor)`:
 *   - Allowed only if `actor.role === 'admin'` OR `customer.accountId === actor.id` (IDOR protection).
 * - `createCustomer(dto, actor)`:
 *   - Binds `customer.accountId = actor.id` from server-side authenticated identity.
 * - `updateCustomer(id, dto, actor)`:
 *   - Allowed only if `actor.role === 'admin'` OR `existing.accountId === actor.id`.
 *   - Protects `id`, `accountId`, and `createdAt` from modification.
 * - `deleteCustomer(id, actor)`:
 *   - Restricted strictly to `actor.role === 'admin'`.
 */
export class CustomerService {
  constructor(
    private readonly customerRepo: ICustomerRepository,
    private readonly invoiceRepo?: IInvoiceRepository
  ) {}

  /**
   * Generates a collision-resistant, domain-prefixed ID.
   * Format: `cus_<uuidv4>`
   */
  private generateId(): string {
    return `cus_${randomUUID()}`;
  }

  private assertAuthenticated(actor?: AuthenticatedUser): asserts actor is AuthenticatedUser {
    if (!actor || !actor.id) {
      throw new AuthenticationRequiredError('Authentication is required');
    }
  }

  /**
   * Evaluates resource-level read/update authorization (IDOR protection).
   * Administrators or the owning Account may access/modify the customer record.
   */
  private assertCanAccessOrModifyCustomer(actor: AuthenticatedUser, customer: Customer): void {
    if (actor.role === 'admin') {
      return;
    }
    if (customer.accountId !== actor.id) {
      throw new ForbiddenError('You are not authorized to perform this action');
    }
  }

  async getAllCustomers(actor: AuthenticatedUser): Promise<Customer[]> {
    this.assertAuthenticated(actor);
    if (actor.role === 'admin') {
      return this.customerRepo.findAll();
    }
    return this.customerRepo.findByAccountId(actor.id);
  }

  async listCustomers(
    query: CustomerListQuery,
    actor: AuthenticatedUser
  ): Promise<PaginatedResult<Customer>> {
    this.assertAuthenticated(actor);

    const scopedQuery: CustomerListQuery = {
      ...query,
      accountId: actor.role === 'admin' ? undefined : actor.id,
    };

    if (this.customerRepo.findPaginated) {
      return this.customerRepo.findPaginated(scopedQuery);
    }

    // Fallback for test mocks that only implement findAll / findByAccountId
    const all = await this.getAllCustomers(actor);
    const offset = (scopedQuery.page - 1) * scopedQuery.limit;
    return {
      items: all.slice(offset, offset + scopedQuery.limit),
      pagination: buildPaginationMeta(scopedQuery.page, scopedQuery.limit, all.length),
    };
  }

  async getCustomerById(id: string, actor: AuthenticatedUser): Promise<Customer> {
    this.assertAuthenticated(actor);
    const customer = await this.customerRepo.findById(id);
    if (!customer) {
      throw new NotFoundError(`Customer with ID '${id}' not found`);
    }

    this.assertCanAccessOrModifyCustomer(actor, customer);
    return customer;
  }

  async createCustomer(dto: CreateCustomerDTO, actor: AuthenticatedUser): Promise<Customer> {
    this.assertAuthenticated(actor);

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

    // Server-managed entity creation: ownership bound strictly to authenticated actor.id
    const now = new Date().toISOString();
    const newCustomer: Customer = {
      id: this.generateId(),
      accountId: actor.id,
      name,
      email,
      currency,
      createdAt: now,
      updatedAt: now,
    };

    return this.customerRepo.create(newCustomer);
  }

  async updateCustomer(
    id: string,
    dto: UpdateCustomerDTO,
    actor: AuthenticatedUser
  ): Promise<Customer> {
    this.assertAuthenticated(actor);

    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const existing = await this.customerRepo.findById(id);
    if (!existing) {
      throw new NotFoundError(`Customer with ID '${id}' not found`);
    }

    // Resource-level ownership check BEFORE evaluating or applying updates
    this.assertCanAccessOrModifyCustomer(actor, existing);

    const updates: Partial<Omit<Customer, 'id' | 'accountId' | 'createdAt'>> = {};

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

  async deleteCustomer(id: string, actor: AuthenticatedUser): Promise<void> {
    this.assertAuthenticated(actor);

    if (actor.role !== 'admin') {
      throw new ForbiddenError('You are not authorized to perform this action');
    }

    const existing = await this.customerRepo.findById(id);
    if (!existing) {
      throw new NotFoundError(`Customer with ID '${id}' not found`);
    }

    if (this.invoiceRepo) {
      const invoiceCount = await this.invoiceRepo.countByCustomerId(id);
      if (invoiceCount > 0) {
        throw new ConflictError(
          `Cannot delete customer '${id}' because ${invoiceCount} associated invoice(s) exist`
        );
      }
    }

    await this.customerRepo.delete(id);
  }
}
