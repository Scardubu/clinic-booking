import type { PoolClient } from 'pg';
import { advisoryXactLock } from '../db.js';
import { config } from '../config.js';

export type Verdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Sliding-window-log limiter, backed by Postgres.
 *
 * Why Postgres and not memory/Redis:
 *   - survives restarts and works across instances with no extra infra to host,
 *   - runs INSIDE the booking transaction, so "count the attempt" and "do the
 *     work" are one atomic unit and the 6th concurrent request cannot slip past.
 *
 * Concurrency: a per-email advisory lock serialises same-email requests. Different
 * emails never contend. The lock is held until COMMIT, so attempt N+1 sees attempt N.
 *
 * clock_timestamp() (not now()): now() is frozen at transaction start, which is
 * BEFORE we waited on the lock — using it would shrink the window under contention.
 *
 * Blocked (429) attempts are not logged, so Retry-After is exact: it is the time
 * until the oldest counted attempt leaves the window, after which one request fits.
 */
export async function consumeAttempt(client: PoolClient, email: string): Promise<Verdict> {
  const { max, windowSeconds } = config.rateLimit;
  await advisoryXactLock(client, `rl:${email}`);

  const { rows } = await client.query<{ n: number; retry_after: number | null }>(
    `SELECT count(*)::int AS n,
            CEIL(EXTRACT(EPOCH FROM (min(hit_at) + make_interval(secs => $2) - clock_timestamp())))::int AS retry_after
       FROM rate_limit_hits
      WHERE email = $1
        AND hit_at > clock_timestamp() - make_interval(secs => $2)`,
    [email, windowSeconds],
  );
  const row = rows[0]!;

  if (row.n >= max) {
    return { allowed: false, retryAfterSeconds: Math.max(1, row.retry_after ?? windowSeconds) };
  }
  await client.query('INSERT INTO rate_limit_hits (email) VALUES ($1)', [email]);
  return { allowed: true };
}
