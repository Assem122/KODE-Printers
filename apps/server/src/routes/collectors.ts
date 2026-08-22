import { Router } from 'express';
import { z } from 'zod';
import {
  collectorCreateSchema,
  collectorEventsSchema,
  collectorHeartbeatSchema,
  errors,
  idSchema,
} from '@kode/shared';
import { pool, withTransaction } from '../db/pool.js';
import { collectorsModel } from '../models/collectors.js';
import { printersModel } from '../models/printers.js';
import {
  authenticate,
  authenticateCollector,
  requireAdmin,
  requirePasswordChanged,
} from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/context.js';
import { collectorLimiter } from '../middlewares/rateLimit.js';
import { body, params, validateBody, validateParams } from '../middlewares/validate.js';
import { auditedMutation } from '../services/audit.js';
import { generateApiKey } from '../services/auth/hash.js';
import {
  ingestCounterReading,
  publishAttribution,
  type AttributionOutcome,
} from '../services/walkup.js';
import { subsystem } from '../utilities/logger.js';

const log = subsystem('route:collectors');

/**
 * Site collectors (§B11, ADR-007).
 *
 * On a flat network zero of these are deployed and nothing about the system
 * changes. On a segmented one, a collector replaces three inbound firewall
 * exceptions per building — TCP 631, TCP 9100, UDP 161, plus inbound SMB — with
 * one outbound HTTPS connection. **No inbound connection to a collector is ever
 * required**, which is the entire point.
 */
export const collectorsRouter = Router();
export const collectorAgentRouter = Router();

const idParams = z.object({ id: idSchema });

/* --------------------------------------------------------- admin surface   */

collectorsRouter.use(authenticate, requirePasswordChanged, requireAdmin);

collectorsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await collectorsModel.list(pool));
  }),
);

collectorsRouter.post(
  '/',
  validateBody(collectorCreateSchema),
  asyncHandler(async (req, res) => {
    const input = body(req, collectorCreateSchema);
    const { key, hash, prefix } = generateApiKey();

    const collector = await auditedMutation(
      async (tx) =>
        collectorsModel.insert(tx, {
          name: input.name,
          zoneId: input.zoneId,
          apiKeyHash: hash,
          apiKeyPrefix: prefix,
        }),
      {
        req,
        action: 'collector.create',
        entityType: 'collector',
        entityId: (created) => created.id,
        // The key itself never reaches the audit payload. INV-08.
        after: (created) => ({ id: created.id, name: created.name, keyPrefix: prefix }),
      },
    );

    // Shown exactly once, at creation (§B4.3). There is no route that can
    // retrieve it again, because only its hash is stored.
    res.status(201).json({
      collector,
      apiKey: key,
      warning: 'Copy this key now. It cannot be shown again.',
    });
  }),
);

collectorsRouter.post(
  '/:id/revoke',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const before = await collectorsModel.find(pool, id);
    if (!before) throw errors.notFound('Collector', id);

    await auditedMutation(async (tx) => collectorsModel.revoke(tx, id), {
      req,
      action: 'collector.revoke',
      entityType: 'collector',
      entityId: id,
      before,
    });

    res.status(204).end();
  }),
);

/* --------------------------------------------------------- agent surface   */

collectorAgentRouter.use(authenticateCollector, collectorLimiter);

collectorAgentRouter.post(
  '/heartbeat',
  validateBody(collectorHeartbeatSchema),
  asyncHandler(async (req, res) => {
    const collectorId = req.collectorId;
    if (collectorId === undefined) throw errors.unauthenticated();

    const input = body(req, collectorHeartbeatSchema);
    await collectorsModel.recordHeartbeat(pool, collectorId, input.version);

    // The collector owns reachability for its own segment — the central server
    // cannot reach those devices, which is why the collector exists.
    for (const printer of input.printers) {
      await printersModel.setStatus(pool, printer.printerId, printer.status, printer.stateReasons, {
        resetFailures: printer.reachable,
        incrementFailures: !printer.reachable,
      });
    }

    res.json({ ok: true, serverTime: new Date().toISOString() });
  }),
);

/**
 * Event batches from a collector.
 *
 * §B11.4: every event carries a collector-generated idempotency key, so a
 * replay after a dropped uplink cannot double-log. Without it a ten-minute
 * network blip would turn into a fabricated spike in the audit record the
 * moment the link returned — precisely the failure this system exists to
 * prevent.
 */
collectorAgentRouter.post(
  '/events',
  validateBody(collectorEventsSchema),
  asyncHandler(async (req, res) => {
    const collectorId = req.collectorId;
    if (collectorId === undefined) throw errors.unauthenticated();

    const { events: batch } = body(req, collectorEventsSchema);
    let accepted = 0;
    let duplicates = 0;
    let attributed = 0;
    const published: AttributionOutcome[] = [];

    for (const event of batch) {
      /* The key claim and the work it guards share one transaction.
       *
       * Claiming first and attributing after left a hole: a failure between the
       * two lost the delta permanently, because the collector's replay would
       * then be rejected as a duplicate. Committing them together means a
       * replay either finds the work done or finds no key. */
      const outcome = await withTransaction(async (tx) => {
        const isNew = await collectorsModel.claimEventKey(tx, collectorId, event.idempotencyKey);
        if (!isNew) return null;

        if (event.kind !== 'counter') {
          // Scan events arrive as metadata; the file itself stays on the
          // collector's local share, which is where the person who scanned it
          // is standing.
          return { result: 'scan' as const };
        }

        return ingestCounterReading(tx, {
          printerId: event.printerId,
          observedAt: event.observedAt,
          life: event.lifeCount,
          print: event.printCount ?? null,
          copy: event.copyCount ?? null,
        });
      });

      if (outcome === null) {
        duplicates += 1;
        continue;
      }

      accepted += 1;
      if ('outcome' in outcome && outcome.outcome) {
        attributed += 1;
        published.push(outcome.outcome);
      }
    }

    // Published after every transaction has committed, so no subscriber is told
    // about a job a rollback removed.
    for (const outcome of published) publishAttribution(outcome);

    log.debug({ collectorId, accepted, duplicates, attributed }, 'collector events ingested');
    res.json({ accepted, duplicates });
  }),
);

/**
 * The collector's printer roster.
 *
 * §B11.1 says a collector "runs no database and holds no durable state beyond a
 * small local spool", so it cannot store its own printer list — it fetches one
 * from here and keeps it in memory.
 *
 * This response carries SNMP credentials, which no other route does. That is
 * unavoidable and bounded: a collector is the only thing that can reach the
 * devices in its segment, it cannot poll them without their community string,
 * and it receives only the printers assigned to it, over a connection it opened
 * itself with a key that can be revoked from the admin UI.
 */
collectorAgentRouter.get(
  '/printers',
  asyncHandler(async (req, res) => {
    const collectorId = req.collectorId;
    if (collectorId === undefined) throw errors.unauthenticated();

    const printers = await printersModel.listByCollector(pool, collectorId);

    // Not cacheable at any hop. A proxy holding a copy of this response is
    // holding every SNMP credential for a building.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ printers });
  }),
);

/**
 * Work waiting for this collector.
 *
 * Deliberately empty, and typed rather than removed.
 *
 * The relay this endpoint anticipates does not exist: nothing in the collector
 * agent has ever called it, and no route hands a prepared document downward.
 * While it returned real job ids it described a capability the system does not
 * have, and the queue meanwhile dequeued those same jobs centrally and fired
 * them at an address it cannot reach. Submission now refuses them with a reason
 * (see `checkSubmission`), so nothing is queued for a collector to claim.
 *
 * Kept as the seam the relay will use, so the agent's contract does not change
 * when it lands.
 */
collectorAgentRouter.get('/work', (req, res, next) => {
  if (req.collectorId === undefined) {
    next(errors.unauthenticated());
    return;
  }

  res.json({
    jobIds: [],
    printingSupported: false,
    detail: 'Printing through a collector is not implemented; this collector observes only.',
  });
});
