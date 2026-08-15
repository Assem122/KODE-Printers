import { z } from 'zod';

/**
 * INV-02 — this module and `guards.ts` are the only places in the codebase that
 * touch `process.env`. Everything else imports the frozen `config` object from
 * `./index.js`.
 *
 * The rule exists because the alternative is `process.env.X ?? someDefault`
 * scattered across forty files, where nobody can answer "what does this
 * deployment actually run with" and a typo in a variable name degrades silently
 * into a default. A single typed surface makes the answer readable and makes a
 * missing value a startup failure rather than a 3am mystery.
 */

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const int = (fallback: number, min?: number, max?: number) => {
  let schema = z.coerce.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? String(fallback) : value))
    .pipe(schema);
};

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  );

/**
 * Every variable the application reads. §B3 states that anything not listed
 * here MUST NOT be read from the environment, and `.strip()` semantics plus the
 * INV-02 rule are what enforce it.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** `false` turns on the production boot guards in §B3.3. */
  KODE_DEBUG: bool(true),
  APP_VERSION: z.string().default('1.0.0'),

  /* --- HTTP ------------------------------------------------------------- */
  PORT: int(3000, 1, 65535),
  /**
   * Where this process sits relative to the thing terminating TLS.
   *
   * §B18.3 requires that the application is never directly reachable, but the
   * way that is achieved differs by deployment and the guard has to check the
   * property rather than one particular means:
   *
   *   `loopback`  — the proxy shares this host (IIS, or Caddy on the metal).
   *                 Binding anything but loopback exposes the app without TLS.
   *   `container` — the proxy is a separate service and the app's port is not
   *                 published, so the app must bind a routable address to be
   *                 reachable at all. Isolation comes from the unpublished port.
   *
   * Defaults to the stricter of the two, so an unset value fails closed.
   */
  DEPLOYMENT_TOPOLOGY: z.enum(['loopback', 'container']).default('loopback'),
  /**
   * §B18.3: under the `loopback` topology the process binds loopback only and
   * IIS/Caddy terminates TLS in front of it. Binding anything else there is a
   * boot failure, checked in guards.ts.
   */
  BIND_HOST: z.string().default('127.0.0.1'),
  /** Explicit allow-list. A wildcard is a boot failure in production. */
  CORS_ORIGINS: csv,
  /** Number of proxy hops, so rate limiting sees the real client address. */
  TRUST_PROXY_HOPS: int(1, 0, 10),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  /* --- Database --------------------------------------------------------- */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required.'),
  DB_POOL_MAX: int(10, 1, 100),
  DB_STATEMENT_TIMEOUT_MS: int(15_000, 1000, 120_000),

  /* --- Secrets ---------------------------------------------------------- */
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required.'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  JWT_REFRESH_TTL_REMEMBERED: z.string().default('30d'),
  SECRET_KEY: z.string().min(1, 'SECRET_KEY is required.'),

  /* --- Uploads and storage ---------------------------------------------- */
  UPLOAD_DIR: z.string().default('./data/uploads'),
  SCAN_DIR: z.string().default('./data/scans'),
  TEMPLATE_DIR: z.string().default('./data/templates'),
  TMP_DIR: z.string().default('./data/tmp'),
  UPLOAD_MAX_BYTES: int(104_857_600, 1024, 1_073_741_824),

  /* --- Converters ------------------------------------------------------- */
  LIBREOFFICE_PATH: z.string().default('soffice'),
  GHOSTSCRIPT_PATH: z.string().default('gs'),
  CONVERT_TIMEOUT_MS: int(120_000, 5_000, 900_000),
  /** Wraps every converter invocation. See services/pipeline/sandbox.ts. */
  CONVERT_SANDBOX_CMD: z.string().optional(),
  CONVERT_MAX_MEMORY_MB: int(1024, 128, 16_384),

  /* --- SNMP ------------------------------------------------------------- */
  SNMP_DEFAULT_VERSION: z.enum(['1', '2c', '3']).default('2c'),
  SNMP_DEFAULT_COMMUNITY: z.string().default('public'),
  SNMP_TIMEOUT_MS: int(2000, 250, 30_000),
  SNMP_RETRIES: int(1, 0, 5),

  /* --- Polling ---------------------------------------------------------- */
  POLL_INTERVAL_MS: int(4000, 1000, 600_000),
  POLL_MAX_BACKOFF_MS: int(300_000, 5000, 3_600_000),
  STATUS_POLL_INTERVAL_MS: int(15_000, 2000, 600_000),
  SCAN_POLL_INTERVAL_MS: int(4000, 1000, 600_000),
  /** A scan file must be unchanged this long before ingestion. ADR-009. */
  SCAN_STABILITY_MS: int(2000, 250, 60_000),
  WATCHERS_ENABLED: bool(true),

  /* --- Queue ------------------------------------------------------------ */
  QUEUE_CONCURRENCY: int(2, 1, 32),
  QUEUE_MAX_ATTEMPTS: int(3, 1, 10),
  QUEUE_POLL_INTERVAL_MS: int(1000, 100, 60_000),
  /** A job stuck in `processing` past this is reclaimed on the next sweep. */
  QUEUE_LOCK_TIMEOUT_MS: int(900_000, 60_000, 7_200_000),
  QUEUE_ENABLED: bool(true),

  /* --- Rate limits (requests per minute) -------------------------------- */
  RATE_LIMIT_GENERAL: int(300, 10, 100_000),
  RATE_LIMIT_LOGIN: int(10, 1, 1000),
  RATE_LIMIT_UPLOAD: int(30, 1, 10_000),

  /* --- Account security ------------------------------------------------- */
  LOGIN_MAX_FAILURES: int(10, 3, 100),
  LOGIN_FAILURE_WINDOW_MS: int(900_000, 60_000, 86_400_000),
  LOGIN_LOCKOUT_MS: int(900_000, 60_000, 86_400_000),

  /* --- Email ------------------------------------------------------------ */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(25, 1, 65535),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('KODE Printer <printer@kodesportsclub.local>'),
  EMAIL_ENABLED: bool(false),

  /* --- Web push --------------------------------------------------------- */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:it@kodesportsclub.local'),

  /* --- Collector (§B11) -------------------------------------------------- */
  COLLECTOR_MODE: bool(false),
  COLLECTOR_UPSTREAM_URL: z.string().optional(),
  COLLECTOR_API_KEY: z.string().optional(),
  COLLECTOR_NAME: z.string().default('collector'),
  COLLECTOR_SPOOL_DIR: z.string().default('./data/spool'),
  COLLECTOR_SPOOL_MAX_EVENTS: int(50_000, 100, 5_000_000),
  COLLECTOR_HEARTBEAT_MS: int(30_000, 5000, 600_000),

  /* --- Observability ----------------------------------------------------- */
  // `silent` is a real pino level, used by the test suite and by anyone who
  // wants the process to log nothing at all.
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  METRICS_ENABLED: bool(true),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Reads and validates the environment exactly once.
 *
 * Failures are reported all at once with the offending variable names, because
 * a deployment that is missing three variables should learn all three now
 * rather than across three restarts.
 */
export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues
    .map((issue) => `  · ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Configuration is not valid:\n${problems}`);
}
