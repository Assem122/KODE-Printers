import type {
  ColorMode,
  Job,
  JobSource,
  JobStatus,
  JobType,
  Paginated,
  PrintOptions,
  TransportUsed,
} from '@kode/shared';
import type { Db } from '../db/pool.js';
import { applyKeyset, toPage, WhereBuilder } from '../db/sql.js';

/**
 * The jobs table — the audit record this whole system exists to produce.
 *
 * Every write here is append-or-advance: rows are inserted and their status
 * moves forward, and nothing is ever hard-deleted (INV-05, enforced by
 * ON DELETE RESTRICT on `printer_id` rather than by the good intentions of this
 * module).
 */

interface JobRow {
  id: number;
  printer_id: number | null;
  zone_id: number | null;
  user_id: number | null;
  username_snapshot: string;
  printer_name_snapshot: string;
  source: JobSource;
  job_type: JobType;
  status: JobStatus;
  pages: number;
  copies: number;
  impressions: number | null;
  color_mode: ColorMode | null;
  duplex: boolean | null;
  document_name: string | null;
  file_hash: string | null;
  print_options: Partial<PrintOptions> | null;
  transport_used: TransportUsed | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  error_code: string | null;
  notes: string | null;
  page_count_estimated: boolean;
  created_at: string;
  completed_at: string | null;
}

const JOB_COLUMNS = `
  j.id, j.printer_id, j.zone_id, j.user_id, j.username_snapshot, j.printer_name_snapshot,
  j.source, j.job_type, j.status, j.pages, j.copies, j.impressions, j.color_mode, j.duplex,
  j.document_name, j.file_hash, j.print_options, j.transport_used, j.attempts, j.max_attempts,
  j.next_attempt_at, j.error_code, j.notes, j.page_count_estimated, j.created_at, j.completed_at
`;

const toJob = (row: JobRow): Job => ({
  id: row.id,
  printerId: row.printer_id,
  zoneId: row.zone_id,
  userId: row.user_id,
  usernameSnapshot: row.username_snapshot,
  printerNameSnapshot: row.printer_name_snapshot,
  source: row.source,
  jobType: row.job_type,
  status: row.status,
  pages: row.pages,
  copies: row.copies,
  impressions: row.impressions,
  colorMode: row.color_mode,
  duplex: row.duplex,
  documentName: row.document_name,
  fileHash: row.file_hash,
  printOptions: row.print_options ?? {},
  transportUsed: row.transport_used,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  nextAttemptAt: row.next_attempt_at,
  errorCode: row.error_code,
  notes: row.notes,
  pageCountEstimated: row.page_count_estimated,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

export interface JobFilter {
  printerId?: number | undefined;
  zoneId?: number | undefined;
  userId?: number | undefined;
  status?: JobStatus | undefined;
  source?: JobSource | undefined;
  jobType?: JobType | undefined;
  from?: string | undefined;
  to?: string | undefined;
  search?: string | undefined;
  /** INV-01 — non-admins see only jobs on printers they are permitted to use. */
  permittedPrinterIds?: readonly number[] | undefined;
  /** Non-admins additionally see only their own jobs plus walk-ups on those printers. */
  ownUserId?: number | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

function buildJobWhere(filter: JobFilter): WhereBuilder {
  const where = new WhereBuilder();
  where.addIf(filter.printerId, 'j.printer_id = ?', filter.printerId);
  where.addIf(filter.zoneId, 'j.zone_id = ?', filter.zoneId);
  where.addIf(filter.userId, 'j.user_id = ?', filter.userId);
  where.addIf(filter.status, 'j.status = ?', filter.status);
  where.addIf(filter.source, 'j.source = ?', filter.source);
  where.addIf(filter.jobType, 'j.job_type = ?', filter.jobType);
  where.addIf(filter.from, 'j.created_at >= ?::timestamptz', filter.from);
  // `to` is treated as an inclusive day when a bare date is supplied, which is
  // what a person means by "up to the 31st".
  where.addIf(filter.to, "j.created_at < (?::timestamptz + interval '1 day')", filter.to);
  if (filter.search) {
    where.add(
      '(j.document_name ILIKE ? OR j.username_snapshot ILIKE ? OR j.printer_name_snapshot ILIKE ?)',
      `%${filter.search}%`,
      `%${filter.search}%`,
      `%${filter.search}%`,
    );
  }
  if (filter.permittedPrinterIds) {
    where.add('j.printer_id = ANY(?::int[])', [...filter.permittedPrinterIds]);
  }
  if (filter.ownUserId !== undefined) {
    // A user sees their own jobs, and walk-up activity on printers they may use
    // — the latter is what makes "why is the tray empty" answerable without an
    // admin, and it exposes no other person's document names.
    where.add("(j.user_id = ? OR j.source = 'walkup')", filter.ownUserId);
  }
  return where;
}

export async function listJobs(db: Db, filter: JobFilter): Promise<Paginated<Job>> {
  const where = buildJobWhere(filter);
  const limit = applyKeyset(where, {
    cursor: filter.cursor,
    limit: filter.limit,
    timestampColumn: 'j.created_at',
    idColumn: 'j.id',
  });
  const limitParam = where.push(limit + 1);

  const { rows } = await db.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs j ${where.sql}
      ORDER BY j.created_at DESC, j.id DESC LIMIT ${limitParam}`,
    where.params,
  );
  return toPage(rows.map(toJob), limit, (job) => ({ t: job.createdAt, i: job.id }));
}

/**
 * Streaming cursor for CSV export. §B5.4 requires streaming rather than
 * buffering: a year of job rows materialised into a string is a memory
 * exhaustion vector, and the export is exactly the request most likely to be
 * made against a full table.
 */
export async function* streamJobs(
  db: Db,
  filter: JobFilter,
  batchSize = 500,
): AsyncGenerator<Job[]> {
  let cursor: string | undefined;
  for (;;) {
    const page = await listJobs(db, { ...filter, cursor, limit: batchSize });
    if (page.items.length === 0) return;
    yield page.items;
    if (!page.hasMore || !page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

export async function findJob(db: Db, id: number): Promise<Job | null> {
  const { rows } = await db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs j WHERE j.id = $1`, [
    id,
  ]);
  const row = rows[0];
  return row ? toJob(row) : null;
}

/* ------------------------------------------------------------------ writes */

export interface JobInsert {
  printerId: number | null;
  zoneId: number | null;
  userId: number | null;
  usernameSnapshot: string;
  printerNameSnapshot: string;
  source: JobSource;
  jobType: JobType;
  status: JobStatus;
  pages: number;
  copies: number;
  impressions: number | null;
  colorMode: ColorMode | null;
  duplex: boolean | null;
  documentName: string | null;
  filePath: string | null;
  fileHash: string | null;
  printOptions: Partial<PrintOptions>;
  maxAttempts: number;
  notes: string | null;
  requestId: string | null;
  pageCountEstimated?: boolean;
}

export async function insertJob(db: Db, input: JobInsert): Promise<Job> {
  const { rows } = await db.query<JobRow>(
    `INSERT INTO jobs (printer_id, zone_id, user_id, username_snapshot, printer_name_snapshot,
                       source, job_type, status, pages, copies, impressions, color_mode, duplex,
                       document_name, file_path, file_hash, print_options, max_attempts, notes,
                       request_id, page_count_estimated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21)
     RETURNING ${JOB_COLUMNS.replace(/j\./g, '')}`,
    [
      input.printerId,
      input.zoneId,
      input.userId,
      input.usernameSnapshot,
      input.printerNameSnapshot,
      input.source,
      input.jobType,
      input.status,
      input.pages,
      input.copies,
      input.impressions,
      input.colorMode,
      input.duplex,
      input.documentName,
      input.filePath,
      input.fileHash,
      JSON.stringify(input.printOptions),
      input.maxAttempts,
      input.notes,
      input.requestId,
      input.pageCountEstimated ?? false,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('job insert returned no row');
  return toJob(row);
}

/**
 * §B10.5 — duplicate submission guard.
 *
 * Users double-click, and a second physical copy is not a harmless mistake: it
 * is paper, toner and, on a shared device, someone else's confusion.
 */
export async function findRecentDuplicate(
  db: Db,
  input: { userId: number; printerId: number; fileHash: string; withinSeconds: number },
): Promise<Job | null> {
  const { rows } = await db.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs j
      WHERE j.user_id = $1 AND j.printer_id = $2 AND j.file_hash = $3
        AND j.created_at > now() - make_interval(secs => $4)
        AND j.status <> 'cancelled'
      ORDER BY j.created_at DESC LIMIT 1`,
    [input.userId, input.printerId, input.fileHash, input.withinSeconds],
  );
  const row = rows[0];
  return row ? toJob(row) : null;
}

/**
 * The dequeue, §B10.4.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes a second worker pick the *next* row
 * rather than blocking on the one already being processed. The `EXISTS` clauses
 * are the printer-safety half: a draining printer, a printer with its circuit
 * open, and a printer already at its concurrency limit are all skipped here
 * rather than dequeued and then refused, so the job keeps its place instead of
 * burning an attempt.
 */
export interface DequeuedJob extends Job {
  filePath: string | null;
}

export async function dequeueJob(
  db: Db,
  workerId: string,
  maxConcurrentPerPrinter: number,
  cooldownSeconds: number,
): Promise<DequeuedJob | null> {
  const { rows } = await db.query<JobRow & { file_path: string | null }>(
    `UPDATE jobs
        SET status = 'processing', locked_by = $1, locked_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT j.id FROM jobs j
          JOIN printers p ON p.id = j.printer_id
         WHERE j.status = 'queued'
           AND j.next_attempt_at <= now()
           AND p.is_active
           AND NOT p.is_draining
           -- A printer behind a collector is, by definition, one this process
           -- cannot open a socket to. Dequeuing it here burned three attempts
           -- against an unreachable address and failed the job with "the
           -- printer did not accept the connection", which describes the
           -- network rather than the cause. checkSubmission refuses these up
           -- front instead.
           AND p.collector_id IS NULL
           AND (p.circuit_open_until IS NULL OR p.circuit_open_until <= now())
           AND (
             SELECT count(*) FROM jobs busy
              WHERE busy.printer_id = j.printer_id AND busy.status = 'processing'
           ) < $2
           AND NOT EXISTS (
             SELECT 1 FROM jobs recent
              WHERE recent.printer_id = j.printer_id
                AND recent.status IN ('sent','completed')
                AND recent.completed_at > now() - make_interval(secs => $3)
           )
         ORDER BY j.created_at
         FOR UPDATE OF j SKIP LOCKED
         LIMIT 1
      )
      RETURNING ${JOB_COLUMNS.replace(/j\./g, '')}, file_path`,
    [workerId, maxConcurrentPerPrinter, cooldownSeconds],
  );

  const row = rows[0];
  if (!row) return null;
  return { ...toJob(row), filePath: row.file_path };
}

/**
 * Reclaims jobs abandoned by a crashed worker. This is the single mechanism
 * that makes a mid-job server kill recoverable (§B14) — without it those rows
 * sit in `processing` forever and the user never learns the outcome.
 */
export async function reclaimStuckJobs(db: Db, lockTimeoutMs: number): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET status = 'queued', locked_by = NULL, locked_at = NULL,
            notes = COALESCE(notes || ' | ', '') || 'Requeued after worker restart'
      WHERE status = 'processing'
        AND locked_at < now() - make_interval(secs => $1)`,
    [lockTimeoutMs / 1000],
  );
  return rowCount ?? 0;
}

export async function markSent(
  db: Db,
  id: number,
  details: {
    transportUsed: TransportUsed;
    pages: number;
    impressions: number;
    ippJobUri: string | null;
    pageCountEstimated: boolean;
    notes?: string | null;
  },
): Promise<Job | null> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET status = 'sent', transport_used = $2, pages = $3, impressions = $4,
            ipp_job_uri = $5, page_count_estimated = $6, completed_at = now(),
            locked_by = NULL, locked_at = NULL, error_code = NULL,
            notes = CASE WHEN $7::text IS NULL THEN notes
                         ELSE COALESCE(notes || ' | ', '') || $7 END
      WHERE id = $1
      RETURNING ${JOB_COLUMNS.replace(/j\./g, '')}`,
    [
      id,
      details.transportUsed,
      details.pages,
      details.impressions,
      details.ippJobUri,
      details.pageCountEstimated,
      details.notes ?? null,
    ],
  );
  const row = rows[0];
  return row ? toJob(row) : null;
}

export async function markCompleted(db: Db, id: number, impressions?: number): Promise<void> {
  await db.query(
    `UPDATE jobs
        SET status = 'completed',
            completed_at = COALESCE(completed_at, now()),
            impressions = COALESCE($2, impressions)
      WHERE id = $1 AND status IN ('sent','processing')`,
    [id, impressions ?? null],
  );
}

/** Schedules a retry. Only ever called for failures classified as transient. */
export async function scheduleRetry(
  db: Db,
  id: number,
  delayMs: number,
  errorCode: string,
  note: string,
): Promise<void> {
  await db.query(
    `UPDATE jobs
        SET status = 'queued',
            next_attempt_at = now() + make_interval(secs => $2),
            locked_by = NULL, locked_at = NULL, error_code = $3,
            notes = COALESCE(notes || ' | ', '') || $4
      WHERE id = $1`,
    [id, delayMs / 1000, errorCode, note],
  );
}

export async function markFailed(
  db: Db,
  id: number,
  errorCode: string,
  note: string,
): Promise<Job | null> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET status = 'failed', error_code = $2, completed_at = now(),
            locked_by = NULL, locked_at = NULL,
            notes = COALESCE(notes || ' | ', '') || $3
      WHERE id = $1
      RETURNING ${JOB_COLUMNS.replace(/j\./g, '')}`,
    [id, errorCode, note],
  );
  const row = rows[0];
  return row ? toJob(row) : null;
}

export async function cancelJob(db: Db, id: number, note: string): Promise<Job | null> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET status = 'cancelled', completed_at = now(), locked_by = NULL, locked_at = NULL,
            notes = COALESCE(notes || ' | ', '') || $2
      WHERE id = $1 AND status IN ('queued','held')
      RETURNING ${JOB_COLUMNS.replace(/j\./g, '')}`,
    [id, note],
  );
  const row = rows[0];
  return row ? toJob(row) : null;
}

/** Hold-and-release: moves a held job into the queue when the user is at the device. */
export async function releaseJob(db: Db, id: number): Promise<Job | null> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET status = 'queued', released_at = now(), next_attempt_at = now()
      WHERE id = $1 AND status = 'held'
      RETURNING ${JOB_COLUMNS.replace(/j\./g, '')}`,
    [id],
  );
  const row = rows[0];
  return row ? toJob(row) : null;
}

export async function retryJob(db: Db, id: number): Promise<Job | null> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET status = 'queued', attempts = 0, next_attempt_at = now(),
            error_code = NULL, completed_at = NULL,
            notes = COALESCE(notes || ' | ', '') || 'Retried by user'
      WHERE id = $1 AND status = 'failed'
      RETURNING ${JOB_COLUMNS.replace(/j\./g, '')}`,
    [id],
  );
  const row = rows[0];
  return row ? toJob(row) : null;
}

export async function getFilePath(db: Db, id: number): Promise<string | null> {
  const { rows } = await db.query<{ file_path: string | null }>(
    'SELECT file_path FROM jobs WHERE id = $1',
    [id],
  );
  return rows[0]?.file_path ?? null;
}

export async function queueStats(db: Db): Promise<{ depth: number; oldestSeconds: number }> {
  const { rows } = await db.query<{ depth: number; oldest: number | null }>(
    `SELECT count(*)::int AS depth,
            EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest
       FROM jobs WHERE status IN ('queued','processing')`,
  );
  return { depth: rows[0]?.depth ?? 0, oldestSeconds: rows[0]?.oldest ?? 0 };
}

/** Files eligible for the retention sweep (DEC-03). Metadata is never removed. */
export async function listPurgeableFiles(
  db: Db,
  retentionDays: number,
  limit = 500,
): Promise<Array<{ id: number; filePath: string }>> {
  const { rows } = await db.query<{ id: number; file_path: string }>(
    `SELECT id, file_path FROM jobs
      WHERE file_path IS NOT NULL
        AND status IN ('completed','failed','cancelled','sent')
        AND created_at < now() - make_interval(days => $1)
      ORDER BY created_at LIMIT $2`,
    [retentionDays, limit],
  );
  return rows.map((row) => ({ id: row.id, filePath: row.file_path }));
}

export async function clearFilePath(db: Db, id: number): Promise<void> {
  await db.query(
    `UPDATE jobs
        SET file_path = NULL,
            notes = COALESCE(notes || ' | ', '') || 'Original purged by retention policy'
      WHERE id = $1`,
    [id],
  );
}

export const jobsModel = {
  list: listJobs,
  stream: streamJobs,
  find: findJob,
  insert: insertJob,
  findRecentDuplicate,
  dequeue: dequeueJob,
  reclaimStuck: reclaimStuckJobs,
  markSent,
  markCompleted,
  scheduleRetry,
  markFailed,
  cancel: cancelJob,
  release: releaseJob,
  retry: retryJob,
  getFilePath,
  queueStats,
  listPurgeableFiles,
  clearFilePath,
} as const;
