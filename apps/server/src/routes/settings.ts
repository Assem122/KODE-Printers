import { Router } from 'express';
import { settingsUpdateSchema } from '@kode/shared';
import { getSettings, getSettingsFresh, updateSettings } from '../models/settings.js';
import {
  actorOf,
  authenticate,
  requireAdmin,
  requirePasswordChanged,
} from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/context.js';
import { body, validateBody } from '../middlewares/validate.js';
import { auditedMutation } from '../services/audit.js';

/**
 * Runtime settings.
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
