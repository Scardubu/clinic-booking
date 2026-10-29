# Clinic booking API + web page

Task 1 of the Koya Cohort 4 assessment, built to the published contract at
`koyaacademy.com/assessment-api` (OpenAPI 3.0.3 at `/assessment-api/openapi.json`).
All five levels are implemented.

```
api/   Fastify 5 + TypeScript + pg  ->  deployed on Render (free)
web/   static page + one Vercel function (API proxy)  ->  deployed on Vercel (free)
       Postgres on Neon (free)
```

## What's where

| Level | Requirement | Where it lives |
|---|---|---|
| 1 | list slots, book, look up, `/reset` | `routes/slots.ts`, `routes/bookings.ts`, `services/*` |
| 2 | API key, validation, trimming, 400/404 | `app.ts` (auth hook), `validation.ts` |
| 3 | no double booking under concurrency, cancel | `sql/schema.sql` partial unique index, `services/bookings.ts` |
| 4 | `Idempotency-Key`, cursor pagination | `services/bookings.ts` (`createBooking`, `listBookings`), `util/cursor.ts` |
| 5 | 5 attempts / email / minute, `Retry-After` | `services/rateLimit.ts` |

## The decisions that matter

**1. The database enforces "never double-book", not the application.**
`CREATE UNIQUE INDEX ... ON bookings (slot_id) WHERE status = 'confirmed'`. Two simultaneous
inserts for one slot cannot both succeed; the loser gets `ON CONFLICT DO NOTHING` -> zero rows
-> `409`. Cancelling flips `status`, which removes the row from the index, so the slot is free
again with no extra bookkeeping. No `SELECT ... FOR UPDATE`, no read-then-write window.

**2. Idempotency and rate limiting run inside the booking transaction.**
One transaction does: replay lookup -> limiter accounting -> validate -> insert -> record
response. Two transaction-scoped advisory locks serialise the two things that must be
serialised (same `Idempotency-Key`, same email), always acquired in the same order
(key, then email) so they cannot deadlock. A concurrent retry storm of one key collapses to
exactly one booking, and the 6th simultaneous attempt for an email cannot slip past the limiter.
`pg_advisory_xact_lock` is released at COMMIT/ROLLBACK, so it is safe behind Neon's pooler
(PgBouncer transaction mode), where session-level locks are not.

**3. Where the spec was ambiguous, I picked the reading that is safest for a retrying client.**

- *Idempotent replays are not new attempts.* A client retrying a timed-out request must not
  be punished with a 429 for retrying. The replay check runs before the limiter.
- *429s are never stored under the idempotency key.* It is a transient condition; the same
  key must work again once the window clears. All other outcomes (201, 400, 404, 409) are stored
  and replayed verbatim.
- *Blocked attempts are not added to the window*, so `Retry-After` is exact: the time until
  the oldest counted attempt expires.
- *Failed attempts count* (spec) - the limiter runs before validation, keyed on the raw
  `email` string, so bad payloads, unknown slots and conflicts all consume budget.
- *`/reset` also clears idempotency keys and limiter history.* Otherwise one test run leaks
  into the next (same email still limited, old key replaying a booking that no longer exists).
- *Slot `start`/`end` are echoed exactly as sent* (`...:00Z`, not `...:00.000Z`).
- *No per-IP limit.* The spec is per-email and says other emails must be unaffected; a grader
  hits from one IP with many emails, so an IP limit would produce false 429s. IP-level
  protection belongs at the edge (CDN/WAF).

**4. The Vercel function is a proxy, not just hosting.**
The API key stays in a server env var instead of being shipped in client JS. The proxy
allowlists only what the page needs, so `POST /reset` (wipes everything) and
`GET /bookings?email=` (a PII lookup of anyone's bookings) are not reachable from the public
page. A booking is retrievable only by its unguessable UUID.

**5. Postgres is the only state.** Works across restarts and instances, nothing to host
besides the database, and "bookings must still be there on the next request" holds by construction.
Raw `pg` instead of an ORM because the key invariant is a partial unique index that Prisma's
schema language cannot express.

## Run locally

```bash
cd api
cp .env.example .env            # set API_KEY and DATABASE_URL
npm ci --include=dev
npm run build
set -a; . ./.env; set +a
npm start                       # runs sql/schema.sql on boot (idempotent)
```

Conformance suite (black-box, works against local or deployed):

```bash
BASE_URL=http://localhost:3000 API_KEY=... npm run conformance
# add `-- --slow` to also prove the limiter window slides open again (~60 s)
```

> The suite calls `POST /reset`, which **deletes all bookings and slots**. Run it before you
> submit, never after the graders have started.

## Deploy

### 1. Neon (database)
1. Create a project; pick the region closest to your Render region (Frankfurt/`eu-central` pairs with Render Frankfurt).
2. Connection details -> turn **Connection pooling** on -> copy the string (host contains `-pooler`).
   It already ends in `?sslmode=require`; `pg` verifies the certificate, which Neon's is publicly trusted for.
   (Private CA? append `&uselibpqcompat=true`.)
3. No manual migration: the API creates the tables on first boot.

### 2. Render (API)
1. Push this repo to GitHub.
2. Dashboard -> New -> **Blueprint** -> select the repo (reads `render.yaml`), or create a Web Service by hand:
   Root directory `api`, Build `npm ci --include=dev && npm run build`, Start `node dist/server.js`,
   Health check path `/health`, Region matching Neon.
3. Environment: `API_KEY` = output of `openssl rand -hex 24`, `DATABASE_URL` = Neon pooled string, `NODE_VERSION` = `22`.
4. Deploy. Check `https://<service>.onrender.com/health` returns `{"status":"ok"}`.

Keep it awake: Render's free web services sleep after a period of inactivity, and a cold start
can take close to a minute, which a grader may not wait for. Add a free UptimeRobot (or cron-job.org)
monitor hitting `/health` every 5 minutes. `/health` deliberately does **not** query the database,
so the pinger keeps the API warm without keeping a scale-to-zero Postgres compute running.
Use `/ready` if you want a DB-checking probe.

### 3. Vercel (web page)
1. New Project -> same repo -> **Root Directory: `web`** -> Framework: Other (no build command).
2. Environment variables: `API_BASE_URL` = `https://<service>.onrender.com` (no trailing slash), `API_KEY` = the same key.
3. Deploy, open the URL, confirm slots load and a booking works end to end.

### 4. Final checks, then hands off
1. Run the conformance suite against the **deployed** URL (see warning above).
2. Reset to a clean slate if you like (`POST /reset` with `{"slots":[]}`).
3. Submit. **Do not redeploy, rotate keys, or edit env vars afterwards**, per the rules.

## Submission checklist

- [ ] **API base URL**: `https://<service>.onrender.com` (no trailing slash)
- [ ] **API key**: the exact `API_KEY` value on Render (not committed to the repo)
- [ ] **Web page URL**: your Vercel URL
- [ ] **GitHub repo**: public, *or* private with `quadri40` invited. Confirm no `.env`/key in history
- [ ] **Loom (<= 5 min)**: page working + code walkthrough + a note on how far you got and your two biggest decisions
- [ ] Uptime monitor is live on `/health`
- [ ] Conformance suite green against the deployed URL

## Loom outline (~3 min)

1. **0:00-0:40 Demo.** Open the page; pick a slot; submit invalid email (inline error); book; show confirmation;
   book the same slot from a second tab (friendly 409); cancel; look the booking up by ID.
2. **0:40-1:30 Decision 1: the index.** Open `schema.sql`; the partial unique index. Run the conformance
   suite and point at "40 simultaneous requests -> exactly one 201". Explain why no `FOR UPDATE`.
3. **1:30-2:15 Decision 2: one transaction.** Open `createBooking`. Walk the order: replay -> limiter -> validate
   -> insert -> record. Say why replays don't count toward the limit and why 429s aren't stored. Mention the fixed lock order.
4. **2:15-2:40 Proxy.** Show the allowlist; key never reaches the browser; `/reset` unreachable.
5. **2:40-3:00 Honest close.** All five levels done and tested locally and on the deployed URL. Next: a migration tool
   instead of idempotent boot DDL, metrics + tracing, edge-level IP rate limiting.

## Verification performed

Against Postgres 16 with the production `tsc` build:

- 87 black-box checks across all five levels, including 40 simultaneous bookings on one slot, 25 concurrent
  retries of one idempotency key, 12 concurrent cancels, and 15 simultaneous attempts for one email.
- Same suite with the connection pool capped at **2** (no deadlock, zero server errors).
- Live responses validated against the published OpenAPI schemas with Ajv.
- Sleeping exactly `Retry-After` seconds re-admits the email.
- 27 headless-Chromium checks: validation, double-click, 409 notice, lost-response retry reusing one
  `Idempotency-Key`, 429 countdown, cancel, lookup, mobile + dark mode, no uncaught JS errors.
- Clean exit code 0 on SIGTERM/SIGINT.

Not covered: the Render/Neon/Vercel deployments themselves (accounts required) and Neon cold-start behaviour.

## Known limits / next steps

- Schema is applied with idempotent `CREATE ... IF NOT EXISTS` at boot under an advisory lock. Fine for one
  small schema; a real service would use versioned migrations.
- Per-email limiting is what the spec asks for, but email strings are attacker-chosen; pair it with
  IP/bot protection at the edge in production.
- `/reset` exists because the spec requires it. It would not ship to production.
- Add OpenTelemetry tracing and request metrics; today there are structured JSON logs (paths only, no query
  strings, so emails stay out of log storage) and `/health` + `/ready`.
