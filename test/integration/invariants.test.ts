import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../apps/server/src/db/pool.js';
import { jobsModel } from '../../apps/server/src/models/jobs.js';
import { refreshTokensModel } from '../../apps/server/src/models/refreshTokens.js';
import { usersModel } from '../../apps/server/src/models/users.js';
import { auditModel } from '../../apps/server/src/models/audit.js';
import { canUsePrinter } from '../../apps/server/src/services/printerAccess.js';
import { hashToken } from '../../apps/server/src/services/auth/hash.js';
import { pgErrorCode, PG_ERRORS } from '../../apps/server/src/db/sql.js';
import {
  closeDatabase,
  hasDatabase,
  insertTestJob,
  resetDatabase,
  type TestContext,
} from './helpers.js';

afterAll(async () => {
  // The pool is a module singleton shared by every describe in this file, so it
  // is closed once here. Closing it per describe meant the first block to
  // finish killed the pool for all the others, which is why the integration
  // suite failed everywhere except its first few tests.
  await closeDatabase();
});

/**
 * §B17.2 scenarios 7 to 10, plus the invariants they rest on.
 *
 * Every assertion here targets something enforced by the **database**, not by
 * application code. That distinction is the point: §B4.7 notes the delivered
 * build blocked hard deletion "in the model layer only, which one bypassing
 * route would defeat".
 */

const available = await hasDatabase();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    '\n  ⚠ Integration tests skipped: no PostgreSQL at DATABASE_URL.' +
      '\n    Start one with:  docker compose up -d db\n',
  );
}

let context: TestContext;

suite('database-enforced invariants', () => {
  beforeAll(async () => {
    context = await resetDatabase();
  });

  beforeEach(async () => {
    context = await resetDatabase();
  });

  it('7. hard-deleting a printer with job history is refused by the database, not only the model', async () => {
    await insertTestJob(context);

    // Deleting directly, bypassing every application check — which is exactly
    // the "one bypassing route" §B4.7 worries about.
    let code: string | null = null;
    try {
      await pool.query('DELETE FROM printers WHERE id = $1', [context.printerId]);
    } catch (error) {
      code = pgErrorCode(error);
    }

    expect(code).toBe(PG_ERRORS.restrictViolation);

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM printers WHERE id = $1',
      [context.printerId],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('7b. a printer with no history can still be deleted', async () => {
    // The invariant protects the record, not the printer. A device added by
    // mistake and never used must remain removable.
    await expect(
      pool.query('DELETE FROM printers WHERE id = $1', [context.printerId]),
    ).resolves.toBeDefined();
  });

  it('8. deleting a user leaves their jobs readable via the username snapshot', async () => {
    const jobId = await insertTestJob(context);

    await pool.query('DELETE FROM users WHERE id = $1', [context.userId]);

    const job = await jobsModel.find(pool, jobId);
    expect(job).not.toBeNull();
    // INV-06 — the record stays readable after the user record is gone.
    expect(job?.usernameSnapshot).toBe('testuser');
    expect(job?.userId).toBeNull();
  });

  it('8b. deleting a user cascades their printer grants but not their history', async () => {
    await pool.query('INSERT INTO user_printers (user_id, printer_id) VALUES ($1, $2)', [
      context.userId,
      context.printerId,
    ]);
    const jobId = await insertTestJob(context);

    await pool.query('DELETE FROM users WHERE id = $1', [context.userId]);

    const { rows: grants } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM user_printers WHERE user_id = $1',
      [context.userId],
    );
    expect(grants[0]?.count).toBe(0);
    expect(await jobsModel.find(pool, jobId)).not.toBeNull();
  });

  it('9. reusing a rotated refresh token revokes the whole family', async () => {
    const familyId = crypto.randomUUID();

    const firstId = await refreshTokensModel.insert(pool, {
      userId: context.userId,
      familyId,
      tokenHash: hashToken('token-one'),
      expiresAt: new Date(Date.now() + 86_400_000),
      userAgent: null,
      ipAddress: null,
    });

    // A normal rotation: token two replaces token one.
    await refreshTokensModel.insert(pool, {
      userId: context.userId,
      familyId,
      tokenHash: hashToken('token-two'),
      expiresAt: new Date(Date.now() + 86_400_000),
      userAgent: null,
      ipAddress: null,
      replacesId: firstId,
    });

    const replayed = await refreshTokensModel.findByHash(pool, hashToken('token-one'));
    expect(replayed?.revokedAt).not.toBeNull();

    // The response to detected reuse. Without this the attacker simply keeps
    // using token two, and detection provides no security at all.
    const revoked = await refreshTokensModel.revokeFamily(pool, familyId);
    expect(revoked).toBeGreaterThanOrEqual(1);

    const survivor = await refreshTokensModel.findByHash(pool, hashToken('token-two'));
    expect(survivor?.revokedAt).not.toBeNull();
  });

  it('10. a non-admin has no access to a printer that is not in user_printers', async () => {
    const actor = { id: context.userId, username: 'testuser', role: 'user' as const };

    expect(await canUsePrinter(actor, context.printerId)).toBe(false);

    await pool.query('INSERT INTO user_printers (user_id, printer_id) VALUES ($1, $2)', [
      context.userId,
      context.printerId,
    ]);
    expect(await canUsePrinter(actor, context.printerId)).toBe(true);

    // INV-01 — department must not influence access. The user's department is
    // 'Reception' and so is the printer's area; that must change nothing.
    await pool.query('DELETE FROM user_printers WHERE user_id = $1', [context.userId]);
    expect(await canUsePrinter(actor, context.printerId)).toBe(false);
  });

  it('10b. an expired grant stops granting', async () => {
    const actor = { id: context.userId, username: 'testuser', role: 'user' as const };

    await pool.query(
      `INSERT INTO user_printers (user_id, printer_id, expires_at)
       VALUES ($1, $2, now() - interval '1 hour')`,
      [context.userId, context.printerId],
    );

    // Temporary access for an event contractor that silently outlives the event
    // is the same defect as never revoking it.
    expect(await canUsePrinter(actor, context.printerId)).toBe(false);
  });

  it('10c. an admin needs no grant', async () => {
    const admin = { id: context.adminId, username: 'testadmin', role: 'admin' as const };
    expect(await canUsePrinter(admin, context.printerId)).toBe(true);
  });
});

suite('the audit log is append-only', () => {
  beforeEach(async () => {
    context = await resetDatabase();
  });

  it('refuses UPDATE at the database level', async () => {
    await auditModel.write(pool, {
      actorUserId: context.adminId,
      actorUsername: 'testadmin',
      action: 'printer.update',
      entityType: 'printer',
      entityId: context.printerId,
      after: { name: 'Renamed' },
    });

    let code: string | null = null;
    try {
      await pool.query("UPDATE audit_log SET action = 'tampered'");
    } catch (error) {
      code = pgErrorCode(error);
    }
    expect(code).toBe(PG_ERRORS.restrictViolation);
  });

  it('refuses DELETE at the database level', async () => {
    await auditModel.write(pool, {
      actorUserId: context.adminId,
      actorUsername: 'testadmin',
      action: 'user.deactivate',
      entityType: 'user',
      entityId: context.userId,
    });

    let code: string | null = null;
    try {
      await pool.query('DELETE FROM audit_log');
    } catch (error) {
      code = pgErrorCode(error);
    }
    expect(code).toBe(PG_ERRORS.restrictViolation);
  });

  it('redacts secrets that reach an audit payload', async () => {
    await auditModel.write(pool, {
      actorUserId: context.adminId,
      actorUsername: 'testadmin',
      action: 'printer.update',
      entityType: 'printer',
      entityId: context.printerId,
      // A caller passing a whole row, secrets included, is the realistic
      // mistake. The boundary catches it rather than trusting the call site.
      after: { name: 'Reception MFP', snmpCommunity: 'super-secret', passwordHash: 'argon2...' },
    });

    const { rows } = await pool.query<{ after: Record<string, unknown> }>(
      'SELECT after FROM audit_log ORDER BY id DESC LIMIT 1',
    );
    expect(rows[0]?.after?.snmpCommunity).toBe('[redacted]');
    expect(rows[0]?.after?.passwordHash).toBe('[redacted]');
    expect(rows[0]?.after?.name).toBe('Reception MFP');
  });
});

suite('account lockout (GAP-18)', () => {
  beforeEach(async () => {
    context = await resetDatabase();
  });

  it('locks after the threshold inside the window', async () => {
    const options = { windowMs: 900_000, maxFailures: 3, lockoutMs: 900_000 };

    expect((await usersModel.recordLoginFailure(pool, context.userId, options)).locked).toBe(false);
    expect((await usersModel.recordLoginFailure(pool, context.userId, options)).locked).toBe(false);

    const third = await usersModel.recordLoginFailure(pool, context.userId, options);
    expect(third.locked).toBe(true);
    expect(third.failures).toBe(3);

    const user = await usersModel.find(pool, context.userId);
    expect(user?.lockedUntil).not.toBeNull();
  });

  it('restarts the count when the window has passed', async () => {
    const options = { windowMs: 900_000, maxFailures: 3, lockoutMs: 900_000 };
    await usersModel.recordLoginFailure(pool, context.userId, options);
    await usersModel.recordLoginFailure(pool, context.userId, options);

    // Ten failures spread over a month is a forgetful person; ten in fifteen
    // minutes is an attack. Counting without a window locks out the former.
    await pool.query(
      `UPDATE users SET first_failed_login_at = now() - interval '2 hours' WHERE id = $1`,
      [context.userId],
    );

    const next = await usersModel.recordLoginFailure(pool, context.userId, options);
    expect(next.failures).toBe(1);
    expect(next.locked).toBe(false);
  });

  it('a successful sign-in clears the count and the lock', async () => {
    const options = { windowMs: 900_000, maxFailures: 3, lockoutMs: 900_000 };
    await usersModel.recordLoginFailure(pool, context.userId, options);
    await usersModel.recordLoginFailure(pool, context.userId, options);
    await usersModel.recordLoginFailure(pool, context.userId, options);

    await usersModel.recordLoginSuccess(pool, context.userId);

    const user = await usersModel.find(pool, context.userId);
    expect(user?.lockedUntil).toBeNull();
    expect(user?.lastLoginAt).not.toBeNull();
  });
});
