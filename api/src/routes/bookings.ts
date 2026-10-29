import type { FastifyInstance } from 'fastify';
import { sendOutcome } from '../app.js';
import { cancelBooking, createBooking, getBooking, listBookings } from '../services/bookings.js';
import { purgeStale } from '../services/slots.js';
import { normalizeEmail } from '../validation.js';

const MAX_KEY_LENGTH = 255;

export async function registerBookingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/bookings', async (req, reply) => {
    // Level 4 — optional Idempotency-Key. An empty header is treated as absent.
    const header = req.headers['idempotency-key'];
    let idempotencyKey: string | null = null;
    if (typeof header === 'string' && header.trim() !== '') {
      if (header.trim().length > MAX_KEY_LENGTH) {
        return reply.code(400).send({ error: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters` });
      }
      idempotencyKey = header.trim();
    }

    const outcome = await createBooking(req.body, idempotencyKey);

    // ~2% of attempts also trim expired limiter/idempotency rows. Request-driven (not a
    // timer) so an idle service makes no queries and a scale-to-zero DB can sleep.
    if (Math.random() < 0.02) {
      purgeStale().catch((err) => req.log.warn({ err }, 'stale-row purge failed'));
    }
    return sendOutcome(reply, outcome);
  });

  // Level 4 — a person's bookings, oldest first, cursor-paginated.
  app.get('/bookings', async (req, reply) => {
    const q = req.query as Record<string, unknown>;

    if (typeof q.email !== 'string' || q.email.trim() === '') {
      return reply.code(400).send({ error: 'email query parameter is required' });
    }

    let limit = 10;
    if (q.limit !== undefined) {
      // Strict: digits only, so "1.5", "-1", "1e1", "", "abc" and repeated params all 400.
      if (typeof q.limit !== 'string' || !/^[0-9]{1,3}$/.test(q.limit)) {
        return reply.code(400).send({ error: 'limit must be an integer between 1 and 50' });
      }
      limit = Number(q.limit);
      if (limit < 1 || limit > 50) {
        return reply.code(400).send({ error: 'limit must be an integer between 1 and 50' });
      }
    }

    if (q.cursor !== undefined && typeof q.cursor !== 'string') {
      return reply.code(400).send({ error: 'cursor must be a single value' });
    }
    const cursor = typeof q.cursor === 'string' && q.cursor !== '' ? q.cursor : null;

    return sendOutcome(reply, await listBookings(normalizeEmail(q.email), limit, cursor));
  });

  app.get('/bookings/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return sendOutcome(reply, await getBooking(id));
  });

  // Level 3 — cancel.
  app.delete('/bookings/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return sendOutcome(reply, await cancelBooking(id));
  });
}
