import type { PrinterWithSecrets } from '../../models/printers.js';
import { pool } from '../../db/pool.js';
import { printersModel } from '../../models/printers.js';
import { config } from '../../config/index.js';
import { subsystem } from '../../utilities/logger.js';

const log = subsystem('collector:registry');

/**
 * Where the watchers get their list of printers to poll.
 *
 * On the central server this is the database. On a collector it is an in-memory
 * roster synced from upstream, because §B11.1 is explicit that a collector
 * "runs no database … and holds no durable state beyond a small local spool".
 *
 * A single indirection rather than two copies of each watcher. The watchers ask
 * this module for their targets and never learn which mode they are in — which
 * is what makes the collector "the same application in reduced mode" rather
 * than a second codebase to keep in step.
 */

export interface PrinterTargetSource {
  pollTargets(): Promise<PrinterWithSecrets[]>;
  scanTargets(): Promise<PrinterWithSecrets[]>;
  find(printerId: number): Promise<PrinterWithSecrets | null>;
}

/** The central server's source: the database it owns. */
const databaseSource: PrinterTargetSource = {
  pollTargets: () => printersModel.listPollTargets(pool, null),
  scanTargets: () => printersModel.listScanWatchTargets(pool, null),
  find: (printerId) => printersModel.findWithSecrets(pool, printerId),
};

/**
 * The collector's source: a roster held in memory, refreshed from upstream.
 *
 * It carries SNMP credentials, because the collector is the only thing that can
 * reach these devices and it cannot poll them without. They live in memory for
 * the process lifetime and are never written to the spool or to disk (INV-08).
 */
class RemoteRoster implements PrinterTargetSource {
  private printers: PrinterWithSecrets[] = [];
  private lastSyncedAt = 0;

  replace(printers: PrinterWithSecrets[]): void {
    this.printers = printers;
    this.lastSyncedAt = Date.now();
    log.info({ count: printers.length }, 'printer roster synced from upstream');
  }

  pollTargets(): Promise<PrinterWithSecrets[]> {
    return Promise.resolve(
      this.printers.filter((printer) => printer.isActive && printer.snmpVersion !== 'disabled'),
    );
  }

  scanTargets(): Promise<PrinterWithSecrets[]> {
    return Promise.resolve(
      this.printers.filter((printer) => printer.isActive && Boolean(printer.scanFolder)),
    );
  }

  find(printerId: number): Promise<PrinterWithSecrets | null> {
    return Promise.resolve(this.printers.find((printer) => printer.id === printerId) ?? null);
  }

  get isStale(): boolean {
    // Five minutes without a successful sync. The roster is still used — a
    // stale list is far better than polling nothing — but it is worth saying.
    return this.lastSyncedAt > 0 && Date.now() - this.lastSyncedAt > 300_000;
  }

  get size(): number {
    return this.printers.length;
  }
}

export const remoteRoster = new RemoteRoster();

let active: PrinterTargetSource = databaseSource;

export function useRemoteRoster(): void {
  active = remoteRoster;
}

export function targets(): PrinterTargetSource {
  return active;
}

/**
 * Applies a status change.
 *
 * On the central server this writes to the database. On a collector there is no
 * database to write to — the status travels upstream in the next heartbeat
 * instead, which is why the roster entry is mutated in place.
 */
export async function recordStatus(
  printerId: number,
  status: PrinterWithSecrets['status'],
  stateReasons: readonly string[],
  options: { resetFailures?: boolean; incrementFailures?: boolean } = {},
): Promise<void> {
  if (!config.collector.mode) {
    await printersModel.setStatus(pool, printerId, status, stateReasons, options);
    return;
  }

  const printer = await remoteRoster.find(printerId);
  if (!printer) return;
  printer.status = status;
  printer.stateReasons = [...stateReasons];
  printer.consecutiveFailures = options.resetFailures
    ? 0
    : options.incrementFailures
      ? printer.consecutiveFailures + 1
      : printer.consecutiveFailures;
}
