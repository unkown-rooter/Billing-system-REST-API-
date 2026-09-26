-- Migration: 005_add_pagination_and_filtering_indexes.sql
-- Description: Phase 7 Pagination, Filtering & Sorting indexes.
-- Adds targeted B-tree indexes supporting filtered and sorted collection queries
-- on customers and invoices without modifying previously applied migrations.

-- Customer filtering & deterministic sorting indexes
CREATE INDEX IF NOT EXISTS idx_customers_currency ON customers (currency);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers (created_at);

-- Invoice filtering & deterministic sorting indexes
CREATE INDEX IF NOT EXISTS idx_invoices_currency ON invoices (currency);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices (due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices (issue_date);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices (created_at);
