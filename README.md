## Clinic Booking Platform

A high-concurrency clinic booking system featuring a TypeScript/Express API and a lightweight secure web client. Engineered for strict adherence to OpenAPI 3.0.3 specifications, this platform implements database-level concurrency control, payload-aware idempotency, and intelligent rate limiting to guarantee data integrity under heavy load.
Live Environments
| Environment | URL |
|---|---|
| Client Interface | clinic-booking-web-mu.vercel.app |
| API Base URL | clinic-booking-api-od9i.onrender.com |
| System Health | clinic-booking-api-od9i.onrender.com/health |
> Infrastructure Note: The API is hosted on Render's free tier. Idle instances scale to zero after 15 minutes, which may introduce a ~50-second cold start latency on the initial request.
> 
Architecture & Core Mechanics
The platform prioritizes database-engine guarantees over application-level locking, ensuring resilience against race conditions, retry storms, and transient network failures.
1. Database-Enforced Concurrency
The system guarantees zero double-bookings without relying on expensive SELECT ... FOR UPDATE read-then-write windows.
 * Mechanism: A partial unique index (CREATE UNIQUE INDEX idx_bookings_unique_confirmed_slot ON bookings (slot_id) WHERE LOWER(status) = 'confirmed') enforces slot exclusivity at the engine level.
 * Conflict Resolution: Simultaneous inserts for the same slot compete at the index level. The runner-up triggers ON CONFLICT DO NOTHING, instantly returning a 409 Conflict.
 * Cancellation: Cancelling a booking updates the status to cancelled, dropping the row from the partial index and immediately freeing the slot without tombstone processing.
2. Transaction-Scoped Idempotency & Limiting
Idempotency and rate limiting execute atomically within a single Postgres transaction, safe for use behind PgBouncer connection pooling.
 * Deterministic Locking: Transaction-scoped advisory locks (pg_advisory_xact_lock) serialize requests sharing the same Idempotency-Key and email. Locks are always acquired in strict lexicographical order to eliminate deadlock vectors.
 * Payload Verification: Identical payload replays return the cached response without consuming rate-limit budgets. Reusing a key with a mutated payload correctly yields 422 Unprocessable Entity.
 * Rate Limiter: Caps requests at 5 per minute per email. The 6th concurrent attempt yields a 429 Too Many Requests with an exact, whole-second Retry-After header. Transient 429 responses are explicitly not cached in the idempotency table.
3. Edge-Secured Proxy Layer
The frontend never exposes the API key to the browser network tab.
 * Serverless Middleware: The Vercel deployment routes frontend traffic through a serverless proxy that attaches the X-API-Key securely on the backend.
 * Endpoint Isolation: The proxy explicitly allowlists consumer-facing endpoints. Destructive administrative operations (e.g., POST /reset) and unfiltered global lookup queries are blocked at the edge, protecting the core database.
API Surface
| Method | Endpoint | Description |
|---|---|---|
| GET | /slots | Retrieves available appointment slots. Evaluates real-time availability dynamically. |
| POST | /bookings | Creates a booking. Requires name, email, slot_id, and Idempotency-Key header. |
| GET | /bookings | Lists bookings. Implements strict keyset cursor pagination (limit 1–50, oldest-first). |
| GET | /bookings/:id | Retrieves details for a specific, unguessable booking ID. |
| DELETE | /bookings/:id | Cancels an active booking, immediately releasing the associated slot. |
| POST | /reset | Admin only. Purges all data and reseeds default slots. |
Repository Structure
.
├── api/                        # Express application & API server
│   ├── src/
│   │   ├── routes/             # HTTP route definitions
│   │   ├── services/           # Core business logic and transactions
│   │   ├── util/               # Cursor parsing and idempotency hashing
│   │   └── server.ts           # Application entry point
│   ├── sql/                    # Idempotent Postgres schema definitions
│   └── package.json            
└── web/                        # Static HTML client & Edge proxy
    ├── api/                    # Vercel serverless proxy functions
    └── index.html              # Frontend user interface

Local Development Environment
Prerequisites
 * Node.js v22+
 * PostgreSQL 15+ instance (local or Neon/Supabase)
Build & Run
 * Configure Environment:
   cd api
cp .env.example .env

   Set API_KEY (your secure token) and DATABASE_URL (Postgres connection string) in .env.
 * Initialize:
   npm ci --include=dev
npm run build
npm start 

   Note: Booting the server automatically executes sql/schema.sql to initialize or update tables.
Verification & Testing
The system includes comprehensive black-box and contract testing to guarantee specification adherence.
cd api
npm run test:conformance        # Validates core concurrency, pagination, and rate limiting
npm run test:spec               # Strict OpenAPI 3.0.3 contract adherence testing
npm run test:deep               # Validates proxy, headers, and cryptographic hashing
npm test                        # Executes all suites sequentially

> Warning: Test suites execute POST /reset, which purges the connected database. Never point test commands at a production data source.
> 
Production Deployment Runbook
1. Database (Neon Postgres)
 * Provision a Neon project in a region geographically close to your compute provider (e.g., eu-central).
 * Enable Connection pooling.
 * Copy the pooled connection string (ensure the hostname includes -pooler). Schema migrations will apply automatically on the first API boot.
2. Core API (Render)
 * Create a Web Service mapped to the repository.
 * Root Directory: api
 * Build Command: npm ci --include=dev && npm run build
 * Start Command: node dist/server.js
 * Environment Variables:
   * API_KEY: Secure alphanumeric token.
   * DATABASE_URL: Neon pooled connection string.
   * NODE_VERSION: 22
 * Health Check Path: /health
3. Client & Proxy (Vercel)
 * Import the repository into Vercel.
 * Root Directory: web
 * Framework Preset: Other (bypass build step).
 * Environment Variables:
   * API_BASE_URL: The deployed Render API URL (omit trailing slash).
   * API_KEY: Must match the token defined in the Render environment.
