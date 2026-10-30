import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from './config.js';
import { safeEqual } from './util/safeEqual.js';
import { ApiError } from './validation.js';
import { slotsRouter } from './routes/slots.js';
import { bookingsRouter } from './routes/bookings.js';

export const app = express();

app.set('trust proxy', 1);
app.use(
  cors({
    origin: config.corsOrigin,
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

  let providedKey = '';
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    providedKey = xApiKey.trim();
  } else if (typeof authHeader === 'string' && authHeader.trim()) {
    const raw = authHeader.trim();
    if (raw.toLowerCase().startsWith('bearer ')) {
      providedKey = raw.slice(7).trim();
    } else if (raw.toLowerCase().startsWith('apikey ')) {
      providedKey = raw.slice(7).trim();
    } else {
      providedKey = raw;
    }
  }

  if (!providedKey || !safeEqual(providedKey, config.apiKey)) {
    return next(new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid API key.'));
  }

  next();
}

app.use(['/slots', '/api/slots', '/v1/slots'], apiKeyAuth, slotsRouter);
app.use(['/bookings', '/api/bookings', '/v1/bookings'], apiKeyAuth, bookingsRouter);

app.use((_req, _res, next) => {
  next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found.'));
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Malformed JSON request body.' },
      code: 'INVALID_JSON',
      message: 'Malformed JSON request body.',
    });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }

  console.error('[INTERNAL_ERROR]', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal server error occurred.',
    },
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected internal server error occurred.',
  });
});