import type { Job } from '@kode/shared';
import { pool, withTransaction, type Db } from '../db/pool.js';
import { jobsModel } from '../models/jobs.js';
import { ledgerModel } from '../models/ledger.js';
import { printersModel, type CounterBaseline } from '../models/printers.js';
import { usersModel } from '../models/users.js';
import { subsystem } from '../utilities/logger.js';
import { events } from './events.js';
import { notify } from './notify.js';
import { computeDelta } from './snmp/counters.js';
import { classifyWalkup, isPlausibleDelta, reconcile } from './watchers/attribution.js';

const log = subsystem('walkup');

/**
 * Turning a counter delta into a record (§B8.3, ADR-008).
 *
 * The algorithm is pure and lives in `watchers/attribution.ts`. This is the
 * persistence around it, and it sits here rather than inside the counter
 * watcher because two callers need it and only one of them is a watcher.
 *
 * A printer behind a site collector is polled there and reported here. §B11.2
 * puts the database of record on the central server: the collector reports what
 * it observed and the server decides what it means. While this logic lived in
 * the watcher, the server never decided at all. Counters for collector-served
 * buildings were stored and nothing else happened, so those sites produced no
 * walk-up rows, their ledger entries were never consumed, and their app jobs
 * never advanced past `sent`. Every report covering them silently understated
 * usage rather than carrying the coverage note §B8.5 requires.
 */

export interface VendorCounters {
  print: number | null;
  copy: number | null;
}

/** The subset of a printer this module needs. Deliberately not the secret-bearing shape. */
export interface AttributionTarget {
  id: number;
  name: string;
  zoneId: number | null;
}

export interface AttributionOutcome {
  /** Jobs the device has now finished marking. */
  completedJobIds: number[];
  /** Rows written for impressions no app job accounted for. */
  walkupJobs: Job[];
}

/**
 * Reconciles a delta against the ledger and records the remainder.
 *
 * Takes a `Db` rather than opening its own transaction, because the caller's
 * unit of work is wider than this: the collector path has to claim an
 * idempotency key in the same transaction, or a failure after the claim loses
 * the delta permanently when the replay is rejected as a duplicate.
 *
 * The ledger rows are locked for the duration. The queue worker may be adding
 * an entry for a job it is about to send at the same moment, and without the
 * lock both paths could consume the same outstanding impressions and leak the
 * difference into a phantom walk-up.
 */
export async function attributeDelta(
  db: Db,
  printer: AttributionTarget,
  delta: number,
  vendor: VendorCounters,
): Promise<AttributionOutcome> {
  await ledgerModel.expire(db, printer.id);
  const entries = await ledgerModel.lockLive(db, printer.id);

  const result = reconcile(
    delta,
    entries.map((entry) => ({
      id: entry.id,
      jobId: entry.jobId,
      outstanding: entry.outstanding,
    })),
  );

  const completedJobIds: number[] = [];
  for (const consumed of result.consumed) {
    await ledgerModel.consume(db, consumed.id, consumed.remaining);
    if (consumed.remaining === 0) {
      // The device has marked everything this job asked for.
      await jobsModel.markCompleted(db, consumed.jobId);
      completedJobIds.push(consumed.jobId);
    }
  }

  if (result.walkupImpressions <= 0) return { completedJobIds, walkupJobs: [] };

  const walkupJobs = await logWalkup(db, printer, result.walkupImpressions, vendor);
  return { completedJobIds, walkupJobs };
}

async function logWalkup(
  db: Db,
  printer: AttributionTarget,
  impressions: number,
  vendor: VendorCounters,
): Promise<Job[]> {
  const systemUser = await usersModel.getSystemUser(db);
  const classifications = classifyWalkup(impressions, vendor);
  const created: Job[] = [];

  for (const classification of classifications) {
    const job = await jobsModel.insert(db, {
      printerId: printer.id,
      zoneId: printer.zoneId,
      // The system account owns walk-up jobs, so every row has a stable,
      // non-impersonatable actor rather than a NULL that reports must special-case.
      userId: systemUser.id,
      usernameSnapshot: systemUser.username,
      printerNameSnapshot: printer.name,
      source: 'walkup',
      // §B8.4 — `unknown` where no vendor counter answered. Never `print`.
      jobType: classification.jobType,
      status: 'completed',
      pages: classification.impressions,
      copies: 1,
      impressions: classification.impressions,
      colorMode: null,
      duplex: null,
      documentName: null,
      filePath: null,
      fileHash: null,
      printOptions: {},
      maxAttempts: 1,
      notes:
        classification.jobType === 'unknown'
          ? 'Detected at the device. This printer has no vendor counter, so prints and ' +
            'photocopies cannot be told apart.'
          : 'Detected at the device.',
      requestId: null,
    });

    created.push(job);
    log.info(
      {
        printerId: printer.id,
        jobId: job.id,
        jobType: classification.jobType,
        impressions: classification.impressions,
      },
      'walk-up activity logged',
    );
  }

  return created;
}

/**
 * Publishes what an attribution produced.
 *
 * Kept separate and called after the transaction commits. Publishing from
 * inside it would announce a job that a rollback then removes, and an event the
 * database disagrees with is worse than a late one.
 */
export function publishAttribution(outcome: AttributionOutcome): void {
  for (const job of outcome.walkupJobs) events.jobUpdated(job);
}

/* ------------------------------------------------------- collector ingest  */

export type CounterIngestResult =
  'attributed' | 'baseline' | 'no-change' | 'reset' | 'implausible' | 'unknown-printer';

export interface CounterReading {
  printerId: number;
  observedAt: string;
  life: number;
  print: number | null;
  copy: number | null;
}

/**
 * Applies an absolute counter reading reported by a collector.
 *
 * The collector sends what it read rather than what changed: §B11.1 says it
 * holds no durable state beyond a small spool, so it has no baseline to
 * subtract from. The server owns the previous value, so it owns the delta.
 *
 * Every rule the directly-polled path applies is applied here too, and that
 * matters more than it looks. A reset that was recorded as activity would
 * invent tens of thousands of pages; an implausible jump recorded as real would
 * put a fabricated spike into a report leadership reads. A collector-served
 * building's record has to be the same shape as a directly polled one, or the
 * fleet totals mean two different things.
 */
export async function ingestCounterReading(
  db: Db,
  reading: CounterReading,
): Promise<{ result: CounterIngestResult; outcome?: AttributionOutcome }> {
  const baseline = await printersModel.counterBaseline(db, reading.printerId);
  if (!baseline) return { result: 'unknown-printer' };

  const delta = computeDelta(
    { life: baseline.life, print: baseline.print, copy: baseline.copy },
    { life: reading.life, print: reading.print, copy: reading.copy },
  );

  await printersModel.recordCounters(db, reading.printerId, {
    life: reading.life,
    print: reading.print,
    copy: reading.copy,
  });

  if (!delta) return { result: 'baseline' };

  if (delta.isReset) {
    await notifyCounterReset(baseline);
    return { result: 'reset' };
  }

  if (delta.life === 0) return { result: 'no-change' };

  const secondsSinceLastReading =
    baseline.observedAt === null
      ? 0
      : Math.max(0, (Date.parse(reading.observedAt) - Date.parse(baseline.observedAt)) / 1000);

  if (!isPlausibleDelta(delta.life, secondsSinceLastReading)) {
    log.warn(
      { printerId: baseline.id, delta: delta.life, secondsSinceLastReading },
      'implausible counter jump from a collector ignored',
    );
    await notifyCounterAnomaly(baseline, delta.life);
    return { result: 'implausible' };
  }

  const outcome = await attributeDelta(db, baseline, delta.life, {
    print: delta.print,
    copy: delta.copy,
  });
  return { result: 'attributed', outcome };
}

async function notifyCounterReset(printer: AttributionTarget): Promise<void> {
  await notify(
    {
      type: 'printer.counter_reset',
      severity: 'warning',
      printerId: printer.id,
      message:
        `${printer.name} reported a lower page count than before. The baseline has been ` +
        'reset; walk-up totals for this device may be incomplete around this time.',
      dedupeKey: `printer:${printer.id}:counter-reset:${new Date().toISOString().slice(0, 10)}`,
    },
    pool,
  );
}

async function notifyCounterAnomaly(printer: AttributionTarget, delta: number): Promise<void> {
  await notify(
    {
      type: 'printer.counter_anomaly',
      severity: 'warning',
      printerId: printer.id,
      message:
        `${printer.name} reported an implausible jump of ${delta} impressions and it has ` +
        'been ignored. Check the device counter if this repeats.',
      dedupeKey: `printer:${printer.id}:counter-anomaly`,
    },
    pool,
  );
}

/** Convenience wrapper for the directly-polled path, which owns no wider transaction. */
export async function attributeInTransaction(
  printer: AttributionTarget,
  delta: number,
  vendor: VendorCounters,
): Promise<AttributionOutcome> {
  const outcome = await withTransaction((tx) => attributeDelta(tx, printer, delta, vendor));
  publishAttribution(outcome);
  return outcome;
}

export type { CounterBaseline };
