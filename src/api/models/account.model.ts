/**
 * Authentication & Authorization Account Model
 * Represents an authenticated identity (API user / operator) capable of accessing the API.
 * 
 * Domain Separation:
 * - Customer: A billing entity (individual or company) that receives invoices and holds balances,
 *   owned by a specific Account via `accountId`.
 * - Account: An identity credential (email + passwordHash + role) that signs into the API.
 * 
 * Security Invariants:
 * - passwordHash is NEVER exposed to external callers or API responses.
 * - role is restricted strictly to 'user' (least-privileged default) or 'admin'.
 * - AccountDTO defines the safe, sanitized public representation.
 */

export const VALID_ACCOUNT_ROLES = ['user', 'admin'] as const;

export type AccountRole = (typeof VALID_ACCOUNT_ROLES)[number];

export const DEFAULT_ACCOUNT_ROLE: AccountRole = 'user';

export function isValidAccountRole(value: unknown): value is AccountRole {
  return typeof value === 'string' && (VALID_ACCOUNT_ROLES as readonly string[]).includes(value);
}

export interface Account {
  id: string; // acc_<uuidv4>
  email: string;
  passwordHash: string;
  role: AccountRole;
  createdAt: string;
  updatedAt: string;
}

export interface AccountDTO {
  id: string;
  email: string;
  role: AccountRole;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: AccountRole;
}

export interface RegisterDTO {
  email: string;
  password: string;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export interface AuthTokenResponse {
  token: string;
  tokenType: 'Bearer';
  expiresIn: number;
  account: AccountDTO;
}
