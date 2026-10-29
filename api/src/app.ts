import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { config } from './config.js';
import { pool } from './db.js';
import { safeEqual } from './util/safeEqual.js';
import { registerBookingRoutes } from './routes/bookings.js';
import { registerSlotRoutes } from './routes/slots.js';
import type { Outcome } from './services/bookings.js';

/** Single place that turns a service Outcome into an HTTP response. */
export function sendOutcome(reply: FastifyReply, o: Outcome): FastifyReply {
  if (o.headers) reply.headers(o.headers);
  if (o.replayed) reply.header('Idempotent-Replayed', 'true');
  return reply.code(o.status).send(o.body);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        // Path only. Query strings carry patient emails (GET /bookings?email=) and
        // must not land in log storage. Headers (X-API-Key) are never logged.
        req: (req: FastifyRequest) => ({ method: req.method, path: req.url.split('?')[0], ip: req.ip }),
      },
    },
    // Booking payloads are tiny. A small global cap blunts oversized-body abuse;
    // /reset raises it for itself.
    bodyLimit: 16 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
    requestIdHeader: 'x-request-id',
    trustProxy: true, // Render terminates TLS in front of us; req.ip is the real client
  });

  // Fastify's built-in JSON parser answers 400 to an EMPTY body when Content-Type is
  // application/json — which many HTTP clients send on DELETE/GET. Replace it with one
  // that treats an empty body as "no body" and reports bad JSON in our error shape.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 }));
    }
  });

  // Level 2 — API key on EVERY request (the spec says every request). Runs in onRequest,
  // i.e. before body parsing, so unauthenticated callers cannot make us buffer payloads.
  // Health probes and CORS preflights are the only exemptions.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const path = req.url.split('?')[0]!.replace(/\/+$/, '');
    if (path === '/health' || path === '/ready') return;
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !safeEqual(key, config.apiKey)) {
      return reply.code(401).send({ error: 'missing or invalid API key' });
    }
  });

  // Every error — ours, Fastify's, the body parser's — leaves as {"error": "..."}.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'internal server error' });
    }
    const message =
      status === 413 ? 'request body too large' : status === 415 ? 'content-type must be application/json' : err.message;
    return reply.code(status).send({ error: message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));

  // Liveness never touches the database: an uptime pinger hitting it must not keep a
  // scale-to-zero Postgres compute awake. Readiness does.
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ error: 'database unavailable' });
    }
  });

  await app.register(registerSlotRoutes);
  await app.register(registerBookingRoutes);
  return app;
}
