import express, { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import cors from 'cors';
import { config } from './config.js';
import { withTransaction } from './db.js';
import { safeEqual } from './util/safeEqual.js';
import { ApiError } from './validation.js';
import { slotsRouter } from './routes/slots.js';
import { bookingsRouter } from './routes/bookings.js';
import { resetRateLimiterMemory } from './services/rateLimit.js';

export const app = express();

app.set('trust proxy', 1);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || config.corsOrigin === '*' || config.corsOrigin === '') {
        return callback(null, true);
      }
      const allowed = config.corsOrigin.split(',').map((o) => o.trim().replace(/\/$/, ''));
      const normalized = origin.replace(/\/$/, '');
      if (allowed.includes('*') || allowed.includes(normalized)) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'api-key',
      'Idempotency-Key',
      'X-Idempotency-Key',
      'X-Client-Id',
    ],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
      'Idempotent-Replayed',
    ],
  })
);

app.use(express.json({ limit: '64kb' }));

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🏥</text></svg>`;

app.get(['/favicon.ico', '/api/favicon.ico'], (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.status(200).send(FAVICON_SVG);
});

app.get(['/health', '/api/health'], (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'clinic-booking-api',
    timestamp: new Date().toISOString(),
  });
});

function apiKeyAuth(req: Request, _res: Response, next: NextFunction): void {
  const xApiKey = req.headers['x-api-key'] || req.headers['api-key'];
  const authHeader = req.headers['authorization'];

  const candidateKeys: string[] = [];
  if (typeof xApiKey === 'string') {
    candidateKeys.push(...xApiKey.split(',').map((k) => k.trim()));
  } else if (Array.isArray(xApiKey)) {
    for (const k of xApiKey) {
      candidateKeys.push(...String(k).split(',').map((s) => s.trim()));
    }
  }

  if (typeof authHeader === 'string' && authHeader.trim()) {
    const raw = authHeader.trim();
    let authKey = raw;
    if (raw.toLowerCase().startsWith('bearer ')) {
      authKey = raw.slice(7).trim();
    } else if (raw.toLowerCase().startsWith('apikey ')) {
      authKey = raw.slice(7).trim();
    }
    candidateKeys.push(...authKey.split(',').map((k) => k.trim()));
  }

  const validKey = candidateKeys.find((k) => k && safeEqual(k, config.apiKey));
  if (!validKey) {
    return next(new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid API key.'));
  }

  next();
}

app.post(['/reset', '/api/reset', '/v1/reset'], apiKeyAuth, async (req, res, next) => {
  try {
    const incomingSlots = req.body?.slots;
    await withTransaction(async (client) => {
      await client.query('DELETE FROM bookings');
      await client.query('DELETE FROM idempotency_keys');
      if (Array.isArray(incomingSlots)) {
        await client.query('DELETE FROM slots');
        for (const slot of incomingSlots) {
          const provider = slot.provider || slot.doctor_name || slot.doctorName || 'Dr Ade';
          const startParsed = new Date(slot.start || slot.startTime || slot.start_time);
          const endParsed = new Date(slot.end || slot.endTime || slot.end_time);
          if (isNaN(startParsed.getTime()) || isNaN(endParsed.getTime())) {
            throw new ApiError(400, 'INVALID_DATE', 'Invalid slot start or end date.');
          }
          await client.query(
            `INSERT INTO slots (id, provider, doctor_name, start_time, end_time, is_available)
             VALUES ($1, $2, $2, $3, $4, TRUE)`,
            [
              String(slot.id || crypto.randomUUID()),
              provider,
              startParsed.toISOString(),
              endParsed.toISOString(),
            ]
          );
        }
      } else {
        await client.query('DELETE FROM slots');
        await client.query(`
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
        `);
      }
    });
    resetRateLimiterMemory();
    res.status(200).json({
      status: 'ok',
      message: 'Done',
    });
  } catch (err) {
    next(err);
  }
});

app.use(['/slots', '/api/slots', '/v1/slots'], apiKeyAuth, slotsRouter);
app.use(['/bookings', '/api/bookings', '/v1/bookings'], apiKeyAuth, bookingsRouter);

app.use((_req, _res, next) => {
  next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found.'));
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.retryAfter) {
    res.setHeader('Retry-After', String(err.retryAfter));
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: 'Malformed JSON request body.',
      code: 'INVALID_JSON',
      message: 'Malformed JSON request body.',
    });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }

  console.error('[INTERNAL_ERROR]', err);
  res.status(500).json({
    error: 'An unexpected internal server error occurred.',
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected internal server error occurred.',
  });
});