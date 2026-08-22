import type { PrintOptions, PrintTemplate } from '@kode/shared';
import type { Db } from '../db/pool.js';

/**
 * Quick-print templates.
 *
 * The club prints the same handful of documents constantly — membership forms,
 * day passes, court booking sheets, incident reports. An admin uploads each
 * once with its correct settings, and staff print it in one tap without hunting
 * for the current version on a shared drive. That last part is the real win:
 * it makes "which version is current" a question with one answer.
 */

interface TemplateRow {
  id: number;
  name: string;
  description: string | null;
  stored_filename: string;
  original_filename: string;
  page_count: number | null;
  default_options: Partial<PrintOptions> | null;
  zone_id: number | null;
  is_active: boolean;
  times_used: number;
  created_at: string;
}

const toTemplate = (row: TemplateRow): PrintTemplate => ({
  id: row.id,
  name: row.name,
  description: row.description,
  storedFilename: row.stored_filename,
  originalFilename: row.original_filename,
  pageCount: row.page_count,
  defaultOptions: row.default_options ?? {},
  zoneId: row.zone_id,
  isActive: row.is_active,
  timesUsed: row.times_used,
  createdAt: row.created_at,
});

const COLUMNS = `
  id, name, description, stored_filename, original_filename, page_count,
  default_options, zone_id, is_active, times_used, created_at
`;

export async function listTemplates(db: Db, includeInactive = false): Promise<PrintTemplate[]> {
  const { rows } = await db.query<TemplateRow>(
    `SELECT ${COLUMNS} FROM print_templates
      ${includeInactive ? '' : 'WHERE is_active'}
      ORDER BY times_used DESC, name`,
  );
  return rows.map(toTemplate);
}

export async function findTemplate(db: Db, id: number): Promise<PrintTemplate | null> {
  const { rows } = await db.query<TemplateRow>(
    `SELECT ${COLUMNS} FROM print_templates WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toTemplate(row) : null;
}

export async function insertTemplate(
  db: Db,
  input: {
    name: string;
    description: string | null;
    storedFilename: string;
    originalFilename: string;
    fileHash: string | null;
    pageCount: number | null;
    defaultOptions: Partial<PrintOptions>;
    zoneId: number | null;
    createdBy: number | null;
  },
): Promise<PrintTemplate> {
  const { rows } = await db.query<TemplateRow>(
    `INSERT INTO print_templates (name, description, stored_filename, original_filename,
                                  file_hash, page_count, default_options, zone_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
     RETURNING ${COLUMNS}`,
    [
      input.name,
      input.description,
      input.storedFilename,
      input.originalFilename,
      input.fileHash,
      input.pageCount,
      JSON.stringify(input.defaultOptions),
      input.zoneId,
      input.createdBy,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('template insert returned no row');
  return toTemplate(row);
}

export async function updateTemplate(
  db: Db,
  id: number,
  patch: {
    name?: string;
    description?: string | null;
    defaultOptions?: Partial<PrintOptions>;
    zoneId?: number | null;
    isActive?: boolean;
  },
): Promise<PrintTemplate | null> {
  const { rows } = await db.query<TemplateRow>(
    `UPDATE print_templates
        SET name            = COALESCE($2, name),
            description     = COALESCE($3, description),
            default_options = COALESCE($4::jsonb, default_options),
            zone_id         = COALESCE($5, zone_id),
            is_active       = COALESCE($6, is_active)
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [
      id,
      patch.name ?? null,
      patch.description ?? null,
      patch.defaultOptions ? JSON.stringify(patch.defaultOptions) : null,
      patch.zoneId ?? null,
      patch.isActive ?? null,
    ],
  );
  const row = rows[0];
  return row ? toTemplate(row) : null;
}

/** Drives the "most used" ordering, so the sheet people print daily rises to the top. */
export async function incrementUsage(db: Db, id: number): Promise<void> {
  await db.query('UPDATE print_templates SET times_used = times_used + 1 WHERE id = $1', [id]);
}

export async function deleteTemplate(db: Db, id: number): Promise<void> {
  await db.query('DELETE FROM print_templates WHERE id = $1', [id]);
}

export const templatesModel = {
  list: listTemplates,
  find: findTemplate,
  insert: insertTemplate,
  update: updateTemplate,
  incrementUsage,
  remove: deleteTemplate,
} as const;
