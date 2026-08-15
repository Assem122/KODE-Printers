import type { Quota, QuotaPeriod, QuotaScope } from '@kode/shared';
import type { Db } from '../db/pool.js';
import { quotaUsage } from './stats.js';

/**
 * Page quotas (§B4.10, DEC-05).
 *
 * Shipped with `enforce = FALSE` everywhere. The reasoning in the document is
 * sound and worth keeping visible: the club should see what it actually
 * consumes before deciding to restrict it, because a limit chosen without data
 * either blocks legitimate work or never binds.
 */

interface QuotaRow {
  id: number;
  scope: QuotaScope;
  scope_ref: string;
  period: QuotaPeriod;
  page_limit: number;
  enforce: boolean;
  created_at: string;
}

const toQuota = (row: QuotaRow): Quota => ({
  id: row.id,
  scope: row.scope,
  scopeRef: row.scope_ref,
  period: row.period,
  pageLimit: row.page_limit,
  enforce: row.enforce,
  createdAt: row.created_at,
});

export async function listQuotas(db: Db, withUsage = true): Promise<Quota[]> {
  const { rows } = await db.query<QuotaRow>(
    `SELECT id, scope, scope_ref, period, page_limit, enforce, created_at
       FROM quotas ORDER BY scope, scope_ref`,
  );
  const quotas = rows.map(toQuota);
  if (!withUsage) return quotas;

  return Promise.all(
    quotas.map(async (quota) => ({
      ...quota,
      usedPages: await quotaUsage(db, quota.scope, quota.scopeRef, quota.period),
    })),
  );
}

export async function insertQuota(
  db: Db,
  input: {
    scope: QuotaScope;
    scopeRef: string;
    period: QuotaPeriod;
    pageLimit: number;
    enforce: boolean;
  },
): Promise<Quota> {
  const { rows } = await db.query<QuotaRow>(
    `INSERT INTO quotas (scope, scope_ref, period, page_limit, enforce)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (scope, scope_ref, period)
     DO UPDATE SET page_limit = EXCLUDED.page_limit, enforce = EXCLUDED.enforce
     RETURNING id, scope, scope_ref, period, page_limit, enforce, created_at`,
    [input.scope, input.scopeRef, input.period, input.pageLimit, input.enforce],
  );
  const row = rows[0];
  if (!row) throw new Error('quota upsert returned no row');
  return toQuota(row);
}

export async function findQuota(db: Db, id: number): Promise<Quota | null> {
  const { rows } = await db.query<QuotaRow>(
    `SELECT id, scope, scope_ref, period, page_limit, enforce, created_at
       FROM quotas WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toQuota(row) : null;
}

export async function updateQuota(
  db: Db,
  id: number,
  patch: { pageLimit?: number; enforce?: boolean },
): Promise<Quota | null> {
  const { rows } = await db.query<QuotaRow>(
    `UPDATE quotas
        SET page_limit = COALESCE($2, page_limit),
            enforce    = COALESCE($3, enforce),
            updated_at = now()
      WHERE id = $1
      RETURNING id, scope, scope_ref, period, page_limit, enforce, created_at`,
    [id, patch.pageLimit ?? null, patch.enforce ?? null],
  );
  const row = rows[0];
  return row ? toQuota(row) : null;
}

export async function deleteQuota(db: Db, id: number): Promise<void> {
  await db.query('DELETE FROM quotas WHERE id = $1', [id]);
}

/**
 * Every enforcing quota that applies to a user, with current consumption.
 *
 * Returns *all* matches rather than the tightest one, because a user can be
 * bound by a personal limit and a departmental one simultaneously and the
 * message should name whichever actually blocked them.
 */
export async function enforcingQuotasFor(
  db: Db,
  user: { id: number; department: string | null },
  siteId: number | null,
): Promise<Array<Quota & { usedPages: number }>> {
  const { rows } = await db.query<QuotaRow>(
    `SELECT id, scope, scope_ref, period, page_limit, enforce, created_at
       FROM quotas
      WHERE enforce
        AND ((scope = 'user'       AND scope_ref = $1)
          OR (scope = 'department' AND scope_ref = $2::text)
          OR (scope = 'site'       AND scope_ref = $3::text))`,
    // NULL rather than a sentinel string: `scope_ref = NULL` is never true, so a
    // user with no department simply matches no departmental quota. A sentinel
    // would collide the moment someone named a department after it, and Postgres
    // rejects a NUL byte inside a text parameter outright.
    [String(user.id), user.department, siteId === null ? null : String(siteId)],
  );

  return Promise.all(
    rows.map(toQuota).map(async (quota) => ({
      ...quota,
      usedPages: await quotaUsage(db, quota.scope, quota.scopeRef, quota.period),
    })),
  );
}

export const quotasModel = {
  list: listQuotas,
  find: findQuota,
  insert: insertQuota,
  update: updateQuota,
  remove: deleteQuota,
  enforcingFor: enforcingQuotasFor,
} as const;
