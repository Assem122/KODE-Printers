import { Router } from 'express';
import { z } from 'zod';
import {
  computeCost,
  errors,
  idSchema,
  jobExportSchema,
  jobQuerySchema,
  manualJobSchema,
} from '@kode/shared';
import { pool } from '../db/pool.js';
import { jobsModel } from '../models/jobs.js';
import { printersModel } from '../models/printers.js';
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
import { events } from '../services/events.js';
import { assertCanViewJob, permittedPrinterIds } from '../services/printerAccess.js';
import { csvRow } from '../utilities/csv.js';

export const jobsRouter = Router();

const idParams = z.object({ id: idSchema });

/**
 * Applies the permission scope to a job query.
 *
 * INV-01 in practice: an admin sees everything, a user sees their own jobs plus
 * walk-up activity on printers they may use. The scope is computed here once
 * and handed to the model, rather than each route re-deriving it.
 */
async function scopeFor(actor: ReturnType<typeof actorOf>): Promise<{
  permittedPrinterIds?: number[];
  ownUserId?: number;
}> {
  if (actor.role === 'admin') return {};
  const permitted = await permittedPrinterIds(actor);
  return { permittedPrinterIds: permitted ?? [], ownUserId: actor.id };
}

jobsRouter.get(
  '/',
  authenticate,
  requirePasswordChanged,
  validateQuery(jobQuerySchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const filter = query(req, jobQuerySchema);
    const page = await jobsModel.list(pool, { ...filter, ...(await scopeFor(actor)) });
    res.json(page);
  }),
);

/**
 * CSV export (§B5.4).
 *
 * Streamed, never buffered, and bounded to 366 days by the schema. The bound is
 * not politeness — an unbounded export of the full jobs table is both a slow
 * query and a memory-exhaustion vector, and it is exactly the request someone
 * makes on their first day with the reporting screen.
 */
jobsRouter.get(
  '/export',
  authenticate,
  requirePasswordChanged,
  validateQuery(jobExportSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const filter = query(req, jobExportSchema);
    const settings = await getSettings();
    const scope = await scopeFor(actor);

    const filename = `kode-printer-jobs-${filter.from}-to-${filter.to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Excel opens UTF-8 CSV as Windows-1252 without a BOM, which mangles any
    // Arabic or accented document name in the export.
    res.write('\uFEFF');

    res.write(
      csvRow([
        'Job ID',
        'Created (UTC)',
        'Completed (UTC)',
        'Source',
        'Type',
        'Status',
        'User',
        'Printer',
        'Document',
        'Pages',
        'Copies',
        'Impressions',
        'Colour',
        'Duplex',
        'Transport',
        'Estimated page count',
        `Cost (${settings.currency})`,
        'Notes',
      ]),
    );

    for await (const batch of jobsModel.stream(pool, { ...filter, ...scope })) {
      for (const job of batch) {
        const impressions = job.impressions ?? job.pages * job.copies;
        const isColor = job.colorMode === 'color';
        res.write(
          csvRow([
            job.id,
            job.createdAt,
            job.completedAt ?? '',
            job.source,
            job.jobType,
            job.status,
            job.usernameSnapshot,
            job.printerNameSnapshot,
            job.documentName ?? '',
            job.pages,
            job.copies,
            impressions,
            job.colorMode ?? '',
            job.duplex === null ? '' : job.duplex ? 'yes' : 'no',
            job.transportUsed ?? '',
            job.pageCountEstimated ? 'yes' : 'no',
            computeCost({
              monoImpressions: isColor ? 0 : impressions,
              colorImpressions: isColor ? impressions : 0,
              costPerPageMono: settings.costPerPageMono,
              costPerPageColor: settings.costPerPageColor,
            }),
            job.notes ?? '',
          ]),
        );
      }
    }

    // DEC-06 and §B8.5 — the coverage note travels with the data. A number
    // exported without its caveat is a number that will be quoted without it.
    res.write('\n');
    res.write(
      csvRow([
        `Note: rows with type "unknown" are ${settings.walkupReportLabel.toLowerCase()} detected at the device.`,
      ]),
    );
    res.write(
      csvRow([
        'Where a printer has no vendor print counter, prints and photocopies cannot be told apart.',
      ]),
    );
    res.end();
  }),
);

jobsRouter.get(
  '/:id',
  authenticate,
  requirePasswordChanged,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);

    const job = await jobsModel.find(pool, id);
    if (!job) throw errors.notFound('Job', id);
    await assertCanViewJob(actor, job);

    res.json(job);
  }),
);

/** Hold-and-release: the user is at the device and wants their job now. */
jobsRouter.post(
  '/:id/release',
  authenticate,
  requirePasswordChanged,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);

    const job = await jobsModel.find(pool, id);
    if (!job) throw errors.notFound('Job', id);
    await assertCanViewJob(actor, job);

    if (job.status !== 'held') {
      throw errors.validation('That job is not being held.', { status: job.status });
    }

    const released = await auditedMutation(async (tx) => jobsModel.release(tx, id), {
      req,
      action: 'job.release',
      entityType: 'job',
      entityId: id,
      before: job,
    });

    if (released) events.jobUpdated(released);
    res.json(released);
  }),
);

jobsRouter.post(
  '/:id/retry',
  authenticate,
  requirePasswordChanged,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);

    const job = await jobsModel.find(pool, id);
    if (!job) throw errors.notFound('Job', id);
    await assertCanViewJob(actor, job);

    if (job.status !== 'failed') {
      throw errors.validation('Only a failed job can be retried.', { status: job.status });
    }

    const retried = await auditedMutation(async (tx) => jobsModel.retry(tx, id), {
      req,
      action: 'job.retry',
      entityType: 'job',
      entityId: id,
      before: job,
    });

    if (retried) events.jobUpdated(retried);
    res.json(retried);
  }),
);

jobsRouter.post(
  '/:id/cancel',
  authenticate,
  requirePasswordChanged,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);

    const job = await jobsModel.find(pool, id);
    if (!job) throw errors.notFound('Job', id);
    await assertCanViewJob(actor, job);

    // A job already sent cannot be recalled — the bytes are at the device.
    // Saying so plainly beats a cancel button that silently does nothing.
    if (job.status !== 'queued' && job.status !== 'held') {
      throw errors.validation(
        job.status === 'sent' || job.status === 'completed'
          ? 'This job has already reached the printer and cannot be cancelled here.'
          : 'This job can no longer be cancelled.',
        { status: job.status },
      );
    }

    const cancelled = await auditedMutation(
      async (tx) => jobsModel.cancel(tx, id, `Cancelled by ${actor.username}`),
      { req, action: 'job.cancel', entityType: 'job', entityId: id, before: job },
    );

    if (cancelled) events.jobUpdated(cancelled);
    res.json(cancelled);
  }),
);

/**
 * Manual entry, admin only.
 *
 * For activity the system could not observe — a printer with SNMP disabled, or
 * a period when the scan share was unreachable. It exists so the gaps §B8.5
 * describes can be closed deliberately and visibly rather than left as holes.
 */
jobsRouter.post(
  '/',
  authenticate,
  requirePasswordChanged,
  requireAdmin,
  validateBody(manualJobSchema),
  asyncHandler(async (req, res) => {
    const input = body(req, manualJobSchema);

    const printer = await printersModel.find(pool, input.printerId);
    if (!printer) throw errors.notFound('Printer', input.printerId);

    const owner =
      input.userId === undefined || input.userId === null
        ? await usersModel.getSystemUser(pool)
        : await usersModel.find(pool, input.userId);
    if (!owner) throw errors.notFound('User', input.userId ?? undefined);

    const job = await auditedMutation(
      async (tx) =>
        jobsModel.insert(tx, {
          printerId: printer.id,
          siteId: printer.siteId,
          userId: 'id' in owner ? owner.id : null,
          usernameSnapshot: owner.username,
          printerNameSnapshot: printer.name,
          source: 'manual',
          jobType: input.jobType,
          status: 'completed',
          pages: input.pages,
          copies: input.copies,
          impressions: input.pages * input.copies,
          colorMode: null,
          duplex: null,
          documentName: input.documentName ?? null,
          filePath: null,
          fileHash: null,
          printOptions: {},
          maxAttempts: 1,
          notes: `Manual entry: ${input.notes}`,
          requestId: req.requestId,
        }),
      // Not `job.retry`: the whole point of this route is that a human inserted
      // a number the system could not observe, and the audit row is the evidence
      // of that. Filed as a retry it is indistinguishable from an automated one.
      { req, action: 'job.manual_entry', entityType: 'job', entityId: (created) => created.id },
    );

    events.jobUpdated(job);
    res.status(201).json(job);
  }),
);
