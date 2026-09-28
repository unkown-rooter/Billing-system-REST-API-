-- Migration: 006_add_composite_scaling_indexes.sql
-- Description: Phase 13 Scaling & Production Architecture composite and functional indexes.
-- Eliminates in-memory Sort nodes, Bitmap Heap Rechecks, and Sequential Scans on hot
-- multi-tenant pagination, filtering, item hydration, and case-insensitive lookup paths.

-- 1. Customers: Composite index for owner-scoped deterministic pagination
-- Covers: WHERE account_id = $1 ORDER BY created_at ASC|DESC, id ASC|DESC LIMIT $2 OFFSET $3
CREATE INDEX IF NOT EXISTS idx_customers_account_created_id
  ON customers (account_id, created_at, id);

-- 2. Customers: Composite index for global (admin) deterministic pagination
-- Covers: ORDER BY created_at ASC|DESC, id ASC|DESC LIMIT $1 OFFSET $2
CREATE INDEX IF NOT EXISTS idx_customers_created_id
  ON customers (created_at, id);

-- 3. Invoices: Functional unique index for case-insensitive invoice_number lookup
-- Covers: WHERE UPPER(invoice_number) = UPPER($1) in findByInvoiceNumber()
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_number_upper
  ON invoices (UPPER(invoice_number));

-- 4. Invoices: Composite index for customer-scoped deterministic pagination
-- Covers: WHERE customer_id = $1 ORDER BY created_at ASC|DESC, id ASC|DESC LIMIT $2 OFFSET $3
CREATE INDEX IF NOT EXISTS idx_invoices_customer_created_id
  ON invoices (customer_id, created_at, id);

-- 5. Invoices: Composite index for customer + status filtered deterministic pagination
-- Covers: WHERE customer_id = $1 AND status = $2 ORDER BY created_at ASC|DESC, id ASC|DESC
CREATE INDEX IF NOT EXISTS idx_invoices_customer_status_created_id
  ON invoices (customer_id, status, created_at, id);

-- 6. Invoices: Composite index for status-filtered global pagination
-- Covers: WHERE status = $1 ORDER BY created_at ASC|DESC, id ASC|DESC
CREATE INDEX IF NOT EXISTS idx_invoices_status_created_id
  ON invoices (status, created_at, id);

-- 7. Invoices: Composite index for global deterministic pagination
-- Covers: ORDER BY created_at ASC|DESC, id ASC|DESC LIMIT $1 OFFSET $2
CREATE INDEX IF NOT EXISTS idx_invoices_created_id
  ON invoices (created_at, id);

-- 8. Invoice Items: Composite index for batched item hydration and paginated item queries
-- Covers: WHERE invoice_id = ANY($1) / WHERE invoice_id = $1 ORDER BY created_at ASC|DESC, id ASC|DESC
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_created_id
  ON invoice_items (invoice_id, created_at, id);
