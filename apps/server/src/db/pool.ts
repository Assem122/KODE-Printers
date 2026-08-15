import pg from 'pg';
import { config } from '../config/index.js';
import { serialiseError, subsystem } from '../utilities/logger.js';

const { Pool, types } = pg;
const log = subsystem('db');

/**
 * PostgreSQL access.
 *
 * Two type-parser overrides are applied before any query runs, and both prevent
 * a class of silent corruption rather than merely tidying output.
 *
 * `int8` (BIGINT) is returned by node-postgres as a string, because 2^63 does
 * not fit a JS number. Every BIGINT in this schema is either a row id or a page
 * counter, and both are far below 2^53, so parsing them to numbers is safe and
 * saves a string/number confusion at every call site. The one place this would
 * be wrong — a counter beyond 9 quadrillion — is not reachable by a printer.
 *
 * `timestamptz` is returned as a raw ISO string rather than a JS Date. INV-10
 * says timestamps are stored UTC and that local time exists only in the
 * presentation layer; handing the application a Date invites `.toString()` in a
 * CSV export and a report that silently shifts by the server's offset.
 */
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));
types.setTypeParser(types.builtins.TIMESTAMPTZ, (value) => value);
types.setTypeParser(types.builtins.NUMERIC, (value) => Number.parseFloat(value));

export const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  /**
   * A runaway query holds a pool slot; at pool size 10 it takes ten of them to
   * take the API down. The timeout is the backstop that turns "the site is
   * down" into "one request failed".
   */
  statement_timeout: config.db.statementTimeoutMs,
  query_timeout: config.db.statementTimeoutMs,
  application_name: config.collector.mode ? 'kode-printer-collector' : 'kode-printer',
});

pool.on('error', (error) => {
  // An idle client failed. Recoverable — the pool replaces it — but never silent.
  log.error({ ...serialiseError(error) }, 'idle database client errored');
});

/**
 * The minimal surface a model needs. Accepting this rather than `Pool` is what
 * lets every model function participate in a caller's transaction, which is how
 * INV-07 (audit row written in the same transaction as the change) is possible
 * without a second code path per model.
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export type Db = Queryable;
export type TxClient = pg.PoolClient & Queryable;

/**
 * Runs `fn` inside a transaction, committing on resolve and rolling back on
 * throw. The client is always released, including when the rollback itself
 * fails — a leaked client is worse than a lost error.
 */
export async function withTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      log.error({ ...serialiseError(rollbackError) }, 'rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Advisory lock helper for work that must not run twice concurrently across
 * processes — the retention sweep, the queue reclaim pass.
 *
 * Returns false rather than waiting when the lock is held: these are periodic
 * jobs, so the right response to "someone else is doing it" is to skip this
 * tick, not to queue up behind them.
 */
export async function withAdvisoryLock<T>(
  key: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const client = await pool.connect();
  try {
    const acquired = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key],
    );
    if (!acquired.rows[0]?.locked) return undefined;
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}

/** Stable advisory-lock keys. Collisions would silently serialise unrelated work. */
export const ADVISORY_LOCKS = {
  retentionSweep: 811_001,
  queueReclaim: 811_002,
  migrations: 811_003,
  supplyForecast: 811_004,
} as const;

export async function checkDatabase(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const result = await pool.query<{ one: number }>('SELECT 1 AS one');
    return result.rows[0]?.one === 1 ? { ok: true } : { ok: false, detail: 'unexpected result' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
