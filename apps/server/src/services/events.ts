import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import type { Job, Notification, Printer, Scan, ServerEvent } from '@kode/shared';
import { subsystem } from '../utilities/logger.js';

const log = subsystem('events');

/**
 * Server-sent events — the live-update channel.
 *
 * SSE rather than WebSockets, for three reasons specific to this deployment:
 * it is plain HTTP, so it passes through IIS or Caddy with no upgrade handling;
 * it reconnects automatically in every browser without a client library; and
 * the traffic here is entirely server→client (a job changed status, a printer
 * went offline), so the return channel a WebSocket buys would go unused.
 *
 * ADR-004 makes printing asynchronous — `POST /print-file` returns 202 and the
 * outcome arrives later. Without a live channel the frontend must poll, and the
 * document names that as "a real frontend change and the cost of this
 * decision". This is how that cost is paid without polling.
 */

interface Subscriber {
  userId: number;
  isAdmin: boolean;
  /**
   * The subscriber's permitted printers, resolved once at connect time.
   *
   * Cached rather than queried per event: a busy fleet publishes far more
   * events than it changes grants, and a database round trip per subscriber per
   * event is a poor trade. Staleness is handled by ending the stream when
   * grants change (see `closeForUser`) rather than by expiry, so a revoked
   * grant takes effect within one reconnect instead of within a TTL.
   */
  permittedPrinterIds: ReadonlySet<number>;
  response: Response;
  /** Set by the heartbeat so a dead connection is reaped rather than accumulated. */
  alive: boolean;
}

class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly subscribers = new Set<Subscriber>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor() {
    // Node's default of 10 would warn once the eleventh admin opened a tab.
    this.emitter.setMaxListeners(0);
  }

  subscribe(subscriber: Omit<Subscriber, 'alive'>): () => void {
    const entry: Subscriber = { ...subscriber, alive: true };
    this.subscribers.add(entry);
    this.ensureHeartbeat();

    log.debug({ userId: entry.userId, subscribers: this.subscribers.size }, 'SSE client attached');

    return () => {
      this.subscribers.delete(entry);
      if (this.subscribers.size === 0) this.stopHeartbeat();
    };
  }

  /**
   * Publishes an event to the clients entitled to see it.
   *
   * Visibility is decided here rather than in the client, because "the client
   * filters it out" is not access control. A user must never receive another
   * person's document name over this channel.
   */
  publish(event: ServerEvent, audience: Audience = { kind: 'admins' }): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

    for (const subscriber of this.subscribers) {
      if (!isEntitled(subscriber, audience)) continue;
      try {
        subscriber.response.write(payload);
      } catch (error) {
        log.debug({ err: String(error) }, 'SSE write failed; dropping subscriber');
        this.subscribers.delete(subscriber);
      }
    }
  }

  jobUpdated(job: Job): void {
    // A walk-up job belongs to the system account, and the job list shows it to
    // anyone permitted to use the device. Routing it by owner would deliver it
    // to nobody. It carries no document name, so the printer audience is right.
    if (job.source === 'walkup') {
      this.publish({ type: 'job.updated', job }, { kind: 'printer', printerId: job.printerId });
      return;
    }
    this.publish({ type: 'job.updated', job }, { kind: 'user-and-admins', userId: job.userId });
  }

  printerUpdated(printer: Printer): void {
    this.publish({ type: 'printer.updated', printer }, { kind: 'printer', printerId: printer.id });
  }

  notificationCreated(notification: Notification, userId: number | null): void {
    this.publish(
      { type: 'notification.created', notification },
      userId === null ? { kind: 'admins' } : { kind: 'user-and-admins', userId },
    );
  }

  /**
   * A scan carries `originalFilename`, and at a sports club that is a member's
   * name on a membership form or an ID document. It goes to the people who may
   * use the device it came from, and to nobody else.
   */
  scanCreated(scan: Scan): void {
    this.publish({ type: 'scan.created', scan }, { kind: 'printer', printerId: scan.printerId });
  }

  /**
   * Ends a user's live streams so the next connection resolves fresh grants.
   *
   * Called when printer access changes. The client reconnects after the three
   * seconds the stream advertises, which is a simpler and more certain
   * invalidation than trying to mutate a cached set in place.
   */
  closeForUser(userId: number): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.userId !== userId) continue;
      try {
        subscriber.response.end();
      } catch {
        // Already gone; the delete below is what matters.
      }
      this.subscribers.delete(subscriber);
    }
    if (this.subscribers.size === 0) this.stopHeartbeat();
  }

  queueDepth(depth: number, oldestSeconds: number): void {
    this.publish({ type: 'queue.depth', depth, oldestSeconds }, { kind: 'admins' });
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * A comment line every 25 seconds.
   *
   * Reverse proxies and corporate middleboxes close idle connections at 30 or
   * 60 seconds, and a closed SSE stream reconnects — so without this the client
   * silently reconnects every minute forever. The comment is ignored by the
   * EventSource parser and costs two bytes.
   */
  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const at = new Date().toISOString();
      for (const subscriber of this.subscribers) {
        try {
          subscriber.response.write(`: ping ${at}\n\n`);
        } catch {
          this.subscribers.delete(subscriber);
        }
      }
    }, 25_000);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  closeAll(): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.response.end();
      } catch {
        // Shutting down; a failed close is not actionable.
      }
    }
    this.subscribers.clear();
    this.stopHeartbeat();
  }
}

export type Audience =
  | { kind: 'everyone' }
  | { kind: 'admins' }
  | { kind: 'user-and-admins'; userId: number | null }
  /** Anyone holding a live grant on this printer, plus every administrator. */
  | { kind: 'printer'; printerId: number | null };

function isEntitled(subscriber: Subscriber, audience: Audience): boolean {
  switch (audience.kind) {
    case 'everyone':
      return true;
    case 'admins':
      return subscriber.isAdmin;
    case 'user-and-admins':
      return subscriber.isAdmin || subscriber.userId === audience.userId;
    case 'printer':
      if (subscriber.isAdmin) return true;
      // A record whose printer is gone has no audience left to scope it to.
      if (audience.printerId === null) return false;
      return subscriber.permittedPrinterIds.has(audience.printerId);
  }
}

export const events = new EventBus();
