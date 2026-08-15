import type { Db } from '../db/pool.js';

/**
 * The outstanding-impression ledger (ADR-008, §B8.3).
 *
 * This is the store; the reconciliation algorithm lives in
 * `services/watchers/attribution.ts`. Splitting them keeps the algorithm pure
 * and unit-testable, which matters because it is the piece of this system most
 * likely to be implemented incorrectly and the piece whose defects corrupt the
 * audit record rather than merely annoying someone.
 *
 * Why the rows are in Postgres rather than a Map: an in-memory ledger is lost
 * on restart, and every app job in flight at that moment reappears as a
 * fabricated walk-up the instant its impressions reach the counter. The whole
 * point of the ledger is that the record can be trusted.
 */

export interface LedgerEntry {
  id: number;
  jobId: number;
  outstanding: number;
  expiresAt: string;
  createdAt: string;
}

/**
 * Expiry is generous and quantity-aware: sixty seconds of fixed overhead plus
 * two seconds per impression, capped at fifteen minutes.
 *
 * The cap exists solely to stop a job that silently failed from absorbing a
 * later genuine walk-up. It is explicitly *not* an estimate of how long
 * printing takes — that was the fixed-window design's mistake, and reconciling
 * against quantity rather than elapsed time is what replaced it.
 */
export function ledgerExpiry(impressions: number, now: Date = new Date()): Date {
  const seconds = Math.min(60 + impressions * 2, 15 * 60);
  return new Date(now.getTime() + seconds * 1000);
}

export async function addEntry(
  db: Db,
  printerId: number,
  jobId: number,
  impressions: number,
): Promise<void> {
  if (impressions <= 0) return;
  await db.query(
    `INSERT INTO impression_ledger (printer_id, job_id, outstanding, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [printerId, jobId, impressions, ledgerExpiry(impressions).toISOString()],
  );
}

/**
 * Live entries for a printer, oldest first.
 *
 * Row-locked because the counter watcher and a concurrent send could otherwise
 * both consume the same entry, which would double-count the absorption and
 * leak the difference into a phantom walk-up.
 */
export async function lockLiveEntries(db: Db, printerId: number): Promise<LedgerEntry[]> {
  const { rows } = await db.query<{
    id: number;
    job_id: number;
    outstanding: number;
    expires_at: string;
    created_at: string;
  }>(
    `SELECT id, job_id, outstanding, expires_at, created_at
       FROM impression_ledger
      WHERE printer_id = $1 AND expires_at > now() AND outstanding > 0
      ORDER BY created_at, id
      FOR UPDATE`,
    [printerId],
  );
  return rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    outstanding: row.outstanding,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}

export async function consumeEntry(db: Db, id: number, remaining: number): Promise<void> {
  if (remaining <= 0) {
    await db.query('DELETE FROM impression_ledger WHERE id = $1', [id]);
    return;
  }
  await db.query('UPDATE impression_ledger SET outstanding = $2 WHERE id = $1', [id, remaining]);
}

/** Drops entries past their cap. Called before every reconciliation. */
export async function expireEntries(db: Db, printerId?: number): Promise<number> {
  const { rowCount } = await db.query(
    printerId === undefined
      ? 'DELETE FROM impression_ledger WHERE expires_at <= now()'
      : 'DELETE FROM impression_ledger WHERE expires_at <= now() AND printer_id = $1',
    printerId === undefined ? [] : [printerId],
  );
  return rowCount ?? 0;
}

/** Removes a job's entry when its send failed, so nothing is wrongly absorbed. */
export async function dropEntriesForJob(db: Db, jobId: number): Promise<void> {
  await db.query('DELETE FROM impression_ledger WHERE job_id = $1', [jobId]);
}

export const ledgerModel = {
  add: addEntry,
  lockLive: lockLiveEntries,
  consume: consumeEntry,
  expire: expireEntries,
  dropForJob: dropEntriesForJob,
  expiryFor: ledgerExpiry,
} as const;
