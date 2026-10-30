# Clinic booking API + web page

Task 1 of the Koya Cohort 4 assessment, built to the published contract at
`koyaacademy.com/assessment-api` (OpenAPI 3.0.3 at `/assessment-api/openapi.json`).
All five levels are implemented and verified.

```
api/   Express 4 + TypeScript + pg  ->  deployed on Render (free)
web/   static page + one Vercel function (API proxy)  ->  deployed on Vercel (free)
       Postgres on Neon (free)
```

## What's where

| Level | Requirement | Where it lives |
|---|---|---|
| 1 | List slots (earliest start first), create booking (`name`, `email`, `slot_id`), look up (`/bookings/:id`), `/reset` (replaces slots or reseeds) | `routes/slots.ts`, `routes/bookings.ts`, `services/slots.ts`, `services/bookings.ts` |
| 2 | API key auth (`X-API-Key`, `api-key`, `Authorization: Bearer`), validation (lowercase & trimmed email, 400 for started/past slots, 404 for unknown slot, 400 for invalid query parameters) | `app.ts` (auth middleware), `validation.ts`, `services/bookings.ts` |
| 3 | Concurrency safety (zero double-bookings under simultaneous races), cancel booking (`DELETE /bookings/:id` frees slot) | `sql/schema.sql` partial unique index, `services/bookings.ts` |
| 4 | `Idempotency-Key` replay (identical payload replays; mutated payload returns 422), cursor pagination (`limit` 1–50, `cursor`, oldest first) | `services/bookings.ts` (`createBooking`, `listBookings`), `util/cursor.ts` |
| 5 | Per-email rate limiting (5 attempts/min, 6th returns 429 with whole-second `Retry-After`, other emails unaffected) | `services/rateLimit.ts` |

## The decisions that matter

**1. The database enforces "never double-book", not the application.**
`CREATE UNIQUE INDEX ... ON bookings (slot_id) WHERE LOWER(status) = 'confirmed'`. Two simultaneous
inserts for one slot cannot both succeed; the loser gets `ON CONFLICT DO NOTHING` -> zero rows
-> `409 Conflict`. Cancelling flips `status` to `cancelled`, which removes the row from the partial index,
freeing the slot immediately with no extra bookkeeping. No `SELECT ... FOR UPDATE`, no read-then-write window.

**2. Idempotency and rate limiting run inside the booking transaction.**
One transaction does: replay lookup -> limiter accounting -> validate -> insert -> record
response. Two transaction-scoped advisory locks serialise the two things that must be
serialised (same `Idempotency-Key`, same email), always acquired in the same order
(key, then email) so they cannot deadlock. A concurrent retry storm of one key collapses to
exactly one booking, and the 6th simultaneous attempt for an email cannot slip past the limiter.
`pg_advisory_xact_lock` is released at COMMIT/ROLLBACK, so it is safe behind Neon's pooler
(PgBouncer transaction mode), where session-level locks are not.

**3. OpenAPI 3.0.3 contract adherence.**
- *Idempotent replays with mutated payloads return 422.* As specified in the OpenAPI spec (`422: Idempotency-Key reused with a different body`), re-using an existing key with altered parameters returns 422 (not 409).
- *Idempotent replays are not new attempts.* A client retrying a timed-out request is not
  punished with a 429 for retrying. The replay check runs before the limiter.
- *429s are never stored under the idempotency key.* It is a transient condition; the same
  key works again once the window clears. All other outcomes (201, 400, 404, 409) are stored
  and replayed verbatim.
- *Failed attempts count toward the rate limit* (per spec). The limiter runs before validation, keyed on
  `email:${cleanEmail}`, so malformed payloads, unknown slots, and conflicts consume budget.
- *Retry-After is exact* in whole seconds: the time until the oldest counted attempt expires.
- *String slot IDs are supported.* Slot identifiers may be arbitrary strings (e.g. `"s1"`, `"s2"`) or UUIDs.
- *Past slot booking prevention.* Booking a slot whose start time has already passed returns 400 (`"The slot has already started"`).
- *Strict pagination limit.* `limit` query param on `GET /bookings` must be an integer between 1 and 50; anything else returns 400.
- *Order is oldest first.* `GET /bookings` orders by `created_at ASC, id ASC`, matching the spec.
- *Error envelope consistency.* Top-level `error` is always a descriptive string (`{"error": "<message>"}`).

**4. The Vercel function is a proxy, not just hosting.**
The API key stays in a server env var instead of being shipped in client JS. The proxy
allowlists only what the page needs, so `POST /reset` (wipes everything) and
`GET /bookings?email=` (a PII lookup of anyone's bookings) are not reachable from the public
page. A booking is retrievable only by its unguessable ID.

**5. Postgres is the only state.**
Works across restarts and instances, with automatic transient retry resilience for connection pool drops (`ECONNRESET`, socket timeouts).
Raw `pg` with connection pooling is used instead of an ORM because the key invariant is a partial unique index that ORM schema languages cannot express cleanly.

## Run locally

```bash
cd api
cp .env.example .env            # set API_KEY and DATABASE_URL
npm ci --include=dev
npm run build
npm start                       # runs sql/schema.sql on boot (idempotent)
```

Run test suites:

```bash
cd api
npm test                        # runs all 3 verification suites
npm run test:conformance        # black-box verification of levels 1–5
npm run test:spec               # strict OpenAPI 3.0.3 contract & edge cases
npm run test:deep               # deep skeptical verification of proxy & unit helpers
```

> The conformance and spec suites call `POST /reset`, which **deletes all bookings and slots**. Run it before you
> submit, never after the graders have started.

## Deploy

### 1. Neon (database)
1. Create a project; Frankfurt/`eu-central` pairs with Render Frankfurt.
2. Connection details -> turn **Connection pooling** on -> copy the string (host contains `-pooler`).
3. Schema applies automatically on API boot.

### 2. Render (API)
1. Push this repo to GitHub.
2. Dashboard -> New -> **Web Service**:
   Root directory `api`, Build `npm ci --include=dev && npm run build`, Start `node dist/server.js`,
   Health check path `/health`, Region matching Neon.
3. Environment: `API_KEY` = your API key, `DATABASE_URL` = Neon pooled string, `NODE_VERSION` = `22`.
4. Deploy. Check `https://<service>.onrender.com/health` returns `{"status":"ok"}`.

### 3. Vercel (web page)
1. New Project -> same repo -> **Root Directory: `web`** -> Framework: Other (no build command).
2. Environment variables: `API_BASE_URL` = `https://<service>.onrender.com` (no trailing slash), `API_KEY` = the same key.
3. Deploy, open the URL, confirm slots load and a booking works end to end.

### 4. Final checks, then hands off
1. Run the conformance and spec suites against the **deployed** URL.
2. Reset to a clean slate (`POST /reset` with `{}`).
3. Submit. **Do not redeploy, rotate keys, or edit env vars afterwards**, per the rules.

## Submission checklist

- [x] **API base URL**: `https://<service>.onrender.com` (or proxy endpoint)
- [x] **API key**: `koya_live_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c` (matches configured key)
- [x] **Web page URL**: Vercel deployed URL
- [x] **GitHub repo**: `https://github.com/Scardubu/clinic-booking` (public, or invite `quadri40`)
- [x] **Loom (<= 5 min)**: page working + code walkthrough + note on how far we got (all 5 levels) and two biggest decisions
- [x] Uptime monitor is live on `/health`
- [x] Conformance and OpenAPI spec suites green against target

## Loom script / talking points (<= 5 min)

1. **0:00-0:45 Live Web App Demo**
   - Open Vercel web page; inspect available doctor slots loaded from Neon Postgres.
   - Enter invalid email format: highlight client-side and server-side validation.
   - Select an available slot, enter patient details, submit booking: show immediate confirmation with booking ID.
   - Open second tab/incognito window, attempt to book the exact same slot: show immediate friendly 409 conflict message.
   - Cancel the booking: show slot instantly returned to available state.

2. **0:45-1:45 Decision 1: Database-Enforced Concurrency (Zero Double-Booking)**
   - Show `api/sql/schema.sql` and `api/src/services/bookings.ts`.
   - Explain the partial unique index: `CREATE UNIQUE INDEX idx_bookings_unique_confirmed_slot ON bookings (slot_id) WHERE LOWER(status) = 'confirmed'`.
   - Explain why this beats application-level locks or `SELECT ... FOR UPDATE`: race condition is resolved at the database engine level atomically.
   - Explain how cancellation works: flipping `status` to `'cancelled'` drops the row from the partial index without row deletion or tombstone tracking.

3. **1:45-2:45 Decision 2: Atomic Transaction Architecture for Idempotency & Rate Limiting**
   - Show `api/src/services/bookings.ts` (`createBooking`).
   - Transaction flow:
     1. Advisory locks on `(Idempotency-Key, email)` acquired in strictly sorted order to eliminate deadlock risks.
     2. Idempotency replay check: identical payload returns previous response immediately without consuming rate limit budget; mutated payload returns 422.
     3. Level 5 Rate Limiter: evaluates 5 attempts per minute per email (including failed attempts) and generates precise `Retry-After` header.
     4. Slot validation (checks slot exists and start time is in the future).
     5. Insertion with `ON CONFLICT DO NOTHING`.
     6. Idempotency record stored.
   - Note transaction-scoped advisory lock compatibility with PgBouncer connection pooling.

4. **2:45-3:30 API Security Proxy & OpenAPI Conformance**
   - Show `web/api/[...path].js`: proxy handles Vercel serverless functions, secures API keys server-side, and prevents external abuse of internal admin endpoints like `POST /reset`.
   - Mention test suite: Level 1-5 conformance suite, OpenAPI 3.0.3 contract test, and deep skeptical test suite all passing with 100% green exit code.

5. **3:30-4:00 Wrap-up & Status**
   - All 5 levels fully complete and strictly adhering to `https://koyaacademy.com/assessment-api/openapi.json`.
   - Ready for evaluation.

## Verification record

Against PostgreSQL with the production build:
- **Level 1–5 Conformance**: 5-way concurrent booking race (1 win, 4 conflicts), cancellation, lookup, cursor pagination, email rate limiting (6th attempt returns 429 with whole-second `Retry-After`).
- **OpenAPI 3.0.3 Contract Verification**: Exact status codes (200, 201, 400, 401, 404, 409, 422, 429), `POST /reset` with custom/past slots, provider query filter, cursor pagination limits (1–50).
- **Deep Verification Suite**: Safe string equality, canonical JSON hash determinism, base64url cursor encoding, proxy forwarding, header preservation, route parameter resolution.
