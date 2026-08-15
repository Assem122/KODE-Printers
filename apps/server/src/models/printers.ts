import type {
  Paginated,
  Printer,
  PrinterCapabilities,
  PrinterStatus,
  PrinterSupply,
  SnmpVersion,
  TransportPreference,
} from '@kode/shared';
import { pool, type Db } from '../db/pool.js';
import { applyKeyset, toPage, WhereBuilder } from '../db/sql.js';

/**
 * The printers table.
 *
 * The distinction this file exists to enforce: there are two shapes of printer.
 * `Printer` is what leaves the server and carries no credentials at all;
 * `PrinterWithSecrets` is what the SNMP and transport layers need and never
 * leaves this process. Two functions, two row shapes, no boolean flag that
 * someone can pass wrongly. INV-08 becomes a type error rather than a review
 * comment.
 */

const EMPTY_CAPABILITIES: PrinterCapabilities = {
  ipp: { supported: null, versions: [], uri: null },
  formats: [],
  sides: [],
  colorModes: [],
  maxCopies: null,
  media: [],
  probedVia: 'none',
  counters: { life: false, print: false, copy: false },
};

interface PrinterRow {
  id: number;
  site_id: number | null;
  site_name: string | null;
  site_code: string | null;
  collector_id: number | null;
  name: string;
  serial_number: string | null;
  mac_address: string | null;
  hostname: string | null;
  ip_address: string;
  area: string | null;
  vendor: string | null;
  model: string | null;
  transport: TransportPreference;
  ipp_uri: string | null;
  capabilities: PrinterCapabilities | null;
  capabilities_probed_at: string | null;
  snmp_version: SnmpVersion;
  snmp_configured: boolean;
  last_page_count: number | null;
  last_page_count_at: string | null;
  scan_folder: string | null;
  status: PrinterStatus;
  state_reasons: string[] | null;
  consecutive_failures: number;
  last_checked_at: string | null;
  is_active: boolean;
  is_draining: boolean;
  max_job_impressions: number | null;
  created_at: string;
  updated_at: string;
  supplies: PrinterSupply[] | null;
}

/**
 * `snmp_configured` is computed in SQL as a boolean rather than selecting the
 * community string and testing it in JavaScript. The secret never enters this
 * query's result set, so it cannot be logged by accident.
 */
const PRINTER_SELECT = `
  SELECT p.id, p.site_id, s.name AS site_name, s.code AS site_code, p.collector_id,
         p.name, p.serial_number, p.mac_address::text AS mac_address, p.hostname,
         host(p.ip_address) AS ip_address, p.area, p.vendor, p.model,
         p.transport, p.ipp_uri, p.capabilities, p.capabilities_probed_at,
         p.snmp_version,
         (p.snmp_community IS NOT NULL OR p.snmp_username IS NOT NULL) AS snmp_configured,
         p.last_page_count, p.last_page_count_at, p.scan_folder,
         p.status, p.state_reasons, p.consecutive_failures, p.last_checked_at,
         p.is_active, p.is_draining, p.max_job_impressions,
         p.created_at, p.updated_at,
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'name', ps.name,
                     'colorant', ps.colorant,
                     'level', ps.level,
                     'maxLevel', ps.max_level,
                     'percent', CASE WHEN ps.max_level > 0
                                     THEN round((ps.level::numeric / ps.max_level) * 100, 1)
                                     ELSE NULL END,
                     -- Withheld until the history can support it: at least four
                     -- observations spanning a day, and a level that is actually
                     -- falling. A rise means the cartridge was replaced, and a
                     -- slope across that boundary is meaningless. A dashboard
                     -- that says "3 days" and means it is worth more than one
                     -- that always shows a number.
                     'estimatedDaysRemaining',
                       CASE WHEN ps.max_level > 0
                                 AND burn.samples >= 4
                                 AND burn.span_days >= 1
                                 AND burn.percent_per_day > 0
                            THEN floor(
                                   (ps.level::numeric / ps.max_level * 100)
                                   / burn.percent_per_day
                                 )::int
                            ELSE NULL END
                   ) ORDER BY ps.supply_index)
              FROM printer_supplies ps
              LEFT JOIN LATERAL (
                -- Least squares across the retained window rather than the
                -- difference between the endpoints: one anomalous reading at
                -- either end would otherwise set the whole forecast.
                SELECT -regr_slope(h.percent, EXTRACT(EPOCH FROM h.observed_at) / 86400)
                         AS percent_per_day,
                       count(*) AS samples,
                       EXTRACT(EPOCH FROM (max(h.observed_at) - min(h.observed_at))) / 86400
                         AS span_days
                  FROM printer_supply_history h
                 WHERE h.printer_id = ps.printer_id
                   AND h.supply_index = ps.supply_index
                   AND h.observed_at > now() - interval '21 days'
              ) burn ON TRUE
             WHERE ps.printer_id = p.id),
           '[]'::json
         ) AS supplies
    FROM printers p
    LEFT JOIN sites s ON s.id = p.site_id
`;

function toPrinter(row: PrinterRow): Printer {
  const capabilities = { ...EMPTY_CAPABILITIES, ...(row.capabilities ?? {}) };
  return {
    id: row.id,
    siteId: row.site_id,
    siteName: row.site_name,
    siteCode: row.site_code,
    collectorId: row.collector_id,
    name: row.name,
    serialNumber: row.serial_number,
    macAddress: row.mac_address,
    hostname: row.hostname,
    ipAddress: row.ip_address,
    area: row.area,
    vendor: row.vendor,
    model: row.model,
    transport: row.transport,
    ippUri: row.ipp_uri,
    capabilities,
    capabilitiesProbedAt: row.capabilities_probed_at,
    snmpVersion: row.snmp_version,
    snmpConfigured: row.snmp_configured,
    lastPageCount: row.last_page_count,
    lastPageCountAt: row.last_page_count_at,
    scanFolder: row.scan_folder,
    status: row.status,
    stateReasons: row.state_reasons ?? [],
    consecutiveFailures: row.consecutive_failures,
    lastCheckedAt: row.last_checked_at,
    isActive: row.is_active,
    isDraining: row.is_draining,
    maxJobImpressions: row.max_job_impressions,
    supplies: row.supplies ?? [],
    // §B8.5 — this must be visible, because a printer nobody can track looks
    // exactly like a printer nobody uses.
    walkupTrackingUnavailable: row.snmp_version === 'disabled' || !row.snmp_configured,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface PrinterFilter {
  siteId?: number | undefined;
  status?: PrinterStatus | undefined;
  search?: string | undefined;
  includeInactive?: boolean | undefined;
  /** Restricts to the caller's permitted set. INV-01 — supplied by printerAccess. */
  permittedIds?: readonly number[] | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listPrinters(db: Db, filter: PrinterFilter): Promise<Paginated<Printer>> {
  const where = new WhereBuilder();
  if (!filter.includeInactive) where.add('p.is_active');
  where.addIf(filter.siteId, 'p.site_id = ?', filter.siteId);
  where.addIf(filter.status, 'p.status = ?', filter.status);
  if (filter.search) {
    where.add(
      '(p.name ILIKE ? OR p.area ILIKE ? OR p.model ILIKE ? OR host(p.ip_address) LIKE ?)',
      `%${filter.search}%`,
      `%${filter.search}%`,
      `%${filter.search}%`,
      `%${filter.search}%`,
    );
  }
  if (filter.permittedIds) {
    // An empty permitted set must return nothing, not everything. `= ANY('{}')`
    // is false for every row, which is exactly right.
    where.add('p.id = ANY(?::int[])', [...filter.permittedIds]);
  }

  const limit = applyKeyset(where, {
    cursor: filter.cursor,
    limit: filter.limit,
    timestampColumn: 'p.created_at',
    idColumn: 'p.id',
  });

  const limitParam = where.push(limit + 1);
  const { rows } = await db.query<PrinterRow>(
    `${PRINTER_SELECT} ${where.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ${limitParam}`,
    where.params,
  );

  return toPage(rows.map(toPrinter), limit, (printer) => ({
    t: printer.createdAt,
    i: printer.id,
  }));
}

/** Unpaginated, for the fleet board and printer pickers where 50 rows is the whole estate. */
export async function listAllPrinters(
  db: Db,
  options: { permittedIds?: readonly number[] | undefined; includeInactive?: boolean } = {},
): Promise<Printer[]> {
  const where = new WhereBuilder();
  if (!options.includeInactive) where.add('p.is_active');
  if (options.permittedIds) where.add('p.id = ANY(?::int[])', [...options.permittedIds]);

  const { rows } = await db.query<PrinterRow>(
    `${PRINTER_SELECT} ${where.sql} ORDER BY s.name NULLS LAST, p.name`,
    where.params,
  );
  return rows.map(toPrinter);
}

export async function findPrinter(db: Db, id: number): Promise<Printer | null> {
  const { rows } = await db.query<PrinterRow>(`${PRINTER_SELECT} WHERE p.id = $1`, [id]);
  const row = rows[0];
  return row ? toPrinter(row) : null;
}

/* ------------------------------------------------------------ with secrets */

/**
 * The credential-bearing shape. Returned only to the SNMP and transport
 * layers, and deliberately not assignable to `Printer`, so it cannot be handed
 * to a route serialiser by mistake.
 */
export interface PrinterWithSecrets {
  id: number;
  name: string;
  ipAddress: string;
  hostname: string | null;
  siteId: number | null;
  collectorId: number | null;
  transport: TransportPreference;
  ippUri: string | null;
  capabilities: PrinterCapabilities;
  snmpVersion: SnmpVersion;
  snmpCommunity: string | null;
  snmpUsername: string | null;
  snmpAuthKey: string | null;
  snmpPrivKey: string | null;
  snmpPageOid: string;
  snmpPrintOid: string | null;
  snmpCopyOid: string | null;
  serialNumber: string | null;
  lastPageCount: number | null;
  lastPrintCount: number | null;
  lastCopyCount: number | null;
  consecutiveFailures: number;
  circuitOpenUntil: string | null;
  status: PrinterStatus;
  stateReasons: string[];
  isActive: boolean;
  isDraining: boolean;
  maxJobImpressions: number | null;
  scanFolder: string | null;
}

interface SecretRow {
  id: number;
  name: string;
  ip_address: string;
  hostname: string | null;
  site_id: number | null;
  collector_id: number | null;
  transport: TransportPreference;
  ipp_uri: string | null;
  capabilities: PrinterCapabilities | null;
  snmp_version: SnmpVersion;
  snmp_community: string | null;
  snmp_username: string | null;
  snmp_auth_key: string | null;
  snmp_priv_key: string | null;
  snmp_page_oid: string;
  snmp_print_oid: string | null;
  snmp_copy_oid: string | null;
  serial_number: string | null;
  last_page_count: number | null;
  last_print_count: number | null;
  last_copy_count: number | null;
  consecutive_failures: number;
  circuit_open_until: string | null;
  status: PrinterStatus;
  state_reasons: string[] | null;
  is_active: boolean;
  is_draining: boolean;
  max_job_impressions: number | null;
  scan_folder: string | null;
}

const SECRET_SELECT = `
  SELECT id, name, host(ip_address) AS ip_address, hostname, site_id, collector_id,
         transport, ipp_uri, capabilities, snmp_version, snmp_community, snmp_username,
         snmp_auth_key, snmp_priv_key, snmp_page_oid, snmp_print_oid, snmp_copy_oid,
         serial_number, last_page_count, last_print_count, last_copy_count,
         consecutive_failures, circuit_open_until, status, state_reasons,
         is_active, is_draining, max_job_impressions, scan_folder
    FROM printers
`;

const toSecret = (row: SecretRow): PrinterWithSecrets => ({
  id: row.id,
  name: row.name,
  ipAddress: row.ip_address,
  hostname: row.hostname,
  siteId: row.site_id,
  collectorId: row.collector_id,
  transport: row.transport,
  ippUri: row.ipp_uri,
  capabilities: { ...EMPTY_CAPABILITIES, ...(row.capabilities ?? {}) },
  snmpVersion: row.snmp_version,
  snmpCommunity: row.snmp_community,
  snmpUsername: row.snmp_username,
  snmpAuthKey: row.snmp_auth_key,
  snmpPrivKey: row.snmp_priv_key,
  snmpPageOid: row.snmp_page_oid,
  snmpPrintOid: row.snmp_print_oid,
  snmpCopyOid: row.snmp_copy_oid,
  serialNumber: row.serial_number,
  lastPageCount: row.last_page_count,
  lastPrintCount: row.last_print_count,
  lastCopyCount: row.last_copy_count,
  consecutiveFailures: row.consecutive_failures,
  circuitOpenUntil: row.circuit_open_until,
  status: row.status,
  stateReasons: row.state_reasons ?? [],
  isActive: row.is_active,
  isDraining: row.is_draining,
  maxJobImpressions: row.max_job_impressions,
  scanFolder: row.scan_folder,
});

export async function findPrinterWithSecrets(
  db: Db,
  id: number,
): Promise<PrinterWithSecrets | null> {
  const { rows } = await db.query<SecretRow>(`${SECRET_SELECT} WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? toSecret(row) : null;
}

/** Every device this instance is responsible for polling. */
export async function listPollTargets(
  db: Db,
  collectorId: number | null,
): Promise<PrinterWithSecrets[]> {
  const { rows } = await db.query<SecretRow>(
    `${SECRET_SELECT}
      WHERE is_active
        AND snmp_version <> 'disabled'
        AND ${collectorId === null ? 'collector_id IS NULL' : 'collector_id = $1'}
      ORDER BY id`,
    collectorId === null ? [] : [collectorId],
  );
  return rows.map(toSecret);
}

/**
 * Every active printer assigned to a collector, credentials included.
 *
 * Sent to that collector and to nothing else. A collector is the only thing
 * that can reach the devices in its segment, so it cannot poll them without
 * their SNMP credentials — this is the one place those values legitimately
 * leave the process, over an authenticated outbound HTTPS connection the
 * collector itself opened.
 */
export async function listByCollector(db: Db, collectorId: number): Promise<PrinterWithSecrets[]> {
  const { rows } = await db.query<SecretRow>(
    `${SECRET_SELECT} WHERE is_active AND collector_id = $1 ORDER BY id`,
    [collectorId],
  );
  return rows.map(toSecret);
}

export async function listScanWatchTargets(
  db: Db,
  collectorId: number | null,
): Promise<PrinterWithSecrets[]> {
  const { rows } = await db.query<SecretRow>(
    `${SECRET_SELECT}
      WHERE is_active
        AND scan_folder IS NOT NULL
        AND scan_folder <> ''
        AND ${collectorId === null ? 'collector_id IS NULL' : 'collector_id = $1'}
      ORDER BY id`,
    collectorId === null ? [] : [collectorId],
  );
  return rows.map(toSecret);
}

/* ------------------------------------------------------------------ writes */

export interface PrinterInsert {
  name: string;
  ipAddress: string;
  siteId: number | null;
  area: string | null;
  hostname: string | null;
  transport: TransportPreference;
  ippUri: string | null;
  snmpVersion: SnmpVersion;
  snmpCommunity: string | null;
  snmpUsername: string | null;
  snmpAuthKey: string | null;
  snmpPrivKey: string | null;
  snmpPageOid: string;
  snmpPrintOid: string | null;
  snmpCopyOid: string | null;
  scanFolder: string | null;
  maxJobImpressions: number | null;
}

export async function insertPrinter(db: Db, input: PrinterInsert): Promise<Printer> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO printers (name, ip_address, site_id, area, hostname, transport, ipp_uri,
                           snmp_version, snmp_community, snmp_username, snmp_auth_key,
                           snmp_priv_key, snmp_page_oid, snmp_print_oid, snmp_copy_oid,
                           scan_folder, max_job_impressions)
     VALUES ($1, $2::inet, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING id`,
    [
      input.name,
      input.ipAddress,
      input.siteId,
      input.area,
      input.hostname,
      input.transport,
      input.ippUri,
      input.snmpVersion,
      input.snmpCommunity,
      input.snmpUsername,
      input.snmpAuthKey,
      input.snmpPrivKey,
      input.snmpPageOid,
      input.snmpPrintOid,
      input.snmpCopyOid,
      input.scanFolder,
      input.maxJobImpressions,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('printer insert returned no id');
  const created = await findPrinter(db, id);
  if (!created) throw new Error('printer disappeared immediately after insert');
  return created;
}

const UPDATABLE: Readonly<Record<string, { column: string; cast?: string }>> = {
  name: { column: 'name' },
  ipAddress: { column: 'ip_address', cast: '::inet' },
  siteId: { column: 'site_id' },
  area: { column: 'area' },
  hostname: { column: 'hostname' },
  transport: { column: 'transport' },
  ippUri: { column: 'ipp_uri' },
  snmpVersion: { column: 'snmp_version' },
  snmpCommunity: { column: 'snmp_community' },
  snmpUsername: { column: 'snmp_username' },
  snmpAuthKey: { column: 'snmp_auth_key' },
  snmpPrivKey: { column: 'snmp_priv_key' },
  snmpPageOid: { column: 'snmp_page_oid' },
  snmpPrintOid: { column: 'snmp_print_oid' },
  snmpCopyOid: { column: 'snmp_copy_oid' },
  scanFolder: { column: 'scan_folder' },
  maxJobImpressions: { column: 'max_job_impressions' },
  isActive: { column: 'is_active' },
  isDraining: { column: 'is_draining' },
  serialNumber: { column: 'serial_number' },
  macAddress: { column: 'mac_address', cast: '::macaddr' },
  vendor: { column: 'vendor' },
  model: { column: 'model' },
};

export async function updatePrinter(
  db: Db,
  id: number,
  patch: Record<string, unknown>,
): Promise<Printer | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const target = UPDATABLE[key];
    if (!target) continue; // Unknown keys are ignored, never interpolated.
    values.push(value);
    assignments.push(`${target.column} = $${values.length}${target.cast ?? ''}`);
  }

  if (assignments.length === 0) return findPrinter(db, id);

  values.push(id);
  await db.query(
    `UPDATE printers SET ${assignments.join(', ')} WHERE id = $${values.length}`,
    values,
  );
  return findPrinter(db, id);
}

export async function setPrinterStatus(
  db: Db,
  id: number,
  status: PrinterStatus,
  stateReasons: readonly string[],
  options: { resetFailures?: boolean; incrementFailures?: boolean } = {},
): Promise<void> {
  await db.query(
    `UPDATE printers
        SET status = $2,
            state_reasons = $3::text[],
            last_checked_at = now(),
            consecutive_failures = CASE
              WHEN $4::boolean THEN 0
              WHEN $5::boolean THEN consecutive_failures + 1
              ELSE consecutive_failures END,
            circuit_open_until = CASE WHEN $4::boolean THEN NULL ELSE circuit_open_until END
      WHERE id = $1`,
    [
      id,
      status,
      [...stateReasons],
      options.resetFailures ?? false,
      options.incrementFailures ?? false,
    ],
  );
}

export async function recordCounters(
  db: Db,
  id: number,
  counters: { life: number; print?: number | null; copy?: number | null },
): Promise<void> {
  await db.query(
    `UPDATE printers
        SET last_page_count = $2,
            last_page_count_at = now(),
            last_print_count = COALESCE($3, last_print_count),
            last_copy_count  = COALESCE($4, last_copy_count)
      WHERE id = $1`,
    [id, counters.life, counters.print ?? null, counters.copy ?? null],
  );
}

/**
 * The stored counter baseline, plus the identity the walk-up record needs.
 *
 * Deliberately not `findWithSecrets`: the collector ingest path needs a
 * printer's previous counters and its name, and hauling SNMP credentials into a
 * route handler to get them would put the one shape that carries secrets
 * somewhere INV-08 works hard to keep it out of.
 */
export interface CounterBaseline {
  id: number;
  name: string;
  siteId: number | null;
  life: number | null;
  print: number | null;
  copy: number | null;
  /** When the stored counters were last written. Null before the first reading. */
  observedAt: string | null;
}

export async function counterBaseline(db: Db, id: number): Promise<CounterBaseline | null> {
  const { rows } = await db.query<{
    id: number;
    name: string;
    site_id: number | null;
    last_page_count: number | null;
    last_print_count: number | null;
    last_copy_count: number | null;
    last_page_count_at: string | null;
  }>(
    `SELECT id, name, site_id, last_page_count, last_print_count, last_copy_count,
            last_page_count_at
       FROM printers WHERE id = $1 AND is_active`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    siteId: row.site_id,
    life: row.last_page_count,
    print: row.last_print_count,
    copy: row.last_copy_count,
    observedAt: row.last_page_count_at,
  };
}

export async function openCircuit(db: Db, id: number, untilMs: number): Promise<void> {
  await db.query(
    `UPDATE printers SET circuit_open_until = now() + make_interval(secs => $2) WHERE id = $1`,
    [id, Math.round(untilMs / 1000)],
  );
}

export async function saveCapabilities(
  db: Db,
  id: number,
  capabilities: PrinterCapabilities,
  resolved: { transport?: TransportPreference; ippUri?: string | null } = {},
): Promise<void> {
  await db.query(
    `UPDATE printers
        SET capabilities = $2::jsonb,
            capabilities_probed_at = now(),
            ipp_uri = COALESCE($3, ipp_uri),
            transport = COALESCE($4, transport)
      WHERE id = $1`,
    [id, JSON.stringify(capabilities), resolved.ippUri ?? null, resolved.transport ?? null],
  );
}

/**
 * INV-05 — a printer with job history is never hard-deleted.
 *
 * The database enforces this with ON DELETE RESTRICT; this function's job is to
 * turn the resulting driver error into a clear refusal, and to make the
 * successful case (a printer added by mistake, never used) still possible.
 */
export async function countJobsForPrinter(db: Db, id: number): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM jobs WHERE printer_id = $1',
    [id],
  );
  return rows[0]?.count ?? 0;
}

export async function deletePrinter(db: Db, id: number): Promise<void> {
  await db.query('DELETE FROM printers WHERE id = $1', [id]);
}

export async function findBySerial(db: Db, serial: string): Promise<{ id: number } | null> {
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM printers WHERE serial_number = $1',
    [serial],
  );
  return rows[0] ?? null;
}

export async function replaceSupplies(
  db: Db,
  printerId: number,
  supplies: ReadonlyArray<{
    index: number;
    name: string;
    colorant: string | null;
    level: number | null;
    maxLevel: number | null;
  }>,
): Promise<void> {
  for (const supply of supplies) {
    await db.query(
      `INSERT INTO printer_supplies (printer_id, supply_index, name, colorant, level, max_level, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (printer_id, supply_index)
       DO UPDATE SET name = EXCLUDED.name, colorant = EXCLUDED.colorant,
                     level = EXCLUDED.level, max_level = EXCLUDED.max_level,
                     observed_at = now()`,
      [printerId, supply.index, supply.name, supply.colorant, supply.level, supply.maxLevel],
    );

    if (supply.level !== null && supply.maxLevel !== null && supply.maxLevel > 0) {
      const percent = Math.round((supply.level / supply.maxLevel) * 10000) / 100;
      await db.query(
        `INSERT INTO printer_supply_history (printer_id, supply_index, percent)
         VALUES ($1, $2, $3)`,
        [printerId, supply.index, percent],
      );
    }
  }
}

export const printersModel = {
  list: listPrinters,
  listAll: listAllPrinters,
  find: findPrinter,
  findWithSecrets: findPrinterWithSecrets,
  listPollTargets,
  listScanWatchTargets,
  listByCollector,
  insert: insertPrinter,
  update: updatePrinter,
  setStatus: setPrinterStatus,
  recordCounters,
  counterBaseline,
  openCircuit,
  saveCapabilities,
  countJobs: countJobsForPrinter,
  remove: deletePrinter,
  findBySerial,
  replaceSupplies,
} as const;

export { pool };
