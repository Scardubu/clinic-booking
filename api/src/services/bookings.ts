import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { advisoryXactLock, pool, withTx } from '../db.js';
import { canonicalJson } from '../util/canonical.js';
import { decodeCursor, encodeCursor } from '../util/cursor.js';
import { consumeAttempt } from './rateLimit.js';
import { parseNewBooking, rateLimitKey } from '../validation.js';

export interface Outcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  replayed?: boolean;
}

interface BookingRow {
  seq: string;
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: 'confirmed' | 'cancelled';
  created_at: Date;
}

const BOOKING_COLS = 'seq, id, slot_id, name, email, status, created_at';

const toBooking = (r: BookingRow) => ({
  id: r.id,
  slot_id: r.slot_id,
  name: r.name,
  email: r.email,
  status: r.status,
  created_at: r.created_at.toISOString(),
});

const fail = (status: number, error: string): Outcome => ({ status, body: { error } });

/**
 * POST /bookings — levels 1-5 in ONE transaction:
 *
 *   1. idempotency lookup   (replay / 422)           lock order: idem key ...
 *   2. rate-limit accounting (429)                   ... then email. Fixed order => no deadlocks.
 *   3. validate -> slot exists -> slot not started -> insert (409 on conflict)
 *   4. record the response against the idempotency key
 *
 * Order matters for the contract:
 *   - Replays are NOT new attempts: they short-circuit before the limiter, so a client
 *     retrying a timed-out request is never punished with a 429 for retrying.
 *   - The limiter runs BEFORE validation so that failed attempts count ("failed
 *     attempts included"), but AFTER the replay check.
 *   - 429 responses are never stored under the idempotency key: it is a transient
 *     condition, and the same key must be usable again once the window clears.
 */
export function createBooking(rawBody: unknown, idempotencyKey: string | null): Promise<Outcome> {
  return withTx(async (client) => {
    let requestHash: string | null = null;

    if (idempotencyKey !== null) {
      requestHash = createHash('sha256').update(canonicalJson(rawBody)).digest('hex');

      // Serialise same-key requests: the second waits here until the first commits,
      // then finds the stored response below. This is what makes a concurrent
      // retry storm collapse to exactly one booking.
      await advisoryXactLock(client, `idem:${idempotencyKey}`);
      const prior = await client.query<{ request_hash: string; status_code: number; response_body: unknown }>(
        'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1',
        [idempotencyKey],
      );
      const hit = prior.rows[0];
      if (hit) {
        if (hit.request_hash !== requestHash) {
          return fail(422, 'Idempotency-Key was already used with a different request body');
        }
        return { status: hit.status_code, body: hit.response_body, replayed: true };
      }
    }

    const limiterKey = rateLimitKey(rawBody);
    if (limiterKey !== null) {
      const verdict = await consumeAttempt(client, limiterKey);
      if (!verdict.allowed) {
        return {
          status: 429,
          body: { error: 'too many booking attempts for this email, try again later' },
          headers: { 'Retry-After': String(verdict.retryAfterSeconds) },
        };
      }
    }

    const outcome = await attemptBooking(client, rawBody);

    if (idempotencyKey !== null) {
      await client.query(
        `INSERT INTO idempotency_keys (key, request_hash, status_code, response_body)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [idempotencyKey, requestHash, outcome.status, JSON.stringify(outcome.body)],
      );
    }
    return outcome;
  });
}

async function attemptBooking(client: PoolClient, rawBody: unknown): Promise<Outcome> {
  const parsed = parseNewBooking(rawBody);
  if (!parsed.ok) return fail(400, parsed.error);
  const { slotId, name, email } = parsed.value;

  const slot = await client.query<{ started: boolean }>(
    'SELECT start_at <= clock_timestamp() AS started FROM slots WHERE id = $1',
    [slotId],
  );
  const found = slot.rows[0];
  if (!found) return fail(404, 'slot not found');
  if (found.started) return fail(400, 'slot has already started');

  // The race-proof part. The partial unique index means two concurrent inserts for
  // the same slot cannot both succeed: the loser blocks on the index entry until the
  // winner commits, then hits the conflict and gets zero rows back. No error is
  // raised, so the surrounding transaction (and its rate-limit hit) stays valid.
  const inserted = await client.query<BookingRow>(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING ${BOOKING_COLS}`,
    [randomUUID(), slotId, name, email],
  );
  const row = inserted.rows[0];
  if (!row) return fail(409, 'slot is already booked');
  return { status: 201, body: toBooking(row) };
}

export async function getBooking(id: string): Promise<Outcome> {
  const { rows } = await pool.query<BookingRow>(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? { status: 200, body: toBooking(row) } : fail(404, 'booking not found');
}

/**
 * DELETE /bookings/:id. One conditional UPDATE is the whole race-safe story: of two
 * concurrent cancels exactly one matches `status = 'confirmed'`; the other updates
 * nothing and is told 409. Flipping the status also frees the slot, because the
 * unique index only covers confirmed rows.
 */
export async function cancelBooking(id: string): Promise<Outcome> {
  const updated = await pool.query<BookingRow>(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = clock_timestamp()
      WHERE id = $1 AND status = 'confirmed'
      RETURNING ${BOOKING_COLS}`,
    [id],
  );
  const row = updated.rows[0];
  if (row) return { status: 200, body: toBooking(row) };

  const exists = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [id]);
  return exists.rowCount ? fail(409, 'booking is already cancelled') : fail(404, 'booking not found');
}

/**
 * GET /bookings?email=&limit=&cursor= — keyset pagination, oldest first.
 * Fetches limit+1 rows: if the extra row exists there IS a next page, so the final
 * page reports next_cursor:null even when it is exactly `limit` long (no phantom
 * empty trailing page).
 */
export async function listBookings(email: string, limit: number, cursor: string | null): Promise<Outcome> {
  let after: string | null = null;
  if (cursor !== null) {
    after = decodeCursor(cursor);
    if (after === null) return fail(400, 'cursor is not valid');
  }

  const { rows } = await pool.query<BookingRow>(
    `SELECT ${BOOKING_COLS}
       FROM bookings
      WHERE email = $1 AND ($2::bigint IS NULL OR seq > $2::bigint)
      ORDER BY seq ASC
      LIMIT $3`,
    [email, after, limit + 1],
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    status: 200,
    body: {
      bookings: page.map(toBooking),
      next_cursor: hasMore && last ? encodeCursor(last.seq) : null,
    },
  };
}
