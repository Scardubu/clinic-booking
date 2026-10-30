import { Pool, PoolClient } from 'pg';
import dns from 'dns';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Force IPv4 first to prevent Windows/Node IPv6 timeout blackholes to AWS/Neon
dns.setDefaultResultOrder('ipv4first');

const INLINE_SCHEMA_FALLBACK = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS slots (
    id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    provider VARCHAR(255) NOT NULL DEFAULT 'Dr. Adaobi Okafor',
    doctor_name VARCHAR(255) NOT NULL DEFAULT 'Dr. Adaobi Okafor (General Practice)',
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_slot_time_range CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_slots_availability_start
    ON slots (is_available, start_time ASC, id ASC);

CREATE TABLE IF NOT EXISTS bookings (
    id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    slot_id VARCHAR(255) NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
    patient_name VARCHAR(120) NOT NULL,
    patient_email VARCHAR(255) NOT NULL,
    patient_phone VARCHAR(40),
    reason VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'confirmed'
        CHECK (LOWER(status) IN ('confirmed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_unique_confirmed_slot
    ON bookings (slot_id)
    WHERE LOWER(status) = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_bookings_email_created_id
    ON bookings (LOWER(patient_email), created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_bookings_created_id
    ON bookings (created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    client_scope VARCHAR(255) NOT NULL DEFAULT 'global',
    idempotency_key VARCHAR(255) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    booking_id VARCHAR(255) REFERENCES bookings(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS'
        CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    PRIMARY KEY (client_scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
    ON idempotency_keys (expires_at);

INSERT INTO slots (id, provider, doctor_name, start_time, end_time, is_available)
SELECT
    gen_random_uuid()::text,
    doctor,
    doctor,
    slot_start,
    slot_start + INTERVAL '30 minutes',
    TRUE
FROM (
    SELECT
        CASE
            WHEN gs % 3 = 0 THEN 'Dr. Adaobi Okafor (General Practice)'
            WHEN gs % 3 = 1 THEN 'Dr. Tunde Bakare (Internal Medicine)'
            ELSE 'Dr. Amina Yusuf (Family Medicine)'
        END AS doctor,
        DATE_TRUNC('hour', NOW() + INTERVAL '2 hours') + (gs * INTERVAL '1 hour') AS slot_start
    FROM generate_series(1, 24) AS gs
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM slots LIMIT 1);
`;

function buildPoolConfig(rawUrl: string) {
  if (!rawUrl || rawUrl.includes('ep-example')) {
    console.error(
      '\n[CRITICAL] DATABASE_URL in api/.env is missing or still set to the ep-example placeholder!'
    );
    console.error('Please set a real Neon or Supabase PostgreSQL URI in api/.env.\n');
  }

  const isLocal =
    rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1');

  let cleanConnectionString = rawUrl.trim();
  let sniHost: string | undefined;

  try {
    const parsed = new URL(cleanConnectionString);
    sniHost = parsed.hostname;
    // Remove query params that conflict with node-postgres explicit ssl object
    parsed.searchParams.delete('channel_binding');
    parsed.searchParams.delete('sslmode');
    cleanConnectionString = parsed.toString();
  } catch {
    // Fallback if URL is not parseable
  }

  const useSsl =
    process.env.NODE_ENV === 'production' ||
    (!isLocal &&
      (rawUrl.includes('sslmode=require') ||
        rawUrl.includes('neon.tech') ||
        rawUrl.includes('amazonaws.com') ||
        rawUrl.includes('supabase')));

  const ssl = useSsl
    ? {
        rejectUnauthorized: false,
        ...(sniHost ? { servername: sniHost } : {}),
      }
    : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false);

  return {
    connectionString: cleanConnectionString,
    ssl,
    max: 15,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 30000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
  };
}

export const pool = new Pool(buildPoolConfig(config.databaseUrl));

pool.on('error', (err) => {
  console.warn('[DB_POOL_IDLE_WARN]', err.message);
});

const originalPoolQuery = pool.query.bind(pool);
(pool as any).query = async function (queryTextOrConfig: any, values?: any, callback?: any) {
  if (typeof values === 'function') {
    return (originalPoolQuery as any)(queryTextOrConfig, values);
  }
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await (originalPoolQuery as any)(queryTextOrConfig, values);
    } catch (err: any) {
      lastErr = err;
      const isTransient =
        err?.code === 'ECONNRESET' ||
        err?.code === 'EPIPE' ||
        err?.code === 'ETIMEDOUT' ||
        err?.message?.includes('Connection terminated') ||
        err?.message?.includes('read ECONNRESET');
      if (isTransient && attempt < 3) {
        console.warn(
          `[DB] Transient connection drop on pool.query (${err.code || err.message}), retrying (${attempt + 1}/3)...`
        );
        await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  maxRetries = 2
): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err: any) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      throw err;
    }

    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      lastErr = err;
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors on dropped connections
      }
      const isTransient =
        err?.code === 'ECONNRESET' ||
        err?.code === 'EPIPE' ||
        err?.code === 'ETIMEDOUT' ||
        err?.message?.includes('Connection terminated') ||
        err?.message?.includes('read ECONNRESET');
      if (isTransient && attempt < maxRetries) {
        console.warn(
          `[DB] Transient connection drop in withTransaction (${err.code || err.message}), retrying (${attempt + 1}/${maxRetries})...`
        );
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
  throw lastErr;
}

const SCHEMA_PRECHECK_SQL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'slots' AND column_name = 'id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_slot_id_fkey1;
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_slot_id_fkey;
    ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_booking_id_fkey;
    ALTER TABLE slots ALTER COLUMN id TYPE VARCHAR(255);
    ALTER TABLE bookings ALTER COLUMN id TYPE VARCHAR(255);
    ALTER TABLE bookings ALTER COLUMN slot_id TYPE VARCHAR(255);
    ALTER TABLE idempotency_keys ALTER COLUMN booking_id TYPE VARCHAR(255);
    ALTER TABLE bookings ADD CONSTRAINT bookings_slot_id_fkey FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE RESTRICT;
    ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'slots' AND column_name = 'provider'
  ) THEN
    ALTER TABLE slots ADD COLUMN provider VARCHAR(255);
    UPDATE slots SET provider = doctor_name WHERE provider IS NULL;
  END IF;
END $$;
`;

export async function initDb(maxRetries = 4): Promise<void> {
  const candidatePaths = [
    path.resolve(__dirname, '../sql/schema.sql'),
    path.resolve(process.cwd(), 'sql/schema.sql'),
    path.resolve(process.cwd(), 'api/sql/schema.sql'),
    path.resolve(__dirname, '../../sql/schema.sql'),
  ];

  let sql = '';
  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        sql = fs.readFileSync(candidate, 'utf8');
        break;
      }
    } catch {
      // Continue to next candidate
    }
  }

  if (!sql) {
    console.warn('[DB] Could not locate sql/schema.sql on disk. Falling back to inline schema.');
    sql = INLINE_SCHEMA_FALLBACK;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[DB] Connecting to PostgreSQL (attempt ${attempt}/${maxRetries})...`);
      await pool.query(SCHEMA_PRECHECK_SQL);
      await pool.query(sql);
      return;
    } catch (err: any) {
      console.warn(`[DB] Attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) {
        throw err;
      }
      const delayMs = attempt * 2500;
      console.log(`[DB] Waiting ${delayMs}ms for database compute to wake up...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}