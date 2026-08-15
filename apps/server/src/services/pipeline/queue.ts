import { createHash } from 'node:crypto';
import { AppError, computeImpressions, isDuplex, type Job, type PrintOptions } from '@kode/shared';
import { config } from '../../config/index.js';
import { withTransaction, type Db } from '../../db/pool.js';
import { jobsModel } from '../../models/jobs.js';
import { quotasModel } from '../../models/quotas.js';
import { getSettings } from '../../models/settings.js';
import type { PrinterWithSecrets } from '../../models/printers.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';
import { events } from '../events.js';
import { checkSubmission } from '../transport/safety.js';
import { countPdfPages, verifyMagicBytes } from './prepare.js';
import { needsOfficeConversion } from './convert.js';

const log = subsystem('pipeline:queue');

/**
 * Job submission (§B10.1 steps 1–3).
 *
 * The request ends at step 3. ADR-004 moved the pipeline out of the HTTP
 * request for reasons worth restating: a 60-second Office conversion sitting
 * inside a request gets killed by a browser or proxy timeout, leaving the user
 * with no idea whether their document printed. Returning 202 with a job id and
 * reporting progress over SSE is the whole point.
 */

/**
 * Where a document ended up, and how to undo that.
 *
 * `discard` exists because not every caller owns its file. An upload does, and
 * an orphan left by a rejected submission would never be collected: the
 * retention sweep finds files through job rows, and a row that was never
 * written has none. A template print, by contrast, points at the canonical
 * template file, which must never be deleted.
 */
export interface PersistedDocument {
  path: string;
  discard?: () => Promise<void>;
}

export interface SubmitInput {
  actor: { id: number; username: string; department: string | null };
  printer: PrinterWithSecrets;
  printerName: string;
  content: Buffer;
  originalFilename: string;
  options: PrintOptions;
  confirmLargeJob: boolean;
  requestId: string;
  /**
   * Commits the document to storage.
   *
   * Called after the magic-byte check and the safety gate have passed, and
   * before the job row is inserted. Both halves of that are load-bearing:
   * INV-09 requires that no unverified byte reaches the filesystem, and the
   * worker requires that a row it can dequeue already has a file behind it.
   */
  persist: () => Promise<PersistedDocument>;
}

export interface SubmitResult {
  job: Job;
  /** Impressions the ledger will expect. Recorded so tests can assert on it. */
  impressions: number;
  estimatedPages: boolean;
}

/**
 * The de-duplication window, §B10.5.
 *
 * Users double-click. A second physical copy is not a harmless mistake — it is
 * paper, toner, and on a shared device someone else picking up a stranger's
 * document.
 */
const DEDUPE_WINDOW_SECONDS = 60;

export async function submitJob(input: SubmitInput): Promise<SubmitResult> {
  const settings = await getSettings();

  // ── INV-09 ──────────────────────────────────────────────────────────────
  // No byte reaches a converter or a printer before this passes.
  const verdict = verifyMagicBytes(input.content, input.originalFilename);
  if (!verdict.ok) {
    throw new AppError('FILE_TYPE_REJECTED', verdict.reason ?? 'This file type is not accepted.', {
      details: { filename: input.originalFilename },
    });
  }

  const fileHash = createHash('sha256').update(input.content).digest('hex');

  // Page count now, so the impression figure the safety gate and the quota
  // check use is the real one. An Office document cannot be counted before
  // conversion, so it is estimated from size and corrected by the worker.
  const { pages, estimated } = await estimatePages(input.content, input.originalFilename);
  const selectedPages = countSelectedPages(pages, input.options);
  const impressions = computeImpressions({
    pages: selectedPages,
    copies: input.options.copies,
    sides: input.options.sides,
  });

  // ── Printer safety ──────────────────────────────────────────────────────
  const safety = checkSubmission({
    printer: input.printer,
    settings,
    impressions,
    confirmedLargeJob: input.confirmLargeJob,
  });
  if (!safety.allowed) throw safety.error;

  /* The document goes to disk before the row exists, not after.
   *
   * The reverse order left a window in which the row was `queued` with a null
   * `file_path`, and the dequeue has no predicate excluding that. A worker that
   * claimed the row inside the window failed the job permanently with "the
   * uploaded file is no longer available" for a submission that had just
   * succeeded, and the window scaled with file size, so large uploads lost. */
  const document = await input.persist();

  try {
    return await withTransaction(async (tx) => {
      const duplicate = await jobsModel.findRecentDuplicate(tx, {
        userId: input.actor.id,
        printerId: input.printer.id,
        fileHash,
        withinSeconds: DEDUPE_WINDOW_SECONDS,
      });
      if (duplicate) {
        throw new AppError(
          'DUPLICATE_SUBMISSION',
          `You sent this same document to ${input.printerName} a moment ago. ` +
            'Check the printer before sending it again.',
          { details: { existingJobId: duplicate.id }, retryable: false },
        );
      }

      await assertWithinQuota(tx, input, impressions, settings.quotaEnforcementEnabled);

      const job = await jobsModel.insert(tx, {
        printerId: input.printer.id,
        siteId: input.printer.siteId,
        userId: input.actor.id,
        // INV-06 — snapshots written at insert time, so the record stays readable
        // after the user or printer record changes or is removed.
        usernameSnapshot: input.actor.username,
        printerNameSnapshot: input.printerName,
        source: 'app',
        jobType: 'print',
        // Hold-and-release parks the job until the user is standing at the device.
        status: input.options.holdForRelease ? 'held' : 'queued',
        pages: selectedPages,
        copies: input.options.copies,
        impressions,
        colorMode: input.options.colorMode,
        duplex: isDuplex(input.options.sides),
        documentName: input.originalFilename,
        filePath: document.path,
        fileHash,
        printOptions: input.options,
        maxAttempts: config.queue.maxAttempts,
        notes: null,
        requestId: input.requestId,
        pageCountEstimated: estimated,
      });

      log.info(
        {
          jobId: job.id,
          printerId: input.printer.id,
          impressions,
          held: input.options.holdForRelease,
        },
        'job queued',
      );

      return { job, impressions, estimatedPages: estimated };
    });
  } catch (error) {
    // The row never landed, so anything written for it is an orphan the
    // retention sweep cannot see: it finds files through job rows.
    if (document.discard) {
      await document.discard().catch((discardError: unknown) => {
        log.warn(
          { path: document.path, ...serialiseError(discardError) },
          'could not remove the document for a rejected submission',
        );
      });
    }
    throw error;
  }
}

export function publishJob(job: Job): void {
  events.jobUpdated(job);
}

/* ------------------------------------------------------------------ quota  */

/**
 * Quota enforcement (DEC-05).
 *
 * Off by default. When on, the message names the specific limit that bound —
 * a user can be subject to a personal and a departmental quota at once, and
 * "you are over quota" without saying which is not actionable.
 */
async function assertWithinQuota(
  db: Db,
  input: SubmitInput,
  impressions: number,
  enforcementEnabled: boolean,
): Promise<void> {
  if (!enforcementEnabled) return;

  const quotas = await quotasModel.enforcingFor(
    db,
    { id: input.actor.id, department: input.actor.department },
    input.printer.siteId,
  );

  for (const quota of quotas) {
    if (quota.usedPages + impressions <= quota.pageLimit) continue;
    const remaining = Math.max(0, quota.pageLimit - quota.usedPages);
    throw new AppError(
      'QUOTA_EXCEEDED',
      `This job needs ${impressions} pages but only ${remaining} remain in your ` +
        `${quota.period} ${quota.scope} allowance of ${quota.pageLimit}.`,
      {
        details: {
          scope: quota.scope,
          period: quota.period,
          limit: quota.pageLimit,
          used: quota.usedPages,
          requested: impressions,
        },
        retryable: false,
      },
    );
  }
}

/* ------------------------------------------------------------- page counts */

/**
 * Pages before conversion.
 *
 * A PDF is counted properly. An Office document cannot be — its page count is
 * not knowable without rendering it — so a deliberately conservative estimate
 * is used for the safety and quota checks, and the worker overwrites it with
 * the true figure after conversion.
 *
 * Conservative means *low*: over-estimating would refuse legitimate jobs at the
 * impression ceiling, and the ceiling is re-checked against the real count
 * before anything is sent, so nothing large slips through.
 */
async function estimatePages(
  content: Buffer,
  filename: string,
): Promise<{ pages: number; estimated: boolean }> {
  if (filename.toLowerCase().endsWith('.pdf')) {
    return countPdfPages(content);
  }
  if (needsOfficeConversion(filename)) {
    // ~3 KB of document body per page is a rough but stable heuristic across
    // Word and Excel; it is only ever a placeholder.
    return { pages: Math.max(1, Math.round(content.length / 3072)), estimated: true };
  }
  // A single image becomes one page.
  return { pages: 1, estimated: false };
}

function countSelectedPages(totalPages: number, options: PrintOptions): number {
  if (options.pageRanges.length === 0) return totalPages;
  const selected = new Set<number>();
  for (const [from, to] of options.pageRanges) {
    for (let page = Math.max(1, from); page <= Math.min(totalPages, to); page += 1) {
      selected.add(page);
    }
  }
  return selected.size === 0 ? totalPages : selected.size;
}
