import { errors, type Role } from '@kode/shared';
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';

/**
 * INV-01 — the single permission gate.
 *
 * "Printer permission is derived from the `user_printers` table and nothing
 * else. No route, service, model or report MUST re-derive access from
 * department, site, or any other field."
 *
 * That invariant exists because a previous department-string-matching approach
 * caused two parts of the system to disagree about who could print where. The
 * fix is not "be careful" — it is that every access question in the codebase
 * routes through this file, so there is exactly one implementation to be right
 * or wrong.
 *
 * `users.department` remains, for reporting only. It has no read path here, and
 * that absence is deliberate rather than accidental.
 */

export interface Actor {
  id: number;
  username: string;
  role: Role;
}

const isAdmin = (actor: Actor): boolean => actor.role === 'admin';

/**
 * Printer ids the actor may use.
 *
 * Returns `null` for an admin — meaning "unrestricted", which callers pass
 * straight through to the model layer as "apply no printer filter". A sentinel
 * of `null` rather than "every id" matters at fifty printers and would matter a
 * great deal more at five hundred.
 */
export async function permittedPrinterIds(actor: Actor, db: Db = pool): Promise<number[] | null> {
  if (isAdmin(actor)) return null;

  const { rows } = await db.query<{ printer_id: number }>(
    `SELECT up.printer_id
       FROM user_printers up
       JOIN printers p ON p.id = up.printer_id
      WHERE up.user_id = $1
        AND p.is_active
        AND (up.expires_at IS NULL OR up.expires_at > now())`,
    [actor.id],
  );
  return rows.map((row) => row.printer_id);
}

/**
 * Whether the actor may send a job to this printer.
 *
 * The expiry check is part of the grant, not a separate concern: temporary
 * access for an event contractor that silently outlives the event is the same
 * defect as never revoking it.
 */
export async function canUsePrinter(
  actor: Actor,
  printerId: number,
  db: Db = pool,
): Promise<boolean> {
  if (isAdmin(actor)) return true;

  // The `is_active` join matters: without it this function and
  // `permittedPrinterIds` answer the same question differently, which is
  // precisely the split INV-01 exists to prevent.
  const { rows } = await db.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM user_printers up
         JOIN printers p ON p.id = up.printer_id
        WHERE up.user_id = $1 AND up.printer_id = $2
          AND p.is_active
          AND (up.expires_at IS NULL OR up.expires_at > now())
     ) AS allowed`,
    [actor.id, printerId],
  );
  return rows[0]?.allowed ?? false;
}

/**
 * Throws `FORBIDDEN` when the actor may not use the printer.
 *
 * The message deliberately does not distinguish "no such printer" from "you may
 * not use it". A non-admin enumerating printer ids should learn nothing about
 * which exist.
 */
export async function assertCanUsePrinter(
  actor: Actor,
  printerId: number,
  db: Db = pool,
): Promise<void> {
  if (await canUsePrinter(actor, printerId, db)) return;
  throw errors.forbidden('You do not have access to this printer.');
}

/** Whether the actor may read this job. */
export async function canViewJob(
  actor: Actor,
  job: { userId: number | null; printerId: number | null; source: string },
  db: Db = pool,
): Promise<boolean> {
  if (isAdmin(actor)) return true;
  if (job.userId === actor.id) return true;
  // Walk-up activity on a permitted printer is visible: it is what lets someone
  // answer "why is the tray empty" without an admin, and it exposes no other
  // person's document names because walk-up jobs have none.
  if (job.source === 'walkup' && job.printerId !== null) {
    return canUsePrinter(actor, job.printerId, db);
  }
  return false;
}

export async function assertCanViewJob(
  actor: Actor,
  job: { userId: number | null; printerId: number | null; source: string },
  db: Db = pool,
): Promise<void> {
  if (await canViewJob(actor, job, db)) return;
  throw errors.forbidden('You do not have access to this job.');
}

/** Whether the actor may claim or download this scan. */
export async function canAccessScan(
  actor: Actor,
  scan: { userId: number | null; printerId: number | null; status: string },
  db: Db = pool,
): Promise<boolean> {
  if (isAdmin(actor)) return true;
  if (scan.userId === actor.id) return true;
  // An unclaimed scan on a permitted printer is collectable — that is the
  // inbox. A scan already claimed by someone else is not.
  if (scan.status === 'unclaimed' && scan.printerId !== null) {
    return canUsePrinter(actor, scan.printerId, db);
  }
  return false;
}

export async function assertCanAccessScan(
  actor: Actor,
  scan: { userId: number | null; printerId: number | null; status: string },
  db: Db = pool,
): Promise<void> {
  if (await canAccessScan(actor, scan, db)) return;
  throw errors.forbidden('You do not have access to this scan.');
}

export function assertAdmin(actor: Actor): void {
  if (isAdmin(actor)) return;
  throw errors.forbidden('This action requires an administrator account.');
}
