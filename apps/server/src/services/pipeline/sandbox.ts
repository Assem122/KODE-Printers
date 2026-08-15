import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppError } from '@kode/shared';
import { config } from '../../config/index.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';

const log = subsystem('pipeline:sandbox');

/**
 * Sandboxed execution of the document converters (ADR-010, GAP-17, GAP-20).
 *
 * LibreOffice and Ghostscript are large C++ parsers with long histories of
 * parser vulnerabilities, and they are pointed directly at files uploaded by
 * staff. §B16.1 is clear that antivirus is the weaker control here and process
 * isolation is the real one: a well-formed PDF can carry a payload targeting
 * the parser, and no signature database catches a zero-day.
 *
 * Three protections, all of which the delivered build lacked:
 *
 *   · **Hard timeout** — SIGTERM then SIGKILL. Without it a malformed document
 *     hangs a converter indefinitely, and with no queue that consumed a request
 *     slot forever (GAP-17).
 *   · **Per-invocation temp directory** — deleted in a `finally`, so a crash
 *     cannot carry state into the next job.
 *   · **Optional external sandbox wrapper** — `CONVERT_SANDBOX_CMD` prefixes
 *     the command (`bwrap`, `firejail`, `docker run --rm --network none`). On
 *     the Compose deployment this is set; where the host cannot provide one, a
 *     restricted service account substitutes and the gap is explicit rather
 *     than assumed away.
 */

export interface SandboxResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SandboxOptions {
  command: string;
  args: readonly string[];
  /** Overrides the configured per-stage timeout. */
  timeoutMs?: number;
  cwd?: string;
  /**
   * Extra environment for the child. The parent environment is **not**
   * inherited: it holds DATABASE_URL, JWT_SECRET and every other secret, and a
   * compromised converter that can read `/proc/self/environ` should find
   * nothing worth having.
   */
  env?: Record<string, string>;
}

export async function runSandboxed(options: SandboxOptions): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? config.convert.timeoutMs;
  const wrapper = config.convert.sandboxCommand;

  const [command, ...args] = wrapper
    ? [...wrapper, options.command, ...options.args]
    : [options.command, ...options.args];

  if (command === undefined) throw new Error('sandbox: empty command');

  const startedAt = Date.now();

  return new Promise<SandboxResult>((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: {
        // A minimal, deliberate environment. HOME must exist or LibreOffice
        // writes its profile into an unpredictable location.
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: options.cwd ?? tmpdir(),
        LANG: 'C.UTF-8',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached so the whole process group can be signalled: LibreOffice forks
      // children, and killing only the parent leaves `soffice.bin` running and
      // holding the profile lock that the next job needs.
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const OUTPUT_CAP = 256 * 1024;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8');
    });

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform === 'win32' || child.pid === undefined) child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // Already gone. Nothing to do.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // Grace period, then SIGKILL. A hung parser ignores SIGTERM.
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
    }, timeoutMs);

    const finish = (error: Error | null, code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new AppError('CONVERSION_TIMEOUT', 'The document took too long to convert.', {
            details: { command: options.command, timeoutMs },
            retryable: true,
          }),
        );
        return;
      }

      if (error) {
        reject(
          new AppError('CONVERSION_FAILED', 'The document could not be converted.', {
            details: { command: options.command },
            cause: error,
          }),
        );
        return;
      }

      if (code !== 0) {
        reject(
          new AppError('CONVERSION_FAILED', 'The document could not be converted.', {
            details: { command: options.command, exitCode: code ?? -1 },
            // stderr goes to the log, never to the client. INV-12.
            cause: new Error(stderr.slice(0, 2000) || `exit code ${code}`),
          }),
        );
        return;
      }

      resolve({ stdout, stderr, durationMs: Date.now() - startedAt });
    };

    child.once('error', (error) => finish(error, null));
    child.once('close', (code) => finish(null, code));
  });
}

/**
 * Runs `fn` with a private temporary directory, removed afterwards whatever
 * happens.
 *
 * The removal is in a `finally` and swallows its own errors: failing a
 * successful conversion because cleanup hit a locked file would be absurd, and
 * the leftover directory is picked up by the next boot's sweep.
 */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(config.storage.tmpDir, `${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      log.warn({ dir, ...serialiseError(error) }, 'failed to remove temp directory');
    });
  }
}
