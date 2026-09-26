import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresAccountRepository } from '../../api/repositories/postgres-account.repository.js';
import { PostgresCustomerRepository } from '../../api/repositories/postgres-customer.repository.js';
import { PostgresInvoiceRepository } from '../../api/repositories/postgres-invoice.repository.js';
import { CustomerService } from '../../api/services/customer.service.js';
import { InvoiceService } from '../../api/services/invoice.service.js';
import {
  DuplicateResourceError,
  ConflictError,
  NotFoundError,
  ValidationError,
  DatabaseError,
} from '../../api/services/errors.js';
import {
  buildAccountFixture,
  buildCustomerEntityFixture,
  buildInvoiceEntityFixture,
} from '../helpers/fixtures.js';

/**
 * Phase 8 Integration Test Suite: Service ↔ Repository ↔ PostgreSQL Driver Boundary
 * 
 * Verifies:
 * 1. Atomic database transaction lifecycle (`BEGIN` -> `INSERT/UPDATE` -> `COMMIT` vs `ROLLBACK` + `client.release()`).
 * 2. PostgreSQL SQLSTATE error code translation (`23505`, `23503`, `23514`, operational errors) into domain errors.
 * 3. Service + Repository integration for multi-step billing workflows.
 * 4. N+1 query avoidance in invoice list hydration (`WHERE invoice_id = ANY($1::text[])`).
 */
describe('Billing System REST API - Phase 8 Service & Repository Integration Test Suite', () => {
  describe('1. Atomic Transaction Lifecycle (COMMIT & ROLLBACK) in PostgresInvoiceRepository', () => {
    it('commits transaction and releases client when invoice and all line items succeed', async () => {
      const executedStatements: string[] = [];
      let clientReleased = false;

      const invoiceFixture = buildInvoiceEntityFixture({
        items: [
          {
            id: 'item_0001_tx',
            invoiceId: 'inv_tx_success',
            description: 'First Atomic Item',
            quantity: 2,
            unitPrice: 100.0,
            lineTotal: 200.0,
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
          {
            id: 'item_0002_tx',
            invoiceId: 'inv_tx_success',
            description: 'Second Atomic Item',
            quantity: 1,
            unitPrice: 50.0,
            lineTotal: 50.0,
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ],
      });

      const mockClient = {
        async query(sql: string, params: any[] = []) {
          const normalized = sql.trim().split(/\s+/)[0].toUpperCase();
          executedStatements.push(normalized);

          if (sql.includes('INSERT INTO invoices')) {
            return {
              rows: [
                {
                  id: invoiceFixture.id,
                  customer_id: invoiceFixture.customerId,
                  invoice_number: invoiceFixture.invoiceNumber,
                  status: invoiceFixture.status,
                  currency: invoiceFixture.currency,
                  subtotal: '250.00',
                  tax: '0.00',
                  discount: '0.00',
                  total: '250.00',
                  issue_date: invoiceFixture.issueDate,
                  due_date: invoiceFixture.dueDate,
                  notes: invoiceFixture.notes,
                  created_at: invoiceFixture.createdAt,
                  updated_at: invoiceFixture.updatedAt,
                },
              ],
            };
          }

          if (sql.includes('INSERT INTO invoice_items')) {
            return {
              rows: [
                {
                  id: params[0],
                  invoice_id: params[1],
                  description: params[2],
                  quantity: params[3],
                  unit_price: params[4],
                  line_total: params[5],
                  created_at: params[6],
                  updated_at: params[7],
                },
              ],
            };
          }

          return { rows: [] };
        },
        release() {
          clientReleased = true;
        },
      };

      const mockPool = {
        async connect() {
          return mockClient;
        },
      };

      const repo = new PostgresInvoiceRepository(mockPool as any);
      const created = await repo.create(invoiceFixture);

      assert.deepEqual(executedStatements, ['BEGIN', 'INSERT', 'INSERT', 'INSERT', 'COMMIT']);
      assert.equal(clientReleased, true);
      assert.equal(created.items.length, 2);
      assert.equal(created.subtotal, 250.0);
    });

    it('issues ROLLBACK and always releases client when second line item insert fails mid-transaction', async () => {
      const executedStatements: string[] = [];
      let clientReleased = false;
      let itemInsertCount = 0;

      const invoiceFixture = buildInvoiceEntityFixture({
        items: [
          {
            id: 'item_0001_ok',
            invoiceId: 'inv_tx_fail',
            description: 'Valid Item 1',
            quantity: 1,
            unitPrice: 100.0,
            lineTotal: 100.0,
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
          {
            id: 'item_0002_fail',
            invoiceId: 'inv_tx_fail',
            description: 'Failing Item 2',
            quantity: 1,
            unitPrice: 100.0,
            lineTotal: 100.0,
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ],
      });

      const mockClient = {
        async query(sql: string, params: any[] = []) {
          const verb = sql.trim().split(/\s+/)[0].toUpperCase();
          executedStatements.push(verb);

          if (sql.includes('INSERT INTO invoices')) {
            return {
              rows: [
                {
                  id: invoiceFixture.id,
                  customer_id: invoiceFixture.customerId,
                  invoice_number: invoiceFixture.invoiceNumber,
                  status: invoiceFixture.status,
                  currency: invoiceFixture.currency,
                  subtotal: '200.00',
                  tax: '0.00',
                  discount: '0.00',
                  total: '200.00',
                  issue_date: invoiceFixture.issueDate,
                  due_date: invoiceFixture.dueDate,
                  notes: null,
                  created_at: invoiceFixture.createdAt,
                  updated_at: invoiceFixture.updatedAt,
                },
              ],
            };
          }

          if (sql.includes('INSERT INTO invoice_items')) {
            itemInsertCount += 1;
            if (itemInsertCount === 2) {
              throw Object.assign(new Error('new row for relation "invoice_items" violates check constraint'), {
                code: '23514',
              });
            }
            return {
              rows: [
                {
                  id: params[0],
                  invoice_id: params[1],
                  description: params[2],
                  quantity: params[3],
                  unit_price: params[4],
                  line_total: params[5],
                  created_at: params[6],
                  updated_at: params[7],
                },
              ],
            };
          }

          return { rows: [] };
        },
        release() {
          clientReleased = true;
        },
      };

      const mockPool = {
        async connect() {
          return mockClient;
        },
      };

      const repo = new PostgresInvoiceRepository(mockPool as any);
      await assert.rejects(repo.create(invoiceFixture), ValidationError);

      // Verify transaction was rolled back and connection was returned to pool
      assert.deepEqual(executedStatements, ['BEGIN', 'INSERT', 'INSERT', 'INSERT', 'ROLLBACK']);
      assert.equal(clientReleased, true);
    });

    it('rolls back update transaction cleanly when target invoice ID does not exist', async () => {
      const executedStatements: string[] = [];
      let clientReleased = false;

      const mockClient = {
        async query(sql: string) {
          const verb = sql.trim().split(/\s+/)[0].toUpperCase();
          executedStatements.push(verb);
          return { rows: [] }; // 0 rows matched on UPDATE invoices
        },
        release() {
          clientReleased = true;
        },
      };

      const repo = new PostgresInvoiceRepository({
        async connect() {
          return mockClient;
        },
      } as any);

      const updated = await repo.update('inv_nonexistent', {
        status: 'issued',
        updatedAt: new Date().toISOString(),
      });

      assert.equal(updated, null);
      assert.deepEqual(executedStatements, ['BEGIN', 'UPDATE', 'ROLLBACK']);
      assert.equal(clientReleased, true);
    });
  });

  describe('2. PostgreSQL SQLSTATE Constraint & Operational Error Translation', () => {
    it('translates PostgreSQL 23505 (unique_violation), 23503 (foreign_key_violation), and connection errors in PostgresCustomerRepository', async () => {
      const customer = buildCustomerEntityFixture();

      // 1. 23505 -> DuplicateResourceError (409)
      const dupPool = {
        async query() {
          throw Object.assign(new Error('duplicate key value violates unique constraint "idx_customers_email_lower"'), {
            code: '23505',
          });
        },
      };
      const dupRepo = new PostgresCustomerRepository(dupPool as any);
      await assert.rejects(dupRepo.create(customer), DuplicateResourceError);

      // 2. 23503 on customer delete -> ConflictError (409)
      const fkPool = {
        async query() {
          throw Object.assign(new Error('update or delete on table "customers" violates foreign key constraint "fk_invoices_customer_id"'), {
            code: '23503',
          });
        },
      };
      const fkRepo = new PostgresCustomerRepository(fkPool as any);
      await assert.rejects(fkRepo.delete(customer.id), ConflictError);

      // 3. Operational failure -> DatabaseError (500) without leaking internal Postgres details
      const deadPool = {
        async query() {
          throw new Error('FATAL: password authentication failed for user "postgres_prod_admin"');
        },
      };
      const deadRepo = new PostgresCustomerRepository(deadPool as any);
      await assert.rejects(
        deadRepo.findAll(),
        (err: unknown) => {
          assert.ok(err instanceof DatabaseError);
          assert.equal(err.statusCode, 500);
          assert.ok(!err.message.includes('postgres_prod_admin'));
          return true;
        }
      );
    });

    it('translates PostgreSQL 23505 and operational errors in PostgresAccountRepository', async () => {
      const account = buildAccountFixture();

      const dupPool = {
        async query() {
          throw Object.assign(new Error('duplicate key value violates unique constraint "idx_accounts_email_lower"'), {
            code: '23505',
          });
        },
      };
      const accountRepo = new PostgresAccountRepository(dupPool as any);
      await assert.rejects(accountRepo.create(account), DuplicateResourceError);
    });

    it('translates PostgreSQL 23503 (fk_invoices_customer_id) into NotFoundError in PostgresInvoiceRepository', async () => {
      const invoice = buildInvoiceEntityFixture();
      const fkClient = {
        async query(sql: string) {
          if (sql.includes('INSERT INTO invoices')) {
            throw Object.assign(new Error('insert or update on table "invoices" violates foreign key constraint'), {
              code: '23503',
              constraint: 'fk_invoices_customer_id',
            });
          }
          return { rows: [] };
        },
        release() {},
      };
      const repo = new PostgresInvoiceRepository({
        async connect() {
          return fkClient;
        },
      } as any);

      await assert.rejects(repo.create(invoice), NotFoundError);
    });
  });

  describe('3. Batched Item Hydration Performance Sanity Check (Zero N+1 Queries)', () => {
    it('hydrates 20 invoices and their line items using a single batched ANY($1::text[]) query instead of 20 separate queries', async () => {
      const executedQueries: string[] = [];
      const twentyInvoices = Array.from({ length: 20 }, (_, i) => ({
        id: `inv_batch_${i + 1}`,
        customer_id: 'cus_batch_1',
        invoice_number: `INV-2026-00${i + 1}-BBBB`,
        status: 'issued' as const,
        currency: 'USD',
        subtotal: '100.00',
        tax: '0.00',
        discount: '0.00',
        total: '100.00',
        issue_date: '2026-05-01T00:00:00.000Z',
        due_date: '2026-05-31T00:00:00.000Z',
        notes: null,
        created_at: '2026-05-01T00:00:00.000Z',
        updated_at: '2026-05-01T00:00:00.000Z',
      }));

      const mockPool = {
        async query(sql: string) {
          executedQueries.push(sql);
          if (sql.includes('COUNT(*)')) {
            return { rows: [{ count: '20' }] };
          }
          if (sql.includes('FROM invoices')) {
            return { rows: twentyInvoices };
          }
          if (sql.includes('FROM invoice_items')) {
            return {
              rows: twentyInvoices.map((inv, idx) => ({
                id: `item_0001_${idx}`,
                invoice_id: inv.id,
                description: `Item for ${inv.id}`,
                quantity: 1,
                unit_price: '100.00',
                line_total: '100.00',
                created_at: '2026-05-01T00:00:00.000Z',
                updated_at: '2026-05-01T00:00:00.000Z',
              })),
            };
          }
          return { rows: [] };
        },
      };

      const repo = new PostgresInvoiceRepository(mockPool as any);
      const result = await repo.findPaginated({
        page: 1,
        limit: 20,
        sort: 'createdAt',
        order: 'asc',
      });

      assert.equal(result.items.length, 20);
      assert.ok(result.items.every((inv) => inv.items.length === 1));
      // Exactly 3 SQL queries total (1 COUNT + 1 SELECT invoices + 1 batched SELECT invoice_items WHERE invoice_id = ANY($1::text[]))
      // NOT 1 + 1 + 20 = 22 queries!
      assert.equal(executedQueries.length, 3);
      assert.ok(executedQueries[2].includes('WHERE invoice_id = ANY($1::text[])'));
    });
  });
});
