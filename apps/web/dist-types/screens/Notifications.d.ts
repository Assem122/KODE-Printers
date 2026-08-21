import type { ReactElement } from 'react';
/**
 * The notification centre (ADR-011).
 *
 * Persisted, with per-user read state — the delivered build kept these in an
 * in-memory FIFO, so a restart lost them and one admin marking an alert read
 * hid it from every other admin.
 *
 * Repeats collapse. A printer polled every fifteen seconds while offline would
 * otherwise produce 240 rows an hour and make this screen useless at exactly
 * the moment it matters most.
 */
export declare function Notifications(): ReactElement;
//# sourceMappingURL=Notifications.d.ts.map