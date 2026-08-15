import { execFile } from 'node:child_process';
import { access, mkdir, stat } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { config } from './index.js';

const execFileAsync = promisify(execFile);

/**
 * Boot guards, §B3.3.
 *
 * The governing sentence in the document is worth repeating because it drives
 * every decision here: *a silent start with a bad configuration is worse than
 * no start*. Each guard therefore fails loudly, names the offending variable,
 * and refuses to boot rather than degrading into a system that looks healthy
 * while shipping default credentials or skipping every Office conversion.
 *
 * They run only when `KODE_DEBUG=false`, so local development stays frictionless.
 */

export interface GuardFailure {
  variable: string;
  problem: string;
  remedy: string;
}

/** Placeholders that ship in example files and end up in production untouched. */
const PLACEHOLDER_SECRETS = new Set(
  [
    'change-me',
    'changeme',
    'secret',
    'mysecret',
    'your-secret-here',
    'your_secret_here',
    'kode-secret',
    'dev-secret',
    'development',
    'test',
    'password',
    'supersecret',
    'jwt-secret',
    'replace-me',
    'todo',
    'xxx',
  ].map((value) => value.toLowerCase()),
);

/** Credential pairs that mean "nobody rotated the database password". GAP-04. */
const DEFAULT_DB_CREDENTIALS: ReadonlyArray<readonly [string, string]> = [
  ['postgres', 'postgres'],
  ['postgres', 'password'],
  ['postgres', 'admin'],
  ['postgres', 'changeme'],
  ['kode', 'kode'],
  ['admin', 'admin'],
  ['root', 'root'],
];

const MIN_SECRET_LENGTH = 32;

export function checkSecrets(): GuardFailure[] {
  const failures: GuardFailure[] = [];

  const secrets: Array<[string, string]> = [
    ['JWT_SECRET', config.auth.jwtSecret],
    ['SECRET_KEY', config.auth.secretKey],
  ];

  for (const [variable, value] of secrets) {
    if (PLACEHOLDER_SECRETS.has(value.trim().toLowerCase())) {
      failures.push({
        variable,
        problem: 'is still set to a placeholder value.',
        remedy: 'Generate one with: openssl rand -base64 48',
      });
      continue;
    }
    if (value.length < MIN_SECRET_LENGTH) {
      failures.push({
        variable,
        problem: `is only ${value.length} characters; ${MIN_SECRET_LENGTH} is the minimum.`,
        remedy: 'Generate one with: openssl rand -base64 48',
      });
    }
  }

  if (config.auth.jwtSecret === config.auth.secretKey) {
    failures.push({
      variable: 'JWT_SECRET / SECRET_KEY',
      problem: 'are the same value, so compromising one compromises both.',
      remedy: 'Generate two independent secrets.',
    });
  }

  return failures;
}

/** GAP-04 — the delivered build checked JWT secrets but not database credentials. */
export function checkDatabaseUrl(): GuardFailure[] {
  let parsed: URL;
  try {
    parsed = new URL(config.db.url);
  } catch {
    return [
      {
        variable: 'DATABASE_URL',
        problem: 'is not a valid connection URL.',
        remedy: 'Use postgres://user:password@host:5432/database',
      },
    ];
  }

  const user = decodeURIComponent(parsed.username).toLowerCase();
  const password = decodeURIComponent(parsed.password);

  if (password === '') {
    return [
      {
        variable: 'DATABASE_URL',
        problem: 'has no password.',
        remedy: 'Set a password on the database role and put it in the URL.',
      },
    ];
  }

  const isDefault = DEFAULT_DB_CREDENTIALS.some(
    ([u, p]) => u === user && p === password.toLowerCase(),
  );
  if (isDefault) {
    return [
      {
        variable: 'DATABASE_URL',
        problem: `uses the default credential pair "${user}:****".`,
        remedy: 'Create a dedicated role with a generated password and rotate the URL.',
      },
    ];
  }

  return [];
}

export function checkCors(): GuardFailure[] {
  const origins = config.http.corsOrigins;
  if (origins.length === 0) {
    return [
      {
        variable: 'CORS_ORIGINS',
        problem: 'is empty, so no browser origin is allowed.',
        remedy: 'Set it to the real hostname, e.g. https://printers.kodesportsclub.local',
      },
    ];
  }
  if (origins.includes('*')) {
    return [
      {
        variable: 'CORS_ORIGINS',
        problem: 'contains a wildcard, which is forbidden in production.',
        remedy: 'List each allowed origin explicitly.',
      },
    ];
  }
  const malformed = origins.filter((origin) => !/^https?:\/\/[^/]+$/.test(origin));
  if (malformed.length > 0) {
    return [
      {
        variable: 'CORS_ORIGINS',
        problem: `contains entries that are not scheme+host origins: ${malformed.join(', ')}`,
        remedy: 'Use the form https://host[:port] with no trailing path.',
      },
    ];
  }
  return [];
}

/**
 * §B18.3 — the application does not terminate TLS and MUST NOT be exposed
 * directly.
 *
 * The requirement is one thing; the way it is satisfied is two, and the guard
 * has to check the property rather than assume the means. On a shared host the
 * proxy reaches the app over loopback, so any other binding is reachable
 * without TLS and the address is the whole test. In a container the proxy is a
 * separate service on an internal network: the app *must* bind a routable
 * address to be reachable at all, and the isolation comes from the port never
 * being published. Testing for loopback there would refuse the only correct
 * configuration, which is what the delivered image did.
 *
 * What remains checkable under `container` is that something is declared in
 * front of the app. A container topology with no trusted proxy hop means either
 * nothing is proxying it or the forwarded headers are not being read, and
 * combined with a routable bind that is exactly the exposure this guard exists
 * to catch.
 */
export function checkBinding(): GuardFailure[] {
  if (config.http.topology === 'container') {
    if (config.http.trustProxyHops >= 1) return [];
    return [
      {
        variable: 'TRUST_PROXY_HOPS',
        problem:
          'is 0 while DEPLOYMENT_TOPOLOGY is "container", so nothing is known to sit in ' +
          'front of the app and its bound address is routable.',
        remedy:
          'Set it to the number of proxy hops (1 behind Caddy), or switch to ' +
          'DEPLOYMENT_TOPOLOGY=loopback and bind 127.0.0.1.',
      },
    ];
  }

  const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
  if (loopback.has(config.http.host)) return [];
  return [
    {
      variable: 'BIND_HOST',
      problem: `is "${config.http.host}"; a loopback deployment must bind loopback only.`,
      remedy:
        'Set BIND_HOST=127.0.0.1 and let the reverse proxy terminate TLS. If the proxy is a ' +
        'separate container, set DEPLOYMENT_TOPOLOGY=container and do not publish the port.',
    },
  ];
}

/**
 * GAP-06 — LibreOffice and Ghostscript are OS binaries, not npm packages.
 *
 * The delivered build degrades gracefully when they are absent, which is right
 * at runtime and dangerous at startup: a fresh host without them looks healthy
 * while silently skipping every Office conversion. Graceful degradation is
 * correct mid-flight and wrong at boot.
 */
export async function checkConverters(): Promise<GuardFailure[]> {
  const failures: GuardFailure[] = [];

  const probes: Array<{ variable: string; command: string; args: string[] }> = [
    { variable: 'LIBREOFFICE_PATH', command: config.convert.libreOfficePath, args: ['--version'] },
    { variable: 'GHOSTSCRIPT_PATH', command: config.convert.ghostscriptPath, args: ['--version'] },
  ];

  for (const probe of probes) {
    try {
      await execFileAsync(probe.command, probe.args, { timeout: 20_000 });
    } catch (error) {
      failures.push({
        variable: probe.variable,
        problem: `could not be executed at "${probe.command}" (${describe(error)}).`,
        remedy: 'Install the binary on the host or point the variable at its full path.',
      });
    }
  }

  return failures;
}

/** Resolved converter versions, for the boot log and `/health/ready`. */
export async function converterVersions(): Promise<Record<string, string | null>> {
  const read = async (command: string, args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 20_000 });
      return stdout.trim().split('\n')[0]?.trim() ?? null;
    } catch {
      return null;
    }
  };
  return {
    libreoffice: await read(config.convert.libreOfficePath, ['--version']),
    ghostscript: await read(config.convert.ghostscriptPath, ['--version']),
  };
}

/**
 * The upload directory must be writable and must not resolve inside anything
 * the server serves statically — otherwise an uploaded document becomes a
 * fetchable URL and the permission model is bypassed entirely.
 */
export async function checkStorage(staticRoot: string | null): Promise<GuardFailure[]> {
  const failures: GuardFailure[] = [];

  const directories: Array<[string, string]> = [
    ['UPLOAD_DIR', config.storage.uploadDir],
    ['SCAN_DIR', config.storage.scanDir],
    ['TEMPLATE_DIR', config.storage.templateDir],
    ['TMP_DIR', config.storage.tmpDir],
  ];

  for (const [variable, dir] of directories) {
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, FS.W_OK);
      const info = await stat(dir);
      if (!info.isDirectory()) {
        failures.push({
          variable,
          problem: `resolves to "${dir}", which is not a directory.`,
          remedy: 'Point it at a directory the service account can write to.',
        });
      }
    } catch (error) {
      failures.push({
        variable,
        problem: `is not writable at "${dir}" (${describe(error)}).`,
        remedy: 'Create the directory and grant the service account write access.',
      });
    }
  }

  if (staticRoot) {
    const root = resolve(staticRoot);
    for (const [variable, dir] of directories) {
      if (isInside(root, dir)) {
        failures.push({
          variable,
          problem: `resolves inside the served static root "${root}".`,
          remedy:
            'Move it outside the web root; uploaded documents must never be directly fetchable.',
        });
      }
    }
  }

  return failures;
}

export function checkCollector(): GuardFailure[] {
  if (!config.collector.mode) return [];
  const failures: GuardFailure[] = [];
  if (!config.collector.upstreamUrl) {
    failures.push({
      variable: 'COLLECTOR_UPSTREAM_URL',
      problem: 'is required when COLLECTOR_MODE=true.',
      remedy: 'Set it to the central server URL, e.g. https://printers.kodesportsclub.local',
    });
  }
  if (!config.collector.apiKey) {
    failures.push({
      variable: 'COLLECTOR_API_KEY',
      problem: 'is required when COLLECTOR_MODE=true.',
      remedy: 'Create a collector in the admin UI and copy the key it shows once.',
    });
  }
  return failures;
}

/**
 * Runs every configuration guard and throws one aggregated error listing all
 * failures.
 *
 * Aggregating matters: an operator fixing a fresh deployment should see all six
 * problems at once, not discover them one restart at a time.
 *
 * Nothing here touches the database, and that is deliberate. These run before
 * the migration step, so a deployment with a placeholder secret fails naming
 * the secret rather than failing with a connection error from a database it was
 * never going to reach. The one check that does need the database, GAP-01's
 * seeded password, is not a guard at all: it cannot be fixed without a running
 * server, so it locks the API down instead of refusing to start it. See
 * `services/setupState.ts`.
 *
 * @param staticRoot Directory served statically, or null when the SPA is served
 *   elsewhere. Upload directories must not resolve inside it.
 */
export async function runBootGuards(staticRoot: string | null): Promise<void> {
  if (config.debug) {
    return; // KODE_DEBUG=true — development. Guards are production-only by design.
  }

  const failures: GuardFailure[] = [
    ...checkSecrets(),
    ...checkDatabaseUrl(),
    ...checkCors(),
    ...checkBinding(),
    ...checkCollector(),
    ...(await checkConverters()),
    ...(await checkStorage(staticRoot)),
  ];

  if (failures.length === 0) return;

  const report = failures
    .map((f, index) => `  ${index + 1}. ${f.variable} ${f.problem}\n     → ${f.remedy}`)
    .join('\n');

  throw new Error(
    `Refusing to start: ${failures.length} configuration problem(s) found.\n\n${report}\n\n` +
      'Set KODE_DEBUG=true to bypass these checks in development only.',
  );
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.name;
  return String(error);
}
