-- Clinic booking schema. Idempotent: safe to run on every boot (see src/db.ts#migrate).
--
-- The invariants that matter are enforced HERE, not in application code:
--   * one confirmed booking per slot  -> partial unique index bookings_one_confirmed_per_slot
--   * stable pagination order         -> bookings.seq (identity) + (email, seq) index
--   * idempotent replays              -> idempotency_keys primary key
--   * per-email attempt window        -> rate_limit_hits + (email, hit_at) index

CREATE TABLE IF NOT EXISTS slots (
  id        text        PRIMARY KEY,
  provider  text        NOT NULL,
  start_at  timestamptz NOT NULL,
  end_at    timestamptz NOT NULL,
  -- The client's original ISO strings, echoed back verbatim so
  -- "2026-12-10T09:00:00Z" never comes back as "2026-12-10T09:00:00.000Z".
  start_raw text        NOT NULL,
  end_raw   text        NOT NULL
);

-- GET /slots (all, and filtered by provider), always ordered by start.
CREATE INDEX IF NOT EXISTS slots_start_idx          ON slots (start_at, id);
CREATE INDEX IF NOT EXISTS slots_provider_start_idx ON slots (provider, start_at, id);

CREATE TABLE IF NOT EXISTS bookings (
  -- Monotonic insertion order. Cursor pagination keys on this, not created_at:
  -- timestamps can tie or reorder under concurrency, a sequence cannot.
  seq          bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  id           text        PRIMARY KEY,
  slot_id      text        NOT NULL REFERENCES slots (id),
  name         text        NOT NULL,
  email        text        NOT NULL,          -- stored trimmed + lower-cased
  status       text        NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at timestamptz
);

-- THE double-booking guard. Only confirmed rows participate, so cancelling
-- (status -> 'cancelled') frees the slot with no extra bookkeeping, and any
-- number of historical cancelled rows can coexist for the same slot.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

-- GET /bookings?email=...&cursor=... : equality on email, range on seq.
CREATE INDEX IF NOT EXISTS bookings_email_seq_idx ON bookings (email, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           text        PRIMARY KEY,
  request_hash  text        NOT NULL,         -- sha256 of canonicalised request body
  status_code   integer     NOT NULL,
  response_body jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Sliding-window log: one row per counted attempt.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  email  text        NOT NULL,
  hit_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_email_at_idx ON rate_limit_hits (email, hit_at);
