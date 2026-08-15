import { Router } from 'express';
import { z } from 'zod';
import { auditQuerySchema, idSchema, notificationQuerySchema } from '@kode/shared';
import { pool } from '../db/pool.js';
import { auditModel } from '../models/audit.js';
import { notificationsModel } from '../models/notifications.js';
import {
  actorOf,
  authenticate,
  requireAdmin,
  requirePasswordChanged,
} from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/context.js';
import { params, query, validateParams, validateQuery } from '../middlewares/validate.js';

/**
 * Notifications (ADR-011) and the audit explorer (ADR-012).
 *
 * Notifications are readable by any signed-in user, because job-done and
 * scan-ready messages are addressed to individuals — the model scopes admins to
 * operational alerts plus their own, and everyone else to their own only.
 *
 * The audit log is admin-only and read-only. There is no write route here at
 * all: audit rows are written inside the transaction of the change they record
 * (INV-07), never through an API.
 */
export const notificationsRouter = Router();
export const auditRouter = Router();

const idParams = z.object({ id: idSchema });

notificationsRouter.use(authenticate, requirePasswordChanged);

notificationsRouter.get(
  '/',
  validateQuery(notificationQuerySchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const filter = query(req, notificationQuerySchema);
    res.json(
      await notificationsModel.list(pool, {
        ...filter,
        userId: actor.id,
        isAdmin: actor.role === 'admin',
      }),
    );
  }),
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    res.json({
      count: await notificationsModel.countUnread(pool, actor.id, actor.role === 'admin'),
    });
  }),
);

notificationsRouter.post(
  '/:id/read',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);
    // Per-user read state (§B4.8): one admin marking an alert read must not
    // hide it from another, which is what the in-memory FIFO used to do.
    await notificationsModel.markRead(pool, id, actor.id);
    res.status(204).end();
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const count = await notificationsModel.markAllRead(pool, actor.id, actor.role === 'admin');
    res.json({ marked: count });
  }),
);

/* ------------------------------------------------------------------ audit  */

auditRouter.use(authenticate, requirePasswordChanged, requireAdmin);

auditRouter.get(
  '/',
  validateQuery(auditQuerySchema),
  asyncHandler(async (req, res) => {
    res.json(await auditModel.list(pool, query(req, auditQuerySchema)));
  }),
);

/** Distinct actions, for the explorer's filter chips. */
auditRouter.get(
  '/actions',
  asyncHandler(async (_req, res) => {
    res.json(await auditModel.listActions(pool));
  }),
);
