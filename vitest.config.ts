import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 * Coverage thresholds apply to the modules §B17.4 names — pipeline, transport,
 * permission and ledger — rather than as a blanket percentage across the
 * repository. A blanket number rewards testing the easy files and says nothing
 * about whether the impression ledger is correct.
 */
export default defineConfig({
  resolve: {
    alias: {
      /**
       * Tests import `@kode/shared` transitively through server modules.
       * Pointing the alias at source rather than `dist` means `npm test` needs
       * no build step and, more usefully, a failing test points at the line you
       * would edit rather than at compiled output.
       */
      '@kode/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },

  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Runs before the config module is imported, so the boot-time validation in
    // `config/env.ts` sees a complete environment rather than being weakened.
    setupFiles: ['./test/setup.ts'],
    /**
     * Integration tests talk to a real Postgres and must not race each other
     * over the same schema. `resetDatabase` truncates every table and re-seeds
     * a fixed set of rows, so two files doing that at once means one of them
     * inserts the system account while the other has just truncated it away.
     *
     * `singleThread: false` said the opposite of the comment above it, and the
     * suite was never run against a database, so nothing contradicted it. The
     * whole run takes about nine seconds serially; parallelism here buys a
     * couple of those and costs a flake that looks like a product bug.
     */
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    fileParallelism: false,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'apps/server/src/services/**',
        'apps/server/src/models/**',
        'packages/shared/src/**',
      ],
      exclude: ['**/*.d.ts', '**/types.ts'],
      thresholds: {
        'apps/server/src/services/watchers/attribution.ts': {
          statements: 95,
          branches: 90,
          functions: 100,
          lines: 95,
        },
        'apps/server/src/services/transport/**': {
          statements: 70,
          branches: 60,
          functions: 70,
          lines: 70,
        },
        'apps/server/src/services/printerAccess.ts': {
          statements: 90,
          branches: 80,
          functions: 100,
          lines: 90,
        },
      },
    },
  },
});
