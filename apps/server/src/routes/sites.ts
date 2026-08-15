import { Router } from 'express';
import { z } from 'zod';
import { errors, idSchema, siteCreateSchema, siteUpdateSchema } from '@kode/shared';
import { pool } from '../db/pool.js';
import { sitesModel } from '../models/sites.js';
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
 * Sites — one row per building or facility (§B4.2, GAP-14).
 *
 * Without this a report cannot be broken out by building and an admin cannot
 * answer "which printer is near me", which is the question people actually ask
 * across a club with a main office, a clubhouse and outlying areas.
 *
 * There is no `floor` anywhere in this model. Every KODE building is
 * single-storey, so the column would be a guaranteed NULL. `printers.area`
 * holds what people actually say: "Reception", "Back office", "Pro shop".
 */
export const sitesRouter = Router();

const idParams = z.object({ id: idSchema });
const listQuery = z.object({ includeInactive: z.coerce.boolean().default(false) });

sitesRouter.get(
  '/',
  authenticate,
  requirePasswordChanged,
  validateQuery(listQuery),
  asyncHandler(async (req, res) => {
    // Readable by any signed-in user: the site list drives the printer picker's
    // grouping, and knowing the club has a clubhouse is not privileged.
    const { includeInactive } = query(req, listQuery);
    res.json(await sitesModel.list(pool, includeInactive));
  }),
);

sitesRouter.post(
  '/',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateBody(siteCreateSchema),
  asyncHandler(async (req, res) => {
    const input = body(req, siteCreateSchema);
    const site = await auditedMutation(
      async (tx) =>
        sitesModel.insert(tx, {
          code: input.code,
          name: input.name,
          address: input.address ?? null,
          isActive: input.isActive,
        }),
      { req, action: 'site.create', entityType: 'site', entityId: (created) => created.id },
    );
    res.status(201).json(site);
  }),
);

sitesRouter.put(
  '/:id',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateParams(idParams),
  validateBody(siteUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const before = await sitesModel.find(pool, id);
    if (!before) throw errors.notFound('Site', id);

    const updated = await auditedMutation(
      async (tx) => sitesModel.update(tx, id, body(req, siteUpdateSchema)),
      { req, action: 'site.update', entityType: 'site', entityId: id, before },
    );
    res.json(updated);
  }),
);
