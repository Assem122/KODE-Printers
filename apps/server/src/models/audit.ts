import type { AuditEntry, Paginated } from '@kode/shared';
import type { Db } from '../db/pool.js';
import { applyKeyset, toPage, WhereBuilder } from '../db/sql.js';

/**
 * The append-only administrative audit log (ADR-012, INV-07).
 *
 * There is deliberately no update and no delete function in this module. The
 * database enforces the same rule with a trigger, so a future contributor who
 * adds one here gets a runtime error rather than a quietly rewritten history.
 *
 * A permission system with no record of permission changes is not auditable —
 * that sentence is the entire justification for the table, and it is why the
 * write happens inside the caller's transaction rather than afterwards.
 */

interface AuditRow {
  id: number;
  actor_user_id: number | null;
  actor_username: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip_address: string | null;
  request_id: string | null;
  created_at: string;
}

const toEntry = (row: AuditRow): AuditEntry => ({
  id: row.id,
  actorUserId: row.actor_user_id,
  actorUsername: row.actor_username,
  action: row.action,
  entityType: row.entity_type,
  entityId: row.entity_id,
  before: row.before,
  after: row.after,
  ipAddress: row.ip_address,
  requestId: row.request_id,
  createdAt: row.created_at,
});

export interface AuditWrite {
  actorUserId: number | null;
  actorUsername: string;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  requestId?: string | null;
}

/**
 * Fields never written into an audit payload, whatever the caller passes.
 *
 * The audit log is the one table an operator reads casually and exports freely,
 * which makes it the worst possible place for a leaked secret. INV-08 is
 * therefore enforced here at the boundary rather than trusted at each call site.
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'newPassword',
  'currentPassword',
  'snmpCommunity',
  'snmp_community',
  'snmpAuthKey',
  'snmp_auth_key',
  'snmpPrivKey',
  'snmp_priv_key',
  'apiKey',
  'api_key',
  'apiKeyHash',
  'api_key_hash',
  'tokenHash',
  'token_hash',
  'accessToken',
  'refreshToken',
]);

export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactForAudit(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redactForAudit(item, depth + 1);
  }
  return out;
}

/**
 * INV-07 — the caller passes its transaction client, so if the audit insert
 * fails the change it records is rolled back with it. An audit row written
 * after a committed change can silently go missing; one written inside it
 * cannot.
 */
export async function writeAudit(db: Db, entry: AuditWrite): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, actor_username, action, entity_type, entity_id,
                            before, after, ip_address, request_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::inet,$9)`,
    [
      entry.actorUserId,
      entry.actorUsername,
      entry.action,
      entry.entityType,
      entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      entry.before === undefined ? null : JSON.stringify(redactForAudit(entry.before)),
      entry.after === undefined ? null : JSON.stringify(redactForAudit(entry.after)),
      entry.ipAddress ?? null,
      entry.requestId ?? null,
    ],
  );
}

export interface AuditFilter {
  actorUserId?: number | undefined;
  action?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listAudit(db: Db, filter: AuditFilter): Promise<Paginated<AuditEntry>> {
  const where = new WhereBuilder();
  where.addIf(filter.actorUserId, 'a.actor_user_id = ?', filter.actorUserId);
  where.addIf(filter.action, 'a.action = ?', filter.action);
  where.addIf(filter.entityType, 'a.entity_type = ?', filter.entityType);
  where.addIf(filter.entityId, 'a.entity_id = ?', filter.entityId);
  where.addIf(filter.from, 'a.created_at >= ?::timestamptz', filter.from);
  where.addIf(filter.to, "a.created_at < (?::timestamptz + interval '1 day')", filter.to);

  const limit = applyKeyset(where, {
    cursor: filter.cursor,
    limit: filter.limit,
    timestampColumn: 'a.created_at',
    idColumn: 'a.id',
  });
  const limitParam = where.push(limit + 1);

  const { rows } = await db.query<AuditRow>(
    `SELECT a.id, a.actor_user_id, a.actor_username, a.action, a.entity_type, a.entity_id,
            a.before, a.after, host(a.ip_address) AS ip_address, a.request_id, a.created_at
       FROM audit_log a ${where.sql}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${limitParam}`,
    where.params,
  );
  return toPage(rows.map(toEntry), limit, (entry) => ({ t: entry.createdAt, i: entry.id }));
}

/** Distinct actions present in the log, for the audit explorer's filter chips. */
export async function listAuditActions(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ action: string }>(
    'SELECT DISTINCT action FROM audit_log ORDER BY action',
  );
  return rows.map((row) => row.action);
}

export const auditModel = { write: writeAudit, list: listAudit, listActions: listAuditActions };
