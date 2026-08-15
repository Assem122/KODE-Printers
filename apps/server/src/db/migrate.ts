import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool, withTransaction, type TxClient } from './pool.js';
import { serialiseError, subsystem } from '../utilities/logger.js';

const log = subsystem('migrate');
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Forward-only, ordered, idempotent migrations.
 *
 * Three properties, each earning its keep:
 *
 * The **advisory lock** means two application instances booting simultaneously
 * (a rolling restart, or the app and a collector sharing a database in a test)
 * cannot both run migration 003. One waits, then finds it already applied.
 *
 * The **checksum** catches an edited migration. Editing an applied migration is
 * the single most common way a schema drifts between two environments: it
 * succeeds on a fresh database and does nothing on an existing one, so the
 * difference only surfaces as a bewildering production bug weeks later. Here it
 * fails at boot with the filename.
 *
 * Each file runs in **its own transaction**, so a failure leaves the database at
 * the last complete migration rather than half-way through one.
 */

export interface AppliedMigration {
  filename: string;
  checksum: string;
  appliedAt: string;
  durationMs: number;
}

const MIGRATION_LOCK_KEY = 811_003;

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT        PRIMARY KEY,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER     NOT NULL DEFAULT 0
    )
  `);
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

const checksumOf = (sql: string): string =>
  createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 32);

export async function runMigrations(): Promise<AppliedMigration[]> {
  await ensureMigrationsTable();

  const client = await pool.connect();
  try {
    // Blocking acquire: unlike the periodic sweeps, a booting instance must not
    // proceed on an un-migrated schema, so waiting is the correct behaviour.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    const files = await listMigrationFiles();
    const { rows: applied } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const appliedByName = new Map(applied.map((row) => [row.filename, row.checksum]));

    const results: AppliedMigration[] = [];

    for (const filename of files) {
      const sql = await readFile(join(migrationsDir, filename), 'utf8');
      const checksum = checksumOf(sql);
      const previous = appliedByName.get(filename);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${filename} has changed since it was applied ` +
              `(recorded ${previous}, now ${checksum}). Applied migrations are immutable — ` +
              'add a new migration instead of editing this one.',
          );
        }
        continue;
      }

      const startedAt = Date.now();
      log.info({ filename }, 'applying migration');

      await withTransaction(async (tx: TxClient) => {
        await tx.query(sql);
        await tx.query(
          `INSERT INTO schema_migrations (filename, checksum, duration_ms)
           VALUES ($1, $2, $3)`,
          [filename, checksum, Date.now() - startedAt],
        );
      });

      const durationMs = Date.now() - startedAt;
      log.info({ filename, durationMs }, 'migration applied');
      results.push({
        filename,
        checksum,
        appliedAt: new Date().toISOString(),
        durationMs,
      });
    }

    if (results.length === 0) log.info({ count: files.length }, 'schema is up to date');
    return results;
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}

/**
 * `npm run migrate` — used by CI, the restore procedure and the Docker entrypoint.
 *
 * `pathToFileURL` rather than a hand-built `file://` string. The latter yields
 * `file://C:/…` on Windows where Node's `import.meta.url` is `file:///C:/…`, so
 * the comparison never matched and the command exited 0 having applied nothing:
 * a silent no-op on exactly the platform this is developed on.
 */
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runMigrations()
    .then(async (applied) => {
      log.info({ applied: applied.length }, 'migrations complete');
      await pool.end();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      log.fatal({ ...serialiseError(error) }, 'migrations failed');
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
