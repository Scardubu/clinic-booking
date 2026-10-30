import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'api/.env'),
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../.env'),
];

for (const p of envPaths) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p, override: true });
  }
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: process.env.DATABASE_URL || '',
  apiKey: process.env.API_KEY || 'dev-clinic-api-key-2026',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '5', 10),
};