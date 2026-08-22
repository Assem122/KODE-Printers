import type { Zone } from '@kode/shared';
import type { Db } from '../db/pool.js';

/** The zones table. Small enough that everything is unpaginated by design. */

interface ZoneRow {
  id: number;
  code: string;
  label: string;
  is_active: boolean;
  created_at: string;
  printer_count: number;
}

const toZone = (row: ZoneRow): Zone => ({
  id: row.id,
  code: row.code,
  label: row.label,
  isActive: row.is_active,
  printerCount: row.printer_count,
  createdAt: row.created_at,
});

const SELECT = `
  SELECT z.id, z.code, z.label, z.is_active, z.created_at,
         (SELECT count(*)::int FROM printers p WHERE p.zone_id = z.id AND p.is_active)
           AS printer_count
    FROM zones z
`;

export async function listZones(db: Db, includeInactive = false): Promise<Zone[]> {
  const { rows } = await db.query<ZoneRow>(
    `${SELECT} ${includeInactive ? '' : 'WHERE z.is_active'} ORDER BY z.label`,
  );
  return rows.map(toZone);
}

export async function findZone(db: Db, id: number): Promise<Zone | null> {
  const { rows } = await db.query<ZoneRow>(`${SELECT} WHERE z.id = $1`, [id]);
  const row = rows[0];
  return row ? toZone(row) : null;
}

export async function insertZone(
  db: Db,
  input: { code: string; label: string; isActive: boolean },
): Promise<Zone> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO zones (code, label, is_active) VALUES ($1,$2,$3) RETURNING id`,
    [input.code, input.label, input.isActive],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('zone insert returned no id');
  const zone = await findZone(db, id);
  if (!zone) throw new Error('zone disappeared immediately after insert');
  return zone;
}

const UPDATABLE: Readonly<Record<string, string>> = {
  code: 'code',
  label: 'label',
  isActive: 'is_active',
};

export async function updateZone(
  db: Db,
  id: number,
  patch: Record<string, unknown>,
): Promise<Zone | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = UPDATABLE[key];
    if (!column) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }
  if (assignments.length === 0) return findZone(db, id);
  values.push(id);
  await db.query(`UPDATE zones SET ${assignments.join(', ')} WHERE id = $${values.length}`, values);
  return findZone(db, id);
}

export const zonesModel = {
  list: listZones,
  find: findZone,
  insert: insertZone,
  update: updateZone,
} as const;
