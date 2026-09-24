/**
 * Customer Model Definition
 * Represents a party (individual or legal entity) that can receive invoices.
 * 
 * Minimal justification for Phase 1 fields:
 * - id: unique identifier for referencing the customer in invoices/records
 * - name: legal/display name of the entity being billed
 * - email: primary contact address for billing notices and communication (unique)
 * - currency: default currency for billing (ISO 4217, 3 letters)
 * - createdAt: audit timestamp for record creation
 * - updatedAt: audit timestamp for record modification
 */

export interface Customer {
  id: string;
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
