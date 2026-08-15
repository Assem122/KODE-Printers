import { resolve } from 'node:path';
import { readEnv, type Env } from './env.js';

/**
 * The merged, frozen configuration object. Every module outside `config/`
 * imports this and never touches `process.env` (INV-02).
 *
 * Paths are resolved to absolute here rather than at each use site, so a
 * relative `UPLOAD_DIR` cannot mean two different directories depending on
 * which module happened to resolve it and from where.
 */

export interface Config {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  /** `KODE_DEBUG`. False switches on every production guard. */
  readonly debug: boolean;
  readonly version: string;

  readonly http: {
    readonly port: number;
    readonly host: string;
    /** Decides which form of "not directly reachable" the boot guard enforces. */
    readonly topology: Env['DEPLOYMENT_TOPOLOGY'];
    readonly corsOrigins: readonly string[];
    readonly trustProxyHops: number;
    readonly publicUrl: string;
  };

  readonly db: {
    readonly url: string;
    readonly poolMax: number;
    readonly statementTimeoutMs: number;
  };

  readonly auth: {
    readonly jwtSecret: string;
    readonly accessTtl: string;
    readonly refreshTtl: string;
    readonly refreshTtlRemembered: string;
    readonly secretKey: string;
    readonly maxFailures: number;
    readonly failureWindowMs: number;
    readonly lockoutMs: number;
  };

  readonly storage: {
    readonly uploadDir: string;
    readonly scanDir: string;
    readonly templateDir: string;
    readonly tmpDir: string;
    readonly maxUploadBytes: number;
  };

  readonly convert: {
    readonly libreOfficePath: string;
    readonly ghostscriptPath: string;
    readonly timeoutMs: number;
    readonly sandboxCommand: readonly string[] | null;
    readonly maxMemoryMb: number;
  };

  readonly snmp: {
    readonly defaultVersion: '1' | '2c' | '3';
    readonly defaultCommunity: string;
    readonly timeoutMs: number;
    readonly retries: number;
  };

  readonly polling: {
    readonly counterIntervalMs: number;
    readonly statusIntervalMs: number;
    readonly maxBackoffMs: number;
    readonly scanIntervalMs: number;
    readonly scanStabilityMs: number;
    readonly enabled: boolean;
  };

  readonly queue: {
    readonly concurrency: number;
    readonly maxAttempts: number;
    readonly pollIntervalMs: number;
    readonly lockTimeoutMs: number;
    readonly enabled: boolean;
    /** Identifies this worker in `jobs.locked_by`, so a crash is attributable. */
    readonly workerId: string;
  };

  readonly rateLimit: {
    readonly general: number;
    readonly login: number;
    readonly upload: number;
  };

  readonly email: {
    readonly enabled: boolean;
    readonly host: string | null;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string | null;
    readonly password: string | null;
    readonly from: string;
  };

  readonly push: {
    readonly enabled: boolean;
    readonly publicKey: string | null;
    readonly privateKey: string | null;
    readonly subject: string;
  };

  readonly collector: {
    readonly mode: boolean;
    readonly upstreamUrl: string | null;
    readonly apiKey: string | null;
    readonly name: string;
    readonly spoolDir: string;
    readonly spoolMaxEvents: number;
    readonly heartbeatMs: number;
  };

  readonly observability: {
    readonly logLevel: Env['LOG_LEVEL'];
    readonly logFormat: Env['LOG_FORMAT'];
    readonly metricsEnabled: boolean;
  };
}

function buildConfig(env: Env): Config {
  const isProduction = env.NODE_ENV === 'production';
  const abs = (path: string) => resolve(process.cwd(), path);

  return Object.freeze({
    env: env.NODE_ENV,
    isProduction,
    isTest: env.NODE_ENV === 'test',
    debug: env.KODE_DEBUG,
    version: env.APP_VERSION,

    http: Object.freeze({
      port: env.PORT,
      host: env.BIND_HOST,
      topology: env.DEPLOYMENT_TOPOLOGY,
      corsOrigins: Object.freeze([...env.CORS_ORIGINS]),
      trustProxyHops: env.TRUST_PROXY_HOPS,
      publicUrl: env.PUBLIC_URL.replace(/\/+$/, ''),
    }),

    db: Object.freeze({
      url: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    }),

    auth: Object.freeze({
      jwtSecret: env.JWT_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshTtl: env.JWT_REFRESH_TTL,
      refreshTtlRemembered: env.JWT_REFRESH_TTL_REMEMBERED,
      secretKey: env.SECRET_KEY,
      maxFailures: env.LOGIN_MAX_FAILURES,
      failureWindowMs: env.LOGIN_FAILURE_WINDOW_MS,
      lockoutMs: env.LOGIN_LOCKOUT_MS,
    }),

    storage: Object.freeze({
      uploadDir: abs(env.UPLOAD_DIR),
      scanDir: abs(env.SCAN_DIR),
      templateDir: abs(env.TEMPLATE_DIR),
      tmpDir: abs(env.TMP_DIR),
      maxUploadBytes: env.UPLOAD_MAX_BYTES,
    }),

    convert: Object.freeze({
      libreOfficePath: env.LIBREOFFICE_PATH,
      ghostscriptPath: env.GHOSTSCRIPT_PATH,
      timeoutMs: env.CONVERT_TIMEOUT_MS,
      sandboxCommand: env.CONVERT_SANDBOX_CMD
        ? Object.freeze(env.CONVERT_SANDBOX_CMD.split(/\s+/).filter(Boolean))
        : null,
      maxMemoryMb: env.CONVERT_MAX_MEMORY_MB,
    }),

    snmp: Object.freeze({
      defaultVersion: env.SNMP_DEFAULT_VERSION,
      defaultCommunity: env.SNMP_DEFAULT_COMMUNITY,
      timeoutMs: env.SNMP_TIMEOUT_MS,
      retries: env.SNMP_RETRIES,
    }),

    polling: Object.freeze({
      counterIntervalMs: env.POLL_INTERVAL_MS,
      statusIntervalMs: env.STATUS_POLL_INTERVAL_MS,
      maxBackoffMs: env.POLL_MAX_BACKOFF_MS,
      scanIntervalMs: env.SCAN_POLL_INTERVAL_MS,
      scanStabilityMs: env.SCAN_STABILITY_MS,
      enabled: env.WATCHERS_ENABLED,
    }),

    queue: Object.freeze({
      concurrency: env.QUEUE_CONCURRENCY,
      maxAttempts: env.QUEUE_MAX_ATTEMPTS,
      pollIntervalMs: env.QUEUE_POLL_INTERVAL_MS,
      lockTimeoutMs: env.QUEUE_LOCK_TIMEOUT_MS,
      enabled: env.QUEUE_ENABLED,
      workerId: `${process.env['HOSTNAME'] ?? 'host'}:${process.pid}`,
    }),

    rateLimit: Object.freeze({
      general: env.RATE_LIMIT_GENERAL,
      login: env.RATE_LIMIT_LOGIN,
      upload: env.RATE_LIMIT_UPLOAD,
    }),

    email: Object.freeze({
      enabled: env.EMAIL_ENABLED && Boolean(env.SMTP_HOST),
      host: env.SMTP_HOST ?? null,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER ?? null,
      password: env.SMTP_PASSWORD ?? null,
      from: env.SMTP_FROM,
    }),

    push: Object.freeze({
      enabled: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      publicKey: env.VAPID_PUBLIC_KEY ?? null,
      privateKey: env.VAPID_PRIVATE_KEY ?? null,
      subject: env.VAPID_SUBJECT,
    }),

    collector: Object.freeze({
      mode: env.COLLECTOR_MODE,
      upstreamUrl: env.COLLECTOR_UPSTREAM_URL ?? null,
      apiKey: env.COLLECTOR_API_KEY ?? null,
      name: env.COLLECTOR_NAME,
      spoolDir: abs(env.COLLECTOR_SPOOL_DIR),
      spoolMaxEvents: env.COLLECTOR_SPOOL_MAX_EVENTS,
      heartbeatMs: env.COLLECTOR_HEARTBEAT_MS,
    }),

    observability: Object.freeze({
      logLevel: env.LOG_LEVEL,
      logFormat: env.LOG_FORMAT,
      metricsEnabled: env.METRICS_ENABLED,
    }),
  });
}

/**
 * `config.queue.workerId` is the one place a raw `process.env` read survives
 * outside `env.ts`, and only because `HOSTNAME` is diagnostic rather than
 * configuration: it labels a lock holder in the queue table. It has no default
 * to get wrong and no behaviour depends on it.
 */
export const config: Config = buildConfig(readEnv());

export type { Env } from './env.js';
