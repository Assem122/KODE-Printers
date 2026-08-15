import type { Request } from 'express';
import type { AuditAction } from '@kode/shared';
import { withTransaction, type TxClient } from '../db/pool.js';
import { auditModel } from '../models/audit.js';
import { clientIp } from '../middlewares/context.js';

/**
 * The audit-writing helper (INV-07, ADR-012).
 *
 * "Every administrative mutation writes an `audit_log` row in the same
 * transaction as the change. If the audit write fails, the change fails."
 *
 * `auditedMutation` is how that invariant is made hard to break: it opens the
 * transaction, hands the caller a client, and writes the audit row inside it.
 * A caller that forgets the audit write has to go out of its way — using
 * `withTransaction` directly — rather than merely forgetting a line.
 */

/**
 * A recorded snapshot.
 *
 * Deliberately not `unknown`: `unknown | ((result: T) => unknown)` collapses to
 * `unknown`, which silently strips the type from every callback parameter and
 * makes `entityId: (created) => created.id` an implicit `any`. Narrowing the
 * value side to an object keeps the union discriminable.
 */
export type AuditSnapshot = object | null;

export interface AuditedMutationOptions<T> {
  req: Request;
  action: AuditAction;
  entityType: string;
  /** Resolved from the result when the id is only known after the write. */
  entityId?: string | number | null | ((result: T) => string | number | null);
  /** State before the change. Fetched by the caller inside the transaction. */
  before?: AuditSnapshot | ((result: T) => AuditSnapshot);
  /** State after. Defaults to the mutation's own result. */
  after?: AuditSnapshot | ((result: T) => AuditSnapshot);
}

/**
 * The mutation comes first so TypeScript can infer `T` from it before it has
 * to type the `entityId`/`before`/`after` callbacks in the options. With the
 * arguments the other way round those callbacks receive `unknown`, and every
 * call site needs an explicit type argument to compensate.
 */
export async function auditedMutation<T>(
  mutate: (tx: TxClient) => Promise<T>,
  options: AuditedMutationOptions<T>,
): Promise<T> {
  const actor = options.req.actor;

  return withTransaction(async (tx) => {
    const result = await mutate(tx);

    await auditModel.write(tx, {
      actorUserId: actor?.id ?? null,
      // A username rather than only an id: the id becomes NULL if the account
      // is later deleted, and an audit row that cannot name who acted is not an
      // audit row.
      actorUsername: actor?.username ?? 'system',
      action: options.action,
      entityType: options.entityType,
      entityId: resolve(options.entityId, result) ?? null,
      before: resolve(options.before, result),
      after: options.after === undefined ? result : resolve(options.after, result),
      ipAddress: clientIp(options.req),
      requestId: options.req.requestId,
    });

    return result;
  });
}

/** For audit rows raised outside a request — watchers, the queue worker. */
export async function auditSystemAction(input: {
  action: string;
  entityType: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await withTransaction(async (tx) => {
    await auditModel.write(tx, {
      actorUserId: null,
      actorUsername: 'system',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: input.before,
      after: input.after,
    });
  });
}

function resolve<T, V>(value: V | ((result: T) => V) | undefined, result: T): V | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'function' ? (value as (r: T) => V)(result) : value;
}
