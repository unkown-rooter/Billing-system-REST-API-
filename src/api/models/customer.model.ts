/**
 * Customer Model Definition
 * Represents a party (individual or legal entity) that can receive invoices.
 * 
 * Domain & Ownership fields:
 * - id: unique identifier for referencing the customer in invoices/records (cus_<uuidv4>)
 * - accountId: authoritative ID of the Account (acc_<uuidv4>) that owns this customer record
 * - name: legal/display name of the entity being billed
 * - email: primary contact address for billing notices and communication (unique)
 * - currency: default currency for billing (ISO 4217, 3 letters)
 * - createdAt: audit timestamp for record creation
 * - updatedAt: audit timestamp for record modification
 */

export interface Customer {
  id: string;
  accountId: string;
  name: string;
  email: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomerDTO {
  name: string;
  email: string;
  currency?: string;
}

export interface UpdateCustomerDTO {
  name?: string;
  email?: string;
  currency?: string;
}
