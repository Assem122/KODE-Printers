import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger } from 'pino';
import { config } from '../config/index.js';

/**
 * Structured logging, §B13.1.
 *
 * Two things here are load-bearing rather than stylistic.
 *
 * The redaction list is INV-08 made mechanical. "Never log a secret" as a rule
 * survives exactly until someone logs a whole request body while debugging; a
 * redaction path means that debugging session prints `[redacted]` instead of a
 * refresh token. The list covers SNMP community strings and collector API keys
 * specifically because those are the two the document calls out and the two a
 * developer is least likely to think of as secrets.
 *
 * The request-scoped store is what makes `requestId` appear on every line
 * emitted during a request without threading a logger through forty function
 * signatures. §B5.2 calls requestId "the join key between a user's complaint
 * and the logs", and it only earns that description if it is on every line.
 */

export interface RequestContext {
  requestId: string;
  userId?: number;
  username?: string;
  ip?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? 'no-request';
}

/** Adds fields to the active request context, e.g. after authentication. */
export function enrichContext(fields: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

const redactPaths = [
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'token_hash',
  'apiKey',
  'api_key',
  'apiKeyHash',
  'snmpCommunity',
  'snmp_community',
  'snmpAuthKey',
  'snmpPrivKey',
  'authorization',
  'cookie',
  'set-cookie',
  'secret',
  'jwtSecret',
  'DATABASE_URL',
];

const expanded = redactPaths.flatMap((path) => [
  path,
  `*.${path}`,
  `*.*.${path}`,
  `req.headers.${path.toLowerCase()}`,
  `res.headers.${path.toLowerCase()}`,
]);

export const logger: Logger = pino({
  level: config.observability.logLevel,
  base: {
    service: 'kode-printer',
    version: config.version,
    ...(config.collector.mode ? { mode: 'collector', collector: config.collector.name } : {}),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: expanded, censor: '[redacted]' },
  /** Mixed into every line, so requestId/userId need no explicit passing. */
  mixin() {
    const store = storage.getStore();
    if (!store) return {};
    return {
      requestId: store.requestId,
      ...(store.userId === undefined ? {} : { userId: store.userId }),
      ...(store.username === undefined ? {} : { username: store.username }),
    };
  },
  ...(config.observability.logFormat === 'pretty'
    ? {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }
    : {}),
});

/**
 * A child logger for a subsystem. Preferred over passing the root logger, so a
 * line can be traced to the watcher, worker or route that emitted it.
 */
export function subsystem(name: string, extra: Record<string, unknown> = {}): Logger {
  return logger.child({ subsystem: name, ...extra });
}

/**
 * Renders an error for logging without leaking it to a client.
 *
 * The full chain is walked because a `PRINTER_UNREACHABLE` wrapping an
 * `ECONNREFUSED` is only useful if the cause survives; INV-12 keeps that detail
 * out of the response body, not out of the log.
 */
export function serialiseError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };

  const chain: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  let depth = 0;
  while (current instanceof Error && depth < 5) {
    chain.push({
      name: current.name,
      message: current.message,
      ...(typeof (current as NodeJS.ErrnoException).code === 'string'
        ? { code: (current as NodeJS.ErrnoException).code }
        : {}),
      stack: current.stack,
    });
    current = current.cause;
    depth += 1;
  }
  return { err: chain[0], ...(chain.length > 1 ? { causes: chain.slice(1) } : {}) };
}
