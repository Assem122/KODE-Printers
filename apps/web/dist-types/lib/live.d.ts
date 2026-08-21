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
export declare function useLiveUpdates(enabled: boolean): void;
//# sourceMappingURL=live.d.ts.map