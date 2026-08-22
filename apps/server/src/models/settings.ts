import type { AppSettings, SettingsUpdateInput } from '@kode/shared';
import { pool, type Db } from '../db/pool.js';

/**
 * Runtime configuration the club can change without a redeploy (DEC-03, DEC-05).
 *
 * These are settings rather than environment variables because an operations
 * manager should be able to decide that colour costs 0.14 rather than 0.12
 * without an engineer and a restart. Anything that changes *how the process
 * starts* stays in the environment; anything that changes *how the club
 * operates* lives here — and every change writes an audit row.
 */

interface SettingsRow {
  upload_retention_days: number;
  scan_retention_days: number;
  notification_retention_days: number;
  max_job_impressions: number;
  large_job_warn_impressions: number;
  max_concurrent_jobs_per_printer: number;
  printer_cooldown_seconds: number;
  cost_per_page_mono: number;
  cost_per_page_color: number;
  currency: string;
  co2_grams_per_impression: number;
  email_enabled: boolean;
  web_push_enabled: boolean;
  scan_reservation_minutes: number;
  walkup_report_label: string;
}

const toSettings = (row: SettingsRow): AppSettings => ({
  uploadRetentionDays: row.upload_retention_days,
  scanRetentionDays: row.scan_retention_days,
  notificationRetentionDays: row.notification_retention_days,
  maxJobImpressions: row.max_job_impressions,
  largeJobWarnImpressions: row.large_job_warn_impressions,
  maxConcurrentJobsPerPrinter: row.max_concurrent_jobs_per_printer,
  printerCooldownSeconds: row.printer_cooldown_seconds,
  costPerPageMono: row.cost_per_page_mono,
  costPerPageColor: row.cost_per_page_color,
  currency: row.currency,
  co2GramsPerImpression: row.co2_grams_per_impression,
  emailEnabled: row.email_enabled,
  webPushEnabled: row.web_push_enabled,
  scanReservationMinutes: row.scan_reservation_minutes,
  walkupReportLabel: row.walkup_report_label,
});

const SELECT = `
  SELECT upload_retention_days, scan_retention_days, notification_retention_days,
         max_job_impressions, large_job_warn_impressions,
         max_concurrent_jobs_per_printer, printer_cooldown_seconds,
         cost_per_page_mono, cost_per_page_color, currency, co2_grams_per_impression,
         email_enabled, web_push_enabled, scan_reservation_minutes, walkup_report_label
    FROM app_settings WHERE id = TRUE
`;

/**
 * Settings are read on nearly every print submission (impression caps) and on every report render. A short cache keeps that off the
 * database without making an admin's change take minutes to appear.
 *
 * Two seconds is chosen so a settings save followed by a page reload always
 * shows the new value — the round trip is slower than the TTL.
 */
const CACHE_TTL_MS = 2000;
let cached: { value: AppSettings; expiresAt: number } | null = null;

export async function getSettings(db: Db = pool): Promise<AppSettings> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const { rows } = await db.query<SettingsRow>(SELECT);
  const row = rows[0];
  if (!row) {
    throw new Error('app_settings row is missing — migration 001 did not complete.');
  }
  const value = toSettings(row);
  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Bypasses the cache. Used by the settings route after a write. */
export async function getSettingsFresh(db: Db = pool): Promise<AppSettings> {
  cached = null;
  return getSettings(db);
}

export function invalidateSettingsCache(): void {
  cached = null;
}

const COLUMN_BY_FIELD: Readonly<Record<keyof AppSettings, string>> = {
  uploadRetentionDays: 'upload_retention_days',
  scanRetentionDays: 'scan_retention_days',
  notificationRetentionDays: 'notification_retention_days',
  maxJobImpressions: 'max_job_impressions',
  largeJobWarnImpressions: 'large_job_warn_impressions',
  maxConcurrentJobsPerPrinter: 'max_concurrent_jobs_per_printer',
  printerCooldownSeconds: 'printer_cooldown_seconds',
  costPerPageMono: 'cost_per_page_mono',
  costPerPageColor: 'cost_per_page_color',
  currency: 'currency',
  co2GramsPerImpression: 'co2_grams_per_impression',
  emailEnabled: 'email_enabled',
  webPushEnabled: 'web_push_enabled',
  scanReservationMinutes: 'scan_reservation_minutes',
  walkupReportLabel: 'walkup_report_label',
};

export async function updateSettings(
  db: Db,
  patch: SettingsUpdateInput,
  updatedBy: number | null,
): Promise<AppSettings> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // Column names come from a closed literal map, never from the request. The
    // *values* are always placeholders. INV-04.
    const column = COLUMN_BY_FIELD[field as keyof AppSettings];
    if (!column) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  if (assignments.length === 0) return getSettings(db);

  values.push(updatedBy);
  const { rows } = await db.query<SettingsRow>(
    `UPDATE app_settings
        SET ${assignments.join(', ')}, updated_at = now(), updated_by = $${values.length}
      WHERE id = TRUE
      RETURNING upload_retention_days, scan_retention_days, notification_retention_days,
                max_job_impressions, large_job_warn_impressions,
                max_concurrent_jobs_per_printer, printer_cooldown_seconds,
                cost_per_page_mono, cost_per_page_color, currency, co2_grams_per_impression,
                email_enabled, web_push_enabled, scan_reservation_minutes, walkup_report_label`,
    values,
  );

  invalidateSettingsCache();
  const row = rows[0];
  if (!row) throw new Error('app_settings update affected no rows.');
  return toSettings(row);
}
