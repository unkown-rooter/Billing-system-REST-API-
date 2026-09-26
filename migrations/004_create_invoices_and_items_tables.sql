-- Migration: 004_create_invoices_and_items_tables.sql
-- Description: Phase 6 Relationships & Relational Domain Modeling.
-- 1. Creates the invoices table with a foreign key referencing customers(id) ON DELETE RESTRICT.
-- 2. Creates the invoice_items table with a foreign key referencing invoices(id) ON DELETE CASCADE.
-- 3. Enforces unique invoice numbers, explicit status values, ISO currency codes, and financial arithmetic invariants.

CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    invoice_number VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    currency CHAR(3) NOT NULL,
    subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    tax NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    discount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    issue_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_date TIMESTAMPTZ NOT NULL,
    notes VARCHAR(1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_invoices_customer_id
        FOREIGN KEY (customer_id)
        REFERENCES customers(id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_invoices_invoice_number UNIQUE (invoice_number),
    CONSTRAINT chk_invoices_status CHECK (status IN ('draft', 'issued', 'paid', 'overdue', 'cancelled')),
    CONSTRAINT chk_invoices_currency CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT chk_invoices_subtotal_non_negative CHECK (subtotal >= 0),
    CONSTRAINT chk_invoices_tax_non_negative CHECK (tax >= 0),
    CONSTRAINT chk_invoices_discount_non_negative CHECK (discount >= 0),
    CONSTRAINT chk_invoices_total_non_negative CHECK (total >= 0),
    CONSTRAINT chk_invoices_total_consistency CHECK (total = subtotal + tax - discount)
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);

CREATE TABLE IF NOT EXISTS invoice_items (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL,
    description VARCHAR(500) NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price NUMERIC(12, 2) NOT NULL,
    line_total NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_invoice_items_invoice_id
        FOREIGN KEY (invoice_id)
        REFERENCES invoices(id)
        ON DELETE CASCADE,
    CONSTRAINT chk_invoice_items_description_not_empty CHECK (LENGTH(BTRIM(description)) > 0),
    CONSTRAINT chk_invoice_items_quantity_positive CHECK (quantity > 0),
    CONSTRAINT chk_invoice_items_unit_price_non_negative CHECK (unit_price >= 0),
    CONSTRAINT chk_invoice_items_line_total_non_negative CHECK (line_total >= 0),
    CONSTRAINT chk_invoice_items_line_total_consistency CHECK (line_total = quantity * unit_price)
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items (invoice_id);
