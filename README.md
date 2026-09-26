# Billing System REST API

A production-grade, API-first, backend-first REST API built with **Node.js**, **Express.js**, **TypeScript**, and **PostgreSQL**.

This service serves as the core billing and accounting ledger for external client applications (web frontends, mobile applications, CLI tools, and background services).

---

## 1. What the Billing System API Is

The Billing System REST API provides a centralized, structured interface for managing the financial relationship between a business and its customers. It tracks customer identities, products/services, invoices, line items, taxes, discounts, payments, and balances.

---

## 2. Phase 2 Architecture: PostgreSQL Persistence

> **PERSISTENCE STATUS:**
> - **Phase 1** used ephemeral in-memory storage (`Map<string, Customer>`).
> - **Phase 2** replaces in-memory storage with durable, database-backed **PostgreSQL persistence**.
> 
> **PostgreSQL is now the single production source of truth for customer records.** Records survive application restarts, connection pool drains, and container reboots.

### Architectural Inversion of Control
The application adheres strictly to layered separation:

```
HTTP Request
     ↓
Express Middleware
     ├── Disable 'X-Powered-By'
     ├── express.json({ limit: '100kb', strict: true })
     └── requestLogger (Method, Path, Status, Latency)
     ↓
Express Router (/api/v1)
     ├── /health    → HealthController
     └── /customers → CustomerController
     ↓
CustomerController
     ├── Handles HTTP params, query DTOs, and status codes (200, 201, 204, 400, 404, 409)
     ├── Sets Location header on creation
     └── Does NOT know PostgreSQL exists
     ↓
CustomerService
     ├── Enforces business rules (string lengths, RFC formats, currency ISO 4217)
     ├── Generates domain identifiers (`cus_<uuidv4>`)
     ├── Protects immutable attributes (id, createdAt)
     └── Does NOT contain any SQL
     ↓
ICustomerRepository (Contract Interface)
     ↓
PostgresCustomerRepository
     ├── Owns all SQL and parameterized queries ($1, $2, ...)
     ├── Maps DB columns (created_at, updated_at) to Domain model (createdAt, updatedAt)
     └── Translates DB constraint violations (Postgres 23505) into domain errors (DuplicateResourceError)
     ↓
PostgreSQL Connection Pool (pg.Pool)
     ├── Managed lifecycle via DATABASE_URL
     ├── Reuses connections, avoids per-query overhead
     └── Cleanly drained on SIGTERM / SIGINT graceful shutdown
     ↓
PostgreSQL Database
```

---

## 3. Database Schema & Integrity Constraints

The `customers` table is provisioned via the versioned migration runner (`migrations/001_create_customers_table.sql`):

```sql
CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(254) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_customers_currency CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_lower 
ON customers (LOWER(email));
```

### Constraint Rationale
1. **Primary Key on `id`:** Retains the public API `cus_<uuidv4>` identifier directly in the database without artificial translation.
2. **Case-Insensitive Email Uniqueness:** `CREATE UNIQUE INDEX ... ON customers (LOWER(email))` prevents race conditions at the database engine level. `finance@wayne.com` and `FINANCE@WAYNE.COM` are guaranteed unique.
3. **Currency Invariant:** `CHECK (currency ~ '^[A-Z]{3}$')` enforces exact 3-letter uppercase ISO 4217 currency representations.
4. **Non-Null Invariants:** Mandatory fields cannot be set to `NULL`.
5. **UTC Timestamps:** `TIMESTAMPTZ` stores exact microsecond-precision UTC timestamps.

---

## 4. Migration System

Migrations are tracked in the database inside the `schema_migrations` table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Migration Idempotency
- Each migration file in `/migrations` is executed inside an atomic database transaction (`BEGIN ... COMMIT`).
- Successfully applied files are recorded in `schema_migrations`.
- Running `npm run migrate` repeatedly safely recognizes that existing migrations are already applied and skips them without errors.

---

## 5. Technology Stack

- **Runtime:** Node.js (v22+)
- **Framework:** Express.js (v4.21+)
- **Language:** TypeScript (v7+, strict mode enabled, `noImplicitAny: true`)
- **Database Driver:** `pg` (v8.13+, native node-postgres)
- **Database:** PostgreSQL (v15+)
- **Database Management:** Direct SQL with parameterized queries; zero ORM abstraction overhead
- **Testing:** Node.js native `node:test` and `node:assert/strict`
- **Execution:** `tsx` for high-performance TypeScript execution

---

## 6. Installation & Configuration

### Prerequisites
- Node.js (v22 or higher)
- PostgreSQL (v15 or higher) running locally or remotely

### 1. Environment Configuration
Copy the example environment file:
```bash
cp .env.example .env
```
Configure `DATABASE_URL` in `.env`:
```env
DATABASE_URL="postgresql://username:password@localhost:5432/billing_system"
```

> **SECURITY:** `.env` is ignored by Git. Real database credentials must never be committed.

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Database Migrations
Create the database tables and constraints:
```bash
npm run migrate
```

---

## 7. Running the Application

### Development Server
Starts the Express server with live reload:
```bash
npm run dev
```

### Production Build & Execution
```bash
npm run build
npm start
```

---

## 8. Verification & Testing

### 1. TypeScript Verification
```bash
npm run typecheck
```

### 2. Phase 1 Service Tests (In-Memory Isolation)
Verifies HTTP endpoints, request envelopes, and validations using an isolated in-memory repository:
```bash
npm test
```

### 3. Phase 2 PostgreSQL Integration Tests
Verifies real PostgreSQL database connectivity, schema migrations, constraints, unique indexes, process restart durability, and truthful degraded health reporting:
```bash
npm run test:integration
```

---

## 9. API Specification & Endpoints

**Base URL:** `http://localhost:3000/api/v1`

### Standard Response Envelopes

#### Success Envelope
```json
{
  "status": "success",
  "data": { ... }
}
```

#### Error Envelope
```json
{
  "status": "error",
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable description of the error"
  }
}
```

Standard error codes:
- `VALIDATION_ERROR` (HTTP 400)
- `MALFORMED_JSON` (HTTP 400)
- `RESOURCE_NOT_FOUND` (HTTP 404)
- `ROUTE_NOT_FOUND` (HTTP 404)
- `DUPLICATE_RESOURCE` (HTTP 409)
- `PAYLOAD_TOO_LARGE` (HTTP 413)
- `INTERNAL_SERVER_ERROR` (HTTP 500)

---

### Endpoints

#### 1. Truthful Health Check
Tests application uptime and executes `SELECT 1` on PostgreSQL.

- **URL:** `GET /api/v1/health`
- **Response (Database Connected - 200 OK):**
```json
{
  "status": "success",
  "data": {
    "status": "healthy",
    "timestamp": "2026-09-24T13:42:27.549Z",
    "uptime": 1.898774134,
    "database": {
      "status": "healthy"
    }
  }
}
```
- **Response (Database Degraded - 503 Service Unavailable):**
```json
{
  "status": "error",
  "data": {
    "status": "degraded",
    "timestamp": "2026-09-24T13:43:22.673Z",
    "uptime": 2.1245,
    "database": {
      "status": "unhealthy"
    }
  }
}
```

#### 2. List Customers
Returns all customers from PostgreSQL. Starts completely empty (`[]`).

- **URL:** `GET /api/v1/customers`
- **Response:** `200 OK`
```json
{
  "status": "success",
  "data": []
}
```

#### 3. Create Customer
Persists a customer to PostgreSQL. Server generates `id`, `createdAt`, and `updatedAt`.

- **URL:** `POST /api/v1/customers`
- **Headers:** `Content-Type: application/json`
- **Body:**
```json
{
  "name": "Wayne Enterprises",
  "email": "finance@wayne.com",
  "currency": "USD"
}
```
- **Response:** `201 Created`
- **Headers:** `Location: /api/v1/customers/cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3`
```json
{
  "status": "success",
  "data": {
    "id": "cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3",
    "name": "Wayne Enterprises",
    "email": "finance@wayne.com",
    "currency": "USD",
    "createdAt": "2026-09-24T13:42:32.165Z",
    "updatedAt": "2026-09-24T13:42:32.165Z"
  }
}
```

#### 4. Get Customer by ID
- **URL:** `GET /api/v1/customers/:id`
- **Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3",
    "name": "Wayne Enterprises",
    "email": "finance@wayne.com",
    "currency": "USD",
    "createdAt": "2026-09-24T13:42:32.165Z",
    "updatedAt": "2026-09-24T13:42:32.165Z"
  }
}
```

#### 5. Update Customer (PATCH)
- **URL:** `PATCH /api/v1/customers/:id`
- **Body:**
```json
{
  "name": "Wayne Enterprises Holdings",
  "currency": "EUR"
}
```
- **Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "id": "cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3",
    "name": "Wayne Enterprises Holdings",
    "email": "finance@wayne.com",
    "currency": "EUR",
    "createdAt": "2026-09-24T13:42:32.165Z",
    "updatedAt": "2026-09-24T13:42:38.516Z"
  }
}
```

#### 6. Delete Customer
- **URL:** `DELETE /api/v1/customers/:id`
- **Response:** `204 No Content` (Strictly empty body)

---

## 10. Security & Data Protection in Phase 2

1. **Strictly Parameterized SQL:** 100% of queries executed against PostgreSQL use positional parameters (`$1, $2, ...`). Zero string concatenation is permitted.
2. **Credential Sanitization:** Database credentials reside exclusively in environment variables. Database errors are caught and sanitized to generic `500 INTERNAL_SERVER_ERROR` without leaking hostnames, usernames, passwords, or schema table names.
3. **Graceful Pool Draining:** `SIGTERM` and `SIGINT` signals first stop HTTP reception, then drain all PostgreSQL client connections before exiting.
4. **No Fallback Ambiguity:** When PostgreSQL is unavailable, the application does **not** fall back to in-memory maps. It fails truthfully, preserving data integrity.

---

## 11. Known Limitations (Phase 2)

- **Single Table:** Only the `customers` resource is persisted. Products, invoices, and payments are scheduled for subsequent phases.
- **No Query Pagination:** `GET /api/v1/customers` returns all customers without cursor or limit/offset pagination.
- **No Multi-Row Transactions:** CRUD operations modify single rows. Multi-table transaction orchestration belongs to the invoicing phase.
- **Authentication:** The API does not yet require API keys or bearer tokens.

---

## 12. Phase 3 Architecture: Schema Validation & Standardized Error Handling

Phase 3 introduces an explicit, declarative validation layer and a unified, standardized error architecture across the entire request-response lifecycle.

### Request Lifecycle
```
HTTP Request
    ↓
HTTP / JSON Parsing (express.json limit: 100kb, strict: false)
    ↓ [catches SyntaxError → 400 MALFORMED_JSON]
Request Validation Middleware
    ├── validateCreateCustomer / validateUpdateCustomer
    └── validateCustomerId (:id format: cus_<string>)
    ↓ [catches invalid shape / constraints → 400 VALIDATION_ERROR with fields[]]
Route (/api/v1/customers)
    ↓
Controller (CustomerController)
    ├── Extracts typed, pre-sanitized DTOs
    └── Invokes domain service
    ↓
Service (CustomerService)
    ├── Orchestrates domain business rules & email uniqueness
    └── Protects entity invariants
    ↓
Repository (PostgresCustomerRepository)
    ├── Executes parameterized SQL queries ($1, $2, ...)
    └── Maps PostgreSQL error codes (e.g. 23505 → DuplicateResourceError)
    ↓
Centralized Error Handler (errorHandler)
    ├── Maps domain/application errors to standard HTTP status codes
    ├── Formats uniform JSON envelopes
    └── Sanitizes unexpected failures (never leaks stack traces, paths, or SQL)
    ↓
Standardized HTTP Response
```

### Standardized Error Envelopes

Every error response adheres strictly to the top-level envelope:
```json
{
  "status": "error",
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable diagnostic summary"
  }
}
```

#### Field-Level Validation Details
When validation fails for one or more fields, the error envelope includes a structured `fields` array providing granular diagnostics:
```json
{
  "status": "error",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "fields": [
      {
        "field": "name",
        "message": "Field 'name' is required"
      },
      {
        "field": "email",
        "message": "Field 'email' must be a valid email address"
      },
      {
        "field": "currency",
        "message": "Field 'currency' must be a valid 3-letter uppercase ISO code (e.g. USD, EUR, KES)"
      }
    ]
  }
}
```

### Application Error Vocabulary

| Error Code | HTTP Status | Description | Sanitization Guarantee |
|---|---|---|---|
| `VALIDATION_ERROR` | `400 Bad Request` | Missing/invalid fields, wrong types, unknown fields, immutable field modifications, or malformed customer IDs | Includes `fields[]` diagnostic array |
| `MALFORMED_JSON` | `400 Bad Request` | Unparseable JSON syntax received in HTTP request body | Sanitized message; no parser stack trace |
| `RESOURCE_NOT_FOUND` | `404 Not Found` | Target customer ID is structurally valid but does not exist in the database | Predictable message with ID |
| `ROUTE_NOT_FOUND` | `404 Not Found` | Requested HTTP path or method is not registered | Lists method and attempted route |
| `DUPLICATE_RESOURCE` | `409 Conflict` | Unique constraint conflict (e.g. case-insensitive email already in use) | Domain message; no raw SQL code 23505 |
| `PAYLOAD_TOO_LARGE` | `413 Payload Too Large` | Request body exceeds the 100kb limit | Rejects oversized payload safely |
| `DATABASE_ERROR` | `500 Internal Server Error` | Database connection or query operation failed | Operational query error logged server-side; response sanitized |
| `INTERNAL_SERVER_ERROR` | `500 Internal Server Error` | Unhandled runtime exception or infrastructure crash | Full stack trace logged to server stderr; response contains zero internal details |

### Request Contracts & Validation Invariants

#### 1. Create Customer (`POST /api/v1/customers`)
- **Body Shape:** Must be a valid JSON object (rejects `null`, arrays `[]`, strings `"..."`, numbers `123`).
- **Required Fields:** `name`, `email`, `currency`.
- **Field Constraints:**
  - `name`: String, 1–255 characters, trimmed, cannot be empty whitespace.
  - `email`: String, 1–254 characters, RFC-compliant format, trimmed & lowercased.
  - `currency`: String, exactly 3 uppercase alphabetic characters (`^[A-Z]{3}$`).
- **Unknown Fields:** Strict rejection. Supplying extra properties (e.g. `isAdmin`, `balance`) returns `400 VALIDATION_ERROR`.

#### 2. Update Customer (`PATCH /api/v1/customers/:id`)
- **Body Shape:** Must be a non-empty JSON object.
- **Allowed Mutable Fields:** `name`, `email`, `currency` (at least one must be provided).
- **Immutable Fields:** Modification of `id` or `createdAt` is explicitly rejected with `400 VALIDATION_ERROR`.
- **Unknown Fields:** Any field other than `name`, `email`, `currency` is rejected with `400 VALIDATION_ERROR`.

#### 3. Path Parameters (`:id`)
- **Format:** Must match `^cus_[a-zA-Z0-9_-]+$`.
- **Malformed ID (`12345`, `invalid!id`):** Returns `400 Bad Request` with `VALIDATION_ERROR`.
- **Valid Format but Nonexistent:** Returns `404 Not Found` with `RESOURCE_NOT_FOUND`.

---

## 13. Testing & Verification

The suite includes comprehensive automated tests across all locked phases:
1. **Unit, Validation, Authentication & Authorization Contract Tests (`npm test`):**
   - 18 Phase 1 functional tests verifying routing, CRUD, and isolated in-memory persistence.
   - 23 Phase 3 schema validation tests verifying shape validation, constraint enforcement, field details, immutable field protection, path parameter formats, malformed JSON handling, and failure injection sanitization.
   - 22 Phase 4 authentication tests verifying registration, scrypt password hashing, case-insensitive email uniqueness, login credential verification, timing-attack neutral dummy checks, Bearer token lifecycle, expiration verification, and protected endpoint access (`GET /auth/me` and `DELETE /customers/:id`).
   - 24 Phase 5 authorization tests verifying least-privilege role defaults (`user`), role validation, strict `401` vs `403 FORBIDDEN` separation, resource ownership binding (`accountId`), cross-account IDOR protection (`Account A` vs `Account B`), admin global access & deletion, and privilege escalation prevention.
   - Total: **87 passing unit & contract tests**.
2. **PostgreSQL Integration Tests (`npm run test:integration`):**
   - 19 PostgreSQL integration tests verifying migrations (`001_create_customers_table.sql`, `002_create_accounts_table.sql`, and `003_add_authorization_role_and_ownership.sql`), SQL-level constraints (PK, case-insensitive UNIQUE index, currency CHECK, role CHECK, foreign key `account_id`), durable restart survival, truthful degraded state reporting, and PostgreSQL-backed IDOR & RBAC enforcement.

To run tests:
```bash
npm test                  # Run all 87 unit, validation, authentication & authorization tests
npm run test:auth         # Run Phase 4 authentication test suite specifically
npm run test:authz        # Run Phase 5 authorization & IDOR test suite specifically
npm run test:integration  # Run Phase 2 & Phase 5 PostgreSQL integration test suite
```

---

## 14. Phase 4 Architecture: Authentication & Identity Management

Phase 4 establishes a cryptographically secure identity layer answering: **«Who is making this request?»**

### 1. Domain Separation: Accounts vs. Customers

An intentional boundary separates the accounting ledger from API authentication:

- **Customer (`customers` table):** A billing entity (individual or legal entity) that receives invoices, line items, and maintains a balance in a default ledger currency (`USD`, `EUR`, etc.).
- **Account (`accounts` table):** An authenticated identity (API user / operator / system client) holding login credentials (`email` + `passwordHash`) authorized to interact with the API.

An account signs in with credentials to issue Bearer tokens; customers do not have passwords.

### 2. Authentication Strategy: Stateless JWT Bearer Tokens

- **Protocol:** RFC 6750 Bearer Tokens via standard `Authorization: Bearer <token>` header.
- **Signing Algorithm:** HMAC with SHA-256 (`HS256`).
- **Signature Verification:** Constant-time verification (`crypto.timingSafeEqual`) prevents byte-by-byte timing leaks.
- **Key Derivation & Secret:** Configured via `JWT_SECRET` environment variable (minimum 32 characters).
- **Token Claims:** Minimal payload containing only identity and role claims:
  ```json
  {
    "sub": "acc_cb5d153e-a061-45ac-b338-acaa916bd5e5",
    "email": "operator@billing.com",
    "role": "user",
    "iat": 1727280000,
    "exp": 1727366400
  }
  ```
- **Security Guarantees:**
  - Passwords and password hashes are **never** placed into JWT claims.
  - No personal or sensitive billing data is stored in the token.
  - Explicit expiration window: default 24 hours (`86400` seconds), configurable via `JWT_EXPIRES_IN`.
  - Expired tokens are rejected immediately with `401 TOKEN_EXPIRED`.
  - Tampered or malformed tokens (including unrecognized `role` claims) are rejected with `401 INVALID_TOKEN`.

### 3. Password Security: Memory-Hard `scrypt`

- **Algorithm:** Node.js native `crypto.scrypt` (OWASP recommended memory-hard password derivation function).
- **Work Factor:** `N = 16384` (CPU/memory cost), `r = 8` (block size), `p = 1` (parallel threads), derived key length = 64 bytes.
- **Salt:** 16 cryptographically secure random bytes generated per password (`crypto.randomBytes(16)`), defeating rainbow tables.
- **Storage Format:** Positional crypt string: `scrypt$N=16384,r=8,p=1$<saltHex>$<derivedKeyHex>`.
- **Policy Invariants:**
  - Minimum 8 characters, maximum 128 characters.
  - Rejection of whitespace-only strings.
  - Passwords are **never** logged to disk or console.
  - Passwords and hashes are **never** returned in HTTP responses.

### 4. Anti-Enumeration & Timing Attack Defense

To eliminate user enumeration vulnerabilities during login:
1. **Unified Error Contract:** Attempting to log in with an unknown email or with an incorrect password returns the exact same response:
   ```json
   {
     "status": "error",
     "error": {
       "code": "INVALID_CREDENTIALS",
       "message": "Invalid email or password"
     }
   }
   ```
2. **Constant-Time Execution via Dummy Hash:** When an email is not found in the database, `AuthService` executes a real `scrypt` derivation against an internal pre-computed dummy hash. As a result, the server response latency for nonexistent accounts is virtually identical to existing accounts with incorrect passwords.

### 5. Authentication Endpoints

#### Register Account
- **URL:** `POST /api/v1/auth/register`
- **Request Body:**
  ```json
  {
    "email": "operator@billing.com",
    "password": "SuperSecurePassword123!"
  }
  ```
- **Response (201 Created):**
  - **Header:** `Location: /api/v1/auth/me`
  ```json
  {
    "status": "success",
    "data": {
      "id": "acc_cb5d153e-a061-45ac-b338-acaa916bd5e5",
      "email": "operator@billing.com",
      "role": "user",
      "createdAt": "2026-09-25T17:22:04.717Z",
      "updatedAt": "2026-09-25T17:22:04.717Z"
    }
  }
  ```

#### Login & Issue Token
- **URL:** `POST /api/v1/auth/login`
- **Request Body:**
  ```json
  {
    "email": "operator@billing.com",
    "password": "SuperSecurePassword123!"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "status": "success",
    "data": {
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "tokenType": "Bearer",
      "expiresIn": 86400,
      "account": {
        "id": "acc_cb5d153e-a061-45ac-b338-acaa916bd5e5",
        "email": "operator@billing.com",
        "role": "user",
        "createdAt": "2026-09-25T17:22:04.717Z",
        "updatedAt": "2026-09-25T17:22:04.717Z"
      }
    }
  }
  ```

#### Current Authenticated Identity (Protected)
- **URL:** `GET /api/v1/auth/me`
- **Header:** `Authorization: Bearer <token>`
- **Response (200 OK):**
  ```json
  {
    "status": "success",
    "data": {
      "id": "acc_cb5d153e-a061-45ac-b338-acaa916bd5e5",
      "email": "operator@billing.com",
      "role": "user",
      "createdAt": "2026-09-25T17:22:04.717Z",
      "updatedAt": "2026-09-25T17:22:04.717Z"
    }
  }
  ```

---

## 15. Phase 5 Architecture: Authorization & Access Control

Phase 5 establishes a deterministic authorization layer answering: **«What is this authenticated identity allowed to do?»**

### 1. Authentication vs. Authorization Pipeline

Authentication and authorization are strictly separated across the request lifecycle:

```
HTTP Request
     ↓
Authentication Middleware (authenticate)
     ├── Validates Bearer token signature & expiration
     ├── Establishes req.user = { id, email, role }
     └── Fails with 401 Unauthorized (AUTHENTICATION_REQUIRED | INVALID_TOKEN | TOKEN_EXPIRED)
     ↓
Route Authorization Middleware (authorize(...allowedRoles))
     ├── Evaluates req.user.role against route role policy ('user' | 'admin')
     ├── Contains zero business logic and zero SQL queries
     └── Fails with 403 Forbidden (FORBIDDEN)
     ↓
Validation Middleware (validate*)
     ├── Validates path parameters and JSON request body
     └── Rejects client-supplied role/ownership fields with 400 VALIDATION_ERROR
     ↓
CustomerController
     ├── Extracts req.user and validated DTO
     └── Delegates to CustomerService
     ↓
CustomerService (Resource Ownership Policy)
     ├── Binds customer.accountId = req.user.id on creation
     ├── Enforces ownership (customer.accountId === req.user.id || req.user.role === 'admin')
     ├── Protects against Insecure Direct Object Reference (IDOR) with 403 FORBIDDEN
     └── Restricts destructive DELETE strictly to 'admin' role
     ↓
Repository (PostgresCustomerRepository / InMemoryCustomerRepository)
     └── Executes parameterized persistence queries
```

### 2. Domain Relationship: `Account` (1) → `Customer` (0..N)

Preserving Phase 4's separation between **Account** (authenticated identity) and **Customer** (billing ledger record), Phase 5 establishes an explicit ownership relationship:
- Each `Customer` record belongs to an owning `Account` via `accountId` (`customers.account_id` foreign key referencing `accounts(id)`).
- Ownership is assigned exclusively server-side from the authenticated `req.user.id` when `POST /api/v1/customers` is executed.
- Clients can **never** supply or modify `accountId`, `userId`, or `ownerId` in request bodies.

### 3. Role Model & Least-Privilege Default

The authorization model defines a minimal, non-speculative two-role set justified directly by API operations:

| Role | Assignment Mechanism | Capabilities |
|---|---|---|
| `user` | **Default least-privileged role** assigned server-side (`AuthService.register`) and enforced by database default (`DEFAULT 'user'`). | Create customers (bound to own `accountId`), list own customers, inspect own customer (`GET /:id`), and update own customer (`PATCH /:id`). Cannot access other accounts' customers or delete ledger records. |
| `admin` | **Out-of-band provisioned** (never via public registration). | Full ledger visibility (`GET /customers`, `GET /customers/:id`), cross-account customer updates (`PATCH /customers/:id` while preserving original `accountId`), and destructive customer deletion (`DELETE /customers/:id`). |

### 4. Administrator Provisioning Strategy

To prevent privilege escalation:
- Public registration (`POST /api/v1/auth/register`) strictly rejects any `role` attribute in the request body (`400 VALIDATION_ERROR`) and hard-assigns `role: 'user'` in `AuthService.register`.
- No hard-coded administrator credentials or fake admin accounts are seeded in application runtime code.
- In production environments, `admin` privileges are granted out-of-band by an authorized database administrator or internal ops migration against the `accounts` table:
  ```sql
  UPDATE accounts SET role = 'admin', updated_at = NOW() WHERE email = 'ops-admin@company.com';
  ```

### 5. Customer Endpoint Authorization Policy Matrix

| Endpoint | Unauthenticated | Authenticated `user` (Owner) | Authenticated `user` (Non-Owner / IDOR) | Authenticated `admin` |
|---|---|---|---|---|
| `POST /api/v1/customers` | `401 AUTHENTICATION_REQUIRED` | `201 Created` (`accountId = req.user.id`) | N/A | `201 Created` (`accountId = req.user.id`) |
| `GET /api/v1/customers` | `401 AUTHENTICATION_REQUIRED` | `200 OK` (Scoped to own customers) | N/A (Filtered out) | `200 OK` (All customers) |
| `GET /api/v1/customers/:id` | `401 AUTHENTICATION_REQUIRED` | `200 OK` | `403 FORBIDDEN` (Zero data leakage) | `200 OK` |
| `PATCH /api/v1/customers/:id` | `401 AUTHENTICATION_REQUIRED` | `200 OK` | `403 FORBIDDEN` (Record untouched) | `200 OK` (`accountId` preserved) |
| `DELETE /api/v1/customers/:id` | `401 AUTHENTICATION_REQUIRED` | `403 FORBIDDEN` | `403 FORBIDDEN` | `204 No Content` |

### 6. Standardized `401` vs. `403` Error Contract

- **401 Unauthorized (`AUTHENTICATION_REQUIRED` / `INVALID_TOKEN` / `TOKEN_EXPIRED`):** Missing, malformed, tampered, or expired Bearer token.
- **403 Forbidden (`FORBIDDEN`):** Valid authenticated identity, but insufficient role or ownership permission:
  ```json
  {
    "status": "error",
    "error": {
      "code": "FORBIDDEN",
      "message": "You are not authorized to perform this action"
    }
  }
  ```

### 7. Phase 5 Database Schema Migration (`003_add_authorization_role_and_ownership.sql`)

```sql
ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS role VARCHAR(32) NOT NULL DEFAULT 'user';

ALTER TABLE accounts
ADD CONSTRAINT chk_accounts_role CHECK (role IN ('user', 'admin'));

ALTER TABLE customers
ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL
CONSTRAINT fk_customers_account_id REFERENCES accounts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_customers_account_id ON customers (account_id);
```

---

## 16. Phase 6 Architecture: Relationships & Relational Domain Modeling

Phase 6 establishes authoritative relational modeling, foreign key enforcement, atomic database transactions, and deterministic integer-cents financial computation across the core billing entities.

### 1. Relational Domain Hierarchy

```
Account (accounts.id)
   │ 1
   │
   └── 0..N Customer (customers.id, FK: customers.account_id → accounts.id)
               │ 1
               │
               └── 0..N Invoice (invoices.id, FK: invoices.customer_id → customers.id ON DELETE RESTRICT)
                           │ 1
                           │
                           └── 1..N InvoiceItem (invoice_items.id, FK: invoice_items.invoice_id → invoices.id ON DELETE CASCADE)
```

- **Account → Customer (`1..N`):** An authenticated `Account` owns zero or more `Customer` ledger records.
- **Customer → Invoice (`1..N`):** Each `Invoice` belongs to exactly one `Customer` via `invoices.customer_id`. An invoice cannot exist without a valid parent customer (`404 RESOURCE_NOT_FOUND` on creation if customer does not exist).
- **Invoice → InvoiceItem (`1..N`):** Each `Invoice` contains one or more line items (`InvoiceItem`) via `invoice_items.invoice_id`. An invoice cannot be created or updated with zero line items (`400 VALIDATION_ERROR`).

### 2. Invoice & InvoiceItem Models

#### Invoice (`invoices` table)
- `id`: Internal collision-resistant identifier (`inv_<uuidv4>`, Primary Key).
- `customerId`: Parent customer reference (`cus_<uuidv4>`, Foreign Key → `customers(id) ON DELETE RESTRICT`).
- `invoiceNumber`: Unique human-readable billing reference (`INV-YYYY-XXXX-XXXX`, `UNIQUE` constraint).
- `status`: Explicit lifecycle state restricted to `'draft' | 'issued' | 'paid' | 'overdue' | 'cancelled'` (Default: `'draft'`).
- `currency`: 3-letter ISO 4217 currency code inherited from or matching the parent `Customer` currency (`CHECK (currency ~ '^[A-Z]{3}$')`).
- `subtotal`: Authoritative server-computed sum of all line item totals (`NUMERIC(12, 2)`).
- `tax`: Non-negative tax amount (`NUMERIC(12, 2)`, default `0`).
- `discount`: Non-negative discount amount (`NUMERIC(12, 2)`, default `0`, cannot exceed `subtotal + tax`).
- `total`: Authoritative server-computed net total (`subtotal + tax - discount`, `CHECK (total = subtotal + tax - discount)`).
- `issueDate` / `dueDate`: UTC ISO 8601 timestamps (`dueDate >= issueDate`).
- `notes`: Optional billing memo (`VARCHAR(1000)`).
- `items`: Hydrated array of `InvoiceItem` records belonging to the invoice.

#### InvoiceItem (`invoice_items` table)
- `id`: Internal identifier (`item_<uuidv4>`, Primary Key).
- `invoiceId`: Parent invoice reference (`inv_<uuidv4>`, Foreign Key → `invoices(id) ON DELETE CASCADE`).
- `description`: Non-empty line item description (`1..500` characters).
- `quantity`: Positive integer (`INTEGER`, `CHECK (quantity > 0)`).
- `unitPrice`: Non-negative unit price (`NUMERIC(12, 2)`, `CHECK (unit_price >= 0)`).
- `lineTotal`: Authoritative server-computed line total (`quantity * unitPrice`, `CHECK (line_total = quantity * unit_price)`).

### 3. Authoritative Financial Calculation & Anti-Tampering

- **Zero Client Trust for Totals:** Clients supply only `quantity`, `unitPrice`, `tax`, and `discount`. Supplying `lineTotal`, `subtotal`, `total`, or `invoiceNumber` in request payloads is rejected with `400 VALIDATION_ERROR`.
- **Integer-Cents Precision:** All financial arithmetic in `InvoiceService` is executed in integer cents (`Math.round(amount * 100)`) before converting to two-decimal currency values, eliminating IEEE 754 floating-point drift (e.g. `3 * 19.99 + 2 * 10.05 = 80.07`).
- **Finalized State Protection:** Once an invoice is transitioned to `'paid'` or `'cancelled'`, its `items`, `tax`, and `discount` are locked; attempts to mutate financial amounts return `409 CONFLICT`.

### 4. Referential Integrity, Delete Semantics & Atomic Transactions

- **Atomic Multi-Row Persistence (`BEGIN ... COMMIT / ROLLBACK`):** Creating or updating an invoice and its `invoice_items` executes inside a single PostgreSQL transaction in `PostgresInvoiceRepository`. If any line item fails a constraint, the entire transaction rolls back so no partial or itemless invoice is ever persisted.
- **Customer Deletion Guard (`ON DELETE RESTRICT`):** Attempting to delete a `Customer` that has existing `Invoice` records is blocked by both `CustomerService` and PostgreSQL `fk_invoices_customer_id ON DELETE RESTRICT`, returning `409 CONFLICT` to preserve historical accounting records.
- **Invoice Item Cascade (`ON DELETE CASCADE`):** When an `admin` deletes an `Invoice` (`DELETE /api/v1/invoices/:id`), all child `invoice_items` are atomically removed via `fk_invoice_items_invoice_id ON DELETE CASCADE`.

### 5. Phase 6 Relational Endpoints & Authorization Policy

Ownership flows transitively from `Account → Customer → Invoice → InvoiceItem`:

| Endpoint | Unauthenticated | Authenticated `user` (Owner of Customer) | Authenticated `user` (Non-Owner / IDOR) | Authenticated `admin` |
|---|---|---|---|---|
| `POST /api/v1/customers/:id/invoices` | `401 AUTHENTICATION_REQUIRED` | `201 Created` (`Location: /api/v1/invoices/:id`) | `403 FORBIDDEN` | `201 Created` |
| `GET /api/v1/customers/:id/invoices` | `401 AUTHENTICATION_REQUIRED` | `200 OK` (Customer's invoices + items) | `403 FORBIDDEN` | `200 OK` |
| `POST /api/v1/invoices` | `401 AUTHENTICATION_REQUIRED` | `201 Created` | `403 FORBIDDEN` | `201 Created` |
| `GET /api/v1/invoices` | `401 AUTHENTICATION_REQUIRED` | `200 OK` (Scoped via `JOIN customers` to own customers) | N/A (Filtered out) | `200 OK` (All invoices) |
| `GET /api/v1/invoices/:id` | `401 AUTHENTICATION_REQUIRED` | `200 OK` (Invoice + `items[]`) | `403 FORBIDDEN` | `200 OK` |
| `GET /api/v1/invoices/:id/items` | `401 AUTHENTICATION_REQUIRED` | `200 OK` (`InvoiceItem[]`) | `403 FORBIDDEN` | `200 OK` |
| `PATCH /api/v1/invoices/:id` | `401 AUTHENTICATION_REQUIRED` | `200 OK` (Recalculates totals) | `403 FORBIDDEN` | `200 OK` |
| `DELETE /api/v1/invoices/:id` | `401 AUTHENTICATION_REQUIRED` | `403 FORBIDDEN` | `403 FORBIDDEN` | `204 No Content` (Cascades items) |

---

## 17. Phase 7 Architecture: Pagination, Filtering & Deterministic Sorting

Phase 7 equips all collection endpoints with bounded offset pagination, parameterized domain filtering, and whitelisted deterministic sorting while preserving Phase 4 authentication, Phase 5 ownership/RBAC authorization, and Phase 6 relational integrity.

### 1. Paginatable Collection Endpoints

| Endpoint | Resource | Default Sort |
|---|---|---|
| `GET /api/v1/customers` | Customers | `createdAt ASC, id ASC` |
| `GET /api/v1/invoices` | Invoices (with hydrated `items[]`) | `createdAt ASC, id ASC` |
| `GET /api/v1/customers/:id/invoices` | Customer's Invoices (with hydrated `items[]`) | `createdAt ASC, id ASC` |
| `GET /api/v1/invoices/:id/items` | Invoice Line Items | `createdAt ASC, id ASC` |

### 2. Pagination Strategy & Bounds

The API implements **1-indexed Page/Limit Offset Pagination**:
- `page`: `1`-indexed page number (Default: `1`, Minimum: `1`, Maximum: `1,000,000`).
- `limit`: Maximum records per page (Default: `20`, Minimum: `1`, Maximum: `100`).
- `OFFSET` formula: `offset = (page - 1) * limit`.
- Any invalid `page` or `limit` (`0`, negative, non-numeric, fractional, or `limit > 100`) is rejected at the validation middleware layer with `400 VALIDATION_ERROR`.

#### Paginated Response Contract
Every collection endpoint returns `data` (the array of records for the current page) alongside a top-level `pagination` metadata block:
```json
{
  "status": "success",
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "totalPages": 3,
    "hasNextPage": true,
    "hasPreviousPage": false
  }
}
```
- When `total === 0`, `data` is `[]`, `totalPages` is `0`, `hasNextPage` is `false`, and `hasPreviousPage` is `false`.
- Requesting a valid page beyond `totalPages` (e.g. `?page=10&limit=20` when `total` is `5`) returns `200 OK` with `data: []` and truthful `pagination` metadata.

### 3. Supported Filters & Whitelisted Sorting

#### Customers (`GET /api/v1/customers`)
- **Filters:**
  - `currency`: Exact 3-letter uppercase ISO 4217 code (`USD`, `EUR`, `KES`).
  - `email`: Case-insensitive exact email match (`LOWER(email) = LOWER($N)`).
  - `name`: Case-insensitive substring match (`name ILIKE $N`).
- **Whitelisted `sort` fields:** `createdAt`, `updatedAt`, `name`, `email`.
- **`order` direction:** `asc` (default) or `desc`.

#### Invoices (`GET /api/v1/invoices` & `GET /api/v1/customers/:id/invoices`)
- **Filters:**
  - `status`: One of `'draft' | 'issued' | 'paid' | 'overdue' | 'cancelled'`.
  - `customerId`: Customer ID (`cus_<uuid>`, top-level `/api/v1/invoices` endpoint).
  - `currency`: Exact 3-letter uppercase ISO 4217 code (`USD`, `EUR`, `KES`).
  - `issueDate`, `issueDateFrom`, `issueDateTo`: ISO 8601 timestamp or `YYYY-MM-DD` date bounds.
  - `dueDate`, `dueDateFrom`, `dueDateTo`: ISO 8601 timestamp or `YYYY-MM-DD` date bounds.
- **Whitelisted `sort` fields:** `createdAt`, `updatedAt`, `issueDate`, `dueDate`, `total`, `subtotal`, `invoiceNumber`, `status`.
- **`order` direction:** `asc` (default) or `desc`.

#### Invoice Items (`GET /api/v1/invoices/:id/items`)
- **Filters:**
  - `description`: Case-insensitive substring match (`description ILIKE $N`).
- **Whitelisted `sort` fields:** `createdAt`, `quantity`, `unitPrice`, `lineTotal`, `description`.
- **`order` direction:** `asc` (default) or `desc`.

### 4. SQL Injection Prevention & Authorization-First Scoping

1. **Zero Raw SQL Interpolation:** Filter values, `LIMIT`, and `OFFSET` are passed exclusively as positional SQL parameters (`$1, $2, ...`).
2. **Strict Column Whitelisting:** `sort` and `order` values are validated against compile-time whitelists and mapped through static lookup dictionaries (`CUSTOMER_SORT_COLUMN_MAP`, `INVOICE_SORT_COLUMN_MAP`, `INVOICE_ITEM_SORT_COLUMN_MAP`) with deterministic primary-key tie-breaking (`ORDER BY <column> <dir>, id <dir>`).
3. **Authorization Scope Applied First:** For regular `user` accounts, `accountId = req.user.id` is injected server-side into both the `SELECT` query and the `COUNT(*)` query. Filtering by `?customerId=<another-users-customer>` never bypasses ownership and never leaks unauthorized records or counts.

### 5. Phase 7 Database Indexes (`005_add_pagination_and_filtering_indexes.sql`)

```sql
CREATE INDEX IF NOT EXISTS idx_customers_currency ON customers (currency);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers (created_at);

CREATE INDEX IF NOT EXISTS idx_invoices_currency ON invoices (currency);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices (due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices (issue_date);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices (created_at);
```

---

## 18. Phase 8 Architecture: Testing & Quality Engineering

Phase 8 establishes a layered, deterministic Quality Engineering and automated verification architecture across Phases 1–7 using Node.js native test runner (`node:test`) and strict assertions (`node:assert/strict`) without introducing external framework bloat.

### 1. The Testing Pyramid

```
              /\
             /  \        Layer 3: E2E / Full HTTP & Live PostgreSQL Suites
            /----\       (http-contracts-and-security, api, validation, auth,
           /      \       authorization, relationships, pagination, postgres)
          /--------\     Layer 2: Service ↔ Repository ↔ Driver Integration
         /          \    (service-repository.integration.test.ts: transactions,
        /------------\    ROLLBACK safety, SQLSTATE mapping, N+1 batch check)
       /              \  Layer 1: Fast Isolated Unit Tests
      /________________\ (domain-and-services.unit.test.ts: math, pagination,
                          validators, crypto helpers, error mapping, DB guard)
```

### 2. Test Layers & Suites

| Layer | Suite File | Scope & Responsibilities Verified |
|---|---|---|
| **Shared Fixtures & Harness** | `src/test/helpers/fixtures.ts` | Deterministic builders (`buildAccountFixture`, `buildCustomerDtoFixture`, `buildInvoiceDtoFixture`, `buildInvoiceEntityFixture`), `createIsolatedHttpHarness()`, and `assertSafeTestDatabaseUrl()` safety guard. |
| **Layer 1: Unit Tests** | `src/test/unit/domain-and-services.unit.test.ts` | `buildPaginationMeta` boundary math, domain type guards (`isValidAccountRole`, `isValidInvoiceStatus`, `toAccountDTO`), schema validators, `PasswordService` scrypt salt & malformed hash safety, `TokenService` `alg: "none"` and wrong-secret defense, IEEE-754 integer-cents invoice arithmetic, 100% discount boundary (`total === 0.00`), finalized invoice mutation locks, and `errorHandler` status/code mapping. |
| **Layer 2: Service ↔ Repo Integration** | `src/test/integration/service-repository.integration.test.ts` | Atomic multi-table PostgreSQL transaction lifecycle (`BEGIN` → `INSERT` → `COMMIT` vs mid-item failure `ROLLBACK` + `client.release()`), PostgreSQL SQLSTATE translation (`23505` → `409 DUPLICATE_RESOURCE`, `23503` → `409 CONFLICT` / `404 RESOURCE_NOT_FOUND`, `23514` → `400 VALIDATION_ERROR`), and N+1 query elimination via batched `WHERE invoice_id = ANY($1::text[])` item hydration. |
| **Layer 3a: HTTP Contracts & Security** | `src/test/http/http-contracts-and-security.test.ts` | Security headers (`x-powered-by` omitted, `Location` header on `201 Created`, `Content-Type: application/json`), `413 PAYLOAD_TOO_LARGE` (>100kb), SQL injection neutralization on search filters, query parameter array pollution (`?page=1&page=2`), and zero credential/hash leakage. |
| **Layer 3b: Phase 1–7 Feature Suites** | `src/test/api.test.ts`<br>`src/test/validation.test.ts`<br>`src/test/auth.test.ts`<br>`src/test/authorization.test.ts`<br>`src/test/relationships.test.ts`<br>`src/test/pagination.test.ts` | End-to-end HTTP behavioral coverage of Customer CRUD, Schema Validation, Authentication, RBAC & IDOR Authorization, Relational Invoices/Items, and Pagination/Filtering/Sorting. |
| **Layer 3c: Live PostgreSQL Integration** | `src/test/postgres.test.ts` | Real PostgreSQL 15 persistence: idempotent migrations (`001`–`005`), SQL-level constraints, cascade/restrict delete rules, live SQL `LIMIT`/`OFFSET` & indexed filtering, and proof that resetting `billing_system_test` never affects persistent records in `billing_system`. |

### 3. Test Database Isolation & Repeatable Lifecycle

1. **Dedicated Test Database (`Development DB ≠ Test DB`):**
   - Development database: `postgresql://postgres@localhost:5432/billing_system` (`DATABASE_URL`)
   - Dedicated test database: `postgresql://postgres@localhost:5432/billing_system_test` (`TEST_DATABASE_URL`)
2. **Programmatic Safety Guard (`assertSafeTestDatabaseUrl`):**
   - Before any `TRUNCATE` executes in `src/test/postgres.test.ts`, `assertSafeTestDatabaseUrl(TEST_DATABASE_URL, process.env.DATABASE_URL)` verifies that the target database name ends with `_test` and is never identical to `DATABASE_URL`.
3. **Repeatable Database Lifecycle:**
   ```
   Start Test Suite
        ↓
   Enforce assertSafeTestDatabaseUrl (Verify *_test DB ≠ Dev DB)
        ↓
   Apply Pending SQL Migrations (001..005 via runMigrations)
        ↓
   Reset Test Tables (TRUNCATE invoice_items, invoices, customers, accounts CASCADE)
        ↓
   Seed Controlled Fixtures & Execute Tests
        ↓
   Close HTTP Server & Drain pg.Pool (testPool.end())
   ```

### 4. Running the Test Suites

```bash
# Run all fast Unit, Service-Repository Integration, HTTP Security, and Phase 1–9 Contract suites
npm test

# Run individual test layers
npm run test:unit                  # Layer 1: Isolated unit tests
npm run test:service-integration   # Layer 2: Service ↔ Repository transaction & SQLSTATE integration tests
npm run test:http                  # Layer 3a: HTTP contract, 413 limit & security regression tests
npm run test:security              # Phase 9 security hardening test suite
npm run test:validation            # Phase 3 validation suite
npm run test:auth                  # Phase 4 authentication suite
npm run test:authorization         # Phase 5 authorization & IDOR suite
npm run test:relationships         # Phase 6 relational domain suite
npm run test:pagination            # Phase 7 pagination, filtering & sorting suite

# Run live PostgreSQL database integration suite (requires PostgreSQL with billing_system_test DB)
npm run test:integration

# Run the entire test pyramid including live PostgreSQL integration tests
npm run test:all
```

---

## 19. Phase 9 Architecture: Security Hardening

Phase 9 hardens the Billing System REST API against concrete application-level threats across authentication, authorization, input validation, rate limiting, HTTP transport headers, CORS, method handling, secret management, and log redaction while preserving the layered architecture from Phases 1–8.

### 1. Threat Model

| Threat Actor | Trust Level | Primary Attack Vectors | Mitigations Enforced |
|---|---|---|---|
| **Anonymous Attacker** | Unauthenticated (`none`) | Brute-force login guessing, registration flooding, SQL injection in query/body fields, oversized payload DoS, malformed JWT / `alg: "none"` forgery, unsupported HTTP method probing. | `createAuthRateLimiter` (`429 RATE_LIMIT_EXCEEDED`), `createApiRateLimiter`, `scrypt` memory-hard hashing + dummy verification, `express.json({ limit: '100kb' })` (`413`), strict `HS256` signature & header validation (`401`), `405 METHOD_NOT_ALLOWED`. |
| **Normal Authenticated User** | Valid `role: 'user'` JWT | Horizontal privilege escalation (IDOR) against another account's customers/invoices/items, cross-account `?customerId=` filter enumeration, vertical privilege escalation (`{"role": "admin"}`), mass assignment of `accountId`/`total`/`subtotal`. | Server-side `accountId === req.user.id` ownership checks on every read/write/nested route (`403 FORBIDDEN`), authorization-first SQL `WHERE` scoping on `SELECT` and `COUNT(*)`, strict schema field whitelists (`400 VALIDATION_ERROR`). |
| **Malicious / Compromised Privileged User** | Valid `role: 'admin'` JWT | Attempting to corrupt financial math, bypass finalized (`paid`/`cancelled`) invoice locks, inject SQL via sort/filter parameters, or extract password hashes/secrets from responses. | Server-computed integer-cents financial math, `409 CONFLICT` lock on finalized invoices, parameterized SQL + static column whitelist maps, complete omission of `passwordHash` and secrets from all DTOs and error responses. |

### 2. Defense-in-Depth Controls

#### A. Brute-Force & Request Rate Limiting (`src/api/middlewares/rate-limit.middleware.ts`)
- **Authentication Rate Limiter (`createAuthRateLimiter`):**
  - Applied to `POST /api/v1/auth/login` and `POST /api/v1/auth/register`.
  - Default window: `60,000 ms` (`AUTH_RATE_LIMIT_WINDOW_MS`), default max: `30` requests per IP per endpoint (`AUTH_RATE_LIMIT_MAX`).
- **General API Rate Limiter (`createApiRateLimiter`):**
  - Applied to `/api/v1/*` routes to guard against runaway client loops and high-rate floods.
  - Default window: `60,000 ms` (`API_RATE_LIMIT_WINDOW_MS`), default max: `300` requests per IP (`API_RATE_LIMIT_MAX`).
- **Response Contract & Memory Safety:**
  - Emits `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` on every response.
  - Returns `429 Too Many Requests` (`code: 'RATE_LIMIT_EXCEEDED'`) with a standard `Retry-After` header when exceeded.
  - Bounds internal tracking map to `MAX_TRACKED_KEYS = 10,000` with automatic expired-bucket eviction.

#### B. Authentication, Password & Token Hardening (`src/api/services/token.service.ts` & `auth.schema.ts`)
- **Password Policy & CPU Amplification Defense:**
  - Enforces `8..128` characters on both registration **and** login (`validateLoginBody`), blocking oversized multi-kilobyte password payloads from amplifying `scrypt` CPU work.
  - Rejects null bytes (`\u0000`) and whitespace-only passwords with `400 VALIDATION_ERROR`.
- **JWT Algorithm & Claim Hardening:**
  - Explicitly verifies `header.alg === 'HS256'` and `header.typ === 'JWT'` alongside `crypto.timingSafeEqual` HMAC-SHA256 verification, defeating `alg: "none"` and algorithm-confusion attacks.
  - Enforces `MAX_TOKEN_LENGTH = 4096` bytes before parsing/hashing.
  - Validates `sub`, `email`, `role` (`'user' | 'admin'`), `iat`, and `exp` claims.
- **Production Fail-Closed Secret Validation (`resolveAndValidateJwtSecret`):**
  - When `NODE_ENV === 'production'`, startup fails closed with `SecurityConfigurationError` if `JWT_SECRET` is unset, shorter than 32 characters, or set to a placeholder (`MY_JWT_SECRET`, `changeme`, or the development fallback key).

#### C. Input Validation, Mass Assignment, Null-Byte & Prototype Pollution Protection
- All body and query validators inspect `Object.getOwnPropertyNames` and explicitly reject `__proto__`, `constructor`, `prototype`, and any unrecognized or server-computed fields (`id`, `accountId`, `role`, `subtotal`, `total`, `lineTotal`, `invoiceNumber`, `createdAt`, `updatedAt`) with `400 VALIDATION_ERROR`.
- All string inputs (`name`, `email`, `password`, `description`, `notes`) reject null bytes (`\u0000`) at the validation boundary before reaching PostgreSQL UTF-8 drivers.

#### D. HTTP Security Headers, Conditional HSTS, CORS & `405 Method Not Allowed`
- **Security Headers (`src/api/middlewares/security-headers.middleware.ts`):**
  - `X-Powered-By`: Disabled (`app.disable('x-powered-by')`).
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()`
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (on `/api/*`)
  - `Cache-Control: no-store` and `Pragma: no-cache` (on `/api/*`)
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains` emitted **only** when `NODE_ENV === 'production'` or `ENABLE_HSTS === 'true'`.
- **Restrictive CORS Policy (`src/api/middlewares/cors.middleware.ts`):**
  - Denies cross-origin browser access by default when `CORS_ALLOWED_ORIGINS` is empty.
  - Grants `Access-Control-Allow-Origin` only to origins explicitly listed in `CORS_ALLOWED_ORIGINS` (never reflects arbitrary origins or `*`).
- **HTTP Method Hardening (`src/api/middlewares/method-not-allowed.middleware.ts`):**
  - Unsupported HTTP verbs on known routes (`/api/v1/health`, `/api/v1/auth/*`, `/api/v1/customers*`, `/api/v1/invoices*`) return `405 Method Not Allowed` (`code: 'METHOD_NOT_ALLOWED'`) with an RFC 9110 `Allow` header.

#### E. Logging Redaction & Database Security (`src/api/security/redaction.ts`)
- `redactSensitiveUrl` and `redactSensitiveText` strip CRLF characters (`\r`, `\n`) to prevent log injection and automatically redact `password`, `token`, `secret`, `Bearer <jwt>`, `scrypt$...` hashes, and `postgresql://user:pass@host` connection strings from request and operational error logs.
- **Recommended Production Database Privilege Posture:**
  - Run schema migrations (`npm run migrate`) using a migration/DDL role, and run the Express API process using a least-privilege application role granted only `SELECT, INSERT, UPDATE, DELETE` on `accounts, customers, invoices, invoice_items` (without `DROP`, `ALTER`, or `SUPERUSER` privileges).

### 3. Security Environment Variables

| Variable | Default (Dev) | Purpose |
|---|---|---|
| `JWT_SECRET` | Dev fallback (Fails closed in `production`) | HMAC-SHA256 signing secret (minimum 32 characters required in production). |
| `JWT_EXPIRES_IN` | `86400` (24h) | JWT expiration window in seconds. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `60000` (60s) | Window duration for `/api/v1/auth/login` and `/register` rate limiting. |
| `AUTH_RATE_LIMIT_MAX` | `30` | Maximum auth attempts per window per client IP + route. |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` (60s) | Window duration for general `/api/v1/*` rate limiting. |
| `API_RATE_LIMIT_MAX` | `300` | Maximum general API requests per window per client IP. |
| `CORS_ALLOWED_ORIGINS` | `""` (Disabled) | Comma-separated list of allowed browser origins for CORS. |
| `ENABLE_HSTS` | `"false"` (`"true"` in `production`) | Controls emission of `Strict-Transport-Security` header. |

### 4. Known Security Limitations
1. **Process-Local Rate Limiting:** Rate limit counters reside in process memory (`Map`). In a multi-instance horizontal deployment (Phase 13), limits apply per Node.js process unless backed by a shared store or upstream reverse proxy.
2. **Stateless JWT Revocation:** Stateless JWTs remain valid until `exp` unless signing keys are rotated. Short expiration windows (`JWT_EXPIRES_IN`) are recommended in production.
3. **TLS Termination:** HTTPS/TLS termination is assumed to be handled by the reverse proxy or cloud load balancer in production deployments.





