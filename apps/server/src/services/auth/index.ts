import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AppError, type LoginResult, type Role, type User } from '@kode/shared';
import { config } from '../../config/index.js';
import { pool, withTransaction, type Db } from '../../db/pool.js';
import { auditModel } from '../../models/audit.js';
import { refreshTokensModel } from '../../models/refreshTokens.js';
import { usersModel } from '../../models/users.js';
import { subsystem } from '../../utilities/logger.js';
import { notify } from '../notify.js';
import { revalidateSetupState } from '../setupState.js';
import {
  generateRefreshToken,
  hashPassword,
  hashToken,
  isObviousPassword,
  needsRehash,
  verifyPassword,
} from './hash.js';

const log = subsystem('auth');

/**
 * Authentication.
 *
 * Local accounts today, behind a provider seam so Active Directory can be added
 * without touching a route (see `AuthProvider` below). The token model is
 * §B12.3: short-lived access JWT, opaque rotating refresh token, and family
 * revocation on reuse.
 */

export interface AccessTokenClaims {
  sub: number;
  username: string;
  role: Role;
  /** Set while `must_change_password` holds, so the middleware can gate routes. */
  pwd?: 'change-required';
}

export interface AuthContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

/* --------------------------------------------------------- provider seam   */

export interface AuthProvider {
  readonly id: string;
  /** Returns the username on success, null on rejection. */
  authenticate(username: string, password: string): Promise<string | null>;
}

/**
 * The local provider. An LDAP provider implementing the same two-method
 * interface can be registered alongside it, and `resolveProvider` picks by the
 * user's `auth_provider` column — so adding AD is a new file and a config
 * value, not a change to the login route.
 */
const localProvider: AuthProvider = {
  id: 'local',
  async authenticate(username, password) {
    const credentials = await usersModel.findCredentials(pool, username);
    if (!credentials?.passwordHash) return null;
    const ok = await verifyPassword(credentials.passwordHash, password);
    if (!ok) return null;

    // Transparent upgrade if the cost parameters have since been raised.
    if (needsRehash(credentials.passwordHash)) {
      await usersModel.setPasswordHash(
        pool,
        credentials.id,
        await hashPassword(password),
        credentials.mustChangePassword,
      );
    }
    return credentials.username;
  },
};

const providers = new Map<string, AuthProvider>([[localProvider.id, localProvider]]);

export function registerProvider(provider: AuthProvider): void {
  providers.set(provider.id, provider);
  log.info({ provider: provider.id }, 'auth provider registered');
}

/* ------------------------------------------------------------------ login  */

/**
 * What a sign-in or a rotation hands back to the route.
 *
 * `refreshMaxAgeSeconds` travels with the token because the cookie's lifetime
 * has to match the token's. The route used to set it from the *remembered* TTL
 * unconditionally, so an ordinary session held a thirty-day cookie around a
 * seven-day token and ended in a rejected refresh instead of a clean expiry.
 */
export interface Session {
  result: LoginResult;
  refreshToken: string;
  refreshMaxAgeSeconds: number;
}

export async function login(
  username: string,
  password: string,
  rememberMe: boolean,
  context: AuthContext,
): Promise<Session> {
  const credentials = await usersModel.findCredentials(pool, username);

  /* A uniform failure for every rejection path.
   *
   * "No such user", "wrong password" and "account disabled" all produce the
   * same message and, because the argon2 verify below runs even for an unknown
   * user, roughly the same timing. Distinguishing them turns the login form
   * into a username oracle. */
  const reject = async (reason: string): Promise<never> => {
    await auditModel.write(pool, {
      actorUserId: credentials?.id ?? null,
      actorUsername: username,
      action: 'auth.login_failure',
      entityType: 'user',
      entityId: credentials?.id ?? null,
      after: { reason },
      ipAddress: context.ip,
      requestId: context.requestId,
    });
    throw new AppError('CREDENTIALS_INVALID', 'That username or password is not correct.');
  };

  if (!credentials) {
    // Burn comparable time so a missing account is not detectable by latency.
    await verifyPassword(
      '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      password,
    );
    return reject('unknown-user');
  }

  if (credentials.isSystem) return reject('system-account');
  if (!credentials.isActive) return reject('account-disabled');

  if (credentials.lockedUntil && Date.parse(credentials.lockedUntil) > Date.now()) {
    const minutes = Math.ceil((Date.parse(credentials.lockedUntil) - Date.now()) / 60_000);
    throw new AppError(
      'ACCOUNT_LOCKED',
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, ` +
        'or ask an administrator to reset your password.',
      { details: { minutes } },
    );
  }

  const provider = providers.get(credentials.authProvider);
  if (!provider) {
    log.error({ provider: credentials.authProvider }, 'no auth provider registered for user');
    return reject('provider-missing');
  }

  const authenticated = await provider.authenticate(username, password);
  if (!authenticated) {
    const { locked, failures } = await usersModel.recordLoginFailure(pool, credentials.id, {
      windowMs: config.auth.failureWindowMs,
      maxFailures: config.auth.maxFailures,
      lockoutMs: config.auth.lockoutMs,
    });

    if (locked) {
      await notify(
        {
          type: 'auth.account_locked',
          severity: 'warning',
          message: `Account "${username}" was locked after ${failures} failed sign-in attempts.`,
          payload: { username, failures, ip: context.ip },
        },
        pool,
      );
    }
    return reject('bad-password');
  }

  const user = await usersModel.find(pool, credentials.id);
  if (!user) return reject('user-vanished');

  await usersModel.recordLoginSuccess(pool, user.id);

  const { accessToken, expiresIn } = signAccessToken(user, credentials.mustChangePassword);
  const issued = await issueRefreshToken(pool, user.id, randomUUID(), rememberMe, context);

  await auditModel.write(pool, {
    actorUserId: user.id,
    actorUsername: user.username,
    action: 'auth.login_success',
    entityType: 'user',
    entityId: user.id,
    ipAddress: context.ip,
    requestId: context.requestId,
  });

  log.info({ userId: user.id, username: user.username }, 'sign-in succeeded');

  return {
    result: {
      accessToken,
      expiresIn,
      user,
      mustChangePassword: credentials.mustChangePassword,
    },
    refreshToken: issued.token,
    refreshMaxAgeSeconds: issued.maxAgeSeconds,
  };
}

/* ---------------------------------------------------------------- refresh  */

/**
 * Rotates a refresh token, revoking the whole family on reuse.
 *
 * §B12.3: "Detecting reuse and doing nothing about it provides no security."
 * The delivered build chained tokens through `replaced_by`, which made reuse
 * *visible* — but an attacker whose stolen token was rejected could simply keep
 * using the one it had already been exchanged for. Revoking the family is what
 * closes that.
 */
export async function refresh(presentedToken: string, context: AuthContext): Promise<Session> {
  const tokenHash = hashToken(presentedToken);

  return withTransaction(async (tx) => {
    const stored = await refreshTokensModel.findByHash(tx, tokenHash);
    if (!stored) {
      throw new AppError('UNAUTHENTICATED', 'Your session has expired. Sign in again.');
    }

    if (stored.revokedAt !== null) {
      const revoked = await refreshTokensModel.revokeFamily(tx, stored.familyId);
      const user = await usersModel.find(tx, stored.userId);

      await auditModel.write(tx, {
        actorUserId: stored.userId,
        actorUsername: user?.username ?? 'unknown',
        action: 'auth.token_reuse',
        entityType: 'user',
        entityId: stored.userId,
        after: { familyId: stored.familyId, tokensRevoked: revoked },
        ipAddress: context.ip,
        requestId: context.requestId,
      });

      // Deliberately fire-and-forget outside the transaction's success path:
      // the revocation must commit even if the notification channel is down.
      void notify(
        {
          type: 'auth.token_reuse',
          severity: 'critical',
          message:
            `A refresh token for "${user?.username ?? 'unknown'}" was replayed. Every session ` +
            'for that account has been ended. This is either a stolen token or a broken client.',
          payload: { userId: stored.userId, ip: context.ip },
        },
        pool,
      );

      log.warn(
        { userId: stored.userId, familyId: stored.familyId },
        'refresh token reuse — family revoked',
      );

      throw new AppError(
        'TOKEN_REUSE_DETECTED',
        'This session has been ended for security reasons.',
      );
    }

    if (Date.parse(stored.expiresAt) <= Date.now()) {
      throw new AppError('UNAUTHENTICATED', 'Your session has expired. Sign in again.');
    }

    const user = await usersModel.find(tx, stored.userId);
    if (!user?.isActive) {
      await refreshTokensModel.revokeFamily(tx, stored.familyId);
      throw new AppError('UNAUTHENTICATED', 'This account is no longer active.');
    }

    const credentials = await usersModel.findCredentialsById(tx, user.id);
    const { accessToken, expiresIn } = signAccessToken(
      user,
      credentials?.mustChangePassword ?? false,
    );

    // The family's original choice, not `false`. Rotating a remembered session
    // into a seven-day token quietly signed those people out a week in.
    const rotated = await issueRefreshToken(
      tx,
      user.id,
      stored.familyId,
      stored.remembered,
      context,
      stored.id,
    );

    return {
      result: {
        accessToken,
        expiresIn,
        user,
        mustChangePassword: credentials?.mustChangePassword ?? false,
      },
      refreshToken: rotated.token,
      refreshMaxAgeSeconds: rotated.maxAgeSeconds,
    };
  });
}

export async function logout(presentedToken: string): Promise<void> {
  await refreshTokensModel.revokeOne(pool, hashToken(presentedToken));
}

export async function logoutAll(
  userId: number,
  username: string,
  context: AuthContext,
): Promise<number> {
  return withTransaction(async (tx) => {
    const revoked = await refreshTokensModel.revokeAllForUser(tx, userId);
    await auditModel.write(tx, {
      actorUserId: userId,
      actorUsername: username,
      action: 'auth.logout_all',
      entityType: 'user',
      entityId: userId,
      after: { tokensRevoked: revoked },
      ipAddress: context.ip,
      requestId: context.requestId,
    });
    return revoked;
  });
}

/* -------------------------------------------------------- change password  */

export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
  context: AuthContext,
): Promise<void> {
  const credentials = await usersModel.findCredentialsById(pool, userId);
  if (!credentials?.passwordHash) {
    throw new AppError('FORBIDDEN', 'This account does not use a local password.');
  }

  if (!(await verifyPassword(credentials.passwordHash, currentPassword))) {
    throw new AppError('CREDENTIALS_INVALID', 'Your current password is not correct.');
  }

  assertPasswordAcceptable(newPassword, credentials.username);

  await withTransaction(async (tx) => {
    await usersModel.setPasswordHash(tx, userId, await hashPassword(newPassword), false);
    await auditModel.write(tx, {
      actorUserId: userId,
      actorUsername: credentials.username,
      action: 'user.password_set',
      entityType: 'user',
      entityId: userId,
      after: { self: true },
      ipAddress: context.ip,
      requestId: context.requestId,
    });
    // Changing a password ends other sessions. If the change was prompted by a
    // suspected compromise, leaving the attacker's session alive defeats it.
    await refreshTokensModel.revokeAllForUser(tx, userId);
  });

  // This may have been the account holding the seeded password, which is the
  // one condition that locks the whole API down. Re-checking here is what turns
  // the lockdown from a state someone has to restart out of into one the
  // documented action clears.
  await revalidateSetupState();

  log.info({ userId }, 'password changed');
}

/**
 * Policy beyond the length rule in the shared schema.
 *
 * Kept server-side because it needs the username, which the client-side schema
 * does not have — and because a policy enforced only in the browser is not a
 * policy.
 */
export function assertPasswordAcceptable(password: string, username: string): void {
  if (isObviousPassword(password)) {
    throw new AppError(
      'PASSWORD_POLICY_VIOLATION',
      'That password is too easy to guess. Choose something less predictable.',
    );
  }
  if (password.toLowerCase().includes(username.toLowerCase())) {
    throw new AppError('PASSWORD_POLICY_VIOLATION', 'Your password cannot contain your username.');
  }
}

/* ------------------------------------------------------------------ tokens */

function signAccessToken(
  user: User,
  mustChangePassword: boolean,
): {
  accessToken: string;
  expiresIn: number;
} {
  const claims: AccessTokenClaims = {
    sub: user.id,
    username: user.username,
    role: user.role,
    ...(mustChangePassword ? { pwd: 'change-required' as const } : {}),
  };

  const accessToken = jwt.sign(claims, config.auth.jwtSecret, {
    expiresIn: config.auth.accessTtl,
    issuer: 'kode-printer',
    audience: 'kode-printer-web',
  } as jwt.SignOptions);

  return { accessToken, expiresIn: parseDuration(config.auth.accessTtl) };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    // `verify` is typed as `string | JwtPayload`; the claims we sign are
    // always an object, and the issuer/audience checks above have already
    // rejected anything this process did not issue.
    return jwt.verify(token, config.auth.jwtSecret, {
      issuer: 'kode-printer',
      audience: 'kode-printer-web',
    }) as unknown as AccessTokenClaims;
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    throw new AppError(
      'UNAUTHENTICATED',
      expired ? 'Your session has expired.' : 'Sign in to continue.',
      { cause: error },
    );
  }
}

async function issueRefreshToken(
  db: Db,
  userId: number,
  familyId: string,
  rememberMe: boolean,
  context: AuthContext,
  replacesId?: number,
): Promise<{ token: string; maxAgeSeconds: number }> {
  const { token, hash } = generateRefreshToken();
  const ttl = rememberMe ? config.auth.refreshTtlRemembered : config.auth.refreshTtl;
  const maxAgeSeconds = parseDuration(ttl);

  await refreshTokensModel.insert(db, {
    userId,
    familyId,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + maxAgeSeconds * 1000),
    userAgent: context.userAgent,
    ipAddress: context.ip,
    remembered: rememberMe,
    ...(replacesId === undefined ? {} : { replacesId }),
  });

  return { token, maxAgeSeconds };
}

/** Parses `15m`, `7d`, `24h`, or a bare number of seconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!match?.[1]) return 900;
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[unit] ?? 1;
  return amount * multiplier;
}
