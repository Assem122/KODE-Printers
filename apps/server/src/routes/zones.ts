import { Router } from 'express';
import { z } from 'zod';
import { errors, idSchema, zoneCreateSchema, zoneUpdateSchema } from '@kode/shared';
import { pool } from '../db/pool.js';
import { zonesModel } from '../models/zones.js';
import { authenticate, requireAdmin, requirePasswordChanged } from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/context.js';
import {
  body,
  params,
  query,
  validateBody,
  validateParams,
  validateQuery,
} from '../middlewares/validate.js';
import { auditedMutation } from '../services/audit.js';

/**
 * Zones — one row per area (§B4.2, GAP-14).
 *
 * Without this a report cannot be broken out by area and an admin cannot
 * answer "which printer is near me", which is the question people actually ask
 * across a club with reception, a pool area and outlying areas.
 *
 * There is no `floor` anywhere in this model. Every KODE building is
 * single-storey, so the column would be a guaranteed NULL. `printers.area`
 * holds what people actually say: "Reception", "Back office", "Pro shop".
 */
export const zonesRouter = Router();

const idParams = z.object({ id: idSchema });
const listQuery = z.object({ includeInactive: z.coerce.boolean().default(false) });

zonesRouter.get(
  '/',
  authenticate,
  requirePasswordChanged,
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    // Readable by any signed-in user: the zone list drives the printer picker's
    // grouping, and knowing the club has a pool area is not privileged.
    const { includeInactive } = query(req, listQuery);
    res.json(await zonesModel.list(pool, includeInactive));
  }),
);

zonesRouter.post(
  '/',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateBody(zoneCreateSchema),
  asyncHandler(async (req, res) => {
    const input = body(req, zoneCreateSchema);
    const zone = await auditedMutation(
      async (tx) =>
        zonesModel.insert(tx, {
          code: input.code,
          label: input.label,
          isActive: input.isActive,
        }),
      { req, action: 'zone.create', entityType: 'zone', entityId: (created) => created.id },
    );
    res.status(201).json(zone);
  }),
);

zonesRouter.put(
  '/:id',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateParams(idParams),
  validateBody(zoneUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const before = await zonesModel.find(pool, id);
    if (!before) throw errors.notFound('Zone', id);

    const updated = await auditedMutation(
      async (tx) => zonesModel.update(tx, id, body(req, zoneUpdateSchema)),
      { req, action: 'zone.update', entityType: 'zone', entityId: id, before },
    );
    res.json(updated);
  }),
);
