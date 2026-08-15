import { jitteredInterval } from '@kode/shared';
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import { printersModel, type PrinterWithSecrets } from '../../models/printers.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';
import { recordCounterEvent } from '../collector/agent.js';
import { recordStatus, targets } from '../collector/registry.js';
import { notify } from '../notify.js';
import { computeDelta, readCounters, type CounterReading } from '../snmp/counters.js';
import { reconcileIdentity } from '../snmp/identity.js';
import { SnmpUnavailableError, logSnmpFailure } from '../snmp/client.js';
import { attributeInTransaction } from '../walkup.js';
import { isPlausibleDelta } from './attribution.js';

const log = subsystem('watcher:counter');

/**
 * Walk-up detection (§B8).
 *
 * The mechanism in one sentence: poll each printer's page counter, and treat
 * any increase this system did not cause as activity started at the device.
 *
 * Everything difficult about it is in `attribution.ts`, which is pure and
 * tested. This file is the I/O around it — scheduling, backoff, identity
 * checks, and turning a reconciled delta into a job row.
 */

interface PollState {
  timer: NodeJS.Timeout | null;
  lastReading: CounterReading;
  lastPolledAt: number;
  inFlight: boolean;
}

const state = new Map<number, PollState>();
let stopping = false;

export async function startCounterWatcher(collectorId: number | null = null): Promise<void> {
  if (!config.polling.enabled) {
    log.info('counter watcher disabled by configuration');
    return;
  }
  stopping = false;
  await refreshTargets(collectorId);

  // Re-read the fleet periodically so a printer added through the UI starts
  // being polled without a restart.
  const refresh = setInterval(() => void refreshTargets(collectorId), 60_000);
  refresh.unref();
}

export function stopCounterWatcher(): void {
  stopping = true;
  for (const entry of state.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  state.clear();
}

async function refreshTargets(collectorId: number | null): Promise<void> {
  if (stopping) return;
  try {
    void collectorId; // the source already knows which estate it serves
    const printers = await targets().pollTargets();
    const live = new Set(printers.map((printer) => printer.id));

    for (const [id, entry] of state) {
      if (live.has(id)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      state.delete(id);
    }

    for (const printer of printers) {
      if (state.has(printer.id)) continue;
      state.set(printer.id, {
        timer: null,
        lastReading: {
          life: printer.lastPageCount,
          print: printer.lastPrintCount,
          copy: printer.lastCopyCount,
        },
        lastPolledAt: 0,
        inFlight: false,
      });
      schedule(printer.id, 0);
    }
  } catch (error) {
    log.error({ ...serialiseError(error) }, 'could not refresh poll targets');
  }
}

/**
 * Schedules the next poll with ±25% jitter (§B8.2).
 *
 * Fifty printers on a shared four-second timer arrive at the switch as a
 * thundering herd. Spreading them is what keeps one unreachable building from
 * consuming the poll budget for the whole fleet.
 */
function schedule(printerId: number, delayMs: number): void {
  if (stopping) return;
  const entry = state.get(printerId);
  if (!entry) return;

  const jittered = delayMs === 0 ? 0 : jitteredInterval(delayMs);
  entry.timer = setTimeout(() => void poll(printerId), jittered);
  entry.timer.unref();
}

async function poll(printerId: number): Promise<void> {
  const entry = state.get(printerId);
  if (!entry || stopping) return;

  // §B8.2 — polling never runs concurrently against the same printer. Two
  // overlapping reads would each compute a delta from the same baseline and
  // double-count the activity between them.
  if (entry.inFlight) {
    schedule(printerId, config.polling.counterIntervalMs);
    return;
  }
  entry.inFlight = true;

  const printer = await targets()
    .find(printerId)
    .catch(() => null);
  if (!printer || !printer.isActive || printer.snmpVersion === 'disabled') {
    entry.inFlight = false;
    state.delete(printerId);
    return;
  }

  try {
    await pollOnce(printer, entry);
    await recordStatus(
      printerId,
      printer.status === 'offline' ? 'online' : printer.status,
      printer.stateReasons,
      { resetFailures: true },
    );
    schedule(printerId, config.polling.counterIntervalMs);
  } catch (error) {
    if (error instanceof SnmpUnavailableError) {
      logSnmpFailure(printer, error);
      await handleUnreachable(printer);
      // Exponential backoff, 4s → 8s → 16s … capped at five minutes (§B7.4).
      const failures = printer.consecutiveFailures + 1;
      const backoff = Math.min(
        config.polling.maxBackoffMs,
        config.polling.counterIntervalMs * 2 ** Math.min(failures, 8),
      );
      schedule(printerId, backoff);
    } else {
      log.error({ printerId, ...serialiseError(error) }, 'counter poll failed');
      schedule(printerId, config.polling.maxBackoffMs);
    }
  } finally {
    entry.inFlight = false;
  }
}

async function pollOnce(printer: PrinterWithSecrets, entry: PollState): Promise<void> {
  // ADR-006 — confirm the device is still the one on record before believing
  // anything it reports. A swapped unit that took the old lease would otherwise
  // have its counters merged into another printer's history.
  const identity = await reconcileIdentity(pool, printer);
  if (!identity.ok) {
    // Mismatch. `reconcileIdentity` has already raised a critical notification;
    // polling stops here until an administrator resolves it.
    return;
  }

  const current = await readCounters(printer);
  if (current.life === null) return;

  const secondsSinceLastPoll =
    entry.lastPolledAt === 0 ? 0 : (Date.now() - entry.lastPolledAt) / 1000;
  entry.lastPolledAt = Date.now();

  const delta = computeDelta(entry.lastReading, current);
  entry.lastReading = current;

  /* On a collector, attribution stops here.
   *
   * The ledger, the job rows and the audit trail all live on the central
   * server, which is the database of record (§B11.2). A collector reports what
   * it observed and lets the server decide what it means — duplicating the
   * attribution logic here would give two systems the chance to disagree about
   * the same counter, which is the class of bug INV-01 exists to prevent
   * elsewhere. */
  if (config.collector.mode) {
    await recordCounterEvent({
      printerId: printer.id,
      lifeCount: current.life,
      printCount: current.print,
      copyCount: current.copy,
    });
    return;
  }

  await printersModel.recordCounters(pool, printer.id, {
    life: current.life,
    print: current.print,
    copy: current.copy,
  });

  if (!delta) return;

  /* Counter went backwards — reboot, firmware reset or rollover. §B8.3 and
   * §B14 both require re-anchoring the baseline and logging no job. Recording
   * the absolute value here would invent tens of thousands of pages. */
  if (delta.isReset) {
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
    return;
  }

  if (delta.life === 0) return;

  if (!isPlausibleDelta(delta.life, secondsSinceLastPoll)) {
    log.warn(
      { printerId: printer.id, delta: delta.life, secondsSinceLastPoll },
      'implausible counter jump ignored',
    );
    await notify(
      {
        type: 'printer.counter_anomaly',
        severity: 'warning',
        printerId: printer.id,
        message:
          `${printer.name} reported an implausible jump of ${delta.life} impressions and it ` +
          'has been ignored. Check the device counter if this repeats.',
        dedupeKey: `printer:${printer.id}:counter-anomaly`,
      },
      pool,
    );
    return;
  }

  // Shared with the collector ingest path, so a directly polled printer and one
  // behind a collector produce the same record from the same delta.
  await attributeInTransaction(printer, delta.life, {
    print: delta.print,
    copy: delta.copy,
  });
}

async function handleUnreachable(printer: PrinterWithSecrets): Promise<void> {
  await recordStatus(printer.id, 'offline', ['offline'], { incrementFailures: true });

  // One alert after roughly a minute of silence, not one every four seconds.
  const failures = printer.consecutiveFailures + 1;
  if (failures === 15) {
    await notify(
      {
        type: 'printer.unreachable',
        severity: 'warning',
        printerId: printer.id,
        message: `${printer.name} at ${printer.ipAddress} has stopped responding to SNMP.`,
        dedupeKey: `printer:${printer.id}:unreachable`,
      },
      pool,
    );
  }
}
