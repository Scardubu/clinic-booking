import { Pool, PoolClient } from 'pg';
import dns from 'dns';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

// 1. Force IPv4 first to prevent Windows/Node IPv6 timeout blackholes to AWS/Neon
dns.setDefaultResultOrder('ipv4first');

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

  return {
    connectionString: cleanConnectionString,
    ssl: isLocal
      ? false
      : {
          rejectUnauthorized: false,
          ...(sniHost ? { servername: sniHost } : {}),
        },
    max: 10,
    idleTimeoutMillis: 30000,
    // 30-second timeout so Neon serverless cold-starts have plenty of time to wake up
    connectionTimeoutMillis: 30000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  };
}

export const pool = new Pool(buildPoolConfig(config.databaseUrl));

pool.on('error', (err) => {
  console.error('[DB_POOL_IDLE_ERROR]', err.message);
});

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors on dropped connections
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function initDb(maxRetries = 4): Promise<void> {
  const candidatePaths = [
    path.resolve(process.cwd(), 'sql/schema.sql'),
    path.resolve(process.cwd(), 'api/sql/schema.sql'),
  ];
  const schemaPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!schemaPath) {
    throw new Error('Could not locate sql/schema.sql');
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[DB] Connecting to PostgreSQL (attempt ${attempt}/${maxRetries})...`);
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