import { Router } from 'express';
import { register, collectDefaultMetrics, Gauge } from 'prom-client';
import { isPrivateIpv4, type HealthCheck, type ReadinessReport } from '@kode/shared';
import { config } from '../config/index.js';
import { checkDatabase, pool } from '../db/pool.js';
import { converterVersions } from '../config/guards.js';
import { jobsModel } from '../models/jobs.js';
import { asyncHandler } from '../middlewares/context.js';
import { events } from '../services/events.js';
import { workerStatus } from '../services/pipeline/worker.js';

/**
 * Health, readiness and metrics (§B13.2, §B13.3).
 *
 * The two health endpoints answer genuinely different questions, and conflating
 * them is a common way to build an outage:
 *
 *   `/health`       — "is this process alive?" Used by the process manager to
 *                     decide whether to restart. It must not touch the database,
 *                     or a brief DB blip triggers a restart loop that makes
 *                     everything worse.
 *
 *   `/health/ready` — "can this process do its job?" Used by monitoring and by
 *                     the go-live checklist. It checks everything, and a failure
 *                     means "page someone", not "restart".
 */
export const healthRouter = Router();

const startedAt = Date.now();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', version: config.version, uptimeSeconds: uptime() });
});

healthRouter.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    const checks: HealthCheck[] = [];

    const dbStart = Date.now();
    const db = await checkDatabase();
    checks.push({
      name: 'database',
      status: db.ok ? 'pass' : 'fail',
      durationMs: Date.now() - dbStart,
      ...(db.detail ? { detail: db.detail } : {}),
    });

    // §B10.6 — converters absent is a `warn`, not a `fail`, at *runtime*: the
    // pipeline degrades gracefully mid-flight. It is a hard boot failure in
    // production, which is where the distinction belongs.
    const versions = await converterVersions();
    checks.push({
      name: 'libreoffice',
      status: versions['libreoffice'] ? 'pass' : 'warn',
      detail: versions['libreoffice'] ?? 'not found — Office documents cannot be converted',
    });
    checks.push({
      name: 'ghostscript',
      status: versions['ghostscript'] ? 'pass' : 'warn',
      detail: versions['ghostscript'] ?? 'not found — greyscale conversion is unavailable',
    });

    const storage = await checkStorageWritable();
    checks.push(storage);

    const worker = workerStatus();
    checks.push({
      name: 'queue-worker',
      status: !config.queue.enabled ? 'warn' : worker.running ? 'pass' : 'fail',
      detail: !config.queue.enabled
        ? 'disabled by configuration'
        : `${worker.active} job(s) in flight`,
    });

    if (db.ok) {
      const queue = await jobsModel.queueStats(pool);
      checks.push({
        name: 'queue-depth',
        // §B13.4 alerts on `kode_queue_oldest_seconds > 900`; the same threshold
        // is used here so the dashboard and the alert never disagree.
        status: queue.oldestSeconds > 900 ? 'fail' : queue.depth > 50 ? 'warn' : 'pass',
        detail: `${queue.depth} queued, oldest ${queue.oldestSeconds}s`,
      });
    }

    const status: ReadinessReport['status'] = checks.some((c) => c.status === 'fail')
      ? 'fail'
      : checks.some((c) => c.status === 'warn')
        ? 'warn'
        : 'pass';

    const report: ReadinessReport = {
      status,
      version: config.version,
      uptimeSeconds: uptime(),
      checks,
    };

    res.status(status === 'fail' ? 503 : 200).json(report);
  }),
);

/* ---------------------------------------------------------------- metrics  */

if (config.observability.metricsEnabled) {
  collectDefaultMetrics({ register, prefix: 'kode_' });

  new Gauge({
    name: 'kode_queue_depth',
    help: 'Jobs waiting or in flight',
    async collect() {
      const stats = await jobsModel.queueStats(pool).catch(() => ({ depth: 0, oldestSeconds: 0 }));
      this.set(stats.depth);
    },
  });

  new Gauge({
    name: 'kode_queue_oldest_seconds',
    help: 'Age of the oldest unfinished job',
    async collect() {
      const stats = await jobsModel.queueStats(pool).catch(() => ({ depth: 0, oldestSeconds: 0 }));
      this.set(stats.oldestSeconds);
    },
  });

  new Gauge({
    name: 'kode_printers_up',
    help: 'Printers currently reachable',
    async collect() {
      const { rows } = await pool
        .query<{ up: number }>(
          "SELECT count(*)::int AS up FROM printers WHERE is_active AND status = 'online'",
        )
        .catch(() => ({ rows: [{ up: 0 }] }));
      this.set(rows[0]?.up ?? 0);
    },
  });

  new Gauge({
    name: 'kode_sse_subscribers',
    help: 'Connected live-update clients',
    collect() {
      this.set(events.subscriberCount);
    },
  });
}

/**
 * §B13.2 keeps this off the public internet. Enforced at the route rather than
 * the listener, so it stays closed if someone ever fronts the app differently.
 *
 * What "off the public internet" means depends on the topology, and testing
 * only for loopback got it wrong in a container: there the proxy is a separate
 * service, so every request arrives from the internal network and the metrics
 * endpoint 403'd the very scrape it exists for. Isolation comes from the port
 * not being published, so a private source address is the right test there.
 */
healthRouter.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    if (!config.observability.metricsEnabled) {
      res.status(404).end();
      return;
    }

    // Deliberately the socket's own address, never a forwarded header: an
    // X-Forwarded-For a caller controls would make this gate self-service.
    const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const isLoopback = remote === '127.0.0.1' || remote === '::1';
    const permitted =
      config.http.topology === 'container' ? isLoopback || isPrivateIpv4(remote) : isLoopback;

    if (config.isProduction && !permitted) {
      res.status(403).end();
      return;
    }

    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  }),
);

async function checkStorageWritable(): Promise<HealthCheck> {
  const { access, mkdir } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  try {
    await mkdir(config.storage.uploadDir, { recursive: true });
    await access(config.storage.uploadDir, constants.W_OK);
    return { name: 'upload-directory', status: 'pass', detail: config.storage.uploadDir };
  } catch (error) {
    return {
      name: 'upload-directory',
      status: 'fail',
      detail: error instanceof Error ? error.message : 'not writable',
    };
  }
}

function uptime(): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}
