-- Migration: 002_create_accounts_table.sql
-- Description: Creates the accounts table for API authentication and identity management.
-- Enforces primary keys, required fields, and case-insensitive unique email index.

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email VARCHAR(254) NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness enforcement for account emails
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email_lower ON accounts (LOWER(email));
