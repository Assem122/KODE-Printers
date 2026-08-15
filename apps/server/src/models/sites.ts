import type { Site } from '@kode/shared';
import type { Db } from '../db/pool.js';

/** The sites table. Small enough that everything is unpaginated by design. */

interface SiteRow {
  id: number;
  code: string;
  name: string;
  address: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  printer_count: number;
}

const toSite = (row: SiteRow): Site => ({
  id: row.id,
  code: row.code,
  name: row.name,
  address: row.address,
  isActive: row.is_active,
  printerCount: row.printer_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT = `
  SELECT s.id, s.code, s.name, s.address, s.is_active, s.created_at, s.updated_at,
         (SELECT count(*)::int FROM printers p WHERE p.site_id = s.id AND p.is_active)
           AS printer_count
    FROM sites s
`;

export async function listSites(db: Db, includeInactive = false): Promise<Site[]> {
  const { rows } = await db.query<SiteRow>(
    `${SELECT} ${includeInactive ? '' : 'WHERE s.is_active'} ORDER BY s.name`,
  );
  return rows.map(toSite);
}

export async function findSite(db: Db, id: number): Promise<Site | null> {
  const { rows } = await db.query<SiteRow>(`${SELECT} WHERE s.id = $1`, [id]);
  const row = rows[0];
  return row ? toSite(row) : null;
}

export async function insertSite(
  db: Db,
  input: { code: string; name: string; address: string | null; isActive: boolean },
): Promise<Site> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO sites (code, name, address, is_active) VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.code, input.name, input.address, input.isActive],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('site insert returned no id');
  const site = await findSite(db, id);
  if (!site) throw new Error('site disappeared immediately after insert');
  return site;
}

const UPDATABLE: Readonly<Record<string, string>> = {
  code: 'code',
  name: 'name',
  address: 'address',
  isActive: 'is_active',
};

export async function updateSite(
  db: Db,
  id: number,
  patch: Record<string, unknown>,
): Promise<Site | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = UPDATABLE[key];
    if (!column) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }
  if (assignments.length === 0) return findSite(db, id);
  values.push(id);
  await db.query(`UPDATE sites SET ${assignments.join(', ')} WHERE id = $${values.length}`, values);
  return findSite(db, id);
}

export const sitesModel = {
  list: listSites,
  find: findSite,
  insert: insertSite,
  update: updateSite,
} as const;
