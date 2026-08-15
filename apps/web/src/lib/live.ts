import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '@kode/shared';
import { getAccessToken } from './api.js';

/**
 * The live-update subscription.
 *
 * ADR-004 made printing asynchronous — the submit call returns 202 and the
 * outcome arrives later. The document names the frontend consequence honestly:
 * "That is a real frontend change and it is the cost of this decision." This is
 * where that cost is paid, and paying it with a stream rather than a polling
 * loop is what keeps a phone's radio asleep between events.
 *
 * Events invalidate React Query caches rather than writing into them directly.
 * Writing directly would be faster by one round trip and would also mean two
 * sources of truth for the same row, which is how a job shows "queued" in one
 * panel and "sent" in another.
 */

export function useLiveUpdates(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    let source: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let attempts = 0;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      const token = getAccessToken();
      if (!token) {
        // No session yet. Try again shortly rather than failing permanently —
        // this fires during the silent-restore window on a cold load.
        reconnectTimer = window.setTimeout(connect, 1000);
        return;
      }

      // EventSource cannot set headers, so the access token travels in the
      // query string. It is the 15-minute token, never the refresh token, and
      // the server strips query strings from its logs.
      source = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);

      source.onopen = () => {
        attempts = 0;
      };

      source.onmessage = (event) => handle(event.data as string);

      for (const type of [
        'job.updated',
        'printer.updated',
        'notification.created',
        'scan.created',
        'queue.depth',
      ]) {
        source.addEventListener(type, (event) => handle((event as MessageEvent<string>).data));
      }

      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;

        // Backoff with a ceiling. A server restart should not produce a
        // reconnect storm from every open tab in the club.
        attempts += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    const handle = (raw: string): void => {
      let event: ServerEvent;
      try {
        event = JSON.parse(raw) as ServerEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case 'job.updated':
          void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          void queryClient.invalidateQueries({ queryKey: ['stats'] });
          break;
        case 'printer.updated':
          void queryClient.invalidateQueries({ queryKey: ['printers'] });
          break;
        case 'notification.created':
          void queryClient.invalidateQueries({ queryKey: ['notifications'] });
          break;
        case 'scan.created':
          void queryClient.invalidateQueries({ queryKey: ['scans'] });
          break;
        case 'queue.depth':
          queryClient.setQueryData(['queue-depth'], {
            depth: event.depth,
            oldestSeconds: event.oldestSeconds,
          });
          break;
        case 'heartbeat':
          break;
      }
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [enabled, queryClient]);
}
