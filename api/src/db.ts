import { readFileSync } from 'node:fs';
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  // Serverless Postgres (Neon) suspends idle compute and drops connections.
  // Retire idle clients quickly and keep TCP alive so we don't hold dead sockets.
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

// An error on an *idle* pooled client is emitted on the pool. Unhandled, it
// crashes the process. Log it; the pool discards the client and reconnects.
pool.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'idle pg client error', err: err.message }));
});

/**
 * Run `fn` inside one transaction on ONE connection. Everything that must be
 * atomic (idempotency lookup, rate-limit accounting, booking insert, response
 * recording) shares this client; never open a second pool connection inside
 * `fn` or a burst of same-key requests can exhaust the pool and deadlock.
 */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // connection is unusable; make the pool drop it
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/**
 * Transaction-scoped advisory lock keyed by an arbitrary string. Released
 * automatically at COMMIT/ROLLBACK, which also makes it safe behind PgBouncer
 * transaction pooling (Neon's pooled endpoint) where session-level locks are not.
 */
export async function advisoryXactLock(client: pg.PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

const SCHEMA_SQL = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');

export async function migrate(): Promise<void> {
  await withTx(async (client) => {
    await advisoryXactLock(client, 'migrate'); // two instances booting at once
    await client.query(SCHEMA_SQL);
  });
}
