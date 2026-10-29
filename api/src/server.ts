import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';

const app = await buildApp();

try {
  await migrate();
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}

// Render sends SIGTERM on every deploy/restart. Stop accepting connections, let
// in-flight requests (and their open transactions) finish, release the pool, exit.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const hardStop = setTimeout(() => process.exit(1), 10_000);
  hardStop.unref();
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => app.log.error({ reason }, 'unhandled rejection'));
