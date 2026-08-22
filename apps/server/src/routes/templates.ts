import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import {
  DEFAULT_PRINT_OPTIONS,
  errors,
  idSchema,
  printOptionsSchema,
  templateCreateSchema,
} from '@kode/shared';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { printersModel } from '../models/printers.js';
import { templatesModel } from '../models/templates.js';
import {
  actorOf,
  authenticate,
  requireAdmin,
  requirePasswordChanged,
} from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/context.js';
import { uploadLimiter } from '../middlewares/rateLimit.js';
import { storedFilenameFor, uploadDocument } from '../middlewares/upload.js';
import { body, params, validateBody, validateParams } from '../middlewares/validate.js';
import { auditedMutation } from '../services/audit.js';
import { publishJob, submitJob } from '../services/pipeline/queue.js';
import { countPdfPages, verifyMagicBytes } from '../services/pipeline/prepare.js';
import { assertCanUsePrinter } from '../services/printerAccess.js';

/**
 * Quick-print templates.
 *
 * The club prints the same handful of documents constantly — membership forms,
 * day passes, court booking sheets. An admin uploads each once with its correct
 * settings and staff print it in one tap, which also makes "which version is
 * current" a question with exactly one answer.
 */
export const templatesRouter = Router();

const idParams = z.object({ id: idSchema });

/**
 * Drops keys whose value is `undefined`.
 *
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined", and a zod `.partial()` produces the latter. Spreading that over
 * a defaults object would overwrite a real default with `undefined` — so a
 * template that specifies only `copies` would silently blank the colour mode.
 */
type Compacted<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

function compact<T extends object>(value: T): Compacted<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Compacted<T>;
}

templatesRouter.use(authenticate, requirePasswordChanged);

templatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    res.json(await templatesModel.list(pool, actor.role === 'admin'));
  }),
);

templatesRouter.post(
  '/',
  requireAdmin,
  uploadLimiter,
  uploadDocument,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const file = req.file;
    if (!file) throw errors.validation('Attach the document to save as a template.');

    // INV-09 applies here too: a template is printed repeatedly, so an unchecked
    // one is a bad file that reaches a converter many times rather than once.
    const verdict = verifyMagicBytes(file.buffer, file.originalname);
    if (!verdict.ok) {
      throw errors.validation(verdict.reason ?? 'That file type cannot be used as a template.');
    }

    const metaResult = templateCreateSchema.safeParse({
      name: (req.body as Record<string, unknown>)['name'],
      description: (req.body as Record<string, unknown>)['description'],
      zoneId: (req.body as Record<string, unknown>)['zoneId'],
      defaultOptions: JSON.parse(
        typeof (req.body as Record<string, unknown>)['defaultOptions'] === 'string'
          ? ((req.body as Record<string, string>)['defaultOptions'] ?? '{}')
          : '{}',
      ) as unknown,
    });
    if (!metaResult.success) throw metaResult.error;
    const meta = metaResult.data;

    await mkdir(config.storage.templateDir, { recursive: true });
    const storedFilename = storedFilenameFor(file.originalname);
    await writeFile(join(config.storage.templateDir, storedFilename), file.buffer, { mode: 0o600 });

    const pageCount = file.originalname.toLowerCase().endsWith('.pdf')
      ? (await countPdfPages(file.buffer)).pages
      : null;

    const template = await auditedMutation(
      async (tx) =>
        templatesModel.insert(tx, {
          name: meta.name,
          description: meta.description ?? null,
          storedFilename,
          originalFilename: file.originalname,
          fileHash: createHash('sha256').update(file.buffer).digest('hex'),
          pageCount,
          defaultOptions: compact(meta.defaultOptions),
          zoneId: meta.zoneId ?? null,
          createdBy: actor.id,
        }),
      { req, action: 'template.create', entityType: 'template', entityId: (created) => created.id },
    );

    res.status(201).json(template);
  }),
);

/**
 * Print a template.
 *
 * The stored file is re-submitted through the ordinary pipeline rather than
 * shortcut to the transport: the safety gate, the ledger entry
 * and the audit row all have to happen, and a second path that skipped them
 * would be the obvious place for those guarantees to quietly stop holding.
 */
templatesRouter.post(
  '/:id/print',
  validateParams(idParams),
  validateBody(
    z.object({
      printerId: idSchema,
      options: printOptionsSchema.partial().default({}),
      confirmLargeJob: z.boolean().default(false),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);
    const input = body(
      req,
      z.object({
        printerId: idSchema,
        options: printOptionsSchema.partial().default({}),
        confirmLargeJob: z.boolean().default(false),
      }),
    );

    await assertCanUsePrinter(actor, input.printerId);

    const template = await templatesModel.find(pool, id);
    if (!template?.isActive) throw errors.notFound('Template', id);

    const path = join(config.storage.templateDir, template.storedFilename);
    if (!resolve(path).startsWith(resolve(config.storage.templateDir))) {
      throw errors.notFound('Template', id);
    }
    const content = await readFile(path).catch(() => null);
    if (!content) throw errors.notFound('Template file', id);

    const printer = await printersModel.findWithSecrets(pool, input.printerId);
    if (!printer) throw errors.notFound('Printer', input.printerId);
    const printerRecord = await printersModel.find(pool, input.printerId);

    const { job } = await submitJob({
      actor: { id: actor.id, username: actor.username, department: actor.department },
      printer,
      printerName: printerRecord?.name ?? printer.name,
      content,
      originalFilename: template.originalFilename,
      // The template's saved options are the default; a caller may override
      // individual fields (an extra copy, colour for a one-off).
      options: {
        ...DEFAULT_PRINT_OPTIONS,
        ...compact(template.defaultOptions),
        ...compact(input.options),
      },
      confirmLargeJob: input.confirmLargeJob,
      requestId: req.requestId,
      // Templates are re-read from their canonical location on every print, so
      // the job points at the template file rather than a per-job copy. No
      // `discard`: a rejected submission must not delete the template.
      persist: () => Promise.resolve({ path }),
    });

    await templatesModel.incrementUsage(pool, id);
    publishJob(job);

    res.status(202).json({ jobId: job.id, status: job.status, template: template.name });
  }),
);

templatesRouter.delete(
  '/:id',
  requireAdmin,
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const template = await templatesModel.find(pool, id);
    if (!template) throw errors.notFound('Template', id);

    await auditedMutation(async (tx) => templatesModel.remove(tx, id), {
      req,
      action: 'template.delete',
      entityType: 'template',
      entityId: id,
      before: template,
      after: null,
    });

    // Best-effort file removal. A missing template file with no row is inert;
    // failing the delete because of it would leave an unusable template listed.
    await rm(join(config.storage.templateDir, template.storedFilename), { force: true }).catch(
      () => undefined,
    );

    res.status(204).end();
  }),
);
