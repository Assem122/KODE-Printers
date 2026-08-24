import type { RequestHandler } from 'express';
import { AppError, errors } from '@kode/shared';
import { pool } from '../db/pool.js';
import { collectorsModel } from '../models/collectors.js';
import { usersModel } from '../models/users.js';
import { safeCompare, hashToken } from '../services/auth/hash.js';
import { verifyAccessToken } from '../services/auth/index.js';
import { enrichContext } from '../utilities/logger.js';
import { asyncHandler } from './context.js';

/**
 * Authentication and authorisation middleware.
 *
 * The user record is loaded on every request rather than trusted from the JWT.
 * That costs one indexed primary-key lookup and buys immediate revocation: an
 * account disabled by an admin stops working now, not in fifteen minutes when
 * the access token happens to expire. For an internal system where "disable
 * that account" is usually said out loud while something is going wrong, that
 * is the right trade.
 */

export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw errors.unauthenticated();
  }

  const claims = verifyAccessToken(header.slice(7).trim());
  const user = await usersModel.find(pool, claims.sub);

  if (!user || !user.isActive || user.isSystem) {
    throw errors.unauthenticated('This account is no longer active.');
  }

  req.actor = {
    id: user.id,
    username: user.username,
    role: user.role,
    department: user.department,
    mustChangePassword: user.mustChangePassword,
  };

  enrichContext({ userId: user.id, username: user.username });
  next();
});

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.actor?.role !== 'admin') {
    next(errors.forbidden('This action requires an administrator account.'));
    return;
  }
  next();
};

/**
 * GAP-01 — while `must_change_password` holds, every route except
 * `/auth/change-password` returns PASSWORD_CHANGE_REQUIRED.
 *
 * §B12.4 is blunt about why this is a middleware rather than a prompt in the
 * UI: "An operational reminder is not a control." A client that skips the
 * password screen must still be unable to print.
 */
export const requirePasswordChanged: RequestHandler = (req, _res, next) => {
  if (!req.actor) {
    next();
    return;
  }

  // Read from the record `authenticate` already loaded on this request. It used
  // to re-query, which cost two further round trips on every authenticated call
  // to re-read a column the middleware above had just selected — and gave the
  // same answer, since both run inside one request.
  if (req.actor.mustChangePassword) {
    next(
      new AppError('PASSWORD_CHANGE_REQUIRED', 'Choose a new password before continuing.', {
        details: { changePasswordPath: '/api/auth/change-password' },
      }),
    );
    return;
  }
  next();
};

/**
 * Collector authentication (§B11.3).
 *
 * A per-collector API key, stored hashed and compared in constant time. Every
 * active key is fetched and tested rather than looked up by hash, because the
 * candidate set is one row per building — the cost is nil and the comparison
 * stays constant-time per candidate.
 */
export const authenticateCollector: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw errors.unauthenticated('A collector API key is required.');
  }

  const presented = hashToken(header.slice(7).trim());
  const candidates = await collectorsModel.listActiveKeyHashes(pool);

  const match = candidates.find((candidate) => safeCompare(candidate.apiKeyHash, presented));
  if (!match) {
    throw errors.unauthenticated('That collector key is not recognised.');
  }

  req.collectorId = match.id;
  enrichContext({ username: `collector:${match.id}` });
  next();
});

/** Narrows `req.actor` for handlers, so the non-null assertion lives in one place. */
export function actorOf(req: Express.Request): NonNullable<Express.Request['actor']> {
  if (!req.actor) throw errors.unauthenticated();
  return req.actor;
}
