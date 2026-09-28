<div align="center">

# Billing System REST API

**A production-grade, multi-tenant financial ledger and invoicing REST API built with Node.js, Express, TypeScript, and PostgreSQL.**

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4.21-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1.0-6BA539?style=for-the-badge&logo=openapiinitiative&logoColor=white)](./openapi.yaml)
[![Docker](https://img.shields.io/badge/Docker-Multi--Stage-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Tests](https://img.shields.io/badge/Tests-194%20Default%20%7C%20247%20Total-10B981?style=for-the-badge&logo=checkmarx&logoColor=white)](#verification--testing)
[![License](https://img.shields.io/badge/License-MIT-F59E0B?style=for-the-badge)](./LICENSE)

[Overview](#project-description) •
[Core Features](#core-api-features) •
[Architecture](#architecture-diagram) •
[OpenAPI Spec](#openapi-31-specification) •
[Auth & RBAC](#authentication--authorization-guide) •
[Error Contract](#standardized-error-contract) •
[Customer API](#customer-api-reference) •
[Invoice API](#invoice--line-item-api-reference) •
[Health & Metrics](#health-readiness--metrics-api-reference) •
[Getting Started](#getting-started) •
[Testing](#verification--testing)

</div>

---

## Project Description

The **Billing System REST API** is a backend-first financial service designed to manage the end-to-end billing lifecycle between businesses and their customers. It provides a strictly typed, transactional HTTP interface for operator authentication, customer ledger management, multi-item invoice issuance, deterministic financial calculation, and role-scoped reporting.

The system enforces a strict separation between **Identity (`Account`)** and **Billing Domain (`Customer`, `Invoice`, `InvoiceItem`)**:

- **Accounts (`acc_<uuid>`)** represent authenticated API operators or service principals that register, sign in, and receive stateless `HS256` JWT Bearer tokens.
- **Customers (`cus_<uuid>`)** represent billed legal entities or individuals owned by an Account (`accountId`) with a designated 3-letter ISO 4217 ledger currency (`USD`, `EUR`, `KES`, etc.).
- **Invoices (`inv_<uuid>`)** and **Invoice Line Items (`item_<seq>_<uuid>`)** represent financial obligations persisted atomically inside PostgreSQL transactions (`BEGIN ... COMMIT / ROLLBACK`) with authoritative server-side integer-cents arithmetic.

---

## Core API Features

- **Stateless JWT Authentication & Memory-Hard Cryptography**
  - RFC 7519 `HS256` JSON Web Tokens verified via constant-time HMAC comparison (`crypto.timingSafeEqual`).
  - Password hashing powered by Node.js native memory-hard `crypto.scrypt` (`N=16384, r=8, p=1, keylen=64`) with unique 16-byte cryptographic salts per account.
  - Anti-enumeration login flow executing timing-safe dummy `scrypt` derivations when an account email is not found.
- **Role-Based Access Control (RBAC) & Zero-Trust Ownership (IDOR Prevention)**
  - Least-privilege default role (`user`) enforced at registration and database schema levels; administrative privileges (`admin`) are restricted to out-of-band provisioning.
  - Transitive ownership enforcement across `Account → Customer → Invoice → InvoiceItem`. Standard users can only access or mutate resources bound to their own `accountId`; cross-account access attempts return `403 FORBIDDEN` with zero data leakage.
- **Transactional Relational Ledger & Integer-Cents Financial Engine**
  - Invoices and line items are created and updated atomically inside explicit PostgreSQL transactions using single-statement multi-row `INSERT INTO invoice_items` batching.
  - All financial totals (`lineTotal`, `subtotal`, `tax`, `discount`, `total`) are computed exclusively server-side in integer cents (`Math.round(amount * 100)`) to eliminate IEEE-754 floating-point drift.
  - Referential integrity enforced at the database engine level (`ON DELETE RESTRICT` protecting customers with historical invoices; `ON DELETE CASCADE` cleaning up child line items when an invoice is deleted).
  - Finalized state locks prevent financial mutation once an invoice reaches `paid` or `cancelled` status (`409 CONFLICT`).
- **Bounded Pagination, Domain Filtering & Whitelisted Sorting**
  - Collection endpoints support 1-indexed `page` and `limit` (`1..100`, default `20`) pagination with deterministic `pagination` metadata (`total`, `totalPages`, `hasNextPage`, `hasPreviousPage`).
  - Parameterized filtering by currency, status, customer, email, name/description substring (`ILIKE`), and ISO 8601 date ranges (`issueDateFrom`/`To`, `dueDateFrom`/`To`).
  - Compile-time column whitelisting and primary-key tie-breaking (`ORDER BY <col> <dir>, id <dir>`) prevent SQL identifier injection and guarantee stable page ordering.
- **Defense-in-Depth Security Hardening**
  - Strict schema validation rejecting unknown fields, mass-assignment attempts (`id`, `accountId`, `role`, `subtotal`, `total`, `invoiceNumber`), prototype pollution keys (`__proto__`, `constructor`, `prototype`), and UTF-8 null bytes (`\u0000`).
  - Dedicated brute-force rate limiter on authentication routes (`30 req/min` default) and general flood rate limiter across `/api/v1/*` (`300 req/min` default) emitting `X-RateLimit-*` and `Retry-After` headers (`429 RATE_LIMIT_EXCEEDED`).
  - Hardened HTTP response headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, strict API `Content-Security-Policy`, `Cache-Control: no-store`, and `Strict-Transport-Security` over HTTPS).
- **Observability, Containerization & Horizontal Scaling**
  - Single-line structured JSON logs with automatic credential redaction and end-to-end `X-Request-Id` correlation via `AsyncLocalStorage`.
  - Multi-stage `Dockerfile` (`node:22-bookworm-slim`) running as non-root `USER node` (`UID 1000`) on a read-only root filesystem with graceful `SIGTERM`/`SIGINT` connection draining.
  - Composite and functional B-tree indexes (`migrations/001`–`006`) and environment-tunable PostgreSQL connection pooling (`DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`).

---

## Architecture Diagram

### 1. Request, Security & Persistence Lifecycle

```text
HTTPS Client Request
     │
     ▼
Reverse Proxy / TLS Termination (X-Forwarded-Proto: https, X-Forwarded-For)
     │
     ▼
Express Application Boundary (Port 3000, Non-Root UID 1000, Read-Only Rootfs, Keep-Alive 65s)
     ├── SecurityHeadersMiddleware (nosniff, DENY, CSP, no-store, HSTS)
     ├── CorsMiddleware (Explicit CORS_ALLOWED_ORIGINS allowlist; no wildcard '*')
     ├── RequestLoggerMiddleware (AsyncLocalStorage X-Request-Id correlation & log redaction)
     └── express.json({ limit: '100kb', strict: false }) → 400 MALFORMED_JSON / 413 PAYLOAD_TOO_LARGE
     │
     ▼
Versioned API Router (/api/v1 + General API Rate Limiter)
     ├── MethodNotAllowedGuard               → 405 METHOD_NOT_ALLOWED (with RFC 9110 Allow header)
     ├── AuthRateLimiter (/auth/register|login) → 429 RATE_LIMIT_EXCEEDED (with Retry-After header)
     ├── AuthenticationMiddleware (JWT HS256) → 401 AUTHENTICATION_REQUIRED | INVALID_TOKEN | TOKEN_EXPIRED
     ├── AuthorizationMiddleware (RBAC)      → 403 FORBIDDEN
     └── SchemaValidationMiddleware          → 400 VALIDATION_ERROR (with granular fields[])
     │
     ▼
Domain Controllers (HealthController, AuthController, CustomerController, InvoiceController)
     │  Extracts validated DTOs & authenticated principal; sets HTTP status codes & Location headers
     ▼
Domain Services (AuthService, PasswordService, TokenService, CustomerService, InvoiceService)
     │  Enforces ownership (IDOR checks), integer-cents invoice math, state locks & domain invariants
     ▼
Repository Layer (IAccountRepository, ICustomerRepository, IInvoiceRepository)
     │  Executes 100% parameterized SQL ($1, $2, ...), atomic transactions (BEGIN/COMMIT/ROLLBACK),
     │  batched multi-row item inserts, ANY($1::text[]) hydration, and SQLSTATE error mapping
     ▼
PostgreSQL Connection Pool (pg.Pool) ──► PostgreSQL 15+ Database
```

### 2. Relational Domain & Database Schema Model

```text
+-----------------------------------------------------------------------------------+
| accounts                                                                          |
|-----------------------------------------------------------------------------------|
| PK  id             TEXT          ('acc_<uuidv4>')                                 |
| UQ  email          VARCHAR(254)  (Unique index on LOWER(email))                   |
|     password_hash  TEXT          (scrypt derived key)                             |
|     role           VARCHAR(32)   (CHECK role IN ('user', 'admin') DEFAULT 'user') |
|     created_at     TIMESTAMPTZ                                                    |
|     updated_at     TIMESTAMPTZ                                                    |
+-----------------------------------------------------------------------------------+
                                         │ 1
                                         │ ON DELETE RESTRICT
                                         ▼ 0..N
+-----------------------------------------------------------------------------------+
| customers                                                                         |
|-----------------------------------------------------------------------------------|
| PK  id             TEXT          ('cus_<uuidv4>')                                 |
| FK  account_id     TEXT          (REFERENCES accounts(id) ON DELETE RESTRICT)     |
|     name           VARCHAR(255)                                                   |
| UQ  email          VARCHAR(254)  (Unique index on LOWER(email))                   |
|     currency       CHAR(3)       (CHECK currency ~ '^[A-Z]{3}$')                  |
|     created_at     TIMESTAMPTZ                                                    |
|     updated_at     TIMESTAMPTZ                                                    |
+-----------------------------------------------------------------------------------+
                                         │ 1
                                         │ ON DELETE RESTRICT
                                         ▼ 0..N
+-----------------------------------------------------------------------------------+
| invoices                                                                          |
|-----------------------------------------------------------------------------------|
| PK  id             TEXT          ('inv_<uuidv4>')                                 |
| FK  customer_id    TEXT          (REFERENCES customers(id) ON DELETE RESTRICT)    |
| UQ  invoice_number VARCHAR(64)   ('INV-YYYY-XXXX-XXXX', UQ on UPPER(invoice_num)) |
|     status         VARCHAR(32)   ('draft'|'issued'|'paid'|'overdue'|'cancelled')  |
|     currency       CHAR(3)       (Matches parent customer ISO 4217 currency)      |
|     subtotal       NUMERIC(12,2) (Server-computed sum of line items)              |
|     tax            NUMERIC(12,2) (CHECK tax >= 0)                                 |
|     discount       NUMERIC(12,2) (CHECK discount >= 0 AND discount <= sub + tax)  |
|     total          NUMERIC(12,2) (CHECK total = subtotal + tax - discount)        |
|     issue_date     TIMESTAMPTZ                                                    |
|     due_date       TIMESTAMPTZ   (CHECK due_date >= issue_date)                   |
|     notes          VARCHAR(1000)                                                  |
|     created_at     TIMESTAMPTZ                                                    |
|     updated_at     TIMESTAMPTZ                                                    |
+-----------------------------------------------------------------------------------+
                                         │ 1
                                         │ ON DELETE CASCADE
                                         ▼ 1..N
+-----------------------------------------------------------------------------------+
| invoice_items                                                                     |
|-----------------------------------------------------------------------------------|
| PK  id             TEXT          ('item_<seq>_<uuidv4>')                          |
| FK  invoice_id     TEXT          (REFERENCES invoices(id) ON DELETE CASCADE)      |
|     description    VARCHAR(500)                                                   |
|     quantity       INTEGER       (CHECK quantity > 0)                             |
|     unit_price     NUMERIC(12,2) (CHECK unit_price >= 0)                          |
|     line_total     NUMERIC(12,2) (CHECK line_total = quantity * unit_price)       |
|     created_at     TIMESTAMPTZ                                                    |
|     updated_at     TIMESTAMPTZ                                                    |
+-----------------------------------------------------------------------------------+
```

---

## OpenAPI 3.1 Specification

A machine-readable **OpenAPI 3.1.0** specification describing all 20 implemented endpoints, request/response schemas, security schemes, headers, and error contracts is available in the repository root:

- **YAML Specification:** [`./openapi.yaml`](./openapi.yaml)
- **Static Web Asset:** [`./public/openapi.yaml`](./public/openapi.yaml) (served at `GET /openapi.yaml` when the server is running)

You can import `openapi.yaml` directly into **Postman**, **Insomnia**, **Swagger Editor**, **Scalar**, or **OpenAPI Generator** (`openapi-generator-cli`) to generate typed client SDKs.

### Complete Endpoint Inventory (`/api/v1`)

| Method | Path | Auth | Allowed Roles | Ownership Scope | Success Status |
|---|---|---|---|---|---|
| `GET` | `/api/v1/health` | Public | Public | N/A | `200 OK` (`503` if DB down) |
| `GET` | `/api/v1/health/live` | Public | Public | N/A | `200 OK` |
| `GET` | `/api/v1/health/ready` | Public | Public | N/A | `200 OK` (`503` if DB down) |
| `GET` | `/api/v1/metrics` | Public | Public | N/A | `200 OK` |
| `POST` | `/api/v1/auth/register` | Public (Rate-Limited) | Public | Assigns `role: 'user'` | `201 Created` |
| `POST` | `/api/v1/auth/login` | Public (Rate-Limited) | Public | Issues `HS256` JWT | `200 OK` |
| `GET` | `/api/v1/auth/me` | Bearer JWT | `user`, `admin` | Own `Account` (`req.user.id`) | `200 OK` |
| `POST` | `/api/v1/customers` | Bearer JWT | `user`, `admin` | Binds `accountId = req.user.id` | `201 Created` |
| `GET` | `/api/v1/customers` | Bearer JWT | `user`, `admin` | `user`: own; `admin`: all | `200 OK` |
| `GET` | `/api/v1/customers/:id` | Bearer JWT | `user`, `admin` | Owner or `admin` (`403` on others) | `200 OK` |
| `PATCH` | `/api/v1/customers/:id` | Bearer JWT | `user`, `admin` | Owner or `admin` (`403` on others) | `200 OK` |
| `DELETE` | `/api/v1/customers/:id` | Bearer JWT | `admin` only | `admin` (`403` for `user`) | `204 No Content` |
| `POST` | `/api/v1/customers/:id/invoices` | Bearer JWT | `user`, `admin` | Customer owner or `admin` | `201 Created` |
| `GET` | `/api/v1/customers/:id/invoices` | Bearer JWT | `user`, `admin` | Customer owner or `admin` | `200 OK` |
| `POST` | `/api/v1/invoices` | Bearer JWT | `user`, `admin` | Customer owner or `admin` | `201 Created` |
| `GET` | `/api/v1/invoices` | Bearer JWT | `user`, `admin` | `user`: own customers; `admin`: all | `200 OK` |
| `GET` | `/api/v1/invoices/:id` | Bearer JWT | `user`, `admin` | Customer owner or `admin` | `200 OK` |
| `PATCH` | `/api/v1/invoices/:id` | Bearer JWT | `user`, `admin` | Customer owner or `admin` | `200 OK` |
| `DELETE` | `/api/v1/invoices/:id` | Bearer JWT | `admin` only | `admin` (`403` for `user`) | `204 No Content` |
| `GET` | `/api/v1/invoices/:id/items` | Bearer JWT | `user`, `admin` | Customer owner or `admin` | `200 OK` |

---

## Authentication & Authorization Guide

### 1. Authentication Mechanism (`POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET /api/v1/auth/me`)

1. **Registration (`POST /api/v1/auth/register`):**
   - Accepts `{ "email": string, "password": string }`.
   - `email` is trimmed, validated (max 254 chars), and normalized to lowercase. Duplicate emails return `409 DUPLICATE_RESOURCE`.
   - `password` must be `8`–`128` characters and cannot consist solely of whitespace.
   - Hashes the password with `crypto.scrypt` and assigns `role: "user"`. Returns `201 Created` with `Location: /api/v1/auth/me` and the sanitized `AccountDTO` (`passwordHash` is never returned).
2. **Login (`POST /api/v1/auth/login`):**
   - Verifies email and password. If the email does not exist, executes a dummy `scrypt` derivation so response timing is indistinguishable from an incorrect password, returning `401 INVALID_CREDENTIALS` (`"Invalid email or password"`).
   - Issues an RFC 7519 `HS256` signed JWT Bearer token with a default lifetime of `86400` seconds (24 hours, configurable via `JWT_EXPIRES_IN`).
3. **JWT Payload Structure & Bearer Header Usage:**
   - Decoded JWT payload claims:
     ```json
     {
       "sub": "acc_cb5d153e-a061-45ac-b338-acaa916bd5e5",
       "email": "billing.ops@acme-corp.example.com",
       "role": "user",
       "iat": 1758954974,
       "exp": 1759041374
     }
     ```
   - Pass the token on every protected endpoint using the standard `Authorization` header:
     ```http
     Authorization: Bearer <SIGNED_JWT_TOKEN>
     ```

#### Authentication Endpoints Reference

##### `POST /api/v1/auth/register` — Register Operator Account
- **Authentication:** Public (rate-limited: default `30` requests / `60s` per IP).
- **Request Body:**
  ```json
  {
    "email": "billing.ops@acme-corp.example.com",
    "password": "example-Passw0rd-987!"
  }
  ```
- **Success Response (`201 Created`):**
  ```json
  {
    "status": "success",
    "data": {
      "id": "acc_cb5d153e-a061-45ac-b338-acaa916bd5e5",
      "email": "billing.ops@acme-corp.example.com",
      "role": "user",
      "createdAt": "2026-09-27T06:36:14.102Z",
      "updatedAt": "2026-09-27T06:36:14.102Z"
    }
  }
  ```
- **Error Responses:** `400 VALIDATION_ERROR` (weak password, invalid email, unknown field such as `role`), `409 DUPLICATE_RESOURCE` (email already registered), `429 RATE_LIMIT_EXCEEDED`.

##### `POST /api/v1/auth/login` — Authenticate & Obtain Bearer Token
- **Authentication:** Public (rate-limited: default `30` requests / `60s` per IP).
- **Request Body:**
  ```json
  {
    "email": "billing.ops@acme-corp.example.com",
    "password": "example-Passw0rd-987!"
  }
  ```
- **Success Response (`200 OK`):**
  ```json
  {
    "status": "success",
    "data": {
      "token": "<SIGNED_HS256_JWT_TOKEN>",
      "tokenType": "Bearer",
      "expiresIn": 86400,
      "account": {
        "id": "acc_cb5d153e-a061-45ac-b338-acaa916bd5e5",
        "email": "billing.ops@acme-corp.example.com",
        "role": "user",
        "createdAt": "2026-09-27T06:36:14.102Z",
        "updatedAt": "2026-09-27T06:36:14.102Z"
      }
    }
  }
  ```
- **Error Responses:** `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS`, `429 RATE_LIMIT_EXCEEDED`.

##### `GET /api/v1/auth/me` — Inspect Current Identity
- **Authentication:** Required (`Authorization: Bearer <token>`).
- **Success Response (`200 OK`):** Returns `{ "status": "success", "data": AccountDTO }`.
- **Error Responses:** `401 AUTHENTICATION_REQUIRED`, `401 INVALID_TOKEN`, `401 TOKEN_EXPIRED`, `404 RESOURCE_NOT_FOUND`.

---

### 2. Authorization Model (`401 Unauthorized` vs. `403 Forbidden`)

Authentication and authorization are enforced as separate, sequential layers:

| HTTP Status | Meaning | When It Occurs |
|---|---|---|
| **`401 Unauthorized`** | **Authentication Failure:** The request does not carry a valid authenticated identity. | • Missing `Authorization` header (`AUTHENTICATION_REQUIRED`)<br>• Non-`Bearer` scheme, malformed JWT, or tampered HMAC signature (`INVALID_TOKEN`)<br>• Token `exp` claim has passed (`TOKEN_EXPIRED`)<br>• Invalid email or password on `/api/v1/auth/login` (`INVALID_CREDENTIALS`) |
| **`403 Forbidden`** | **Authorization Failure:** The caller's identity is valid and authenticated, but access to the action or resource is denied. | • A `user` account attempts to call an `admin`-only endpoint (`DELETE /api/v1/customers/:id` or `DELETE /api/v1/invoices/:id`)<br>• A `user` account attempts to read, update, or invoice a `Customer` or `Invoice` owned by a different `accountId` (**IDOR prevention**) |

#### Role & Resource Ownership Rules
- **`user` Role (Default):**
  - Can create customers (`customer.accountId` is automatically bound to `req.user.id`).
  - `GET /api/v1/customers` and `GET /api/v1/invoices` automatically filter SQL queries by `account_id = req.user.id`.
  - Can read (`GET`), update (`PATCH`), or create invoices (`POST`) **only** for customers where `customer.accountId === req.user.id`. Accessing another account's customer or invoice ID returns `403 FORBIDDEN`.
  - Cannot `DELETE` customers or invoices (`403 FORBIDDEN`).
- **`admin` Role:**
  - Can list, inspect, update, and issue invoices for customers across all accounts (`PATCH` preserves the original `customer.accountId`).
  - Can `DELETE` customers (`DELETE /api/v1/customers/:id`, subject to `409 CONFLICT` if the customer has existing invoices) and `DELETE` invoices (`DELETE /api/v1/invoices/:id`, which cascades to `invoice_items`).

---

## Standardized Error Contract

Every error returned by the API uses a uniform JSON envelope and echoes (or generates) a correlation `requestId` in both the `X-Request-Id` response header and the JSON body. Stack traces, raw SQL queries, and internal file paths are never exposed.

### Error Envelope Structure

```json
{
  "status": "error",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "fields": [
      {
        "field": "currency",
        "message": "Field 'currency' must be a valid 3-letter uppercase ISO code (e.g. USD, EUR, KES)"
      }
    ],
    "requestId": "req_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
  }
}
```

### Complete Error Code Reference

| Error Code | HTTP Status | Extra Headers | Meaning & Trigger Conditions |
|---|---|---|---|
| `VALIDATION_ERROR` | `400 Bad Request` | `X-Request-Id` | Request body, path parameter (`cus_*`, `inv_*`), or query parameter failed schema validation, included unknown/immutable fields, or violated financial math rules (`discount > subtotal + tax`). Includes `fields[]` when field-specific. |
| `MALFORMED_JSON` | `400 Bad Request` | `X-Request-Id` | Request body contains syntactically invalid JSON. |
| `AUTHENTICATION_REQUIRED` | `401 Unauthorized` | `X-Request-Id` | Protected endpoint called without an `Authorization` header. |
| `INVALID_CREDENTIALS` | `401 Unauthorized` | `X-Request-Id` | Email not found or password mismatch during `POST /api/v1/auth/login`. |
| `INVALID_TOKEN` | `401 Unauthorized` | `X-Request-Id` | `Authorization` header does not use `Bearer <token>`, JWT structure is malformed, `alg` is not `HS256`, or HMAC-SHA256 signature verification failed. |
| `TOKEN_EXPIRED` | `401 Unauthorized` | `X-Request-Id` | JWT `exp` timestamp has passed (`now >= exp`). |
| `FORBIDDEN` | `403 Forbidden` | `X-Request-Id` | Authenticated caller lacks required role (`admin`) or does not own the target customer/invoice (`customer.accountId !== req.user.id`). |
| `RESOURCE_NOT_FOUND` | `404 Not Found` | `X-Request-Id` | Requested `acc_*`, `cus_*`, or `inv_*` identifier does not exist in the database. |
| `ROUTE_NOT_FOUND` | `404 Not Found` | `X-Request-Id` | Request URL does not match any registered `/api/v1/*` route. |
| `METHOD_NOT_ALLOWED` | `405 Method Not Allowed` | `Allow`, `X-Request-Id` | HTTP verb (e.g., `PUT`) is not supported on a valid route. The `Allow` header lists permitted methods (e.g., `GET, POST`). |
| `DUPLICATE_RESOURCE` | `409 Conflict` | `X-Request-Id` | Unique constraint violation: account email already registered, customer email already in use, or duplicate `invoiceNumber`. |
| `CONFLICT` | `409 Conflict` | `X-Request-Id` | Domain state or referential integrity conflict: deleting a customer that has associated invoices (`ON DELETE RESTRICT`) or modifying financials (`items`, `tax`, `discount`) on a `paid` or `cancelled` invoice. |
| `PAYLOAD_TOO_LARGE` | `413 Payload Too Large` | `X-Request-Id` | Request JSON payload exceeds the `100kb` body parser limit. |
| `RATE_LIMIT_EXCEEDED` | `429 Too Many Requests` | `Retry-After`, `X-RateLimit-*` | Client exceeded the auth (`30/min`) or general API (`300/min`) rate limit window. |
| `SECURITY_CONFIGURATION_ERROR` | `500 Internal Server Error` | `X-Request-Id` | Production fail-closed startup guard triggered (missing/weak `JWT_SECRET` or missing `DATABASE_URL` in `NODE_ENV=production`). |
| `DATABASE_ERROR` | `500 Internal Server Error` | `X-Request-Id` | Unexpected database operational error (raw driver details are redacted and logged server-side only). |
| `INTERNAL_SERVER_ERROR` | `500 Internal Server Error` | `X-Request-Id` | Unhandled runtime exception (sanitized message returned to client). |

---

## Customer API Reference

### 1. `POST /api/v1/customers` — Create a Customer
- **Purpose:** Creates a new customer record bound to the authenticated account (`accountId = req.user.id`).
- **Authentication & Authorization:** Bearer Token required (`user` or `admin`).
- **Request Body Fields:**
  - `name` (`string`, required): Non-empty legal or display name (`1..255` chars).
  - `email` (`string`, required): Valid email address (`<= 254` chars, normalized to lowercase, unique across all customers).
  - `currency` (`string`, required): 3-letter uppercase ISO 4217 code matching `^[A-Z]{3}$` (e.g. `USD`, `EUR`, `KES`).
  - *Note:* Unknown fields or `accountId`/`id` overrides are rejected with `400 VALIDATION_ERROR`.
- **Example Request:**
  ```bash
  curl -i -X POST "http://localhost:3000/api/v1/customers" \
    -H "Authorization: Bearer <ACCESS_TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "Wayne Enterprises",
      "email": "ap@wayne-enterprises.example.com",
      "currency": "USD"
    }'
  ```
- **Success Response (`201 Created`, `Location: /api/v1/customers/cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3`):**
  ```json
  {
    "status": "success",
    "data": {
      "id": "cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3",
      "accountId": "acc_cb5d153e-a061-45ac-b338-acaa916bd5e5",
      "name": "Wayne Enterprises",
      "email": "ap@wayne-enterprises.example.com",
      "currency": "USD",
      "createdAt": "2026-09-27T06:36:15.410Z",
      "updatedAt": "2026-09-27T06:36:15.410Z"
    }
  }
  ```
- **Error Responses:** `400 VALIDATION_ERROR`, `401 AUTHENTICATION_REQUIRED | INVALID_TOKEN | TOKEN_EXPIRED`, `409 DUPLICATE_RESOURCE`.

### 2. `GET /api/v1/customers` — List Customers (Paginated)
- **Purpose:** Retrieves a paginated, filtered, and sorted list of customers (`user` sees own customers; `admin` sees all customers).
- **Authentication & Authorization:** Bearer Token required (`user` or `admin`).
- **Query Parameters:**
  - `page` (optional, integer `1..1000000`, default `1`)
  - `limit` (optional, integer `1..100`, default `20`)
  - `currency` (optional, 3-letter uppercase ISO code, e.g., `USD`)
  - `email` (optional, exact case-insensitive email match)
  - `name` (optional, case-insensitive substring match via `ILIKE`)
  - `sort` (optional, one of `createdAt`, `updatedAt`, `name`, `email`; default `createdAt`)
  - `order` (optional, `asc` or `desc`; default `asc`)
- **Example Request:**
  ```bash
  curl -i -X GET "http://localhost:3000/api/v1/customers?page=1&limit=10&currency=USD&sort=createdAt&order=desc" \
    -H "Authorization: Bearer <ACCESS_TOKEN>"
  ```
- **Success Response (`200 OK`):**
  ```json
  {
    "status": "success",
    "data": [
      {
        "id": "cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3",
        "accountId": "acc_cb5d153e-a061-45ac-b338-acaa916bd5e5",
        "name": "Wayne Enterprises",
        "email": "ap@wayne-enterprises.example.com",
        "currency": "USD",
        "createdAt": "2026-09-27T06:36:15.410Z",
        "updatedAt": "2026-09-27T06:36:15.410Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 1,
      "totalPages": 1,
      "hasNextPage": false,
      "hasPreviousPage": false
    }
  }
  ```
- **Error Responses:** `400 VALIDATION_ERROR` (unknown query parameter or out-of-range `limit`), `401`.

### 3. `GET /api/v1/customers/:id` — Get Customer by ID
- **Purpose:** Fetches a single customer record by ID.
- **Authentication & Authorization:** Bearer Token required. Caller must own the customer (`customer.accountId === req.user.id`) or have the `admin` role.
- **Path Parameters:** `id` (`^cus_[a-zA-Z0-9_-]+$`).
- **Success Response (`200 OK`):** `{ "status": "success", "data": Customer }`.
- **Error Responses:** `400 VALIDATION_ERROR` (malformed ID), `401`, `403 FORBIDDEN` (owned by another account), `404 RESOURCE_NOT_FOUND`.

### 4. `PATCH /api/v1/customers/:id` — Update Customer
- **Purpose:** Updates one or more mutable fields (`name`, `email`, `currency`) on a customer.
- **Authentication & Authorization:** Bearer Token required. Caller must own the customer or have the `admin` role.
- **Request Body:** JSON object containing at least one of `name`, `email`, `currency`. Supplying an empty object `{}` or immutable fields (`id`, `accountId`, `createdAt`) returns `400 VALIDATION_ERROR`.
- **Example Request:**
  ```bash
  curl -i -X PATCH "http://localhost:3000/api/v1/customers/cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3" \
    -H "Authorization: Bearer <ACCESS_TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "Wayne Enterprises Global"
    }'
  ```
- **Success Response (`200 OK`):** `{ "status": "success", "data": Customer }`.
- **Error Responses:** `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `404 RESOURCE_NOT_FOUND`, `409 DUPLICATE_RESOURCE`.

### 5. `DELETE /api/v1/customers/:id` — Delete Customer (Admin Only)
- **Purpose:** Permanently removes a customer record that has no associated invoices.
- **Authentication & Authorization:** Bearer Token required with **`admin` role** (`user` accounts receive `403 FORBIDDEN`).
- **Success Response (`204 No Content`):** Empty body.
- **Error Responses:** `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `404 RESOURCE_NOT_FOUND`, `409 CONFLICT` (`Cannot delete customer '<id>' because <N> associated invoice(s) exist`).

### 6. `POST /api/v1/customers/:id/invoices` — Create Invoice for Customer
- **Purpose:** Issues a new multi-item invoice directly under customer `:id`. Automatically sets `customerId = :id` and defaults `currency` to the customer's currency.
- **Authentication & Authorization:** Bearer Token required. Caller must own customer `:id` or have the `admin` role.
- **Request Body:** Same as `POST /api/v1/invoices`, except `customerId` is optional (inferred from `:id`).
- **Success Response (`201 Created`, `Location: /api/v1/invoices/<inv_id>`):** `{ "status": "success", "data": Invoice }`.
- **Error Responses:** `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `404 RESOURCE_NOT_FOUND`.

### 7. `GET /api/v1/customers/:id/invoices` — List Customer Invoices
- **Purpose:** Lists paginated invoices belonging to customer `:id`.
- **Authentication & Authorization:** Bearer Token required. Verifies customer `:id` exists (`404`) and is owned by the caller or `admin` (`403`) before querying invoices.
- **Query Parameters:** `page`, `limit`, `status`, `currency`, `issueDate`, `issueDateFrom`, `issueDateTo`, `dueDate`, `dueDateFrom`, `dueDateTo`, `sort`, `order` (`customerId` query param is not permitted on this nested route).
- **Success Response (`200 OK`):** `{ "status": "success", "data": Invoice[], "pagination": PaginationMeta }`.
- **Error Responses:** `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `404 RESOURCE_NOT_FOUND`.

---

## Invoice & Line Item API Reference

### Authoritative Financial Calculation Rules
All monetary calculations are executed server-side in integer cents (`Math.round(amount * 100)`):
1. **Line Item Total:** `lineTotal = quantity * unitPrice` (`quantity` is an integer `1..1,000,000`; `unitPrice >= 0` with at most 2 decimal places).
2. **Invoice Subtotal:** `subtotal = sum(items[].lineTotal)` (`items` must contain `1..100` line items).
3. **Invoice Total:** `total = subtotal + tax - discount` (`tax >= 0`, `discount >= 0`, and `discount` cannot exceed `subtotal + tax`).
4. **Immutability of Server-Computed Fields:** Clients may **never** send `id`, `invoiceNumber`, `subtotal`, `total`, `lineTotal`, `createdAt`, or `updatedAt` in request payloads (`400 VALIDATION_ERROR`).

### 1. `POST /api/v1/invoices` — Issue a Multi-Item Invoice
- **Purpose:** Creates an invoice and its line items atomically in a single PostgreSQL transaction.
- **Authentication & Authorization:** Bearer Token required. Caller must own the referenced `customerId` or have the `admin` role.
- **Request Body Fields:**
  - `customerId` (`string`, required): Target customer ID (`cus_<uuid>`).
  - `items` (`array`, required, `1..100` items): Each item requires `{ "description": string, "quantity": integer, "unitPrice": number }`.
  - `currency` (`string`, optional): Defaults to the parent customer's currency; if provided, must match the customer's currency (`400 VALIDATION_ERROR` on mismatch).
  - `status` (`string`, optional): One of `draft`, `issued`, `paid`, `overdue`, `cancelled` (defaults to `draft`).
  - `tax` (`number`, optional): Non-negative amount (defaults to `0`).
  - `discount` (`number`, optional): Non-negative amount `<= subtotal + tax` (defaults to `0`).
  - `issueDate` (`string`, optional): ISO 8601 date string (defaults to current UTC timestamp).
  - `dueDate` (`string`, optional): ISO 8601 date string `>= issueDate` (defaults to `issueDate + 30 days`).
  - `notes` (`string | null`, optional): Up to `1000` characters.
- **Example Request:**
  ```bash
  curl -i -X POST "http://localhost:3000/api/v1/invoices" \
    -H "Authorization: Bearer <ACCESS_TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{
      "customerId": "cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3",
      "status": "issued",
      "tax": 25.00,
      "discount": 10.00,
      "issueDate": "2026-09-27T00:00:00.000Z",
      "dueDate": "2026-10-27T00:00:00.000Z",
      "notes": "Q4 Dedicated Infrastructure Commitment",
      "items": [
        {
          "description": "Dedicated Compute Cluster (Monthly)",
          "quantity": 2,
          "unitPrice": 150.00
        },
        {
          "description": "Managed PostgreSQL High-Availability Add-on",
          "quantity": 1,
          "unitPrice": 85.00
        }
      ]
    }'
  ```
- **Success Response (`201 Created`, `Location: /api/v1/invoices/inv_9f82b310-7c12-49a1-8b20-61f3d9a8c112`):**
  ```json
  {
    "status": "success",
    "data": {
      "id": "inv_9f82b310-7c12-49a1-8b20-61f3d9a8c112",
      "customerId": "cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3",
      "invoiceNumber": "INV-2026-0001-9F82",
      "status": "issued",
      "currency": "USD",
      "subtotal": 385.00,
      "tax": 25.00,
      "discount": 10.00,
      "total": 400.00,
      "issueDate": "2026-09-27T00:00:00.000Z",
      "dueDate": "2026-10-27T00:00:00.000Z",
      "notes": "Q4 Dedicated Infrastructure Commitment",
      "items": [
        {
          "id": "item_0001_3d19a400-1b2c-4d5e-9f00-112233445566",
          "invoiceId": "inv_9f82b310-7c12-49a1-8b20-61f3d9a8c112",
          "description": "Dedicated Compute Cluster (Monthly)",
          "quantity": 2,
          "unitPrice": 150.00,
          "lineTotal": 300.00,
          "createdAt": "2026-09-27T06:36:18.904Z",
          "updatedAt": "2026-09-27T06:36:18.904Z"
        },
        {
          "id": "item_0002_7a88e911-4c5d-4e6f-8a11-77889900aabb",
          "invoiceId": "inv_9f82b310-7c12-49a1-8b20-61f3d9a8c112",
          "description": "Managed PostgreSQL High-Availability Add-on",
          "quantity": 1,
          "unitPrice": 85.00,
          "lineTotal": 85.00,
          "createdAt": "2026-09-27T06:36:18.904Z",
          "updatedAt": "2026-09-27T06:36:18.904Z"
        }
      ],
      "createdAt": "2026-09-27T06:36:18.904Z",
      "updatedAt": "2026-09-27T06:36:18.904Z"
    }
  }
  ```
- **Error Responses:** `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `404 RESOURCE_NOT_FOUND`.

### 2. `GET /api/v1/invoices` — List Invoices (Paginated)
- **Purpose:** Returns a paginated list of invoices (`user` sees invoices belonging to their own customers; `admin` sees all invoices).
- **Query Parameters:**
  - `page` (`1..1000000`, default `1`), `limit` (`1..100`, default `20`)
  - `customerId` (`cus_<uuid>`)
  - `status` (`draft`, `issued`, `paid`, `overdue`, `cancelled`, case-insensitive)
  - `currency` (`^[A-Z]{3}$`)
  - `issueDate`, `issueDateFrom`, `issueDateTo` (ISO 8601 timestamp or `YYYY-MM-DD`; `YYYY-MM-DD` on `*To` expands to `T23:59:59.999Z`)
  - `dueDate`, `dueDateFrom`, `dueDateTo` (ISO 8601 timestamp or `YYYY-MM-DD`)
  - `sort` (one of `createdAt`, `updatedAt`, `issueDate`, `dueDate`, `total`, `subtotal`, `invoiceNumber`, `status`; default `createdAt`)
  - `order` (`asc` or `desc`, default `asc`)
- **Success Response (`200 OK`):** `{ "status": "success", "data": Invoice[], "pagination": PaginationMeta }`.
- **Error Responses:** `400 VALIDATION_ERROR` (e.g., `issueDateFrom > issueDateTo`), `401`.

### 3. `GET /api/v1/invoices/:id` — Get Invoice by ID
- **Purpose:** Retrieves an invoice and its nested `items[]` by ID (`inv_<uuid>`).
- **Authentication & Authorization:** Bearer Token required. Caller must own the parent customer or have the `admin` role.
- **Success Response (`200 OK`):** `{ "status": "success", "data": Invoice }`.
- **Error Responses:** `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `404 RESOURCE_NOT_FOUND`.

### 4. `PATCH /api/v1/invoices/:id` — Update Invoice
- **Purpose:** Updates mutable invoice fields (`status`, `tax`, `discount`, `dueDate`, `notes`, `items`) and atomically recalculates `subtotal` and `total`.
- **Finalized State Lock:** Once an invoice is in `paid` or `cancelled` status, attempting to modify `items`, `tax`, or `discount` returns `409 CONFLICT`. Non-financial updates (`status`, `notes`, `dueDate`) remain permitted.
- **Immutable Fields:** `id`, `customerId`, `invoiceNumber`, `currency`, `subtotal`, `total`, `issueDate`, `createdAt`, `updatedAt`, `accountId` cannot be updated (`400 VALIDATION_ERROR`).
- **Success Response (`200 OK`):** `{ "status": "success", "data": Invoice }`.
- **Error Responses:** `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `404 RESOURCE_NOT_FOUND`, `409 CONFLICT`.

### 5. `DELETE /api/v1/invoices/:id` — Delete Invoice (Admin Only)
- **Purpose:** Permanently deletes an invoice and cascades deletion to all child `invoice_items` (`ON DELETE CASCADE`).
- **Authentication & Authorization:** Bearer Token required with **`admin` role** (`user` accounts receive `403 FORBIDDEN`).
- **Success Response (`204 No Content`):** Empty body.
- **Error Responses:** `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `404 RESOURCE_NOT_FOUND`.

### 6. `GET /api/v1/invoices/:id/items` — List Invoice Line Items (Paginated)
- **Purpose:** Returns a paginated, filtered, and sorted list of `InvoiceItem` records for invoice `:id`.
- **Authentication & Authorization:** Bearer Token required. Verifies invoice existence (`404`) and parent customer ownership (`403`).
- **Query Parameters:**
  - `page` (`1..1000000`, default `1`), `limit` (`1..100`, default `20`)
  - `description` (case-insensitive substring match via `ILIKE`, `1..500` chars)
  - `sort` (one of `createdAt`, `quantity`, `unitPrice`, `lineTotal`, `description`; default `createdAt`)
  - `order` (`asc` or `desc`, default `asc`)
- **Success Response (`200 OK`):** `{ "status": "success", "data": InvoiceItem[], "pagination": PaginationMeta }`.
- **Error Responses:** `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `404 RESOURCE_NOT_FOUND`.

---

## Health, Readiness & Metrics API Reference

### 1. `GET /api/v1/health` & `GET /api/v1/health/ready`
Executes a live `SELECT 1` probe against PostgreSQL, measures round-trip latency (`latencyMs`), and reports connection pool utilization (`max`, `totalCount`, `idleCount`, `waitingCount`, `activeCount`). Returns `200 OK` when healthy or `503 Service Unavailable` when the database is unreachable.

```json
{
  "status": "success",
  "data": {
    "status": "healthy",
    "timestamp": "2026-09-27T18:55:00.000Z",
    "uptime": 124.512,
    "database": {
      "status": "healthy",
      "latencyMs": 1,
      "pool": {
        "max": 10,
        "totalCount": 2,
        "idleCount": 2,
        "waitingCount": 0,
        "activeCount": 0
      }
    }
  }
}
```

### 2. `GET /api/v1/health/live`
Lightweight process liveness probe that returns `200 OK` (`{ "status": "success", "data": { "status": "alive", "timestamp": "...", "uptime": ... } }`) without querying PostgreSQL, preventing container orchestrators from restarting healthy API processes during transient database maintenance.

### 3. `GET /api/v1/metrics`
Returns bounded, low-cardinality operational metrics (`processMemoryBytes`, `requests.byMethod`, `requests.byStatusClass`, `securityEvents`, normalized `routes` latency summaries, and `databasePool` state).

---

## Tech Stack

| Layer | Technology | Role & Justification |
|---|---|---|
| **Runtime** | **Node.js 22 LTS** | Native ES2022 module execution, `node:crypto` (`scrypt`, `timingSafeEqual`, `createHmac`), and native `node:test` runner. |
| **HTTP Framework** | **Express.js 4.21** | Modular routing, bounded JSON payload parsing (`100kb`), custom security middleware, and centralized error handling. |
| **Language** | **TypeScript (Strict Mode)** | Compile-time type safety (`strict: true`, `noImplicitAny: true`) across DTOs, domain models, services, and repositories. |
| **Database** | **PostgreSQL 15+** | ACID transactions, `NUMERIC(12,2)` exact decimal storage, `TIMESTAMPTZ` UTC timestamps, `CHECK` constraints, and B-Tree indexes. |
| **Database Driver** | **`pg` (`node-postgres` 8.23)** | Direct parameterized SQL queries (`$1, $2, ...`) and connection pooling (`pg.Pool`) with zero ORM overhead. |
| **API Specification** | **OpenAPI 3.1.0 (`openapi.yaml`)** | Complete contract specification for all 20 endpoints, schemas, parameters, and error codes. |
| **Container Runtime** | **Docker (Multi-Stage OCI)** | Minimal `node:22-bookworm-slim` production stage running compiled JS (`dist-server/`) as non-root `USER node` (`UID 1000`). |
| **Interactive Console** | **React 19 + Tailwind CSS 4 + Vite** | Built-in API Explorer, Schema & Security Validation Lab, and live health/ledger inspector served in development and static builds. |

---

## Getting Started

### Prerequisites

- **Node.js** `v22.0.0` or higher
- **PostgreSQL** `v15.0` or higher
- **Docker** & **Docker Compose** (optional, for containerized execution)

### 1. Clone & Install Dependencies

```bash
git clone <repository-url>
cd billing-system-api
npm install
```

### 2. Configure Environment Variables

Copy the template environment file and supply your local or production values:

```bash
cp .env.example .env
```

| Variable | Category | Required in Prod | Default | Description |
|---|---|---|---|---|
| `DATABASE_URL` | **Secret** | **Yes** | — | PostgreSQL connection URI (`postgresql://<user>:<password>@<host>:5432/<dbname>`). Fails closed in `production` if unset or if a development-only fallback credential (`postgres_local_dev_only`, `username:password`) is used. |
| `JWT_SECRET` | **Secret** | **Yes** | — | High-entropy HMAC-SHA256 signing secret (`>= 32` characters). Fails closed in `production` if missing, weak, or set to a development-only placeholder/fallback key. |
| `NODE_ENV` | **Config** | **Yes** | `development` | Runtime environment (`development` or `production`). |
| `PORT` | **Config** | **Yes** | `3000` | HTTP server listening port. |
| `HOST` | **Config** | Optional | `0.0.0.0` | Network interface bind address. |
| `TRUST_PROXY` | **Config** | Optional | `1` (in prod) | Enables Express `trust proxy` (`1` hop) when deployed behind a TLS-terminating load balancer. |
| `CORS_ALLOWED_ORIGINS` | **Config** | Optional | `""` | Comma-separated allowlist of trusted browser origins. Empty string disables cross-origin access. |
| `ENABLE_HSTS` | **Config** | Optional | `false` (`true` in prod) | Emits `Strict-Transport-Security: max-age=31536000; includeSubDomains`. |
| `LOG_LEVEL` | **Config** | Optional | `info` | Minimum structured JSON log level (`debug`, `info`, `warn`, `error`). Clamped to `info` in `production`. |
| `JWT_EXPIRES_IN` | **Optional** | Optional | `86400` | JWT expiration lifetime in seconds. Must be a finite positive integer in `1..2592000` (up to 30 days). Defaults to `86400` (24h) only when unset; malformed, zero, negative, decimal, or out-of-range values fail closed with `SecurityConfigurationError`. |
| `RATE_LIMIT_MODE` | **Optional** | Optional | `process_local` | Rate-limiting mode: `process_local` (default per-instance in-memory store), `edge_enforced` (requires separately configured Cloud Armor/load-balancer or other edge policy plus this per-instance ceiling), or `shared_store` (requires an injected `RateLimitStore` adapter). |
| `AUTH_RATE_LIMIT_WINDOW_MS` | **Optional** | Optional | `60000` | Rate-limit window in milliseconds for `/api/v1/auth/login` and `/register`. |
| `AUTH_RATE_LIMIT_MAX` | **Optional** | Optional | `30` | Maximum authentication requests per window per client IP (per instance unless edge/shared limiter is used). |
| `API_RATE_LIMIT_WINDOW_MS` | **Optional** | Optional | `60000` | Rate-limit window in milliseconds for general `/api/v1/*` endpoints. |
| `API_RATE_LIMIT_MAX` | **Optional** | Optional | `300` | Maximum general API requests per window per client IP (per instance unless edge/shared limiter is used). |
| `DB_POOL_MAX` | **Optional** | Optional | `10` | Maximum PostgreSQL connections per API instance (`N instances × DB_POOL_MAX < max_connections`). |
| `DB_POOL_IDLE_TIMEOUT_MS` | **Optional** | Optional | `30000` | Idle client retention window in milliseconds before closing unused pooled connections. |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | **Optional** | Optional | `5000` | Maximum wait time in milliseconds to acquire a connection from the pool before failing. |
| `DB_STATEMENT_TIMEOUT_MS` | **Optional** | Optional | `10000` | Per-statement PostgreSQL execution timeout in milliseconds to prevent runaway queries from starving the pool. |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | **Optional** | Optional | `65000` | HTTP server keep-alive timeout (`> 60s` load-balancer idle timeout to prevent `502 Bad Gateway` socket reuse races). |
| `HTTP_HEADERS_TIMEOUT_MS` | **Optional** | Optional | `66000` | Maximum time in milliseconds to receive complete HTTP request headers. |
| `HTTP_REQUEST_TIMEOUT_MS` | **Optional** | Optional | `30000` | Maximum time in milliseconds allowed for an entire HTTP request. |

> **Security Note:** Never commit `.env` files or real secrets to version control. `.gitignore` and `.dockerignore` strictly exclude `.env*` files from Git history and Docker build contexts.

### 3. Create Database & Run Migrations

Ensure PostgreSQL 15+ is running and create the development and test databases if they do not exist:

```bash
psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE billing_system;"
psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE billing_system_test;"
```

Apply all SQL migrations (`migrations/001` through `migrations/006`). The transactional migration runner (`src/api/db/migrate.ts`) acquires a PostgreSQL session-level advisory lock (`pg_advisory_lock` / `pg_advisory_unlock` in a `finally` block) to serialize concurrent deployments, executes each migration inside an atomic `BEGIN ... COMMIT / ROLLBACK` transaction, and tracks applied files in `schema_migrations`:

```bash
# Development (TypeScript via tsx)
npm run migrate

# Production (Compiled JavaScript)
npm run build
npm run migrate:prod
```

### 4. Start the API Server

```bash
# Start in development mode (Express API + Vite interactive console on http://localhost:3000)
npm run dev

# Build and start in production mode (Compiled dist-server/server.js + static dist/)
npm run build
npm run start:prod
```

### 5. End-to-End Developer Quickstart Walkthrough (`curl`)

Once the server is listening on `http://localhost:3000`, run the following commands to register an operator, obtain a Bearer token, create a customer, and issue an invoice:

```bash
# 1. Verify API & PostgreSQL health
curl -s http://localhost:3000/api/v1/health | jq .

# 2. Register an operator account
curl -s -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","password":"example-Passw0rd-987!"}' | jq .

# 3. Log in and store the JWT Bearer token in TOKEN
export TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","password":"example-Passw0rd-987!"}' | jq -r '.data.token')

# 4. Inspect your authenticated profile
curl -s http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN" | jq .

# 5. Create a customer and store its ID in CUSTOMER_ID
export CUSTOMER_ID=$(curl -s -X POST http://localhost:3000/api/v1/customers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Corp","email":"billing@acme.example.com","currency":"USD"}' | jq -r '.data.id')

# 6. Issue a multi-item invoice for the customer
curl -s -X POST http://localhost:3000/api/v1/customers/$CUSTOMER_ID/invoices \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "issued",
    "tax": 15.00,
    "discount": 5.00,
    "items": [
      {"description": "API Platform Subscription", "quantity": 1, "unitPrice": 100.00}
    ]
  }' | jq .
```

### 6. Run with Docker & Docker Compose

```bash
# Start the local PostgreSQL 15 + API container stack
docker compose up --build -d

# Apply pending SQL migrations inside the running API container
docker compose exec api node dist-server/src/api/db/migrate.js

# Verify container health
curl -i http://localhost:3000/api/v1/health

# Tear down the stack
docker compose down
```

---

## Scaling & Production Architecture

### 1. Stateless vs. Process-Local Component Boundaries
- **Stateless Across Horizontal Instances:** JWT authentication (`HS256` signed with shared `JWT_SECRET`), RBAC role evaluation, customer/invoice ownership enforcement (`accountId` in PostgreSQL), and request correlation (`AsyncLocalStorage` per HTTP request) require **zero sticky sessions**. Any request can be routed to any container replica (`1 → 4 → 20` instances).
- **Process-Local Components & Production Global Enforcement:**
  - **Rate Limiting (`createRateLimiter`):** By default (`RATE_LIMIT_MODE=process_local`), the middleware uses a bounded in-memory store (`InMemoryRateLimitStore`, `MAX_TRACKED_KEYS = 10,000`) scoped to a single Node.js process. **It is not a global rate limiter across multi-instance deployments**—across $N$ instances behind a load balancer, a client IP can issue up to $N \times \text{max}$ requests per window. For global enforcement in production, configure Cloud Armor on the external Application Load Balancer and restrict Cloud Run ingress as in `cloudrun.service.yaml`, or inject a shared `RateLimitStore` adapter (`RATE_LIMIT_MODE=shared_store` via `AppDependencies.rateLimitStore` / `RateLimitOptions.store`). `RATE_LIMIT_MODE=edge_enforced` does not provision or activate an edge policy by itself.
  - **Operational Metrics (`metricsCollector`):** Maintains bounded per-instance route counters (`MAX_ROUTE_BUCKETS = 100`) and live `pg.Pool` saturation telemetry (`max`, `totalCount`, `idleCount`, `waitingCount`, `activeCount`), while structured JSON logs on `stdout`/`stderr` are aggregated centrally across all instances.

### 2. Connection Pool Capacity Planning (`API Instances × DB_POOL_MAX`)
- PostgreSQL connections are finite (`max_connections = 100` by default, with ~15 reserved for superuser/maintenance = ~85 usable application connections).
- Total potential database connections follow: $\text{Max Connections} = N_{\text{instances}} \times \text{DB\_POOL\_MAX}$.
  - **1–4 API instances:** `DB_POOL_MAX=10` consumes at most `40` PostgreSQL connections (~47% of usable capacity).
  - **10–20 API instances:** Lower `DB_POOL_MAX=4` (`80` connections) or place **PgBouncer** in transaction-pooling mode in front of PostgreSQL so hundreds of stateless container instances multiplex over a small fixed pool of physical database connections.
- **Caching Policy:** Financial ledger entities (`customers`, `invoices`, `invoice_items`) are intentionally **not** cached in application memory across requests to guarantee strict ACID read-after-write consistency on finalized invoice locks (`paid` / `cancelled`) and `ON DELETE RESTRICT` checks. Instead, query latency is kept sub-millisecond via composite B-tree indexes (`006_add_composite_scaling_indexes.sql`) and batched multi-row `INSERT INTO invoice_items` transactions.

---

## Verification & Testing

The repository enforces three-way database isolation (`Development DB ≠ Automated Test DB ≠ Production DB`) via programmatic guards (`assertSafeTestDatabaseUrl` and `assertSafeProductionDatabaseUrl`) and separates the **default fast verification suite (`npm test` — 194 tests across 12 suites)** from the **extended PostgreSQL, scaling, Docker, deployment, and documentation suites (`npm run test:all` — 247 tests across 17 suites)**:

```bash
# TypeScript strict type-checking (client + server)
npm run lint

# Default fast suite: unit, service-repository transaction, HTTP contract, validation, auth, RBAC, relational, pagination, security, observability & release-config suites (194 tests / 12 suites)
npm test

# Structured logging, X-Request-Id correlation, security event telemetry & metrics suite (10 tests — also included in npm test)
npm run test:observability

# Extended Suite 1: Live PostgreSQL 15 integration suite against dedicated *_test database (22 tests)
npm run test:integration

# Extended Suite 2: Horizontal multi-instance scaling, pool telemetry, EXPLAIN index verification & 60-request concurrent load suite (8 tests)
npm run test:scaling

# Extended Suite 3: Multi-stage Docker runtime, non-root execution, read-only rootfs & SIGTERM suite (6 tests)
npm run test:docker

# Extended Suite 4: Production deployment, DB separation, migration idempotency & HTTPS/TLS live verification suite (5 tests)
npm run test:deploy

# Extended Suite 5: OpenAPI 3.1 contract parity, public documentation completeness & end-to-end onboarding verification suite (12 tests)
npm run test:docs

# Execute the complete 17-suite verification pyramid (194 default + 53 extended = 247 total tests)
npm run test:all
```

---

## Controlled v1.0.0 Release

The release script supports a non-mutating preview by default and requires an explicit execution flag plus a separate production confirmation before creating a GitHub release/tag, pushing an image, running migrations, or deploying Cloud Run:

```bash
npm run deploy:release -- --preview
# Only after the release commit, cloud resources, IAM, and load balancer are approved and ready:
CONFIRM_PRODUCTION_RELEASE=YES CLOUD_ARMOR_READY=true \
  GCP_PROJECT_ID=<project-id> \
  GCP_REGION=<region> \
  ARTIFACT_REGISTRY_REPOSITORY=<repository> \
  CLOUD_SQL_CONNECTION_NAME=<project>:<region>:<instance> \
  CLOUD_RUN_SERVICE_ACCOUNT=<service-account-email> \
  DATABASE_URL_SECRET_NAME=<database-url-secret-id> \
  JWT_SECRET_SECRET_NAME=<jwt-secret-id> \
  PUBLIC_API_URL=https://<api-hostname> \
  npm run deploy:release -- --execute
```

Before execution, the worktree must be clean and the release commit must match `HEAD`. The Artifact Registry repository, Cloud SQL instance, secret versions and IAM grants must already exist. `DATABASE_URL` and `JWT_SECRET` values are read from Secret Manager, not from `.env` or command-line arguments. The database URL must use the chosen Cloud SQL connector/network mode. The configured service account needs Cloud SQL connectivity and access to the referenced secrets; the external load balancer and Cloud Armor policy must be configured before the run. The service manifest restricts Cloud Run ingress to internal traffic and the Cloud Load Balancing path. The script deploys by image digest and performs a readiness check through `PUBLIC_API_URL`; keep the previous Cloud Run revision available for rollback.

---

## Project Status

**Status:** **Production-ready codebase for v1.0.0; source release and production deployment are pending**

| Phase | Capability Area | Status | Verification Coverage |
|---|---|---|---|
| **Phase 1** | **REST API Foundation** | Complete | `api.test.ts`, `http-contracts-and-security.test.ts` |
| **Phase 2** | **PostgreSQL Persistence & Migrations (`001`–`006`)** | Complete | `postgres.test.ts`, `service-repository.integration.test.ts` |
| **Phase 3** | **Validation & Standardized Error Envelopes** | Complete | `validation.test.ts`, `http-contracts-and-security.test.ts` |
| **Phase 4** | **Stateless JWT Authentication & `scrypt` Hashing** | Complete | `auth.test.ts`, `domain-and-services.unit.test.ts` |
| **Phase 5** | **RBAC (`user` / `admin`) & Cross-Account IDOR Prevention** | Complete | `authorization.test.ts`, `security.test.ts` |
| **Phase 6** | **Relational Invoicing (`Customer → Invoice → InvoiceItem`)** | Complete | `relationships.test.ts`, `service-repository.integration.test.ts` |
| **Phase 7** | **Offset Pagination, Filtering & Whitelisted Sorting** | Complete | `pagination.test.ts`, `postgres.test.ts` |
| **Phase 8** | **Multi-Layer Automated Testing Pyramid** | Complete | `domain-and-services.unit.test.ts`, `service-repository.integration.test.ts`, `http-contracts-and-security.test.ts` |
| **Phase 9** | **Security Hardening (Rate Limiting, Headers, HSTS, CORS, Redaction)** | Complete | `security.test.ts` |
| **Phase 10** | **Multi-Stage Docker Containerization & Non-Root Runtime** | Complete | `docker-runtime.test.ts` |
| **Phase 11** | **Production Deployment & Three-Way Database Isolation** | Complete | `deployment.test.ts` |
| **Phase 12** | **Structured JSON Logging, Correlation IDs & Metrics** | Complete | `observability.test.ts` |
| **Phase 13** | **Horizontal Scaling, Composite Indexing & Batched Writes** | Complete | `scaling.test.ts` |
| **Phase 14** | **Developer Readiness, OpenAPI 3.1 Spec & Public Release** | Complete | `developer-readiness.test.ts` |

---

## Future Product Extensions (Optional Post-v1.0 Evolution)

The 14-phase core engineering roadmap is complete. Any future enhancements should be driven by concrete production measurements or business requirements:

- **Payment Recording & Ledger Reconciliation** — Partial and full payment transactions against issued invoices with automatic transition to `paid`.
- **Credit Notes & Refund Workflows** — Auditable post-issuance adjustments preserving immutable historical invoice records.
- **Signed Outbound Webhooks** — HMAC-signed event delivery (`invoice.issued`, `invoice.paid`, `invoice.overdue`) with exponential backoff retries.
- **Distributed Edge / Redis Rate Limiting** — Optional shared rate-limit backing store when scaling horizontally beyond single-region container clusters.

---

## License

Copyright (c) 2026 [G7 COMMUNITY]. Distributed under the **MIT License**. See [`LICENSE`](./LICENSE) for full license text.
