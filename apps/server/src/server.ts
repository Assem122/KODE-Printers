import type { Server } from 'node:http';
import { join } from 'node:path';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { converterVersions, runBootGuards } from './config/guards.js';
import { closePool, pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { usersModel } from './models/users.js';
import { startCollectorAgent, stopCollectorAgent } from './services/collector/agent.js';
import { events } from './services/events.js';
import { initialiseChannels } from './services/notify.js';
import { configureSetupState } from './services/setupState.js';
import { startWorker, stopWorker } from './services/pipeline/worker.js';
import { startCounterWatcher, stopCounterWatcher } from './services/watchers/pageCounter.js';
import { startRetentionSweep, stopRetentionSweep } from './services/watchers/retention.js';
import { startScanWatcher, stopScanWatcher } from './services/watchers/scanFolder.js';
import { startStatusWatcher, stopStatusWatcher } from './services/watchers/status.js';
import { SEEDED_DEFAULT_PASSWORD } from './services/auth/hash.js';
import { verifyPassword } from './services/auth/hash.js';
import { logger, serialiseError } from './utilities/logger.js';

/**
 * Process entry: boot sequence and graceful shutdown.
 *
 * The order below is deliberate — configuration is validated before the
 * database is touched, migrations run before anything reads a table, and the
 * guards run before a single byte is served. A silent start with a bad
 * configuration is worse than no start (§B3.3), and the only way to honour that
 * is to fail before the listener exists.
 */

let server: Server | null = null;
let shuttingDown = false;

async function boot(): Promise<void> {
  logger.info(
    {
      version: config.version,
      env: config.env,
      debug: config.debug,
      mode: config.collector.mode ? 'collector' : 'central',
    },
    'KODE Printer starting',
  );

  // 1. Configuration, before the database is touched. Every one of these is
  //    fixable without a running server, so refusing to start is the right
  //    response, and checking them first means a deployment with a placeholder
  //    secret says so instead of failing on a connection it was never going to
  //    make.
  await runBootGuards(join(process.cwd(), 'public'));

  // 2. Schema. Migrations are idempotent and hold an advisory lock, so a
  //    rolling restart cannot run them twice.
  await runMigrations();

  // 3. First-run state (GAP-01). Needs the database, and unlike the guards it
  //    cannot be resolved without the server, so it locks the API down rather
  //    than preventing the boot.
  const anyAccountUsesSeededPassword = async (): Promise<boolean> => {
    // Only accounts that have never changed their password can still hold the
    // seeded one: changing it clears the flag, and `assertPasswordAcceptable`
    // refuses the seeded value outright so it cannot be set back deliberately.
    // Scanning every account instead cost one argon2 verify each, roughly 100ms,
    // on every boot.
    const accounts = await usersModel.listUnchangedPasswordHashes(pool);
    for (const account of accounts) {
      if (await verifyPassword(account.hash, SEEDED_DEFAULT_PASSWORD)) return true;
    }
    return false;
  };

  configureSetupState(
    anyAccountUsesSeededPassword,
    config.debug ? false : await anyAccountUsesSeededPassword(),
  );

  // 3. Log resolved converter versions. §B10.6: the delivered build degraded
  //    silently when these were missing, which looks like success on a fresh
  //    host while every Office conversion is skipped.
  const versions = await converterVersions();
  logger.info(versions, 'converter binaries resolved');

  initialiseChannels();

  // 4. Background work. A collector runs the watchers for its own segment and
  //    nothing else — no queue, no user-facing surface (§B11.1).
  if (config.collector.mode) {
    await startCounterWatcher(null);
    await startScanWatcher(null);
    startStatusWatcher(null);
    // The uplink. One outbound HTTPS connection; nothing here listens.
    startCollectorAgent();
    logger.info({ name: config.collector.name }, 'running in collector mode');
  } else {
    startWorker();
    await startCounterWatcher(null);
    await startScanWatcher(null);
    startStatusWatcher(null);
    startRetentionSweep();
  }

  // 5. Listen. Loopback only in production — TLS terminates at the reverse
  //    proxy and the guards refuse any other binding (§B18.3).
  const app = createApp();
  server = app.listen(config.http.port, config.http.host, () => {
    logger.info(
      { host: config.http.host, port: config.http.port, url: config.http.publicUrl },
      'listening',
    );
  });

  // Slightly above the typical 60s proxy idle timeout, so the proxy closes
  // connections rather than racing us to it — which is what produces
  // intermittent 502s under load.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
}

/**
 * Graceful shutdown.
 *
 * The sequence matters: stop accepting new work, let in-flight jobs finish,
 * then close the pool. Killing the pool first would strand a job mid-send with
 * its ledger entry already written, which is the one state that produces a
 * phantom walk-up on the next poll.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 45_000);
  forceExit.unref();

  try {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      logger.info('HTTP listener closed');
    }

    events.closeAll();
    stopCounterWatcher();
    stopScanWatcher();
    stopStatusWatcher();
    stopRetentionSweep();
    stopCollectorAgent();

    await stopWorker();
    await closePool();

    clearTimeout(forceExit);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ ...serialiseError(error) }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * INV-11 covers rejected promises inside route handlers. These two handlers
 * cover everything else — a rejection in a watcher timer, or a throw inside a
 * native callback. Logging and exiting is correct: the process manager restarts
 * a crashed process, and a Node process in an unknown state after an unhandled
 * rejection should not keep serving.
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ ...serialiseError(reason) }, 'unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ ...serialiseError(error) }, 'uncaught exception');
  void shutdown('uncaughtException');
});

boot().catch((error: unknown) => {
  logger.fatal({ ...serialiseError(error) }, 'failed to start');
  process.exit(1);
});
