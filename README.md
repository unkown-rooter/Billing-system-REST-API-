<div align="center">

# Billing System REST API

**A production-grade, multi-tenant financial ledger and invoicing REST API built with Node.js, Express, TypeScript, and PostgreSQL.**

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4.21-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Multi--Stage-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Tests](https://img.shields.io/badge/Tests-212%20Passing-10B981?style=for-the-badge&logo=checkmarx&logoColor=white)](#verification--testing)
[![License](https://img.shields.io/badge/License-MIT-F59E0B?style=for-the-badge)](#license)

[Overview](#project-description) •
[Core Features](#core-api-features) •
[Architecture](#architecture-diagram) •
[API Reference](#api-endpoints-documentation) •
[Request & Response Examples](#example-api-request--response) •
[Tech Stack](#tech-stack) •
[Getting Started](#getting-started) •
[Project Status](#project-status) •
[Roadmap](#roadmap) •
[License](#license)

</div>

---

## Project Description

The **Billing System REST API** is a backend-first financial service designed to manage the end-to-end billing lifecycle between businesses and their customers. It provides a strictly typed, transactional interface for operator authentication, customer ledger management, multi-item invoice issuance, deterministic financial calculation, and role-scoped reporting.

The system enforces a strict separation between **Identity (`Account`)** and **Billing Domain (`Customer`, `Invoice`, `InvoiceItem`)**:

- **Accounts (`acc_<uuid>`)** represent authenticated API operators or service principals that sign in and receive stateless Bearer tokens.
- **Customers (`cus_<uuid>`)** represent billed legal entities or individuals owned by an Account (`accountId`) with a designated ISO 4217 ledger currency (`USD`, `EUR`, `KES`, etc.).
- **Invoices (`inv_<uuid>`)** and **Invoice Line Items (`item_<uuid>`)** represent immutable-by-default financial obligations persisted atomically inside PostgreSQL transactions (`BEGIN ... COMMIT / ROLLBACK`) with server-side integer-cents arithmetic.

---

## Core API Features

- **Stateless JWT Authentication & Memory-Hard Cryptography**
  - RFC 7519 `HS256` JSON Web Tokens verified via constant-time HMAC comparison (`crypto.timingSafeEqual`).
  - Password hashing powered by Node.js native memory-hard `crypto.scrypt` with unique 16-byte cryptographic salts per account.
  - Anti-enumeration login flow executing timing-safe dummy derivations when an account email is not found.
- **Role-Based Access Control (RBAC) & Zero-Trust Ownership (IDOR Prevention)**
  - Least-privilege default role (`user`) enforced at registration and database schema levels; administrative privileges (`admin`) are restricted to out-of-band provisioning.
  - Transitive ownership enforcement across `Account → Customer → Invoice → InvoiceItem`. Standard users can only access or mutate resources bound to their own `accountId`; cross-account access attempts return `403 FORBIDDEN` with zero data leakage.
- **Transactional Relational Ledger & Integer-Cents Financial Engine**
  - Invoices and line items are created and updated atomically inside explicit PostgreSQL transactions.
  - All financial totals (`lineTotal`, `subtotal`, `tax`, `discount`, `total`) are computed exclusively server-side in integer cents (`Math.round(amount * 100)`) to eliminate IEEE-754 floating-point drift.
  - Referential integrity enforced at the database engine level (`ON DELETE RESTRICT` protecting customers with historical invoices; `ON DELETE CASCADE` cleaning up child line items when an invoice is deleted).
  - Finalized state locks prevent financial mutation once an invoice reaches `paid` or `cancelled` status (`409 CONFLICT`).
- **Bounded Pagination, Domain Filtering & Whitelisted Sorting**
  - Collection endpoints support 1-indexed `page` and `limit` (`1..100`) pagination with deterministic `pagination` metadata (`total`, `totalPages`, `hasNextPage`, `hasPreviousPage`).
  - Parameterized filtering by currency, status, customer, email, name/description substring (`ILIKE`), and ISO 8601 date ranges (`issueDateFrom`/`To`, `dueDateFrom`/`To`).
  - Compile-time column whitelisting and primary-key tie-breaking (`ORDER BY <col> <dir>, id <dir>`) prevent SQL identifier injection and guarantee stable page ordering.
- **Defense-in-Depth Security Hardening**
  - Strict schema validation rejecting unknown fields, mass-assignment attempts (`id`, `accountId`, `role`, `subtotal`, `total`, `invoiceNumber`), prototype pollution keys (`__proto__`, `constructor`, `prototype`), and UTF-8 null bytes (`\u0000`).
  - Dedicated brute-force rate limiter on authentication routes and general flood rate limiter across `/api/v1/*` emitting `X-RateLimit-*` and `Retry-After` headers (`429 RATE_LIMIT_EXCEEDED`).
  - Hardened HTTP response headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, strict API `Content-Security-Policy`, `Cache-Control: no-store`, and `Strict-Transport-Security` over HTTPS).
  - Automatic log redaction stripping CRLF injection sequences and masking credentials, tokens, and connection strings.
- **Multi-Stage Docker Runtime & Production Readiness**
  - Two-stage `Dockerfile` (`node:22-bookworm-slim`) compiling TypeScript to native ES2022 JavaScript (`dist-server/`) and running as non-root `USER node` (`UID 1000`) on a read-only root filesystem.
  - Fail-closed startup validation in `NODE_ENV=production` when `DATABASE_URL` or a strong `JWT_SECRET` (`>= 32` characters) is missing.
  - Truthful `/api/v1/health` probe verifying live PostgreSQL connectivity (`SELECT 1`) and graceful `SIGTERM`/`SIGINT` connection draining.

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
Express Application Boundary (Port 3000, Non-Root UID 1000, Read-Only Rootfs)
     ├── SecurityHeadersMiddleware (nosniff, DENY, CSP, no-store, HSTS)
     ├── CorsMiddleware (Explicit CORS_ALLOWED_ORIGINS allowlist; no wildcard '*')
     ├── express.json({ limit: '100kb', strict: false }) → 400 MALFORMED_JSON / 413 PAYLOAD_TOO_LARGE
     └── RequestLoggerMiddleware (CRLF sanitization & credential redaction)
     │
     ▼
Versioned API Router (/api/v1 + General API Rate Limiter)
     ├── MethodNotAllowedGuard               → 405 METHOD_NOT_ALLOWED (with RFC 9110 Allow header)
     ├── AuthRateLimiter (/auth/*)           → 429 RATE_LIMIT_EXCEEDED (with Retry-After header)
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
     │  batched item hydration (ANY($1::text[])), and maps SQLSTATE codes (23505, 23503, 23514)
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
| UQ  invoice_number VARCHAR(64)   ('INV-YYYY-XXXX-XXXX')                           |
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
| PK  id             TEXT          ('item_<uuidv4>')                                |
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

## API Endpoints Documentation

**Base Path:** `/api/v1`

### 1. Endpoint Overview & Authorization Matrix

| Method | Endpoint | Auth Required | `user` Role Policy | `admin` Role Policy | Success Status |
|---|---|---|---|---|---|
| `GET` | `/api/v1/health` | No | Public health & DB probe | Public health & DB probe | `200 OK` / `503` |
| `POST` | `/api/v1/auth/register` | No | Registers account (`role: 'user'`) | N/A | `201 Created` |
| `POST` | `/api/v1/auth/login` | No | Issues signed `HS256` Bearer token | Issues signed `HS256` Bearer token | `200 OK` |
| `GET` | `/api/v1/auth/me` | Bearer Token | Returns own account profile | Returns own account profile | `200 OK` |
| `POST` | `/api/v1/customers` | Bearer Token | Creates customer bound to own `accountId` | Creates customer bound to own `accountId` | `201 Created` |
| `GET` | `/api/v1/customers` | Bearer Token | Lists own customers (paginated) | Lists all customers (paginated) | `200 OK` |
| `GET` | `/api/v1/customers/:id` | Bearer Token | Reads own customer (`403` on others) | Reads any customer | `200 OK` |
| `PATCH` | `/api/v1/customers/:id` | Bearer Token | Updates own customer (`403` on others) | Updates any customer (preserves owner) | `200 OK` |
| `DELETE` | `/api/v1/customers/:id` | Bearer Token | `403 FORBIDDEN` | Deletes customer (`409` if invoices exist) | `204 No Content` |
| `POST` | `/api/v1/customers/:id/invoices` | Bearer Token | Creates invoice for own customer (`403` on others) | Creates invoice for any customer | `201 Created` |
| `GET` | `/api/v1/customers/:id/invoices` | Bearer Token | Lists invoices for own customer (`403` on others) | Lists invoices for any customer | `200 OK` |
| `POST` | `/api/v1/invoices` | Bearer Token | Creates invoice for own customer (`403` on others) | Creates invoice for any customer | `201 Created` |
| `GET` | `/api/v1/invoices` | Bearer Token | Lists own customers' invoices (paginated) | Lists all invoices (paginated) | `200 OK` |
| `GET` | `/api/v1/invoices/:id` | Bearer Token | Reads own customer's invoice (`403` on others) | Reads any invoice | `200 OK` |
| `PATCH` | `/api/v1/invoices/:id` | Bearer Token | Updates own customer's invoice (`403` on others) | Updates any invoice | `200 OK` |
| `DELETE` | `/api/v1/invoices/:id` | Bearer Token | `403 FORBIDDEN` | Deletes invoice & cascades line items | `204 No Content` |
| `GET` | `/api/v1/invoices/:id/items` | Bearer Token | Lists items for own invoice (`403` on others) | Lists items for any invoice | `200 OK` |

> **HTTP Method Enforcement:** Sending an unsupported HTTP verb (such as `PUT` on `/api/v1/customers` or `DELETE` on `/api/v1/health`) returns `405 Method Not Allowed` with an RFC 9110 `Allow` header listing the permitted methods for that resource.

---

### 2. Query Parameters: Pagination, Filtering & Sorting

All collection endpoints (`GET /api/v1/customers`, `GET /api/v1/invoices`, `GET /api/v1/customers/:id/invoices`, and `GET /api/v1/invoices/:id/items`) support standardized pagination and sorting parameters:

| Parameter | Type | Default | Constraints & Behavior |
|---|---|---|---|
| `page` | Integer | `1` | `1`-indexed page number (`1..1,000,000`). Calculates `OFFSET = (page - 1) * limit`. |
| `limit` | Integer | `20` | Page size (`1..100`). Values `< 1` or `> 100` return `400 VALIDATION_ERROR`. |
| `sort` | String | `createdAt` | Whitelisted field name per resource (see below). |
| `order` | String | `asc` | Sort direction: `asc` or `desc`. Deterministic tie-breaking on `id` is always applied. |

#### Resource-Specific Filter & Sort Parameters

| Collection Endpoint | Supported Filter Query Parameters | Whitelisted `sort` Fields |
|---|---|---|
| `GET /api/v1/customers` | `currency` (exact 3-letter ISO code)<br>`email` (case-insensitive exact match)<br>`name` (case-insensitive substring match) | `createdAt`, `updatedAt`, `name`, `email` |
| `GET /api/v1/invoices`<br>`GET /api/v1/customers/:id/invoices` | `status` (`draft`, `issued`, `paid`, `overdue`, `cancelled`)<br>`customerId` (`cus_<uuid>`, on `/api/v1/invoices`)<br>`currency` (exact 3-letter ISO code)<br>`issueDate`, `issueDateFrom`, `issueDateTo` (ISO 8601 / `YYYY-MM-DD`)<br>`dueDate`, `dueDateFrom`, `dueDateTo` (ISO 8601 / `YYYY-MM-DD`) | `createdAt`, `updatedAt`, `issueDate`, `dueDate`, `total`, `subtotal`, `invoiceNumber`, `status` |
| `GET /api/v1/invoices/:id/items` | `description` (case-insensitive substring match) | `createdAt`, `quantity`, `unitPrice`, `lineTotal`, `description` |

---

### 3. Standardized Error Vocabulary

All error responses return a uniform JSON envelope and never expose stack traces, SQL queries, or internal file paths:

| Error Code | HTTP Status | Trigger Condition |
|---|---|---|
| `VALIDATION_ERROR` | `400 Bad Request` | Invalid field types/constraints, unknown properties, mass-assignment fields, or invalid query parameters (includes `fields[]` array). |
| `MALFORMED_JSON` | `400 Bad Request` | Syntactically invalid JSON payload in request body. |
| `AUTHENTICATION_REQUIRED` | `401 Unauthorized` | Missing `Authorization: Bearer <token>` header on a protected endpoint. |
| `INVALID_CREDENTIALS` | `401 Unauthorized` | Unknown email or incorrect password during `POST /api/v1/auth/login`. |
| `INVALID_TOKEN` | `401 Unauthorized` | Malformed JWT, tampered HMAC signature, disallowed algorithm (`alg: "none"`), or invalid claims. |
| `TOKEN_EXPIRED` | `401 Unauthorized` | JWT `exp` timestamp has passed. |
| `FORBIDDEN` | `403 Forbidden` | Authenticated principal lacks required role (`admin`) or attempts cross-account resource access (IDOR). |
| `RESOURCE_NOT_FOUND` | `404 Not Found` | Structurally valid resource ID (`cus_*`, `inv_*`, `acc_*`) does not exist. |
| `ROUTE_NOT_FOUND` | `404 Not Found` | Request path does not match any registered `/api/v1/*` route. |
| `METHOD_NOT_ALLOWED` | `405 Method Not Allowed` | HTTP verb is not supported on a known route (includes `Allow` response header). |
| `DUPLICATE_RESOURCE` | `409 Conflict` | Case-insensitive email uniqueness violation or duplicate invoice number. |
| `CONFLICT` | `409 Conflict` | Deleting a customer with existing invoices (`ON DELETE RESTRICT`) or mutating a `paid`/`cancelled` invoice. |
| `PAYLOAD_TOO_LARGE` | `413 Payload Too Large` | Request body exceeds the `100kb` JSON limit. |
| `RATE_LIMIT_EXCEEDED` | `429 Too Many Requests` | Client exceeded authentication or API rate limit window (includes `Retry-After` header). |
| `DATABASE_ERROR` | `500 Internal Server Error` | Operational database failure (details logged server-side with redaction; sanitized message returned). |
| `INTERNAL_SERVER_ERROR` | `500 Internal Server Error` | Unexpected runtime error (sanitized message returned). |

---

## Example API Request & Response

### 1. Health & Database Connectivity Check (`GET /api/v1/health`)

**Request:**
```bash
curl -i -X GET "http://localhost:3000/api/v1/health"
```

**Response (`200 OK`):**
```json
{
  "status": "success",
  "data": {
    "status": "healthy",
    "timestamp": "2026-09-27T06:36:12.826Z",
    "uptime": 45.024261335,
    "database": {
      "status": "healthy"
    }
  }
}
```

---

### 2. Register & Authenticate an Operator Account

**Register Request (`POST /api/v1/auth/register`):**
```bash
curl -i -X POST "http://localhost:3000/api/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "billing.ops@acme-corp.example.com",
    "password": "<STRONG_PASSWORD_MIN_8_CHARS>"
  }'
```

**Register Response (`201 Created`):**
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

**Login Request (`POST /api/v1/auth/login`):**
```bash
curl -i -X POST "http://localhost:3000/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "billing.ops@acme-corp.example.com",
    "password": "<STRONG_PASSWORD_MIN_8_CHARS>"
  }'
```

**Login Response (`200 OK`):**
```json
{
  "status": "success",
  "data": {
    "token": "<SIGNED_HS256_JWT_BEARER_TOKEN>",
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

---

### 3. Create & Query Customers

**Create Customer Request (`POST /api/v1/customers`):**
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

**Create Customer Response (`201 Created`):**
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

**Paginated & Filtered Customer Query (`GET /api/v1/customers`):**
```bash
curl -i -X GET "http://localhost:3000/api/v1/customers?page=1&limit=10&currency=USD&sort=createdAt&order=desc" \
  -H "Authorization: Bearer <ACCESS_TOKEN>"
```

**Paginated Customer Response (`200 OK`):**
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

---

### 4. Issue a Multi-Item Invoice (`POST /api/v1/invoices`)

**Request:**
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

**Response (`201 Created`):**
```json
{
  "status": "success",
  "data": {
    "id": "inv_9f82b310-7c12-49a1-8b20-61f3d9a8c112",
    "customerId": "cus_4a41c717-3143-4c12-9bf3-de0f4642d7c3",
    "invoiceNumber": "INV-2026-4821-9F82",
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
        "id": "item_3d19a400-1b2c-4d5e-9f00-112233445566",
        "invoiceId": "inv_9f82b310-7c12-49a1-8b20-61f3d9a8c112",
        "description": "Dedicated Compute Cluster (Monthly)",
        "quantity": 2,
        "unitPrice": 150.00,
        "lineTotal": 300.00,
        "createdAt": "2026-09-27T06:36:18.904Z",
        "updatedAt": "2026-09-27T06:36:18.904Z"
      },
      {
        "id": "item_7a88e911-4c5d-4e6f-8a11-77889900aabb",
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

---

### 5. Standardized Error Response Examples

**Field Validation Failure (`400 Bad Request`):**
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
        "field": "currency",
        "message": "Field 'currency' must be a valid 3-letter uppercase ISO code (e.g. USD, EUR, KES)"
      }
    ]
  }
}
```

**Cross-Account Access / Insufficient Role (`403 Forbidden`):**
```json
{
  "status": "error",
  "error": {
    "code": "FORBIDDEN",
    "message": "You are not authorized to access this resource"
  }
}
```

---

## Tech Stack

| Layer | Technology | Role & Justification |
|---|---|---|
| **Runtime** | **Node.js 22 LTS** | Native ES2022 module execution, `node:crypto` (`scrypt`, `timingSafeEqual`, `createHmac`), and native `node:test` runner. |
| **HTTP Framework** | **Express.js 4.21** | Modular routing, bounded JSON payload parsing (`100kb`), custom security middleware, and centralized error handling. |
| **Language** | **TypeScript (Strict Mode)** | Compile-time type safety (`strict: true`, `noImplicitAny: true`) across DTOs, domain models, services, and repositories. |
| **Database** | **PostgreSQL 15+** | ACID transactions, `NUMERIC(12,2)` exact decimal storage, `TIMESTAMPTZ` UTC timestamps, `CHECK` constraints, and B-Tree indexes. |
| **Database Driver** | **`pg` (`node-postgres` 8.23)** | Direct parameterized SQL queries (`$1, $2, ...`) and connection pooling (`pg.Pool`) with zero ORM overhead. |
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
| `DATABASE_URL` | **Secret** | **Yes** | — | PostgreSQL connection URI (`postgresql://<user>:<password>@<host>:5432/<dbname>`). Fails closed if unset in `production`. |
| `JWT_SECRET` | **Secret** | **Yes** | — | High-entropy HMAC-SHA256 signing secret (`>= 32` characters). Fails closed in `production` if missing, weak, or set to a placeholder. |
| `NODE_ENV` | **Config** | **Yes** | `development` | Runtime environment (`development` or `production`). |
| `PORT` | **Config** | **Yes** | `3000` | HTTP server listening port. |
| `HOST` | **Config** | Optional | `0.0.0.0` | Network interface bind address. |
| `TRUST_PROXY` | **Config** | Optional | `1` (in prod) | Enables Express `trust proxy` (`1` hop) when deployed behind a TLS-terminating load balancer. |
| `CORS_ALLOWED_ORIGINS` | **Config** | Optional | `""` | Comma-separated allowlist of trusted browser origins. Empty string disables cross-origin access. |
| `ENABLE_HSTS` | **Config** | Optional | `false` (`true` in prod) | Emits `Strict-Transport-Security: max-age=31536000; includeSubDomains`. |
| `JWT_EXPIRES_IN` | **Optional** | Optional | `86400` | JWT expiration lifetime in seconds (24 hours). |
| `AUTH_RATE_LIMIT_WINDOW_MS` | **Optional** | Optional | `60000` | Rate-limit window in milliseconds for `/api/v1/auth/login` and `/register`. |
| `AUTH_RATE_LIMIT_MAX` | **Optional** | Optional | `30` | Maximum authentication requests per window per client IP. |
| `API_RATE_LIMIT_WINDOW_MS` | **Optional** | Optional | `60000` | Rate-limit window in milliseconds for general `/api/v1/*` endpoints. |
| `API_RATE_LIMIT_MAX` | **Optional** | Optional | `300` | Maximum general API requests per window per client IP. |

> **Security Note:** Never commit `.env` files or real secrets to version control. `.gitignore` and `.dockerignore` strictly exclude `.env*` files from Git history and Docker build contexts.

### 3. Apply Database Migrations

The transactional migration runner (`src/api/db/migrate.ts`) tracks applied SQL files in the `schema_migrations` table and safely skips already-applied migrations:

```bash
# Development (TypeScript via tsx)
npm run migrate

# Production (Compiled JavaScript)
npm run build
npm run migrate:prod
```

### 4. Run the Application

```bash
# Start in development mode (Express API + Vite middleware on http://localhost:3000)
npm run dev

# Build and start in production mode (Compiled dist-server/server.js + static dist/)
npm run build
npm run start:prod

# Run the complete pre-flight release & migration pipeline
npm run deploy:release
```

### 5. Run with Docker & Docker Compose

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

### Verification & Testing

The repository enforces three-way database isolation (`Development DB ≠ Automated Test DB ≠ Production DB`) via programmatic guards (`assertSafeTestDatabaseUrl` and `assertSafeProductionDatabaseUrl`) and includes **212 automated tests across 13 suites**:

```bash
# TypeScript strict type-checking (client + server)
npm run lint

# Fast unit, service-repository transaction, HTTP contract, validation, auth, RBAC, relational, pagination & security suites (179 tests)
npm test

# Live PostgreSQL 15 integration suite against dedicated *_test database (22 tests)
npm run test:integration

# Multi-stage Docker runtime, non-root execution, read-only rootfs & SIGTERM suite (6 tests)
npm run test:docker

# Production deployment, DB separation, migration idempotency & HTTPS/TLS live verification suite (5 tests)
npm run test:deploy

# Execute the complete 13-suite verification pyramid (212 tests)
npm run test:all
```

---

## Project Status

**Status:** **Production-Ready (`v1.0.0`)**

| Capability Area | Status | Verification Coverage |
|---|---|---|
| **REST API Contract & Standardized Errors** | Complete | `api.test.ts`, `validation.test.ts`, `http-contracts-and-security.test.ts` |
| **PostgreSQL Persistence & Transactional Migrations (`001`–`005`)** | Complete | `postgres.test.ts`, `service-repository.integration.test.ts` |
| **Stateless JWT Authentication & `scrypt` Password Hashing** | Complete | `auth.test.ts`, `domain-and-services.unit.test.ts` |
| **RBAC (`user` / `admin`) & Cross-Account IDOR Prevention** | Complete | `authorization.test.ts`, `security.test.ts` |
| **Relational Invoicing (`Customer → Invoice → InvoiceItem`)** | Complete | `relationships.test.ts`, `service-repository.integration.test.ts` |
| **Offset Pagination, Filtering & Whitelisted Sorting** | Complete | `pagination.test.ts`, `postgres.test.ts` |
| **Rate Limiting, Security Headers, HSTS, CORS & Log Redaction** | Complete | `security.test.ts` |
| **Multi-Stage Docker Image & Cloud Run Deployment Configuration** | Complete | `docker-runtime.test.ts`, `deployment.test.ts` |

---

## Roadmap

- [x] **Core Customer & Account Ledger** — Versioned REST endpoints, strict input validation, and PostgreSQL persistence.
- [x] **Authentication & RBAC Authorization** — `scrypt` password hashing, `HS256` JWT Bearer tokens, and ownership-scoped access control.
- [x] **Transactional Invoicing Engine** — Multi-item invoices, integer-cents financial math, and `ON DELETE RESTRICT` / `CASCADE` integrity.
- [x] **Collection Pagination & Filtering** — Indexed filtering, whitelisted sorting, and deterministic pagination metadata.
- [x] **Security Hardening & Containerization** — Rate limiting, defensive HTTP headers, log redaction, and non-root multi-stage Docker runtime.
- [ ] **Payment Recording & Ledger Reconciliation** — Partial and full payment transactions against issued invoices with automatic transition to `paid`.
- [ ] **Credit Notes & Refund Workflows** — Auditable post-issuance adjustments preserving immutable historical invoice records.
- [ ] **Recurring Billing & Subscription Schedules** — Automated billing cycle generation and overdue invoice state transitions.
- [ ] **Signed Outbound Webhooks** — HMAC-signed event delivery (`invoice.issued`, `invoice.paid`, `invoice.overdue`) with exponential backoff retries.
- [ ] **OpenAPI 3.1 Specification & Distributed Rate Limiting** — Machine-readable OpenAPI schema export and optional Redis-backed rate-limit store for multi-instance horizontal scaling.

---

## License

Distributed under the **MIT License**.

```text
MIT License

Copyright (c) 2026 Billing System Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE(S) FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
