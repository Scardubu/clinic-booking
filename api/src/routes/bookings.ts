import { Router } from 'express';
import { ApiError, validateCreateBooking } from '../validation.js';
import { config } from '../config.js';
import { hashPayload } from '../util/canonical.js';
import { evaluateSlidingWindow } from '../services/rateLimit.js';
import {
  cancelBooking,
  createBooking,
  getBookingById,
  getIdempotencyRecord,
  listBookingsPaginated,
} from '../services/bookings.js';

export const bookingsRouter = Router();

bookingsRouter.get('/', async (req, res, next) => {
  try {
    const patientEmail =
      (req.query.email as string) ||
      (req.query.patientEmail as string) ||
      (req.query.patient_email as string) ||
      undefined;
    const status = (req.query.status as string) || undefined;
    const limit = req.query.limit as string | undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
    const cursor = (req.query.cursor as string) || undefined;

    const result = await listBookingsPaginated({
      patientEmail,
      status,
      limit,
      page,
      offset,
      cursor,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

bookingsRouter.post('/', async (req, res, next) => {
  try {
    const idempotencyKey =
      (req.headers['idempotency-key'] as string) ||
      (req.headers['x-idempotency-key'] as string) ||
      undefined;

    // 1. If Idempotency-Key is provided, check if it was already recorded and completed
    if (idempotencyKey && idempotencyKey.trim()) {
      const cleanKey = idempotencyKey.trim();
      const existing = await getIdempotencyRecord(cleanKey, 'global');
      if (existing) {
        const currentHash = hashPayload(req.body);
        if (existing.request_hash !== currentHash) {
          return next(
            new ApiError(
              422,
              'IDEMPOTENCY_KEY_CONFLICT',
              'Idempotency-Key reused with a different body'
            )
          );
        }
        if (existing.status === 'COMPLETED' && existing.response_body) {
          res.setHeader('Idempotent-Replayed', 'true');
          return res.status(existing.response_status || 201).json(existing.response_body);
        }
      }
    }

    // 2. This is a NEW booking attempt (or non-replayed key).
    // Evaluate per-email rate limiting (failed attempts included)
    const rawEmail =
      req.body?.email ||
      req.body?.patientEmail ||
      req.body?.patient_email ||
      (req.body?.patient && req.body?.patient.email);
    let bucketKey: string;
    if (typeof rawEmail === 'string' && rawEmail.trim()) {
      bucketKey = `email:${rawEmail.trim().toLowerCase()}`;
    } else {
      const forwarded = req.headers['x-forwarded-for'];
      const ip =
        (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip) || 'unknown-ip';
      const customActor =
        (req.headers['x-client-id'] as string) ||
        (req.headers['x-rate-limit-key'] as string) ||
        ip;
      bucketKey = `actor:${customActor}`;
    }

    const rlStatus = evaluateSlidingWindow(bucketKey);
    res.setHeader('X-RateLimit-Limit', String(config.rateLimitMaxRequests));
    res.setHeader('X-RateLimit-Remaining', String(rlStatus.remaining));
    res.setHeader('X-RateLimit-Reset', String(rlStatus.resetAtEpochSeconds));

    if (!rlStatus.allowed) {
      res.setHeader('Retry-After', String(rlStatus.retryAfterSeconds));
      return next(
        new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Too many attempts for this email')
      );
    }

    // 3. Validate payload (Level 2)
    const input = validateCreateBooking(req.body);

    // 4. Create booking
    const result = await createBooking(input, idempotencyKey, 'global', req.body);
    if (result.replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
    }
    res.status(result.statusCode).json(result.body);
  } catch (err) {
    next(err);
  }
});

bookingsRouter.get('/:id', async (req, res, next) => {
  try {
    const booking = await getBookingById(req.params.id);
    res.status(200).json({
      booking,
      ...booking,
    });
  } catch (err) {
    next(err);
  }
});

async function handleCancelBooking(req: any, res: any, next: any) {
  try {
    const booking = await cancelBooking(req.params.id);
    res.status(200).json({
      booking,
      ...booking,
    });
  } catch (err) {
    next(err);
  }
}

bookingsRouter.delete('/:id', handleCancelBooking);
bookingsRouter.post('/:id/cancel', handleCancelBooking);
bookingsRouter.patch('/:id/cancel', handleCancelBooking);
bookingsRouter.patch('/:id', handleCancelBooking);