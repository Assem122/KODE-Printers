import { decodeCursor, encodeCursor, PAGINATION, type Paginated } from '@kode/shared';

/**
 * Query-building helpers.
 *
 * INV-04 is absolute: every SQL statement is parameterised, with no exception
 * for migrations or CSV export. That rules out the usual "build a WHERE clause
 * by string concatenation" approach, so this module provides the one safe way
 * to assemble a dynamic filter — values always become `$n` placeholders, and
 * only the column names, which are literals in our own source, appear in text.
 */

export class WhereBuilder {
  private readonly clauses: string[] = [];
  private readonly values: unknown[] = [];

  /**
   * @param fragment SQL with `?` where each value goes. Never interpolate a
   *   value into this string — that is precisely what INV-04 forbids.
   */
  add(fragment: string, ...values: unknown[]): this {
    let index = 0;
    const rendered = fragment.replace(/\?/g, () => {
      this.values.push(values[index]);
      index += 1;
      return `$${this.values.length}`;
    });
    if (index !== values.length) {
      throw new Error(
        `WhereBuilder: fragment has ${index} placeholders but ${values.length} values were given.`,
      );
    }
    this.clauses.push(rendered);
    return this;
  }

  /** Adds the fragment only when `value` is neither undefined nor null. */
  addIf(condition: unknown, fragment: string, ...values: unknown[]): this {
    if (condition === undefined || condition === null || condition === false) return this;
    return this.add(fragment, ...values);
  }

  /** Reserves the next placeholder without adding a clause (for LIMIT etc.). */
  push(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  get sql(): string {
    return this.clauses.length === 0 ? '' : `WHERE ${this.clauses.join(' AND ')}`;
  }

  get params(): unknown[] {
    return this.values;
  }

  get length(): number {
    return this.clauses.length;
  }
}

export interface KeysetOptions {
  cursor?: string | undefined;
  limit?: number | undefined;
  /** Qualified column holding the sort timestamp, e.g. `j.created_at`. */
  timestampColumn: string;
  /** Qualified column holding the tie-breaking id, e.g. `j.id`. */
  idColumn: string;
}

/**
 * Applies a keyset predicate to a builder and returns the row limit.
 *
 * §B5.4 forbids offset pagination outright. The reason is worth stating: with a
 * year of job history, `OFFSET 40000` makes Postgres walk and discard forty
 * thousand rows on every page. A keyset predicate is an index seek regardless of
 * how deep the reader has scrolled.
 *
 * `limit + 1` rows are fetched so `hasMore` is known without a second COUNT.
 */
export function applyKeyset(where: WhereBuilder, options: KeysetOptions): number {
  const limit = Math.min(
    Math.max(1, options.limit ?? PAGINATION.defaultLimit),
    PAGINATION.maxLimit,
  );

  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      where.add(
        `(${options.timestampColumn}, ${options.idColumn}) < (?::timestamptz, ?::bigint)`,
        cursor.t,
        cursor.i,
      );
    }
    // A malformed cursor is ignored rather than rejected. It can only come from
    // a stale bookmark or a truncated URL, and returning page one is friendlier
    // than a 400 the user cannot act on.
  }

  return limit;
}

/**
 * Trims the sentinel row and builds the next cursor.
 *
 * `keyOf` must read the same `(timestamp, id)` pair the query sorted by, or
 * pagination silently loops. Passing it explicitly rather than guessing field
 * names is what keeps that honest.
 */
export function toPage<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => { t: string; i: number },
): Paginated<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(keyOf(last)) : null,
  };
}

/**
 * Postgres error codes we translate rather than surface. Anything else becomes
 * INTERNAL_ERROR with the driver text confined to the log (INV-12).
 */
export const PG_ERRORS = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  restrictViolation: '23001',
  notNullViolation: '23502',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  queryCanceled: '57014',
} as const;

export function pgErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function pgConstraint(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === 'string' ? constraint : null;
  }
  return null;
}
