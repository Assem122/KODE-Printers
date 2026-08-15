import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollectorEventsInput } from '@kode/shared';
import { config } from '../../config/index.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';

const log = subsystem('collector:spool');

type CollectorEvent = CollectorEventsInput['events'][number];

/**
 * The collector's local event spool (§B11.4).
 *
 * When the uplink drops, the collector keeps polling SNMP and watching the scan
 * folder — the devices in its segment are still working, and the whole point of
 * a collector is that the central server cannot see them. Events go here until
 * the link returns.
 *
 * Append-only JSON Lines rather than a database. A collector holds "no durable
 * state beyond a small local spool" (§B11.1), and a line-delimited file is the
 * cheapest thing that survives a crash mid-write: a torn final line is dropped
 * on read, and everything before it is intact.
 */

const SPOOL_FILE = 'events.jsonl';
const SENDING_FILE = 'events.sending.jsonl';

export interface SpoolStats {
  pending: number;
  /** True once the cap has been hit and older events have been dropped. */
  overflowed: boolean;
  droppedCount: number;
}

let overflowed = false;
let droppedCount = 0;

export async function ensureSpoolDir(): Promise<void> {
  await mkdir(config.collector.spoolDir, { recursive: true });
}

export async function append(event: CollectorEvent): Promise<void> {
  await ensureSpoolDir();
  await appendFile(
    join(config.collector.spoolDir, SPOOL_FILE),
    `${JSON.stringify(event)}\n`,
    'utf8',
  );
}

/**
 * Claims the spool for sending by renaming it.
 *
 * The rename is atomic, so events arriving while a batch is in flight land in a
 * fresh file rather than being sent twice or lost. If a previous send crashed
 * part-way, `events.sending.jsonl` still exists and is picked up first — those
 * events may be re-sent, which is exactly what the idempotency keys are for.
 */
export async function claimBatch(maxEvents: number): Promise<CollectorEvent[]> {
  await ensureSpoolDir();

  const spoolPath = join(config.collector.spoolDir, SPOOL_FILE);
  const sendingPath = join(config.collector.spoolDir, SENDING_FILE);

  const hasUnsent = await exists(sendingPath);
  if (!hasUnsent) {
    if (!(await exists(spoolPath))) return [];
    await rename(spoolPath, sendingPath);
  }

  const contents = await readFile(sendingPath, 'utf8').catch(() => '');
  const events: CollectorEvent[] = [];

  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;
    if (events.length >= maxEvents) break;
    try {
      events.push(JSON.parse(line) as CollectorEvent);
    } catch {
      // A torn final line from a crash mid-append. Dropping it is correct: it
      // was never a complete event, and the counter it described will be
      // observed again on the next poll anyway.
      log.debug('discarded a truncated spool line');
    }
  }

  return events;
}

/** Called after the server has accepted a batch. */
export async function releaseBatch(): Promise<void> {
  await rm(join(config.collector.spoolDir, SENDING_FILE), { force: true });
}

/**
 * Enforces the cap.
 *
 * §B11.4: "Local spool is capped; on overflow the oldest events are dropped and
 * a warning is raised on reconnection, because a silently truncated audit trail
 * is the failure this system exists to prevent."
 *
 * So the drop is recorded and surfaced — a gap that is visible is a limitation,
 * a gap that is invisible is a false report.
 */
export async function enforceCap(): Promise<SpoolStats> {
  await ensureSpoolDir();
  const spoolPath = join(config.collector.spoolDir, SPOOL_FILE);

  const contents = await readFile(spoolPath, 'utf8').catch(() => '');
  const lines = contents.split('\n').filter((line) => line.trim() !== '');

  if (lines.length <= config.collector.spoolMaxEvents) {
    return { pending: lines.length, overflowed, droppedCount };
  }

  const keep = lines.slice(lines.length - config.collector.spoolMaxEvents);
  const dropped = lines.length - keep.length;

  const { writeFile } = await import('node:fs/promises');
  await writeFile(spoolPath, `${keep.join('\n')}\n`, 'utf8');

  overflowed = true;
  droppedCount += dropped;
  log.error(
    { dropped, droppedTotal: droppedCount, cap: config.collector.spoolMaxEvents },
    'spool overflowed — oldest events discarded, the record for this period is incomplete',
  );

  return { pending: keep.length, overflowed, droppedCount };
}

/** Read and clear the overflow flag, for the reconnection warning. */
export function takeOverflowReport(): { overflowed: boolean; droppedCount: number } {
  const report = { overflowed, droppedCount };
  overflowed = false;
  droppedCount = 0;
  return report;
}

export async function pendingCount(): Promise<number> {
  const contents = await readFile(join(config.collector.spoolDir, SPOOL_FILE), 'utf8').catch(
    () => '',
  );
  return contents.split('\n').filter((line) => line.trim() !== '').length;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export const spool = {
  append,
  claimBatch,
  releaseBatch,
  enforceCap,
  takeOverflowReport,
  pendingCount,
  ensureSpoolDir,
} as const;

export function logSpoolError(error: unknown): void {
  log.error({ ...serialiseError(error) }, 'spool operation failed');
}
