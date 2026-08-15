import type { Notification, Paginated, Severity } from '@kode/shared';
import type { Db } from '../db/pool.js';
import { applyKeyset, toPage, WhereBuilder } from '../db/sql.js';

/**
 * Persisted notifications with per-user read state (ADR-011).
 *
 * The delivered build kept these in an in-memory FIFO, which loses everything
 * on restart and has no per-admin read state — so with two admins watching, one
 * marking an alert read hid it from the other. Both problems disappear once the
 * rows live in Postgres and `notification_reads` is a separate table.
 *
 * `dedupe_key` is the addition that makes the feature usable rather than
 * merely correct: an offline printer polled every fifteen seconds would
 * otherwise generate 240 identical rows an hour. With a key, the row's
 * `occurrences` count rises and the notification centre stays readable.
 */

interface NotificationRow {
  id: number;
  type: string;
  severity: Severity;
  printer_id: number | null;
  printer_name: string | null;
  job_id: number | null;
  message: string;
  payload: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
}

const toNotification = (row: NotificationRow): Notification => ({
  id: row.id,
  type: row.type,
  severity: row.severity,
  printerId: row.printer_id,
  printerName: row.printer_name,
  jobId: row.job_id,
  message: row.message,
  payload: row.payload,
  isRead: row.is_read,
  createdAt: row.created_at,
});

export interface NotificationWrite {
  type: string;
  severity: Severity;
  message: string;
  printerId?: number | null;
  jobId?: number | null;
  /** Set for a user-directed notification; null makes it an admin-wide alert. */
  userId?: number | null;
  payload?: Record<string, unknown> | null;
  /**
   * Stable identity for a recurring condition, e.g. `printer:12:offline`.
   * Repeats update the existing row rather than creating a new one.
   */
  dedupeKey?: string | null;
}

export async function createNotification(
  db: Db,
  input: NotificationWrite,
): Promise<Notification | null> {
  const { rows } = await db.query<NotificationRow>(
    `INSERT INTO notifications (type, severity, printer_id, job_id, user_id, message, payload, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
     DO UPDATE SET occurrences = notifications.occurrences + 1,
                   last_at = now(),
                   message = EXCLUDED.message,
                   severity = EXCLUDED.severity
     RETURNING id, type, severity, printer_id, NULL::text AS printer_name, job_id,
               message, payload, FALSE AS is_read, created_at`,
    [
      input.type,
      input.severity,
      input.printerId ?? null,
      input.jobId ?? null,
      input.userId ?? null,
      input.message,
      input.payload ? JSON.stringify(input.payload) : null,
      input.dedupeKey ?? null,
    ],
  );
  const row = rows[0];
  return row ? toNotification(row) : null;
}

/** Clears a dedupe key so the next occurrence raises a fresh notification. */
export async function resolveDedupeKey(db: Db, dedupeKey: string): Promise<void> {
  await db.query(`UPDATE notifications SET dedupe_key = NULL WHERE dedupe_key = $1`, [dedupeKey]);
}

export interface NotificationFilter {
  userId: number;
  isAdmin: boolean;
  severity?: Severity | undefined;
  unreadOnly?: boolean | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listNotifications(
  db: Db,
  filter: NotificationFilter,
): Promise<Paginated<Notification>> {
  const where = new WhereBuilder();

  // Admins see operational alerts (user_id IS NULL) plus anything addressed to
  // them. A non-admin sees only their own — a user does not need to know that
  // the pro-shop printer is low on cyan.
  if (filter.isAdmin) where.add('(n.user_id IS NULL OR n.user_id = ?)', filter.userId);
  else where.add('n.user_id = ?', filter.userId);

  where.addIf(filter.severity, 'n.severity = ?', filter.severity);
  if (filter.unreadOnly) {
    where.add(
      'NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?)',
      filter.userId,
    );
  }

  const limit = applyKeyset(where, {
    cursor: filter.cursor,
    limit: filter.limit,
    timestampColumn: 'n.created_at',
    idColumn: 'n.id',
  });
  const readerParam = where.push(filter.userId);
  const limitParam = where.push(limit + 1);

  const { rows } = await db.query<NotificationRow>(
    `SELECT n.id, n.type, n.severity, n.printer_id, p.name AS printer_name, n.job_id,
            n.message, n.payload,
            EXISTS (SELECT 1 FROM notification_reads r
                     WHERE r.notification_id = n.id AND r.user_id = ${readerParam}) AS is_read,
            n.created_at
       FROM notifications n
       LEFT JOIN printers p ON p.id = n.printer_id
       ${where.sql}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ${limitParam}`,
    where.params,
  );

  return toPage(rows.map(toNotification), limit, (n) => ({ t: n.createdAt, i: n.id }));
}

export async function countUnread(db: Db, userId: number, isAdmin: boolean): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM notifications n
      WHERE ${isAdmin ? '(n.user_id IS NULL OR n.user_id = $1)' : 'n.user_id = $1'}
        AND NOT EXISTS (
          SELECT 1 FROM notification_reads r
           WHERE r.notification_id = n.id AND r.user_id = $1)`,
    [userId],
  );
  return rows[0]?.count ?? 0;
}

export async function markRead(db: Db, notificationId: number, userId: number): Promise<void> {
  await db.query(
    `INSERT INTO notification_reads (notification_id, user_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [notificationId, userId],
  );
}

export async function markAllRead(db: Db, userId: number, isAdmin: boolean): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO notification_reads (notification_id, user_id)
     SELECT n.id, $1 FROM notifications n
      WHERE ${isAdmin ? '(n.user_id IS NULL OR n.user_id = $1)' : 'n.user_id = $1'}
     ON CONFLICT DO NOTHING`,
    [userId],
  );
  return rowCount ?? 0;
}

export async function purgeOldNotifications(db: Db, retentionDays: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM notifications
      WHERE created_at < now() - make_interval(days => $1)
        AND severity <> 'critical'`,
    [retentionDays],
  );
  return rowCount ?? 0;
}

export const notificationsModel = {
  create: createNotification,
  resolveDedupeKey,
  list: listNotifications,
  countUnread,
  markRead,
  markAllRead,
  purgeOld: purgeOldNotifications,
} as const;
