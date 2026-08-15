import { createHash } from 'node:crypto';
import { open, readdir, rename, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeFilename, fileExtension } from '@kode/shared';
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import type { PrinterWithSecrets } from '../../models/printers.js';
import { scansModel } from '../../models/scans.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';
import { recordScanEvent } from '../collector/agent.js';
import { targets } from '../collector/registry.js';
import { events } from '../events.js';
import { notify } from '../notify.js';
import { countPdfPages } from '../pipeline/prepare.js';

const log = subsystem('watcher:scan');

/**
 * Scan detection (§B9, ADR-009).
 *
 * A printer cannot tell this application that someone pressed Scan; it can only
 * be configured to push the file somewhere reachable. So an admin points the
 * device's "Scan to Network Folder" at a share on this host, the same path goes
 * into the printer record, and this watcher observes what arrives.
 *
 * The system observes; it does not initiate. There is no scan-triggering flow,
 * because no cross-vendor protocol exists to start a scan remotely.
 *
 * ── The stability gate ────────────────────────────────────────────────────
 *
 * A file appearing in an SMB share is visible *before* its write completes. The
 * delivered watcher could ingest a half-written scan — logging a 40 KB
 * fragment of a 3 MB document and moving it out from under the printer's own
 * write. Three conditions must all hold before a file is touched.
 */

interface WatchState {
  timer: NodeJS.Timeout | null;
  /** Files seen but not yet stable: path → last observed size and mtime. */
  pending: Map<string, { size: number; mtimeMs: number; seenAt: number }>;
}

const watchers = new Map<number, WatchState>();
let stopping = false;

/** Editor and transfer temporaries that are never a finished scan. */
const TEMP_PATTERNS: readonly RegExp[] = [
  /\.tmp$/i,
  /\.part$/i,
  /\.filepart$/i,
  /\.crdownload$/i,
  /^~\$/,
  /^\./,
  /\.swp$/i,
];

export async function startScanWatcher(collectorId: number | null = null): Promise<void> {
  if (!config.polling.enabled) return;
  stopping = false;
  await refreshTargets(collectorId);

  const refresh = setInterval(() => void refreshTargets(collectorId), 60_000);
  refresh.unref();
}

export function stopScanWatcher(): void {
  stopping = true;
  for (const state of watchers.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  watchers.clear();
}

async function refreshTargets(collectorId: number | null): Promise<void> {
  if (stopping) return;
  try {
    void collectorId; // the source already knows which estate it serves
    const printers = await targets().scanTargets();
    const live = new Set(printers.map((printer) => printer.id));

    for (const [id, state] of watchers) {
      if (live.has(id)) continue;
      if (state.timer) clearTimeout(state.timer);
      watchers.delete(id);
    }

    for (const printer of printers) {
      if (watchers.has(printer.id)) continue;
      watchers.set(printer.id, { timer: null, pending: new Map() });
      scheduleSweep(printer.id, 0);
    }
  } catch (error) {
    log.error({ ...serialiseError(error) }, 'could not refresh scan watch targets');
  }
}

function scheduleSweep(printerId: number, delayMs: number): void {
  if (stopping) return;
  const state = watchers.get(printerId);
  if (!state) return;
  state.timer = setTimeout(() => void sweep(printerId), delayMs);
  state.timer.unref();
}

async function sweep(printerId: number): Promise<void> {
  const state = watchers.get(printerId);
  if (!state || stopping) return;

  const printer = await targets()
    .find(printerId)
    .catch(() => null);
  if (!printer?.scanFolder) {
    watchers.delete(printerId);
    return;
  }

  try {
    await sweepFolder(printer, printer.scanFolder, state);
    scheduleSweep(printerId, config.polling.scanIntervalMs);
  } catch (error) {
    log.warn({ printerId, ...serialiseError(error) }, 'scan folder sweep failed');
    await notify(
      {
        type: 'scan.folder_unreachable',
        severity: 'warning',
        printerId,
        message: `The scan folder for ${printer.name} could not be read. Scans are not being tracked.`,
        dedupeKey: `printer:${printerId}:scan-folder`,
      },
      pool,
    );
    // §B14: warn, retry with backoff, log no job, record the gap.
    scheduleSweep(printerId, Math.min(60_000, config.polling.scanIntervalMs * 8));
  }
}

async function sweepFolder(
  printer: PrinterWithSecrets,
  folder: string,
  state: WatchState,
): Promise<void> {
  const entries = await readdir(folder, { withFileTypes: true });
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;

    // Condition 1 — the name is not a temporary.
    if (TEMP_PATTERNS.some((pattern) => pattern.test(name))) continue;

    const path = join(folder, name);
    let info;
    try {
      info = await stat(path);
    } catch {
      continue; // Vanished between readdir and stat; the device moved it.
    }

    const previous = state.pending.get(path);

    // Condition 2 — size and mtime unchanged across two polls at least
    // SCAN_STABILITY_MS apart. A fixed delay before ingestion was rejected in
    // ADR-009 because it guesses at write duration and fails for large scans.
    if (previous?.size !== info.size || previous.mtimeMs !== info.mtimeMs) {
      state.pending.set(path, { size: info.size, mtimeMs: info.mtimeMs, seenAt: now });
      continue;
    }

    if (now - previous.seenAt < config.polling.scanStabilityMs) continue;

    // Condition 3 — the file can be opened for exclusive read. On Windows this
    // alone catches most in-progress writes, and it costs one syscall.
    if (!(await canOpenExclusively(path))) continue;

    state.pending.delete(path);
    await ingest(printer, path, info.size, info.mtime);
  }

  // Forget entries for files that have gone, so the map does not grow.
  const present = new Set(entries.filter((e) => e.isFile()).map((e) => join(folder, e.name)));
  for (const path of state.pending.keys()) {
    if (!present.has(path)) state.pending.delete(path);
  }
}

async function canOpenExclusively(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r+');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Records the scan and moves the file into managed storage.
 *
 * Moved, not deleted. ADR-009 is explicit and right: a scan is a document the
 * club may need, and deleting a member's scanned passport because it has been
 * counted is not this system's decision to make. Retention removes it later,
 * on a policy an administrator set.
 */
async function ingest(
  printer: PrinterWithSecrets,
  sourcePath: string,
  sizeBytes: number,
  mtime: Date,
): Promise<void> {
  const originalFilename = sanitizeFilename(basename(sourcePath), 'scan');
  const extension = fileExtension(originalFilename) || 'pdf';

  /* On a collector, the metadata travels and the file stays.
   *
   * §B11.2 puts the database of record on the central server, so the scan row
   * is created there. The file itself remains on the local share, which is
   * where the person who scanned it is standing — shipping a 3 MB PDF across a
   * constrained inter-building link so they can download it back over the same
   * link would be the wrong trade. */
  if (config.collector.mode) {
    await recordScanEvent({
      printerId: printer.id,
      filename: originalFilename,
      sizeBytes,
      contentType: extension === 'pdf' ? 'application/pdf' : `image/${extension}`,
    });
    log.info({ printerId: printer.id, originalFilename }, 'scan observed, reported upstream');
    return;
  }

  const storedFilename = `${new Date().toISOString().slice(0, 10)}-${randomUUID()}.${extension}`;
  const destination = join(config.storage.scanDir, storedFilename);

  // Confining the destination is defence against a filename that survived
  // sanitisation with traversal intact. §B16.3 treats printer-supplied
  // filenames as untrusted input, and this is the last place that matters.
  if (!resolve(destination).startsWith(resolve(config.storage.scanDir))) {
    log.error({ originalFilename }, 'refusing to write a scan outside the scan directory');
    return;
  }

  const scan = await scansModel.insert(pool, {
    printerId: printer.id,
    printerNameSnapshot: printer.name,
    siteId: printer.siteId,
    originalFilename,
    storedFilename,
    sizeBytes,
    pageCount: null,
    contentType: extension === 'pdf' ? 'application/pdf' : `image/${extension}`,
    fileHash: null,
    scannedAt: mtime,
  });

  if (!scan) {
    // Deduplicated — the same file was already ingested. Nothing to move.
    log.debug({ originalFilename, printerId: printer.id }, 'duplicate scan ignored');
    return;
  }

  try {
    await rename(sourcePath, destination);
  } catch (error) {
    // Cross-device rename fails on some SMB mounts; without the file the row is
    // a dangling record, so it is removed rather than left pointing at nothing.
    log.error({ ...serialiseError(error) }, 'could not move scan into storage');
    await scansModel.remove(pool, scan.id);
    return;
  }

  const enriched = await enrich(scan.id, destination, extension);

  // Scan-to-me: if someone reserved this device before walking over, the scan
  // is theirs. §B9 has no such flow — it is what turns a logging feature into
  // one people open.
  const reservation = await scansModel.consumeReservation(pool, printer.id);
  if (reservation) {
    const claimed = await scansModel.claim(
      pool,
      scan.id,
      reservation.userId,
      reservation.username,
      'reservation',
    );
    if (claimed) {
      events.scanCreated(claimed);
      await notify(
        {
          type: 'scan.ready',
          severity: 'info',
          printerId: printer.id,
          userId: reservation.userId,
          message: `Your scan from ${printer.name} is ready${enriched ? ` — ${enriched} page${enriched === 1 ? '' : 's'}` : ''}.`,
          push: true,
        },
        pool,
      );
      return;
    }
  }

  events.scanCreated(scan);
  log.info({ scanId: scan.id, printerId: printer.id, sizeBytes }, 'scan ingested');
}

/** Fills in the page count once the file is in managed storage. */
async function enrich(scanId: number, path: string, extension: string): Promise<number | null> {
  if (extension !== 'pdf') return null;
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(path);
    const { pages } = await countPdfPages(content);
    await pool.query('UPDATE scans SET page_count = $2, file_hash = $3 WHERE id = $1', [
      scanId,
      pages,
      createHash('sha256').update(content).digest('hex'),
    ]);
    return pages;
  } catch {
    // A page count is a convenience. The scan itself is what matters.
    return null;
  }
}
