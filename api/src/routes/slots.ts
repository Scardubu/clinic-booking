import type { FastifyInstance } from 'fastify';
import { listSlots, resetSlots } from '../services/slots.js';
import { parseSlots } from '../validation.js';

export async function registerSlotRoutes(app: FastifyInstance): Promise<void> {
  // Level 1 — replace all slots (and wipe all bookings). Larger body cap: it carries slots.
  app.post('/reset', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const parsed = parseSlots(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const count = await resetSlots(parsed.value);
    return { ok: true, slots: count };
  });

  // Level 1 — every slot, earliest first, optional exact-match provider filter.
  app.get('/slots', async (req, reply) => {
    const { provider } = req.query as { provider?: unknown };
    if (provider !== undefined && typeof provider !== 'string') {
      return reply.code(400).send({ error: 'provider must be a single value' });
    }
    return listSlots(provider);
  });
}
