import { randomUUID } from 'node:crypto';
import type { CollectorEventsInput, PrinterStatus } from '@kode/shared';
import { config } from '../../config/index.js';
import type { PrinterWithSecrets } from '../../models/printers.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';
import { remoteRoster, targets, useRemoteRoster } from './registry.js';
import { spool } from './spool.js';

const log = subsystem('collector:agent');

/**
 * The collector's outbound client (§B11, ADR-007).
 *
 * A collector is this same application started with `COLLECTOR_MODE=true`. It
 * runs no database, no user interface and no authentication surface of its own.
 * It polls SNMP and watches the scan folder for printers in its own segment,
 * and reports to the central server over **one outbound HTTPS connection**.
 *
 * That direction is the entire point. On a segmented network, running the
 * central server against a building directly needs three inbound rules per site
 * — TCP 631, TCP 9100, UDP 161 — plus inbound SMB for scan-to-folder. §A6.2
 * observes that this is "a request most security policies will refuse, and
 * rightly so". One outbound connection replaces all four.
 *
 * **No inbound connection to a collector is ever required.** Nothing in this
 * file listens.
 */

type CollectorEvent = CollectorEventsInput['events'][number];

interface AgentState {
  heartbeatTimer: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  stopping: boolean;
  /** Consecutive failed uplink attempts, for backoff. */
  failures: number;
  connected: boolean;
}

const state: AgentState = {
  heartbeatTimer: null,
  flushTimer: null,
  stopping: false,
  failures: 0,
  connected: false,
};

const MAX_EVENTS_PER_BATCH = 200;
const FLUSH_INTERVAL_MS = 10_000;

export function startCollectorAgent(): void {
  if (!config.collector.mode) return;

  const upstream = config.collector.upstreamUrl;
  const apiKey = config.collector.apiKey;
  if (!upstream || !apiKey) {
    // The boot guards already refuse to start without these; this is the
    // belt-and-braces check for a development run with KODE_DEBUG=true.
    log.error('COLLECTOR_MODE is set but the upstream URL or API key is missing');
    return;
  }

  state.stopping = false;
  log.info({ upstream, name: config.collector.name }, 'collector agent starting');

  void spool.ensureSpoolDir();

  // The roster has to arrive before the watchers have anything to poll, so
  // this runs first and then on its own timer.
  useRemoteRoster();
  void syncRoster();

  scheduleHeartbeat(1_000);
  scheduleFlush(FLUSH_INTERVAL_MS);
}

/**
 * Fetches the printers assigned to this collector.
 *
 * A failure is survivable: the previous roster stays in memory and polling
 * continues. A collector that stopped watching its own segment every time the
 * uplink hiccuped would defeat the purpose of spooling at all.
 */
async function syncRoster(): Promise<void> {
  if (state.stopping) return;

  try {
    const response = await get<{ printers: PrinterWithSecrets[] }>(
      '/api/collectors/agent/printers',
    );
    remoteRoster.replace(response.printers);
    onUplinkSuccess();
  } catch (error) {
    onUplinkFailure(error, 'roster sync');
    if (remoteRoster.isStale) {
      log.warn(
        { count: remoteRoster.size },
        'printer roster has not synced for five minutes; still polling the last known list',
      );
    }
  }

  const next = setTimeout(() => void syncRoster(), state.connected ? 60_000 : backoffMs());
  next.unref();
}

export function stopCollectorAgent(): void {
  state.stopping = true;
  if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer);
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.heartbeatTimer = null;
  state.flushTimer = null;
}

/* ─────────────────────────────────────────────────────────────── heartbeat ── */

function scheduleHeartbeat(delayMs: number): void {
  if (state.stopping) return;
  state.heartbeatTimer = setTimeout(() => void sendHeartbeat(), delayMs);
  state.heartbeatTimer.unref();
}

/**
 * Every 30 seconds: version, uptime, and a reachability summary for the
 * printers in this segment.
 *
 * The reachability summary is load-bearing rather than informational. The
 * central server *cannot* reach these devices — that is why a collector exists
 * — so the collector's report is the only source of truth for their status, and
 * §B13.4 alerts on three missed heartbeats.
 */
async function sendHeartbeat(): Promise<void> {
  try {
    const printers = await targets()
      .pollTargets()
      .catch(() => []);

    const payload = {
      version: config.version,
      uptimeSeconds: Math.floor(process.uptime()),
      printers: printers.map((printer) => ({
        printerId: printer.id,
        reachable: printer.status === 'online' || printer.status === 'degraded',
        status: printer.status satisfies PrinterStatus,
        stateReasons: printer.stateReasons.slice(0, 30),
      })),
    };

    await post('/api/collectors/agent/heartbeat', payload);
    onUplinkSuccess();
    scheduleHeartbeat(config.collector.heartbeatMs);
  } catch (error) {
    onUplinkFailure(error, 'heartbeat');
    // Backoff, capped at five minutes. A collector whose uplink is down keeps
    // collecting; it just stops shouting about it.
    scheduleHeartbeat(backoffMs());
  }
}

/* ────────────────────────────────────────────────────────────────── events ── */

/**
 * Queues an event for the next flush.
 *
 * The idempotency key is generated here, at the point the observation is made,
 * and never regenerated. That is what makes a replay after a dropped uplink
 * safe: the server's `collector_event_keys` table rejects the duplicate rather
 * than logging the same counter delta twice, which would turn a ten-minute
 * network blip into a fabricated spike in the audit record.
 */
export async function recordCounterEvent(input: {
  printerId: number;
  lifeCount: number;
  printCount?: number | null;
  copyCount?: number | null;
}): Promise<void> {
  if (!config.collector.mode) return;

  await spool
    .append({
      kind: 'counter',
      idempotencyKey: `${config.collector.name}:counter:${input.printerId}:${randomUUID()}`,
      printerId: input.printerId,
      observedAt: new Date().toISOString(),
      lifeCount: input.lifeCount,
      printCount: input.printCount ?? null,
      copyCount: input.copyCount ?? null,
    })
    .catch((error: unknown) => log.error({ ...serialiseError(error) }, 'could not spool counter'));
}

export async function recordScanEvent(input: {
  printerId: number;
  filename: string;
  sizeBytes: number;
  contentType: string;
}): Promise<void> {
  if (!config.collector.mode) return;

  await spool
    .append({
      kind: 'scan',
      idempotencyKey: `${config.collector.name}:scan:${input.printerId}:${randomUUID()}`,
      printerId: input.printerId,
      observedAt: new Date().toISOString(),
      filename: input.filename.slice(0, 400),
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
    })
    .catch((error: unknown) => log.error({ ...serialiseError(error) }, 'could not spool scan'));
}

function scheduleFlush(delayMs: number): void {
  if (state.stopping) return;
  state.flushTimer = setTimeout(() => void flush(), delayMs);
  state.flushTimer.unref();
}

async function flush(): Promise<void> {
  try {
    await spool.enforceCap();

    const events: CollectorEvent[] = await spool.claimBatch(MAX_EVENTS_PER_BATCH);
    if (events.length === 0) {
      scheduleFlush(FLUSH_INTERVAL_MS);
      return;
    }

    const response = await post<{ accepted: number; duplicates: number }>(
      '/api/collectors/agent/events',
      { events },
    );

    // Only released once the server has confirmed. A crash between the POST and
    // this line re-sends the batch on restart, and the idempotency keys absorb
    // it — which is the correct trade: a duplicate that is rejected costs
    // nothing, a lost batch is a hole in the audit trail.
    await spool.releaseBatch();

    log.info(
      { sent: events.length, accepted: response.accepted, duplicates: response.duplicates },
      'event batch delivered',
    );

    onUplinkSuccess();

    // More waiting? Flush again immediately rather than idling for ten seconds
    // while a backlog drains.
    const remaining = await spool.pendingCount();
    scheduleFlush(remaining > 0 ? 250 : FLUSH_INTERVAL_MS);
  } catch (error) {
    onUplinkFailure(error, 'event flush');
    scheduleFlush(backoffMs());
  }
}

/* ──────────────────────────────────────────────────────────────── transport ── */

const post = <T = unknown>(path: string, body: unknown): Promise<T> =>
  request<T>('POST', path, body);

const get = <T = unknown>(path: string): Promise<T> => request<T>('GET', path);

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const upstream = config.collector.upstreamUrl;
  const apiKey = config.collector.apiKey;
  if (!upstream || !apiKey) throw new Error('collector uplink is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(`${upstream.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        // INV-08 — the key is never logged, and it is the only credential the
        // collector holds. Revoking it in the admin UI cuts this agent off
        // without touching the collector host.
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': `kode-printer-collector/${config.version}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      // A revoked key. Retrying forever would fill the upstream's rate limiter
      // with requests that can never succeed, so this is stated plainly and the
      // backoff takes over.
      throw new Error(`collector key rejected (${response.status}) — has it been revoked?`);
    }

    if (!response.ok) {
      throw new Error(`upstream returned ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function onUplinkSuccess(): void {
  if (!state.connected) {
    const overflow = spool.takeOverflowReport();
    if (overflow.overflowed) {
      // §B11.4 — the warning is raised on reconnection, because until the link
      // came back there was nobody to tell.
      log.error(
        { droppedCount: overflow.droppedCount },
        'uplink restored, but the spool had overflowed — ' +
          `${overflow.droppedCount} event(s) were discarded and that period is under-reported`,
      );
    } else if (state.failures > 0) {
      log.info({ afterFailures: state.failures }, 'uplink restored, spooled events replayed');
    }
  }

  state.connected = true;
  state.failures = 0;
}

function onUplinkFailure(error: unknown, what: string): void {
  state.failures += 1;
  state.connected = false;

  // Noisy at first, then quiet. An outage should be obvious in the log without
  // burying every other line for the next six hours.
  const level = state.failures <= 3 || state.failures % 20 === 0 ? 'error' : 'debug';
  log[level](
    { failures: state.failures, ...serialiseError(error) },
    `${what} failed; events continue to spool locally`,
  );
}

function backoffMs(): number {
  const base = Math.min(300_000, 5_000 * 2 ** Math.min(state.failures, 6));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

export function collectorStatus(): { connected: boolean; failures: number } {
  return { connected: state.connected, failures: state.failures };
}
