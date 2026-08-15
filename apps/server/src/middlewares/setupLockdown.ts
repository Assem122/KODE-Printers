import type { RequestHandler } from 'express';
import { AppError } from '@kode/shared';
import { isSetupIncomplete } from '../services/setupState.js';

/**
 * Refuses everything except the path out, while first-run setup is outstanding.
 *
 * The allow-list is the minimum needed to clear the condition and to answer a
 * health probe. `/auth/me` is on it because the client cannot render the
 * password screen without knowing who it is signed in as, and `/health` because
 * a container that reports itself unhealthy gets restarted into the same state.
 *
 * Everything else returns 503 rather than 403: the system is not refusing this
 * caller, it is not yet in service.
 */
const ALLOWED_WHILE_LOCKED: ReadonlySet<string> = new Set([
  '/health',
  '/health/ready',
  '/auth/login',
  '/auth/logout',
  '/auth/refresh',
  '/auth/me',
  '/auth/change-password',
]);

export const setupLockdown: RequestHandler = (req, _res, next) => {
  if (!isSetupIncomplete() || ALLOWED_WHILE_LOCKED.has(req.path)) {
    next();
    return;
  }

  next(
    new AppError(
      'DEPENDENCY_UNAVAILABLE',
      'This system has not finished its first-run setup: an account still holds the ' +
        'password printed by the seed. Sign in as that account and change it.',
      { details: { changePasswordPath: '/api/auth/change-password' }, retryable: false },
    ),
  );
};
