/**
 * Walk-up attribution: the outstanding-impression ledger (ADR-008, §B8.3).
 *
 * This module is deliberately pure — no database, no clock, no I/O. It is the
 * piece of the system the document flags as "most likely to be implemented
 * incorrectly", and its defects corrupt the audit record rather than merely
 * annoying someone, so it is written to be exhaustively unit-testable and is
 * covered by every mandatory scenario in §B17.2.
 *
 * ── Why a ledger rather than a time window ────────────────────────────────
 *
 * The delivered build marked a printer's IP with a timestamp before sending and
 * treated any counter increase within 45 seconds as "this was us". Two failures
 * follow directly from that shape:
 *
 *   1. A large document that takes longer than 45 seconds to convert and
 *      transmit has its counter increase land *outside* the window, and gets
 *      logged as a walk-up job that never happened.
 *   2. Two people printing to one device inside a single poll cycle produce one
 *      combined entry with a summed page count, attributable to neither.
 *
 * Reconciling against *quantity* instead of *elapsed time* fixes the first
 * outright: a slow job is matched whenever its impressions finally appear. The
 * expiry cap exists solely to stop a job whose send silently failed from
 * absorbing a later genuine walk-up — it is not an estimate of print duration.
 *
 * The second is unavoidable at this layer and the document says so: SNMP
 * returns one number, so two simultaneous walk-ups remain one combined entry.
 * That limitation MUST be stated in the report footer rather than left implied.
 */

export interface LedgerEntryView {
  id: number;
  jobId: number;
  outstanding: number;
}

export interface ReconcileResult {
  /** Entries to update or delete, in the order they were consumed. */
  consumed: Array<{ id: number; jobId: number; consumed: number; remaining: number }>;
  /** Impressions no app job accounted for. Zero means nothing to log. */
  walkupImpressions: number;
  /** True when the counter went backwards: re-anchor the baseline, log nothing. */
  isReset: boolean;
}

/**
 * Applies a counter delta against the outstanding ledger, oldest entry first.
 *
 * Oldest-first matters. Entries are consumed in submission order because that
 * is the order the device prints them, so a delta that partially covers two
 * outstanding jobs attributes the right share to each. Consuming newest-first
 * would leave the older job permanently outstanding until it expired, and its
 * impressions would then surface as a phantom walk-up.
 */
export function reconcile(delta: number, entries: readonly LedgerEntryView[]): ReconcileResult {
  if (delta < 0) {
    return { consumed: [], walkupImpressions: 0, isReset: true };
  }

  const consumed: ReconcileResult['consumed'] = [];
  let remainingDelta = delta;

  for (const entry of entries) {
    if (remainingDelta <= 0) break;
    if (entry.outstanding <= 0) continue;

    const take = Math.min(remainingDelta, entry.outstanding);
    remainingDelta -= take;
    consumed.push({
      id: entry.id,
      jobId: entry.jobId,
      consumed: take,
      remaining: entry.outstanding - take,
    });
  }

  return {
    consumed,
    // Only the excess is a walk-up. A genuine walk-up that happens *during* a
    // long app job is still caught, because only that job's own impression
    // count is absorbed — which is the property a time window cannot provide.
    walkupImpressions: remainingDelta,
    isReset: false,
  };
}

/**
 * Whether an observed delta is plausible enough to record.
 *
 * A single poll interval cannot legitimately produce tens of thousands of
 * impressions; a jump that large is a counter rollover, a firmware quirk, or a
 * device that reports a different unit after a reset. Recording it would put a
 * fabricated spike into a report that leadership reads.
 *
 * The threshold is generous — an A3 device running a tournament draw at full
 * speed manages perhaps 60 impressions per minute — so a real busy period never
 * trips it.
 */
export const IMPLAUSIBLE_DELTA_THRESHOLD = 5000;

export function isPlausibleDelta(delta: number, secondsSinceLastPoll: number): boolean {
  if (delta <= 0) return true;
  if (delta > IMPLAUSIBLE_DELTA_THRESHOLD) return false;
  // 120 impressions per second is roughly double the fastest production device;
  // anything above it is a counter artefact, not printing.
  const ceiling = Math.max(200, secondsSinceLastPoll * 120);
  return delta <= ceiling;
}

/**
 * Splits an unattributed delta into the job types the vendor counters support.
 *
 * Where no vendor counter answered, the whole delta is `unknown` — never
 * `print`. §B8.4 and DEC-06 both require this, and it is the difference between
 * a defensible report and one that counts every photocopy as printing.
 */
export interface WalkupClassification {
  jobType: 'print' | 'copy' | 'unknown';
  impressions: number;
}

export function classifyWalkup(
  totalDelta: number,
  vendor: { print: number | null; copy: number | null },
): WalkupClassification[] {
  if (vendor.print === null && vendor.copy === null) {
    return totalDelta > 0 ? [{ jobType: 'unknown', impressions: totalDelta }] : [];
  }

  const out: WalkupClassification[] = [];
  const printed = vendor.print ?? 0;
  const copied = vendor.copy ?? 0;

  if (printed > 0) out.push({ jobType: 'print', impressions: printed });
  if (copied > 0) out.push({ jobType: 'copy', impressions: copied });

  // Faxes and internally generated report pages move the life counter without
  // moving either vendor counter. They are real device activity and are logged
  // as such rather than silently dropped — a gap in the total is exactly the
  // kind of quiet inconsistency that makes an auditor distrust the whole set.
  const residual = totalDelta - printed - copied;
  if (residual > 0) out.push({ jobType: 'unknown', impressions: residual });

  return out;
}
