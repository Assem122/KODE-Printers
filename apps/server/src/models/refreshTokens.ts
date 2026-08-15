import type { Db } from '../db/pool.js';

/**
 * Refresh tokens with family-based reuse detection (§B12.3).
 *
 * The mechanism, stated plainly because it is easy to implement halfway:
 *
 * Every token belongs to a *family*, created at sign-in and inherited by each
 * rotation. Presenting a token that has already been revoked means one of two
 * things — someone stole a token and is replaying it, or the legitimate client
 * is broken. Both warrant ending the session, so the entire family is revoked,
 * not merely the presented token.
 *
 * The delivered build chained tokens through `replaced_by`, which made reuse
 * *observable*. Without the family revoke it was not *actionable*: an attacker
 * whose stolen token was rejected could simply keep using the one they had
 * already exchanged it for. Detecting reuse and doing nothing provides no
 * security, which is why the family column exists.
 */

export interface StoredToken {
  id: number;
  userId: number;
  familyId: string;
  expiresAt: string;
  revokedAt: string | null;
}

export async function insertToken(
  db: Db,
  input: {
    userId: number;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
    ipAddress: string | null;
    replacesId?: number | null;
  },
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1,$2::uuid,$3,$4,$5,$6::inet) RETURNING id`,
    [
      input.userId,
      input.familyId,
      input.tokenHash,
      input.expiresAt.toISOString(),
      input.userAgent,
      input.ipAddress,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('refresh token insert returned no id');

  if (input.replacesId) {
    await db.query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [
      input.replacesId,
      id,
    ]);
  }
  return id;
}

export async function findByHash(db: Db, tokenHash: string): Promise<StoredToken | null> {
  const { rows } = await db.query<{
    id: number;
    user_id: number;
    family_id: string;
    expires_at: string;
    revoked_at: string | null;
  }>(
    `SELECT id, user_id, family_id::text AS family_id, expires_at, revoked_at
       FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    familyId: row.family_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/** The reuse response: end every session descended from the compromised sign-in. */
export async function revokeFamily(db: Db, familyId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE family_id = $1::uuid AND revoked_at IS NULL`,
    [familyId],
  );
  return rowCount ?? 0;
}

export async function revokeOne(db: Db, tokenHash: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  return (rowCount ?? 0) > 0;
}

export async function revokeAllForUser(db: Db, userId: number): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return rowCount ?? 0;
}

/**
 * Expired tokens are deleted; revoked ones are kept for a grace period.
 *
 * Keeping revoked rows briefly is what allows reuse detection to work at all:
 * delete the row and a replayed token looks like an unknown token, which is
 * indistinguishable from a typo and raises no alarm.
 */
export async function purgeExpiredTokens(db: Db, revokedGraceDays = 30): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < now() - interval '1 day'
        AND (revoked_at IS NULL OR revoked_at < now() - make_interval(days => $1))`,
    [revokedGraceDays],
  );
  return rowCount ?? 0;
}

export const refreshTokensModel = {
  insert: insertToken,
  findByHash,
  revokeFamily,
  revokeOne,
  revokeAllForUser,
  purgeExpired: purgeExpiredTokens,
} as const;
