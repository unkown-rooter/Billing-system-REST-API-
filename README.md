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

The suite includes three layers of automated tests:
1. **Unit & Application Contract Tests (`npm test`):**
   - 18 Phase 1 functional tests verifying routing, CRUD, and in-memory persistence.
   - 23 Phase 3 schema validation tests verifying shape validation, constraint enforcement, field details, immutable field protection, path parameter formats, malformed JSON handling, and failure injection sanitization.
2. **PostgreSQL Integration Tests (`npm run test:integration`):**
   - 15 Phase 2 tests verifying migrations, DB constraints (PK, UNIQUE index, CHECK), durable restart survival, and truthful degraded state reporting.

To run all suites:
```bash
npm test
npm run test:integration
```

