function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export const config = {
  port: int('PORT', 3000),
  host: '0.0.0.0',
  apiKey: required('API_KEY'),
  databaseUrl: required('DATABASE_URL'),
  dbPoolMax: int('DB_POOL_MAX', 10),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Level 5: at most `max` attempts per email in any rolling `windowSeconds`. */
  rateLimit: { max: 5, windowSeconds: 60 },
} as const;
