import type { Paginated, Scan, ScanStatus } from '@kode/shared';
import type { Db } from '../db/pool.js';
import { applyKeyset, toPage, WhereBuilder } from '../db/sql.js';

/**
 * The scan hub.
 *
 * §B9 specifies scan *detection* — the watcher observes a folder and logs what
 * arrives. This table carries that further into something staff actually open:
 * an inbox where a scan can be claimed, previewed and downloaded.
 *
 * The ownership rule is the interesting part. A file dropped into an SMB share
 * by printer firmware carries no identity, so a scan starts `unclaimed`. Two
 * paths give it an owner: a reservation the user made before walking to the
 * device (`claimed_via = 'reservation'`), or an explicit claim afterwards
 * (`'manual'`). Recording *which* matters, because a reservation-assigned scan
 * was matched by a rule and a manually claimed one was asserted by a person.
 */

interface ScanRow {
  id: number;
  printer_id: number | null;
  printer_name_snapshot: string;
  site_id: number | null;
  user_id: number | null;
  username_snapshot: string | null;
  status: ScanStatus;
  original_filename: string;
  stored_filename: string;
  size_bytes: number;
  page_count: number | null;
  content_type: string;
  claimed_via: 'reservation' | 'manual' | null;
  scanned_at: string;
  claimed_at: string | null;
  created_at: string;
}

const toScan = (row: ScanRow): Scan => ({
  id: row.id,
  printerId: row.printer_id,
  printerNameSnapshot: row.printer_name_snapshot,
  siteId: row.site_id,
  userId: row.user_id,
  usernameSnapshot: row.username_snapshot,
  status: row.status,
  originalFilename: row.original_filename,
  storedFilename: row.stored_filename,
  sizeBytes: row.size_bytes,
  pageCount: row.page_count,
  contentType: row.content_type,
  claimedVia: row.claimed_via,
  scannedAt: row.scanned_at,
  claimedAt: row.claimed_at,
  createdAt: row.created_at,
});

const COLUMNS = `
  s.id, s.printer_id, s.printer_name_snapshot, s.site_id, s.user_id, s.username_snapshot,
  s.status, s.original_filename, s.stored_filename, s.size_bytes, s.page_count,
  s.content_type, s.claimed_via, s.scanned_at, s.claimed_at, s.created_at
`;

export interface ScanInsert {
  printerId: number | null;
  printerNameSnapshot: string;
  siteId: number | null;
  originalFilename: string;
  storedFilename: string;
  sizeBytes: number;
  pageCount: number | null;
  contentType: string;
  fileHash: string | null;
  scannedAt: Date;
}

/**
 * Returns null when the scan is a duplicate.
 *
 * §B9.2 dedupes on `(printer, filename, size, scanned_at)` rather than filename
 * alone, because many MFPs restart their filename sequence after a reboot and
 * would otherwise collide `scan001.pdf` with a scan from last month.
 */
export async function insertScan(db: Db, input: ScanInsert): Promise<Scan | null> {
  const { rows } = await db.query<ScanRow>(
    `INSERT INTO scans (printer_id, printer_name_snapshot, site_id, original_filename,
                        stored_filename, size_bytes, page_count, content_type, file_hash, scanned_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (printer_id, original_filename, size_bytes, scanned_at) DO NOTHING
     RETURNING ${COLUMNS.replace(/s\./g, '')}`,
    [
      input.printerId,
      input.printerNameSnapshot,
      input.siteId,
      input.originalFilename,
      input.storedFilename,
      input.sizeBytes,
      input.pageCount,
      input.contentType,
      input.fileHash,
      input.scannedAt.toISOString(),
    ],
  );
  const row = rows[0];
  return row ? toScan(row) : null;
}

export interface ScanFilter {
  printerId?: number | undefined;
  status?: ScanStatus | undefined;
  /** Restricts to scans this user owns. */
  ownUserId?: number | undefined;
  /** Non-admins may only see scans on printers they are permitted to use. */
  permittedPrinterIds?: readonly number[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listScans(db: Db, filter: ScanFilter): Promise<Paginated<Scan>> {
  const where = new WhereBuilder();
  where.addIf(filter.printerId, 's.printer_id = ?', filter.printerId);
  where.addIf(filter.status, 's.status = ?', filter.status);
  where.addIf(filter.from, 's.created_at >= ?::timestamptz', filter.from);
  where.addIf(filter.to, "s.created_at < (?::timestamptz + interval '1 day')", filter.to);
  if (filter.permittedPrinterIds) {
    where.add('s.printer_id = ANY(?::int[])', [...filter.permittedPrinterIds]);
  }
  if (filter.ownUserId !== undefined) {
    // A user sees their own scans and anything still unclaimed on a permitted
    // printer — the latter is the inbox they walk over to collect from.
    where.add("(s.user_id = ? OR s.status = 'unclaimed')", filter.ownUserId);
  }

  const limit = applyKeyset(where, {
    cursor: filter.cursor,
    limit: filter.limit,
    timestampColumn: 's.created_at',
    idColumn: 's.id',
  });
  const limitParam = where.push(limit + 1);

  const { rows } = await db.query<ScanRow>(
    `SELECT ${COLUMNS} FROM scans s ${where.sql}
      ORDER BY s.created_at DESC, s.id DESC LIMIT ${limitParam}`,
    where.params,
  );
  return toPage(rows.map(toScan), limit, (scan) => ({ t: scan.createdAt, i: scan.id }));
}

export async function findScan(db: Db, id: number): Promise<Scan | null> {
  const { rows } = await db.query<ScanRow>(`SELECT ${COLUMNS} FROM scans s WHERE s.id = $1`, [id]);
  const row = rows[0];
  return row ? toScan(row) : null;
}

export async function claimScan(
  db: Db,
  id: number,
  userId: number,
  username: string,
  via: 'reservation' | 'manual',
): Promise<Scan | null> {
  const { rows } = await db.query<ScanRow>(
    `UPDATE scans
        SET user_id = $2, username_snapshot = $3, status = 'claimed',
            claimed_at = now(), claimed_via = $4
      WHERE id = $1 AND status = 'unclaimed'
      RETURNING ${COLUMNS.replace(/s\./g, '')}`,
    [id, userId, username, via],
  );
  const row = rows[0];
  return row ? toScan(row) : null;
}

export async function archiveScan(db: Db, id: number): Promise<void> {
  await db.query(`UPDATE scans SET status = 'archived' WHERE id = $1`, [id]);
}

/* --------------------------------------------------------- scan-to-me       */

export async function createReservation(
  db: Db,
  printerId: number,
  userId: number,
  minutes: number,
): Promise<boolean> {
  // The partial unique index allows exactly one live reservation per printer.
  // A second person claiming the same device is refused rather than guessed at:
  // a folder drop carries no identity, so a wrong guess files someone's
  // passport scan into a stranger's inbox.
  const { rowCount } = await db.query(
    `INSERT INTO scan_reservations (printer_id, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))
     ON CONFLICT DO NOTHING`,
    [printerId, userId, minutes],
  );
  return (rowCount ?? 0) > 0;
}

export async function consumeReservation(
  db: Db,
  printerId: number,
): Promise<{ userId: number; username: string } | null> {
  const { rows } = await db.query<{ user_id: number; username: string }>(
    `UPDATE scan_reservations r
        SET consumed_at = now()
       FROM users u
      WHERE r.id = (
        SELECT id FROM scan_reservations
         WHERE printer_id = $1 AND consumed_at IS NULL AND expires_at > now()
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        AND u.id = r.user_id
      RETURNING r.user_id, u.username::text AS username`,
    [printerId],
  );
  const row = rows[0];
  return row ? { userId: row.user_id, username: row.username } : null;
}

/** Expires stale reservations so the partial unique index frees up. */
export async function expireReservations(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE scan_reservations SET consumed_at = now()
      WHERE consumed_at IS NULL AND expires_at <= now()`,
  );
  return rowCount ?? 0;
}

export async function activeReservation(
  db: Db,
  printerId: number,
): Promise<{ userId: number; expiresAt: string } | null> {
  const { rows } = await db.query<{ user_id: number; expires_at: string }>(
    `SELECT user_id, expires_at FROM scan_reservations
      WHERE printer_id = $1 AND consumed_at IS NULL AND expires_at > now() LIMIT 1`,
    [printerId],
  );
  const row = rows[0];
  return row ? { userId: row.user_id, expiresAt: row.expires_at } : null;
}

export async function listPurgeableScans(
  db: Db,
  retentionDays: number,
  limit = 500,
): Promise<Array<{ id: number; storedFilename: string }>> {
  const { rows } = await db.query<{ id: number; stored_filename: string }>(
    `SELECT id, stored_filename FROM scans
      WHERE created_at < now() - make_interval(days => $1)
      ORDER BY created_at LIMIT $2`,
    [retentionDays, limit],
  );
  return rows.map((row) => ({ id: row.id, storedFilename: row.stored_filename }));
}

export async function deleteScanRecord(db: Db, id: number): Promise<void> {
  await db.query('DELETE FROM scans WHERE id = $1', [id]);
}

export const scansModel = {
  insert: insertScan,
  list: listScans,
  find: findScan,
  claim: claimScan,
  archive: archiveScan,
  createReservation,
  consumeReservation,
  expireReservations,
  activeReservation,
  listPurgeable: listPurgeableScans,
  remove: deleteScanRecord,
} as const;
