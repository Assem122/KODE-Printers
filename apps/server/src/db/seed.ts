import { pool, withTransaction } from './pool.js';
import { runMigrations } from './migrate.js';
import { hashPassword, SEEDED_DEFAULT_PASSWORD } from '../services/auth/hash.js';
import { logger, serialiseError } from '../utilities/logger.js';

/**
 * First-run seed.
 *
 * Two rows, both structural rather than sample data:
 *
 *   · The **system account** owns walk-up jobs, so every job row has a stable,
 *     non-impersonatable actor rather than a NULL that every report must
 *     special-case. It is `is_active = FALSE` and `is_system = TRUE`, and the
 *     schema's CHECK constraint makes it un-loggable-in by construction.
 *
 *   · The **first administrator**, created with `must_change_password = TRUE`.
 *     GAP-01 was rated Critical precisely because the delivered build seeded
 *     `admin/admin123` with no forced rotation. Here the password is printed
 *     once to the console, the account cannot do anything until it is changed,
 *     and with `KODE_DEBUG=false` the process refuses to boot while any account
 *     still holds it. §B12.4: "An operational reminder is not a control."
 *
 * Zones are seeded from the club's actual layout, which the architecture
 * document leaves as a GAP (GAP-14) because it had no zone model at all.
 */

const ZONES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'MAIN', label: 'Main Office' },
  { code: 'CLUB', label: 'Club House' },
];

async function seed(): Promise<void> {
  await runMigrations();

  await withTransaction(async (tx) => {
    /* ------------------------------------------------------- system user  */

    const { rows: systemRows } = await tx.query<{ id: number }>(
      `INSERT INTO users (username, display_name, role, is_active, is_system, auth_provider)
       VALUES ('system', 'Device activity', 'user', FALSE, TRUE, 'system')
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
    );
    if (systemRows.length > 0) {
      logger.info('created the system account that owns walk-up activity');
    }

    /* ------------------------------------------------------------ zones   */

    for (const zone of ZONES) {
      await tx.query(
        `INSERT INTO zones (code, label) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`,
        [zone.code, zone.label],
      );
    }

    /* ----------------------------------------------------- first admin    */

    const { rows: adminCount } = await tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND NOT is_system`,
    );

    if ((adminCount[0]?.count ?? 0) > 0) {
      logger.info('an administrator already exists; not seeding another');
      return;
    }

    const passwordHash = await hashPassword(SEEDED_DEFAULT_PASSWORD);
    await tx.query(
      `INSERT INTO users (username, display_name, password_hash, role, must_change_password)
       VALUES ('admin', 'Initial administrator', $1, 'admin', TRUE)
       ON CONFLICT (username) DO NOTHING`,
      [passwordHash],
    );

    // Printed to the console, never logged as structured data and never stored
    // anywhere but the argon2 hash above.
    // Built rather than hand-aligned: the box drifted the last time its
    // wording changed, and a banner nobody trusts to be current is worse than
    // no banner.
    const WIDTH = 62;
    const line = (text = '') => `  │${`  ${text}`.padEnd(WIDTH)}│`;
    const rule = (left: string, right: string) => `  ${left}${'─'.repeat(WIDTH)}${right}`;

    process.stdout.write(
      [
        '',
        rule('┌', '┐'),
        line('KODE Printer — first administrator created'),
        rule('├', '┤'),
        line('Username:  admin'),
        line(`Password:  ${SEEDED_DEFAULT_PASSWORD}`),
        line(),
        line('You must change this at first sign-in. Until you do, the'),
        line('API serves only sign-in and the password change itself;'),
        line('every other route returns 503.'),
        rule('└', '┘'),
        '',
      ].join('\n'),
    );
  });
}

seed()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.fatal({ ...serialiseError(error) }, 'seed failed');
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
