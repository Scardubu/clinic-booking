import { app } from './app.js';
import { config } from './config.js';
import { initDb } from './db.js';

async function startServer() {
  try {
    await initDb();
    console.log('[DB] PostgreSQL schema verified and default clinic slots seeded.');
  } catch (err) {
    console.error('[DB] Database initialization error:', err);
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[SERVER] Clinic Booking API running on http://0.0.0.0:${config.port}`);
  });
}

process.on('uncaughtException', (err: any) => {
  const isTransient =
    err?.code === 'ECONNRESET' ||
    err?.code === 'EPIPE' ||
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'ECONNREFUSED' ||
    err?.message?.includes('read ECONNRESET') ||
    err?.message?.includes('Connection terminated') ||
    err?.message?.includes('socket hang up') ||
    err?.message?.includes('terminating connection') ||
    err?.message?.includes('server closed the connection') ||
    err?.message?.includes('client has already been released');
  if (isTransient) {
    console.warn('[SERVER_TRANSIENT_WARN] Caught transient socket error:', err.message);
    return;
  }
  console.error('[SERVER_UNCAUGHT_EXCEPTION]', err);
});

process.on('unhandledRejection', (reason: any) => {
  console.warn('[SERVER_UNHANDLED_REJECTION]', reason);
});

startServer();