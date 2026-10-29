import { pool, withTx } from '../db.js';
import type { NewSlot } from '../validation.js';

interface SlotRow {
  id: string;
  provider: string;
  start_raw: string;
  end_raw: string;
  available: boolean;
}

export async function listSlots(provider: string | undefined) {
  const { rows } = await pool.query<SlotRow>(
    `SELECT s.id, s.provider, s.start_raw, s.end_raw,
            NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
      WHERE ($1::text IS NULL OR s.provider = $1)
      ORDER BY s.start_at ASC, s.id ASC`,
    [provider ?? null],
  );
  return {
    slots: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start_raw,
      end: r.end_raw,
      available: r.available,
    })),
  };
}

/**
 * POST /reset — atomically wipe everything and install the given slots.
 * Also clears idempotency keys and rate-limit history: a "reset" that left either
 * behind would make test runs leak into each other (the same email would still be
 * rate-limited, an old Idempotency-Key would replay a booking that no longer exists).
 * TRUNCATE takes ACCESS EXCLUSIVE locks, so it waits for in-flight bookings to
 * finish instead of racing them.
 */
export async function resetSlots(slots: NewSlot[]): Promise<number> {
  return withTx(async (client) => {
    await client.query('TRUNCATE bookings, slots, idempotency_keys, rate_limit_hits RESTART IDENTITY');
    if (slots.length > 0) {
      await client.query(
        `INSERT INTO slots (id, provider, start_at, end_at, start_raw, end_raw)
         SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[])`,
        [
          slots.map((s) => s.id),
          slots.map((s) => s.provider),
          slots.map((s) => s.startAt),
          slots.map((s) => s.endAt),
          slots.map((s) => s.startRaw),
          slots.map((s) => s.endRaw),
        ],
      );
    }
    return slots.length;
  });
}

/** Opportunistic housekeeping. Correctness never depends on this running. */
export async function purgeStale(): Promise<void> {
  await pool.query(`DELETE FROM rate_limit_hits WHERE hit_at < clock_timestamp() - interval '10 minutes'`);
  await pool.query(`DELETE FROM idempotency_keys WHERE created_at < clock_timestamp() - interval '24 hours'`);
}
