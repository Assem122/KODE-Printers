import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import {
  errors,
  idSchema,
  scanClaimSchema,
  scanQuerySchema,
  scanReservationSchema,
} from '@kode/shared';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { printersModel } from '../models/printers.js';
import { scansModel } from '../models/scans.js';
import { getSettings } from '../models/settings.js';
import { usersModel } from '../models/users.js';
import {
  actorOf,
  authenticate,
  requireAdmin,
  requirePasswordChanged,
} from '../middlewares/auth.js';
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
import {
  assertCanAccessScan,
  assertCanUsePrinter,
  permittedPrinterIds,
} from '../services/printerAccess.js';

/**
 * The scan hub.
 *
 * §B9 specifies detection — the watcher observes a folder and logs arrivals.
 * These routes are what turn that into something staff open: an inbox where a
 * scan is previewed, claimed and downloaded.
 */
export const scansRouter = Router();

const idParams = z.object({ id: idSchema });

scansRouter.use(authenticate, requirePasswordChanged);

scansRouter.get(
  '/',
  validateQuery(scanQuerySchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const filter = query(req, scanQuerySchema);
    const permitted = await permittedPrinterIds(actor);

    res.json(
      await scansModel.list(pool, {
        ...filter,
        ...(permitted === null ? {} : { permittedPrinterIds: permitted, ownUserId: actor.id }),
        ...(filter.mine ? { ownUserId: actor.id } : {}),
      }),
    );
  }),
);

/**
 * Streams the scan file.
 *
 * `inline` rather than `attachment`, so the PWA can render a preview in place —
 * walking back to your desk to open a download is exactly the friction the scan
 * hub exists to remove. The CSP header is the price: a PDF served inline from
 * our own origin must not be able to pull anything else in.
 */
scansRouter.get(
  '/:id/file',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);

    const scan = await scansModel.find(pool, id);
    if (!scan) throw errors.notFound('Scan', id);
    await assertCanAccessScan(actor, scan);

    const path = join(config.storage.scanDir, scan.storedFilename);
    // §B16.4 — the stored name is generated, but confining the resolved path is
    // what makes that a guarantee rather than an assumption.
    if (!resolve(path).startsWith(resolve(config.storage.scanDir))) {
      throw errors.notFound('Scan', id);
    }

    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      throw errors.notFound('Scan file', id);
    }

    res.setHeader('Content-Type', scan.contentType);
    res.setHeader('Content-Length', String(info.size));
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(scan.originalFilename)}`,
    );
    res.setHeader('Content-Security-Policy', "default-src 'none'; object-src 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');

    createReadStream(path).pipe(res);
  }),
);

scansRouter.post(
  '/:id/claim',
  validateParams(idParams),
  validateBody(scanClaimSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);
    const input = body(req, scanClaimSchema);

    const scan = await scansModel.find(pool, id);
    if (!scan) throw errors.notFound('Scan', id);
    await assertCanAccessScan(actor, scan);

    // Only an admin may file a scan into someone else's inbox — a member's
    // scanned ID landing with the wrong person is the failure this prevents.
    if (input.userId !== undefined && input.userId !== actor.id && actor.role !== 'admin') {
      throw errors.forbidden('You can only claim a scan for yourself.');
    }

    const ownerId = input.userId ?? actor.id;
    const owner = ownerId === actor.id ? actor : await usersModel.find(pool, ownerId);
    if (!owner) throw errors.notFound('User', ownerId);

    const claimed = await auditedMutation(
      async (tx) => scansModel.claim(tx, id, ownerId, owner.username, 'manual'),
      { req, action: 'scan.claim', entityType: 'scan', entityId: id, before: scan },
    );

    if (!claimed) throw errors.validation('That scan has already been claimed.');
    res.json(claimed);
  }),
);

/**
 * Scan-to-me.
 *
 * The user says "the next scan from this device is mine", walks over, and
 * scans. The watcher matches the arrival to the reservation and files it
 * directly into their inbox — which is as close to identity-aware scanning as
 * scan-to-folder can get without per-user device configuration.
 *
 * One live reservation per printer, enforced by a partial unique index. A
 * second person is refused rather than guessed at, because a folder drop
 * carries no identity and a wrong guess misfiles someone's document.
 */
scansRouter.post(
  '/reserve',
  validateBody(scanReservationSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { printerId } = body(req, scanReservationSchema);

    await assertCanUsePrinter(actor, printerId);

    const printer = await printersModel.find(pool, printerId);
    if (!printer) throw errors.notFound('Printer', printerId);
    if (!printer.scanFolder) {
      throw errors.validation(
        `${printer.name} is not set up for scan tracking, so scans from it cannot be claimed automatically.`,
      );
    }

    const settings = await getSettings();
    const created = await scansModel.createReservation(
      pool,
      printerId,
      actor.id,
      settings.scanReservationMinutes,
    );

    if (!created) {
      const existing = await scansModel.activeReservation(pool, printerId);
      throw errors.validation(
        existing?.userId === actor.id
          ? 'You already have a scan reservation open on this printer.'
          : 'Someone else is already waiting for a scan from this printer. Try again shortly.',
      );
    }

    res.status(201).json({
      printerId,
      printerName: printer.name,
      expiresInMinutes: settings.scanReservationMinutes,
      message: `Scan at ${printer.name} within ${settings.scanReservationMinutes} minutes and it will appear in your inbox.`,
    });
  }),
);

/**
 * Who currently holds the reservation on a printer, if anyone.
 *
 * The parameter is a printer id, not a reservation id, and it was named `id`
 * while every other `:id` in this file addresses the resource itself. That is
 * how the missing permission check went unnoticed: without it any signed-in
 * user could enumerate printers and learn who was standing at each one.
 */
const printerIdParams = z.object({ printerId: idSchema });

scansRouter.get(
  '/reservation/:printerId',
  validateParams(printerIdParams),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { printerId } = params(req, printerIdParams);
    await assertCanUsePrinter(actor, printerId);
    res.json(await scansModel.activeReservation(pool, printerId));
  }),
);

scansRouter.post(
  '/:id/archive',
  requireAdmin,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const scan = await scansModel.find(pool, id);
    if (!scan) throw errors.notFound('Scan', id);

    await auditedMutation(async (tx) => scansModel.archive(tx, id), {
      req,
      action: 'scan.delete',
      entityType: 'scan',
      entityId: id,
      before: scan,
    });

    res.status(204).end();
  }),
);
