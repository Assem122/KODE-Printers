import type { Collector } from '@kode/shared';
import type { Db } from '../db/pool.js';



interface CollectorRow {
  id: number;
  name: string;
  site_id: number | null;
  version: string | null;
  last_seen_at: string | null;
  is_active: boolean;
  created_at: string;
  heartbeat_ms: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

const toCollector = (row: CollectorRow): Collector => ({
  id: row.id,
  name: row.name,
  siteId: row.site_id,
  version: row.version,
  lastSeenAt: row.last_seen_at,
  isActive: row.is_active,
  // §B11.3 — three missed heartbeats is the alert threshold, so healthiness is
  // derived from the same number rather than stored and allowed to drift.
  isHealthy:
    row.last_seen_at !== null &&
    Date.now() - Date.parse(row.last_seen_at) < HEARTBEAT_INTERVAL_MS * 3,
  createdAt: row.created_at,
});

const SELECT = `
  SELECT id, name, site_id, version, last_seen_at, is_active, created_at,
         ${HEARTBEAT_INTERVAL_MS} AS heartbeat_ms
    FROM collectors
`;

export async function listCollectors(db: Db): Promise<Collector[]> {
  const { rows } = await db.query<CollectorRow>(`${SELECT} ORDER BY name`);
  return rows.map(toCollector);
}

export async function insertCollector(
  db: Db,
  input: { name: string; siteId: number; apiKeyHash: string; apiKeyPrefix: string },
): Promise<Collector> {
  const { rows } = await db.query<CollectorRow>(
    `INSERT INTO collectors (name, site_id, api_key_hash, api_key_prefix)
     VALUES ($1,$2,$3,$4)
     RETURNING id, name, site_id, version, last_seen_at, is_active, created_at,
               ${HEARTBEAT_INTERVAL_MS} AS heartbeat_ms`,
    [input.name, input.siteId, input.apiKeyHash, input.apiKeyPrefix],
  );
  const row = rows[0];
  if (!row) throw new Error('collector insert returned no row');
  return toCollector(row);
}

/**
 * Resolves a presented key to a collector.
 *
 * Every active collector's hash is fetched and compared, rather than looking up
 * by a hash of the presented key. That is deliberate: it lets the comparison be
 * constant-time against each candidate, and the candidate set is a handful of
 * rows — one per building at most.
 */
export async function listActiveKeyHashes(
  db: Db,
): Promise<Array<{ id: number; apiKeyHash: string }>> {
  const { rows } = await db.query<{ id: number; api_key_hash: string }>(
    'SELECT id, api_key_hash FROM collectors WHERE is_active AND revoked_at IS NULL',
  );
  return rows.map((row) => ({ id: row.id, apiKeyHash: row.api_key_hash }));
}

export async function findCollector(db: Db, id: number): Promise<Collector | null> {
  const { rows } = await db.query<CollectorRow>(`${SELECT} WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? toCollector(row) : null;
}

export async function recordHeartbeat(db: Db, id: number, version: string): Promise<void> {
  await db.query('UPDATE collectors SET last_seen_at = now(), version = $2 WHERE id = $1', [
    id,
    version,
  ]);
}

export async function revokeCollector(db: Db, id: number): Promise<void> {
  await db.query('UPDATE collectors SET is_active = FALSE, revoked_at = now() WHERE id = $1', [id]);
}

/** Collectors that have gone quiet, for the heartbeat alert sweep. */
export async function listSilentCollectors(db: Db): Promise<Collector[]> {
  const { rows } = await db.query<CollectorRow>(
    `${SELECT}
      WHERE is_active
        AND (last_seen_at IS NULL
             OR last_seen_at < now() - make_interval(secs => $1))`,
    [(HEARTBEAT_INTERVAL_MS * 3) / 1000],
  );
  return rows.map(toCollector);
}

/**
 * Idempotency gate for replayed collector events (§B11.4).
 *
 * Returns true when this key is new. A collector that spooled events during an
 * uplink outage replays them on reconnection, and without this every replayed
 * counter delta would be logged a second time — turning a dropped connection
 * into a fabricated spike in the audit record.
 */
export async function claimEventKey(
  db: Db,
  collectorId: number,
  idempotencyKey: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO collector_event_keys (idempotency_key, collector_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [idempotencyKey, collectorId],
  );
  return (rowCount ?? 0) > 0;
}

export async function purgeOldEventKeys(db: Db, days = 7): Promise<number> {
  const { rowCount } = await db.query(
    'DELETE FROM collector_event_keys WHERE received_at < now() - make_interval(days => $1)',
    [days],
  );
  return rowCount ?? 0;
}

export const collectorsModel = {
  list: listCollectors,
  find: findCollector,
  insert: insertCollector,
  listActiveKeyHashes,
  recordHeartbeat,
  revoke: revokeCollector,
  listSilent: listSilentCollectors,
  claimEventKey,
  purgeOldEventKeys,
} as const;
