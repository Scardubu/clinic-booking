import { Router } from 'express';
import { validateCreateBooking } from '../validation.js';
import {
  cancelBooking,
  createBooking,
  getBookingById,
  listBookingsPaginated,
} from '../services/bookings.js';
import { bookingRateLimitMiddleware } from '../services/rateLimit.js';

export const bookingsRouter = Router();

bookingsRouter.get('/', async (req, res, next) => {
  try {
    const patientEmail =
      (req.query.patientEmail as string) ||
      (req.query.patient_email as string) ||
      (req.query.email as string) ||
      undefined;
    const status = (req.query.status as string) || undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 10;
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

bookingsRouter.post('/', bookingRateLimitMiddleware, async (req, res, next) => {
  try {
    const input = validateCreateBooking(req.body);
    const idempotencyKey =
      (req.headers['idempotency-key'] as string) ||
      (req.headers['x-idempotency-key'] as string) ||
      undefined;

    const result = await createBooking(input, idempotencyKey, 'global');
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