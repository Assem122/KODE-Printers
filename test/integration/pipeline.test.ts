import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withTransaction } from '../../apps/server/src/db/pool.js';
import { jobsModel } from '../../apps/server/src/models/jobs.js';
import { ledgerModel } from '../../apps/server/src/models/ledger.js';
import { reconcile } from '../../apps/server/src/services/watchers/attribution.js';
import { runSandboxed } from '../../apps/server/src/services/pipeline/sandbox.js';
import {
  closeDatabase,
  hasDatabase,
  insertTestJob,
  resetDatabase,
  type TestContext,
} from './helpers.js';

afterAll(async () => {
  // The pool is shared by every describe in this file, so it is closed once
  // here rather than by whichever block happens to finish first.
  await closeDatabase();
});

/**
 * §B17.2 scenarios 11 and 13, plus the queue behaviour they depend on.
 *
 * These are the cases where the *system* has to recover, rather than a pure
 * function having to be correct. Scenario 11 in particular — "server killed
 * mid-job: job returns to queued and completes on restart" — is the whole
 * justification for ADR-004's durable queue, and it cannot be verified without
 * a real database.
 */

const available = await hasDatabase();
const suite = available ? describe : describe.skip;

let context: TestContext;

suite('queue recovery', () => {
  beforeEach(async () => {
    context = await resetDatabase();
  });

  it('11. a job abandoned by a killed worker returns to queued', async () => {
    // What a `kill -9` mid-send leaves behind: status `processing`, a lock held
    // by a worker that no longer exists.
    const jobId = await insertTestJob(context, {
      status: 'processing',
      lockedBy: 'dead-worker#0',
      lockedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    const reclaimed = await jobsModel.reclaimStuck(pool, 15 * 60_000);
    expect(reclaimed).toBe(1);

    const job = await jobsModel.find(pool, jobId);
    expect(job?.status).toBe('queued');
    expect(job?.notes).toContain('Requeued after worker restart');
  });

  it('11b. a job still inside the lock window is left alone', async () => {
    // A live worker one minute into a slow Office conversion must not have its
    // job stolen out from under it.
    const jobId = await insertTestJob(context, {
      status: 'processing',
      lockedBy: 'live-worker#0',
      lockedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(await jobsModel.reclaimStuck(pool, 15 * 60_000)).toBe(0);
    expect((await jobsModel.find(pool, jobId))?.status).toBe('processing');
  });

  it('dequeues one job at a time under SKIP LOCKED, never the same one twice', async () => {
    await insertTestJob(context);
    await insertTestJob(context);

    // Concurrency 5 so the printer limit is not what serialises this — the
    // point is that two workers get two different rows.
    const first = await jobsModel.dequeue(pool, 'worker-a', 5, 0);
    const second = await jobsModel.dequeue(pool, 'worker-b', 5, 0);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
  });

  it('respects the per-printer concurrency limit', async () => {
    await insertTestJob(context);
    await insertTestJob(context);

    const first = await jobsModel.dequeue(pool, 'worker-a', 1, 0);
    expect(first).not.toBeNull();

    // One job already `processing` on this printer and a limit of one, so the
    // second must wait rather than interleaving into a half-document.
    expect(await jobsModel.dequeue(pool, 'worker-b', 1, 0)).toBeNull();
  });

  it('skips a draining printer without failing its queued jobs', async () => {
    await insertTestJob(context);
    await pool.query('UPDATE printers SET is_draining = TRUE WHERE id = $1', [context.printerId]);

    expect(await jobsModel.dequeue(pool, 'worker-a', 5, 0)).toBeNull();

    // The job keeps its place. Maintenance mode delays work; it does not
    // destroy it.
    await pool.query('UPDATE printers SET is_draining = FALSE WHERE id = $1', [context.printerId]);
    expect(await jobsModel.dequeue(pool, 'worker-a', 5, 0)).not.toBeNull();
  });

  it('skips a printer whose circuit is open', async () => {
    await insertTestJob(context);
    await pool.query(
      `UPDATE printers SET circuit_open_until = now() + interval '5 minutes' WHERE id = $1`,
      [context.printerId],
    );

    expect(await jobsModel.dequeue(pool, 'worker-a', 5, 0)).toBeNull();
  });

  it('holds a held job out of the queue until it is released', async () => {
    const jobId = await insertTestJob(context, { status: 'held' });

    expect(await jobsModel.dequeue(pool, 'worker-a', 5, 0)).toBeNull();

    const released = await jobsModel.release(pool, jobId);
    expect(released?.status).toBe('queued');
    expect((await jobsModel.dequeue(pool, 'worker-a', 5, 0))?.id).toBe(jobId);
  });
});

suite('the impression ledger, end to end', () => {
  beforeEach(async () => {
    context = await resetDatabase();
  });

  it('survives a process restart, because it is a table rather than a Map', async () => {
    const jobId = await insertTestJob(context, { status: 'sent', impressions: 10 });
    await ledgerModel.add(pool, context.printerId, jobId, 10);

    // An in-memory ledger loses this, and every in-flight job reappears as a
    // fabricated walk-up the moment its impressions reach the counter.
    const entries = await withTransaction((tx) => ledgerModel.lockLive(tx, context.printerId));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.outstanding).toBe(10);
    expect(entries[0]?.jobId).toBe(jobId);
  });

  it('absorbs exactly the app job and logs only the excess', async () => {
    const jobId = await insertTestJob(context, { status: 'sent', impressions: 10 });
    await ledgerModel.add(pool, context.printerId, jobId, 10);

    const result = await withTransaction(async (tx) => {
      const entries = await ledgerModel.lockLive(tx, context.printerId);
      const outcome = reconcile(14, entries);
      for (const consumed of outcome.consumed) {
        await ledgerModel.consume(tx, consumed.id, consumed.remaining);
      }
      return outcome;
    });

    expect(result.walkupImpressions).toBe(4);

    const remaining = await withTransaction((tx) => ledgerModel.lockLive(tx, context.printerId));
    expect(remaining).toHaveLength(0);
  });

  it('drops a failed job’s entry so it cannot absorb a later genuine walk-up', async () => {
    const jobId = await insertTestJob(context, { status: 'failed', impressions: 10 });
    await ledgerModel.add(pool, context.printerId, jobId, 10);

    await ledgerModel.dropForJob(pool, jobId);

    const entries = await withTransaction((tx) => ledgerModel.lockLive(tx, context.printerId));
    expect(entries).toHaveLength(0);
  });

  it('expires entries past their cap', async () => {
    const jobId = await insertTestJob(context, { status: 'sent', impressions: 5 });
    await ledgerModel.add(pool, context.printerId, jobId, 5);

    await pool.query(
      `UPDATE impression_ledger SET expires_at = now() - interval '1 minute' WHERE job_id = $1`,
      [jobId],
    );

    expect(await ledgerModel.expire(pool, context.printerId)).toBe(1);
  });

  it('the expiry window scales with the job size but is capped', () => {
    const small = ledgerModel.expiryFor(1, new Date(0)).getTime();
    const large = ledgerModel.expiryFor(500, new Date(0)).getTime();
    const huge = ledgerModel.expiryFor(100_000, new Date(0)).getTime();

    expect(small).toBe(62_000); // 60s + 1×2s
    expect(large).toBeGreaterThan(small);
    // The cap exists solely to stop a failed job absorbing a later real one —
    // it is not an estimate of how long printing takes.
    expect(huge).toBe(15 * 60 * 1000);
  });
});

suite('duplicate submission guard (§B10.5)', () => {
  beforeEach(async () => {
    context = await resetDatabase();
  });

  it('catches the same file to the same printer inside the window', async () => {
    await pool.query(
      `INSERT INTO jobs (printer_id, zone_id, user_id, username_snapshot, printer_name_snapshot,
                         source, job_type, status, pages, copies, file_hash)
       VALUES ($1, $2, $3, 'testuser', 'Reception MFP', 'app', 'print', 'queued', 3, 1, 'abc123')`,
      [context.printerId, context.zoneId, context.userId],
    );

    const duplicate = await jobsModel.findRecentDuplicate(pool, {
      userId: context.userId,
      printerId: context.printerId,
      fileHash: 'abc123',
      withinSeconds: 60,
    });

    expect(duplicate).not.toBeNull();
  });

  it('does not catch the same file sent deliberately later', async () => {
    await pool.query(
      `INSERT INTO jobs (printer_id, zone_id, user_id, username_snapshot, printer_name_snapshot,
                         source, job_type, status, pages, copies, file_hash, created_at)
       VALUES ($1, $2, $3, 'testuser', 'Reception MFP', 'app', 'print', 'completed', 3, 1, 'abc123',
               now() - interval '10 minutes')`,
      [context.printerId, context.zoneId, context.userId],
    );

    // Printing the same form twice in a morning is normal. The guard is for
    // double-clicks, not for a policy against repetition.
    const duplicate = await jobsModel.findRecentDuplicate(pool, {
      userId: context.userId,
      printerId: context.printerId,
      fileHash: 'abc123',
      withinSeconds: 60,
    });

    expect(duplicate).toBeNull();
  });
});

describe('converter sandbox', () => {
  it('13. a conversion exceeding its timeout is killed and surfaces CONVERSION_TIMEOUT', async () => {
    // A malformed document that hangs a parser. Without the timeout this
    // consumes a worker slot forever (GAP-17).
    const command = process.platform === 'win32' ? 'ping' : 'sleep';
    const args = process.platform === 'win32' ? ['-n', '30', '127.0.0.1'] : ['30'];

    await expect(runSandboxed({ command, args, timeoutMs: 600 })).rejects.toMatchObject({
      code: 'CONVERSION_TIMEOUT',
      // Retryable: a converter that ran out of time might succeed on a quieter
      // host, unlike a file that is simply the wrong type.
      retryable: true,
    });
  });

  it('13b. the worker survives a killed conversion', async () => {
    const command = process.platform === 'win32' ? 'ping' : 'sleep';
    const args = process.platform === 'win32' ? ['-n', '30', '127.0.0.1'] : ['30'];

    await expect(runSandboxed({ command, args, timeoutMs: 400 })).rejects.toThrow();

    // The process that timed out must not have taken this one with it.
    const echo = process.platform === 'win32' ? 'cmd' : 'echo';
    const echoArgs = process.platform === 'win32' ? ['/c', 'echo alive'] : ['alive'];
    const result = await runSandboxed({ command: echo, args: echoArgs, timeoutMs: 5000 });
    expect(result.stdout).toContain('alive');
  });

  it('a non-zero exit becomes CONVERSION_FAILED, not a timeout', async () => {
    const command = process.platform === 'win32' ? 'cmd' : 'sh';
    const args = process.platform === 'win32' ? ['/c', 'exit 3'] : ['-c', 'exit 3'];

    await expect(runSandboxed({ command, args, timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'CONVERSION_FAILED',
      // A converter that rejected the file will reject it again. Retrying
      // burns three attempts and changes nothing.
      retryable: false,
    });
  });

  it('does not pass the parent environment to a converter', async () => {
    // A compromised parser reading /proc/self/environ should find nothing
    // worth having — no DATABASE_URL, no JWT_SECRET.
    if (process.platform === 'win32') return;

    const result = await runSandboxed({
      command: 'sh',
      args: ['-c', 'echo "${JWT_SECRET:-absent}"'],
      timeoutMs: 5000,
    });
    expect(result.stdout.trim()).toBe('absent');
  });
});
