import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Lint configuration.
 *
 * Type-aware rules, because the ones that catch real defects — floating
 * promises, unsafe assignments, misused `await` — all need the type checker.
 * A lint pass without type information mostly enforces formatting, which
 * Prettier already does.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'apps/server/public/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        /**
         * Tests, build config and scripts sit outside the three app tsconfigs.
         * `tsconfig.eslint.json` covers them so they still get type-aware rules
         * — a floating promise in a test is as real as one in a route handler.
         *
         * A real project rather than `allowDefaultProject`, which caps at eight
         * files and warns loudly past that.
         */
        projectService: {
          defaultProject: 'tsconfig.eslint.json',
          // No `**` — the project service rejects it outright. One entry per
          // directory instead, which is also a useful nudge against the test
          // tree sprawling.
          allowDefaultProject: [
            '*.js',
            '*.mjs',
            '*.ts',
            'test/*.ts',
            'test/unit/*.ts',
            'test/integration/*.ts',
            'test/e2e/*.ts',
            'scripts/*.mjs',
            'apps/web/vite.config.ts',
          ],
          // The default cap is eight and this project has eleven such files.
          // The performance warning the flag name shouts about is about
          // hundreds, not eleven.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 40,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /**
       * A floating promise in a route handler is how an error escapes the
       * middleware chain and takes the process down (INV-11). This is the
       * single most valuable rule in the set.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Unused arguments are often deliberate in Express signatures; a leading
      // underscore is the convention that marks them as such.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // Template literals holding a number or boolean are idiomatic and safe.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // `??` and `?.` are preferred, but a `||` on a genuinely falsy-checking
      // branch is not a defect.
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',

      // The codebase uses `interface` for object shapes and `type` for unions,
      // consistently. Enforcing one or the other globally fights that.
      '@typescript-eslint/consistent-type-definitions': 'off',

      /**
       * `T[]` for simple element types, `Array<T>` / `ReadonlyArray<T>` for
       * anything generic or unioned. `readonly Array<{a: 1} | {b: 2}>[]` is
       * genuinely harder to read than the generic form, and this codebase has
       * a lot of readonly generics in the model layer.
       */
      '@typescript-eslint/array-type': ['error', { default: 'array-simple', readonly: 'array-simple' }],

      /**
       * `socket.on('error', () => undefined)` and similar are idiomatic Node
       * and clearer than a braced body that does nothing.
       */
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true },
      ],

      /**
       * Off, deliberately.
       *
       * The rule assumes declared types describe runtime reality. Much of this
       * codebase guards against cases where they do not: a `pg` row typed as
       * present that the query did not return, `Error.captureStackTrace` in a
       * browser where `@kode/shared` also runs, an API response shaped by a
       * server that may be a version behind.
       *
       * Every one of those guards is flagged as "unnecessary", and removing
       * them would trade a real safety property for a lint tick. The genuine
       * redundancies the rule also finds are not worth that.
       */
      '@typescript-eslint/no-unnecessary-condition': 'off',

      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  {
    // `tseslint.config()` is deprecated in favour of ESLint's own
    // `defineConfig()`, which is not yet in this ESLint major. Revisit on the
    // next upgrade.
    files: ['eslint.config.mjs'],
    rules: { '@typescript-eslint/no-deprecated': 'off' },
  },

  {
    // Migrations, seeds and scripts legitimately write to stdout: they are run
    // by a person at a terminal, not by the server.
    files: ['apps/server/src/db/seed.ts', 'apps/server/src/db/migrate.ts', 'tools/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    files: ['test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  {
    /**
     * Plain-JavaScript build scripts.
     *
     * Type-aware rules need a tsconfig that includes them, and adding one for a
     * single icon generator buys nothing — there are no types to check. The
     * checks that still matter (unused variables, unreachable code) come from
     * the base config.
     */
    files: ['scripts/**/*.mjs', '*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  prettier,
);
