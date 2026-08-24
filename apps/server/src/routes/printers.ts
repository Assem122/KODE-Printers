import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  AppError,
  DEFAULT_PRINT_OPTIONS,
  errors,
  idSchema,
  printerCreateSchema,
  printerQuerySchema,
  printerUpdateSchema,
  printOptionsFromFormSchema,
} from '@kode/shared';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { printersModel } from '../models/printers.js';
import { getSettings } from '../models/settings.js';
import {
  actorOf,
  authenticate,
  requireAdmin,
  requirePasswordChanged,
} from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/context.js';
import { storedFilenameFor, uploadDocument } from '../middlewares/upload.js';
import { uploadLimiter } from '../middlewares/rateLimit.js';
import {
  body,
  params,
  query,
  validateBody,
  validateParams,
  validateQuery,
} from '../middlewares/validate.js';
import { auditedMutation } from '../services/audit.js';
import { events } from '../services/events.js';
import { publishJob, submitJob } from '../services/pipeline/queue.js';
import { assertCanUsePrinter, permittedPrinterIds } from '../services/printerAccess.js';
import { probeAndPersist } from '../services/transport/select.js';
import { subsystem } from '../utilities/logger.js';

const log = subsystem('route:printers');
export const printersRouter = Router();

const idParams = z.object({ id: idSchema });

/* ------------------------------------------------------------------- read  */

printersRouter.get(
  '/',
  authenticate,
  requirePasswordChanged,
  validateQuery(printerQuerySchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const filter = query(req, printerQuerySchema);
    // INV-01 — the permitted set comes from printerAccess and nowhere else.
    // `null` means admin, i.e. no filter.
    const permitted = await permittedPrinterIds(actor);

    const page = await printersModel.list(pool, {
      ...filter,
      ...(permitted === null ? {} : { permittedIds: permitted }),
      // Only an admin has any use for a disabled printer in a list.
      includeInactive: actor.role === 'admin' && filter.includeInactive,
    });
    res.json(page);
  }),
);

printersRouter.get(
  '/:id',
  authenticate,
  requirePasswordChanged,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);
    await assertCanUsePrinter(actor, id);

    const printer = await printersModel.find(pool, id);
    if (!printer) throw errors.notFound('Printer', id);
    res.json(printer);
  }),
);

/**
 * The QR sheet for a printer.
 *
 * Printed once and taped to the device. Scanning it opens the print composer
 * with that printer already selected — which removes the step people actually
 * get wrong, picking the right device out of a list of fifty while standing in
 * front of the one they want.
 */
printersRouter.get(
  '/:id/qr',
  authenticate,
  requirePasswordChanged,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);
    await assertCanUsePrinter(actor, id);

    const printer = await printersModel.find(pool, id);
    if (!printer) throw errors.notFound('Printer', id);

    const target = `${config.http.publicUrl}/print?printer=${printer.id}`;
    const svg = await QRCode.toString(target, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      // Brand blue on white. A QR code must stay high-contrast to scan
      // reliably under fluorescent office light, so the palette stops here.
      color: { dark: '#2150A0', light: '#FFFFFF' },
    });

    res.type('image/svg+xml').set('Cache-Control', 'private, max-age=3600').send(svg);
  }),
);

/* ------------------------------------------------------------------ write  */

printersRouter.post(
  '/',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateBody(printerCreateSchema),
  asyncHandler(async (req, res) => {
    const input = body(req, printerCreateSchema);

    const printer = await auditedMutation(
      async (tx) =>
        printersModel.insert(tx, {
          name: input.name,
          ipAddress: input.ipAddress,
          zoneId: input.zoneId ?? null,
          area: input.area ?? null,
          hostname: input.hostname ?? null,
          transport: input.transport,
          ippUri: input.ippUri ?? null,
          snmpVersion: input.snmpVersion,
          snmpCommunity: input.snmpCommunity ?? null,
          snmpUsername: input.snmpUsername ?? null,
          snmpAuthKey: input.snmpAuthKey ?? null,
          snmpPrivKey: input.snmpPrivKey ?? null,
          snmpPageOid: input.snmpPageOid,
          snmpPrintOid: input.snmpPrintOid ?? null,
          snmpCopyOid: input.snmpCopyOid ?? null,
          scanFolder: input.scanFolder ?? null,
          maxJobImpressions: input.maxJobImpressions ?? null,
        }),
      {
        req,
        action: 'printer.create',
        entityType: 'printer',
        entityId: (created) => created.id,
      },
    );

    // §B7.2 — "add by IP only" is preserved; everything else is discovered
    // rather than typed. The probe runs out of band so a sleeping device does
    // not make the create request hang.
    if (input.probeNow) {
      /* Detached, and the catch is on the whole thing rather than on the probe
       * alone. `process.on('unhandledRejection')` shuts this server down, so a
       * database blip in either of the two reads either side of the probe would
       * take the API with it — a background nicety killing the process that
       * just answered 201. */
      void (async () => {
        const withSecrets = await printersModel.findWithSecrets(pool, printer.id);
        if (!withSecrets) return;
        await probeAndPersist(pool, withSecrets);
        const refreshed = await printersModel.find(pool, printer.id);
        if (refreshed) events.printerUpdated(refreshed);
      })().catch((error: unknown) => {
        log.warn({ printerId: printer.id, err: String(error) }, 'initial probe failed');
      });
    }

    res.status(201).json(printer);
  }),
);

printersRouter.put(
  '/:id',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateParams(idParams),
  validateBody(printerUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const patch = body(req, printerUpdateSchema);

    const before = await printersModel.find(pool, id);
    if (!before) throw errors.notFound('Printer', id);

    const updated = await auditedMutation(async (tx) => printersModel.update(tx, id, patch), {
      req,
      action: 'printer.update',
      entityType: 'printer',
      entityId: id,
      before,
    });

    if (updated) events.printerUpdated(updated);
    res.json(updated);
  }),
);

/**
 * INV-05 — a printer with job history is never hard-deleted.
 *
 * The database enforces it with ON DELETE RESTRICT. This route checks first
 * only so the refusal arrives as a clear message rather than as a constraint
 * violation, and it deliberately does not offer a force flag.
 */
printersRouter.delete(
  '/:id',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);

    const printer = await printersModel.find(pool, id);
    if (!printer) throw errors.notFound('Printer', id);

    const jobCount = await printersModel.countJobs(pool, id);
    if (jobCount > 0) {
      throw new AppError(
        'PRINTER_HAS_HISTORY',
        `${printer.name} has ${jobCount} job${jobCount === 1 ? '' : 's'} in its history and ` +
          'cannot be deleted. Disable it instead — the records stay readable and it ' +
          'disappears from every printer picker.',
        { details: { printerId: id, jobCount } },
      );
    }

    await auditedMutation(async (tx) => printersModel.remove(tx, id), {
      req,
      action: 'printer.delete',
      entityType: 'printer',
      entityId: id,
      before: printer,
      after: null,
    });

    res.status(204).end();
  }),
);

/** Soft-disable. The safe alternative to deletion, and the one the UI offers. */
printersRouter.put(
  '/:id/active',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateParams(idParams),
  validateBody(z.object({ isActive: z.boolean() })),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const { isActive } = body(req, z.object({ isActive: z.boolean() }));

    const before = await printersModel.find(pool, id);
    if (!before) throw errors.notFound('Printer', id);

    const updated = await auditedMutation(
      async (tx) => printersModel.update(tx, id, { isActive }),
      { req, action: 'printer.deactivate', entityType: 'printer', entityId: id, before },
    );

    if (updated) events.printerUpdated(updated);
    res.json(updated);
  }),
);

/**
 * Maintenance mode: finish what is queued, accept nothing new.
 *
 * Distinct from disabling, and the distinction matters operationally. Disabling
 * removes a printer from every picker and reads as permanent; draining is what
 * you want at 9am when the engineer is arriving at 10 and there are jobs
 * already queued.
 */
printersRouter.put(
  '/:id/drain',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateParams(idParams),
  validateBody(z.object({ isDraining: z.boolean() })),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const { isDraining } = body(req, z.object({ isDraining: z.boolean() }));

    const before = await printersModel.find(pool, id);
    if (!before) throw errors.notFound('Printer', id);

    const updated = await auditedMutation(
      async (tx) => printersModel.update(tx, id, { isDraining }),
      { req, action: 'printer.drain', entityType: 'printer', entityId: id, before },
    );

    if (updated) events.printerUpdated(updated);
    res.json(updated);
  }),
);

printersRouter.post(
  '/:id/probe',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const printer = await printersModel.findWithSecrets(pool, id);
    if (!printer) throw errors.notFound('Printer', id);

    await probeAndPersist(pool, printer);
    const refreshed = await printersModel.find(pool, id);
    if (refreshed) events.printerUpdated(refreshed);
    res.json(refreshed);
  }),
);

/* ------------------------------------------------------------------ print  */

const printResponseSchema = z.object({
  confirmLargeJob: z.coerce.boolean().optional().default(false),
});

/**
 * Submit a job. Returns 202 — the work happens out of band (ADR-004).
 *
 * The frontend follows the outcome over SSE rather than polling, which is how
 * the cost the ADR names ("a real frontend change") is paid.
 */
printersRouter.post(
  '/:id/print-file',
  authenticate,
  requirePasswordChanged,
  uploadLimiter,
  validateParams(idParams),
  uploadDocument,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);

    await assertCanUsePrinter(actor, id);

    const file = req.file;
    if (!file) throw errors.validation('Attach a file to print.');

    const printer = await printersModel.findWithSecrets(pool, id);
    if (!printer) throw errors.notFound('Printer', id);

    const optionsResult = printOptionsFromFormSchema.safeParse(
      (req.body as Record<string, unknown>)['options'],
    );
    if (!optionsResult.success) throw optionsResult.error;

    const confirmResult = printResponseSchema.safeParse(req.body);
    const confirmLargeJob = confirmResult.success ? confirmResult.data.confirmLargeJob : false;

    const printerRecord = await printersModel.find(pool, id);

    const { job, impressions } = await submitJob({
      actor: { id: actor.id, username: actor.username, department: actor.department },
      printer,
      printerName: printerRecord?.name ?? printer.name,
      content: file.buffer,
      originalFilename: file.originalname,
      options: { ...DEFAULT_PRINT_OPTIONS, ...optionsResult.data },
      confirmLargeJob,
      requestId: req.requestId,
      // Runs after the magic-byte check and the safety gate, and before the job
      // row exists, so the row is never dequeueable without a file behind it.
      async persist() {
        await mkdir(config.storage.uploadDir, { recursive: true });
        const storedPath = join(config.storage.uploadDir, storedFilenameFor(file.originalname));
        await writeFile(storedPath, file.buffer, { mode: 0o600 });
        return {
          path: storedPath,
          discard: () => rm(storedPath, { force: true }),
        };
      },
    });

    publishJob(job);

    res.status(202).json({
      jobId: job.id,
      status: job.status,
      impressions,
      message:
        job.status === 'held'
          ? 'Held. Release it from your phone when you are at the printer.'
          : 'Queued. You will be notified when it reaches the printer.',
    });
  }),
);

/* ------------------------------------------------------------- diagnostics */

printersRouter.post(
  '/:id/check-status',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const printer = await printersModel.findWithSecrets(pool, id);
    if (!printer) throw errors.notFound('Printer', id);

    const settings = await getSettings();
    const { probePort, RAW_PORT } = await import('../services/transport/raw9100.js');
    const { IPP_PORT } = await import('../services/transport/ipp.js');

    const [ipp, raw] = await Promise.all([
      probePort(printer.ipAddress, IPP_PORT, 2500),
      probePort(printer.ipAddress, RAW_PORT, 2500),
    ]);

    res.json({
      printerId: id,
      ipp,
      raw9100: raw,
      snmpConfigured: printer.snmpVersion !== 'disabled',
      // §B8.5 — this must be visible. A printer nobody can track looks exactly
      // like a printer nobody uses.
      walkupTrackingAvailable: printer.snmpVersion !== 'disabled',
      maxJobImpressions: printer.maxJobImpressions ?? settings.maxJobImpressions,
    });
  }),
);
