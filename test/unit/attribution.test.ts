import { describe, expect, it } from 'vitest';
import {
  classifyWalkup,
  IMPLAUSIBLE_DELTA_THRESHOLD,
  isPlausibleDelta,
  reconcile,
} from '../../apps/server/src/services/watchers/attribution.js';

/**
 * The mandatory scenarios from §B17.2.
 *
 * "These are the cases where a defect corrupts the record rather than annoying
 * a user. Each MUST have a named test." Scenarios 1–6 concern attribution and
 * live here; the test names quote the document so the mapping is unambiguous.
 */

const entry = (id: number, jobId: number, outstanding: number) => ({ id, jobId, outstanding });

describe('impression ledger — §B17.2 mandatory scenarios', () => {
  it('1. counter increases by exactly the app job’s impressions: no walk-up logged', () => {
    const result = reconcile(10, [entry(1, 100, 10)]);

    expect(result.walkupImpressions).toBe(0);
    expect(result.consumed).toEqual([{ id: 1, jobId: 100, consumed: 10, remaining: 0 }]);
    expect(result.isReset).toBe(false);
  });

  it('2. counter increases by more than the app job’s impressions: only the excess is logged', () => {
    // 10 impressions were ours; someone photocopied 4 pages at the same device.
    const result = reconcile(14, [entry(1, 100, 10)]);

    expect(result.consumed).toEqual([{ id: 1, jobId: 100, consumed: 10, remaining: 0 }]);
    expect(result.walkupImpressions).toBe(4);
  });

  it('3. counter increases with no app job outstanding: full delta logged as walk-up', () => {
    const result = reconcile(7, []);

    expect(result.consumed).toHaveLength(0);
    expect(result.walkupImpressions).toBe(7);
  });

  it('4. counter decreases: baseline reset, no job logged', () => {
    const result = reconcile(-250, [entry(1, 100, 10)]);

    expect(result.isReset).toBe(true);
    expect(result.walkupImpressions).toBe(0);
    // Critically, the outstanding entry is left alone. A firmware reset is not
    // evidence that our job printed.
    expect(result.consumed).toHaveLength(0);
  });

  it('5. an app job slower than the legacy 45-second window is still attributed', () => {
    // The point of the ledger: attribution reconciles against *quantity*, not
    // elapsed time, so a job whose impressions arrive minutes later still
    // matches instead of being logged as a walk-up that never happened.
    const result = reconcile(120, [entry(1, 100, 120)]);

    expect(result.walkupImpressions).toBe(0);
    expect(result.consumed[0]?.remaining).toBe(0);
  });

  it('6. two app jobs outstanding on one printer, deltas arriving out of order', () => {
    const ledger = [entry(1, 100, 10), entry(2, 101, 5)];

    // First poll sees 12 impressions: all of job 100, and 2 of job 101.
    const first = reconcile(12, ledger);
    expect(first.consumed).toEqual([
      { id: 1, jobId: 100, consumed: 10, remaining: 0 },
      { id: 2, jobId: 101, consumed: 2, remaining: 3 },
    ]);
    expect(first.walkupImpressions).toBe(0);

    // Second poll sees the remaining 3 of job 101 plus 6 nobody claimed.
    const second = reconcile(9, [entry(2, 101, 3)]);
    expect(second.consumed).toEqual([{ id: 2, jobId: 101, consumed: 3, remaining: 3 - 3 }]);
    expect(second.walkupImpressions).toBe(6);
  });
});

describe('impression ledger — ordering and edge cases', () => {
  it('consumes oldest first, so partial coverage attributes to the right job', () => {
    const result = reconcile(4, [entry(1, 100, 3), entry(2, 101, 3)]);

    // Newest-first would leave job 100 outstanding until it expired, and its
    // impressions would then surface as a phantom walk-up.
    expect(result.consumed[0]?.jobId).toBe(100);
    expect(result.consumed[0]?.remaining).toBe(0);
    expect(result.consumed[1]?.jobId).toBe(101);
    expect(result.consumed[1]?.remaining).toBe(2);
  });

  it('a zero delta consumes nothing and logs nothing', () => {
    const result = reconcile(0, [entry(1, 100, 10)]);

    expect(result.consumed).toHaveLength(0);
    expect(result.walkupImpressions).toBe(0);
  });

  it('skips entries already fully consumed', () => {
    const result = reconcile(5, [entry(1, 100, 0), entry(2, 101, 5)]);

    expect(result.consumed).toEqual([{ id: 2, jobId: 101, consumed: 5, remaining: 0 }]);
  });

  it('stops as soon as the delta is exhausted', () => {
    const result = reconcile(2, [entry(1, 100, 10), entry(2, 101, 10)]);

    expect(result.consumed).toHaveLength(1);
    expect(result.consumed[0]?.remaining).toBe(8);
  });
});

describe('plausibility gate', () => {
  it('rejects a jump no print engine could produce', () => {
    expect(isPlausibleDelta(IMPLAUSIBLE_DELTA_THRESHOLD + 1, 4)).toBe(false);
  });

  it('accepts a busy but realistic burst', () => {
    // 60 impressions in a four-second poll window is a device running flat out.
    expect(isPlausibleDelta(60, 4)).toBe(true);
  });

  it('scales its ceiling with the time since the last poll', () => {
    // After a five-minute backoff, a larger accumulated delta is expected.
    expect(isPlausibleDelta(3000, 300)).toBe(true);
    expect(isPlausibleDelta(3000, 1)).toBe(false);
  });

  it('never rejects a zero or negative delta', () => {
    expect(isPlausibleDelta(0, 4)).toBe(true);
    expect(isPlausibleDelta(-5, 4)).toBe(true);
  });
});

describe('walk-up classification — §B8.4 and DEC-06', () => {
  it('records unknown, never print, when no vendor counter answered', () => {
    const result = classifyWalkup(12, { print: null, copy: null });

    // This is the measurement flaw in §A7.1. Labelling this "print" would count
    // every photocopy of a membership form as printing.
    expect(result).toEqual([{ jobType: 'unknown', impressions: 12 }]);
  });

  it('separates prints from copies where vendor counters exist', () => {
    const result = classifyWalkup(10, { print: 6, copy: 4 });

    expect(result).toEqual([
      { jobType: 'print', impressions: 6 },
      { jobType: 'copy', impressions: 4 },
    ]);
  });

  it('records the residual as unknown rather than dropping it', () => {
    // A received fax moves the life counter without moving either vendor
    // counter. Dropping the difference would leave the totals quietly
    // inconsistent, which is worse than an honest "unknown" row.
    const result = classifyWalkup(10, { print: 6, copy: 2 });

    expect(result).toEqual([
      { jobType: 'print', impressions: 6 },
      { jobType: 'copy', impressions: 2 },
      { jobType: 'unknown', impressions: 2 },
    ]);
  });

  it('returns nothing for a zero delta', () => {
    expect(classifyWalkup(0, { print: null, copy: null })).toEqual([]);
  });
});
