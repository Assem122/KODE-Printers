import { Router } from 'express';
import { z } from 'zod';
import {
  errors,
  idSchema,
  quotaCreateSchema,
  quotaUpdateSchema,
  settingsUpdateSchema,
} from '@kode/shared';
import { pool } from '../db/pool.js';
import { quotasModel } from '../models/quotas.js';
import { getSettings, getSettingsFresh, updateSettings } from '../models/settings.js';
import {
  actorOf,
  authenticate,
  requireAdmin,
  requirePasswordChanged,
} from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/context.js';
import { body, params, validateBody, validateParams } from '../middlewares/validate.js';
import { auditedMutation } from '../services/audit.js';

/**
 * Runtime settings and quotas.
 *
 * These are settings rather than environment variables because an operations
 * manager should be able to change what colour costs, or how long scans are
 * kept, without an engineer and a restart. Anything that changes how the
 * *process starts* stays in the environment.
 *
 * Every change writes an audit row with before and after — configuration
 * changes are named explicitly in §B4.9's list of actions that MUST be audited.
 */
export const settingsRouter = Router();
export const quotasRouter = Router();

const idParams = z.object({ id: idSchema });

settingsRouter.use(authenticate, requirePasswordChanged);

/**
 * Readable by any signed-in user, and deliberately so: the client needs the
 * large-job warning threshold and the currency to render the print composer
 * correctly. None of these values are secrets.
 */
settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await getSettings());
  }),
);

settingsRouter.put(
  '/',
  requireAdmin,
  validateBody(settingsUpdateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const patch = body(req, settingsUpdateSchema);
    const before = await getSettings();

    const updated = await auditedMutation(async (tx) => updateSettings(tx, patch, actor.id), {
      req,
      action: 'settings.update',
      entityType: 'settings',
      entityId: 'app',
      before,
    });

    // The read path caches for two seconds; a save must not be followed by a
    // reload showing the old value.
    await getSettingsFresh();
    res.json(updated);
  }),
);

/* ----------------------------------------------------------------- quotas  */

quotasRouter.use(authenticate, requirePasswordChanged, requireAdmin);

quotasRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    // Usage is computed per quota so the admin sees consumption against each
    // limit — DEC-05's "reporting first, so the club can see consumption before
    // deciding to restrict it" only works if the consumption is visible.
    res.json(await quotasModel.list(pool, true));
  }),
);

quotasRouter.post(
  '/',
  validateBody(quotaCreateSchema),
  asyncHandler(async (req, res) => {
    const input = body(req, quotaCreateSchema);
    const quota = await auditedMutation(async (tx) => quotasModel.insert(tx, input), {
      req,
      action: 'quota.create',
      entityType: 'quota',
      entityId: (created) => created.id,
    });
    res.status(201).json(quota);
  }),
);

quotasRouter.put(
  '/:id',
  validateParams(idParams),
  validateBody(quotaUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const patch = body(req, quotaUpdateSchema);

    const before = await quotasModel.find(pool, id);
    if (!before) throw errors.notFound('Quota', id);

    const updated = await auditedMutation(
      async (tx) =>
        quotasModel.update(tx, id, {
          ...(patch.pageLimit === undefined ? {} : { pageLimit: patch.pageLimit }),
          ...(patch.enforce === undefined ? {} : { enforce: patch.enforce }),
        }),
      { req, action: 'quota.update', entityType: 'quota', entityId: id, before },
    );

    res.json(updated);
  }),
);

quotasRouter.delete(
  '/:id',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const before = await quotasModel.find(pool, id);
    if (!before) throw errors.notFound('Quota', id);

    await auditedMutation(async (tx) => quotasModel.remove(tx, id), {
      req,
      action: 'quota.delete',
      entityType: 'quota',
      entityId: id,
      before,
      after: null,
    });

    res.status(204).end();
  }),
);
