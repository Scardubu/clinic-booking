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

startServer();