-- Migration: 001_create_customers_table.sql
-- Description: Creates the customers table with constraints and case-insensitive unique email index.

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(254) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_customers_currency CHECK (currency ~ '^[A-Z]{3}$')
);

-- Case-insensitive uniqueness enforcement for emails
-- Ensures 'user@example.com' and 'USER@EXAMPLE.COM' are treated as identical records
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_lower ON customers (LOWER(email));
