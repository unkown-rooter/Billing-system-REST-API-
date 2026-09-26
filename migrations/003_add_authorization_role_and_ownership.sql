-- Migration: 003_add_authorization_role_and_ownership.sql
-- Description: Phase 5 Authorization & Access Control schema migration.
-- 1. Adds explicit role column ('user' | 'admin') with default 'user' and CHECK constraint to accounts.
-- 2. Adds account_id ownership column with foreign key constraint referencing accounts(id) to customers.

-- 1. Account Role Column & Constraint
ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_accounts_role'
  ) THEN
    ALTER TABLE accounts
    ADD CONSTRAINT chk_accounts_role CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

-- 2. Customer Ownership Column & Foreign Key Constraint
ALTER TABLE customers
ADD COLUMN IF NOT EXISTS account_id TEXT;

-- Remove any legacy unowned customer rows before enforcing NOT NULL + Foreign Key invariant
DELETE FROM customers WHERE account_id IS NULL;

ALTER TABLE customers
ALTER COLUMN account_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_customers_account_id'
  ) THEN
    ALTER TABLE customers
    ADD CONSTRAINT fk_customers_account_id
    FOREIGN KEY (account_id)
    REFERENCES accounts(id)
    ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customers_account_id ON customers (account_id);
