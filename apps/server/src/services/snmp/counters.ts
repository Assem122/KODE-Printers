import type { PrinterStatus } from '@kode/shared';
import type { PrinterWithSecrets } from '../../models/printers.js';
import { asInteger, asString, snmpGet, snmpWalk } from './client.js';
import { decodeErrorState, HOST_RESOURCES, PRINTER_MIB } from './oids.js';

/**
 * Counter, supply and state reads over SNMP.
 *
 * The page counter is the mechanism behind walk-up detection (§B8.1): an
 * increase this system did not cause is a walk-up event. Everything downstream
 * of that — the ledger, the reports, the "device activity" label — depends on
 * this read being both accurate and honest about what it cannot distinguish.
 */

export interface CounterReading {
  /** prtMarkerLifeCount. Includes photocopies and faxes. */
  life: number | null;
  /** Vendor print-only counter, where the device exposes one. */
  print: number | null;
  /** Vendor copy-only counter, where the device exposes one. */
  copy: number | null;
}

export async function readCounters(printer: PrinterWithSecrets): Promise<CounterReading> {
  const oids = [printer.snmpPageOid];
  if (printer.snmpPrintOid) oids.push(printer.snmpPrintOid);
  if (printer.snmpCopyOid) oids.push(printer.snmpCopyOid);

  const values = await snmpGet(printer, oids);

  return {
    life: asInteger(values.get(printer.snmpPageOid) ?? null),
    print: printer.snmpPrintOid ? asInteger(values.get(printer.snmpPrintOid) ?? null) : null,
    copy: printer.snmpCopyOid ? asInteger(values.get(printer.snmpCopyOid) ?? null) : null,
  };
}

export interface CounterDelta {
  life: number;
  print: number | null;
  copy: number | null;
  /** True when the counter went backwards — a reboot, reset or rollover. */
  isReset: boolean;
}

/**
 * Computes the change since the previous poll.
 *
 * A negative delta is a reset, not activity. §B8.3 and §B14 both require the
 * baseline to be re-anchored and *no job logged* — logging a negative or
 * absolute value here would invent thousands of pages of phantom printing the
 * first time a device has its firmware updated.
 */
export function computeDelta(
  previous: CounterReading,
  current: CounterReading,
): CounterDelta | null {
  if (current.life === null) return null;
  if (previous.life === null) {
    // First observation: establish the baseline, attribute nothing. Treating
    // the whole lifetime counter as "activity since we started watching" would
    // record decades of printing on day one.
    return { life: 0, print: null, copy: null, isReset: false };
  }

  const life = current.life - previous.life;
  if (life < 0) return { life: 0, print: null, copy: null, isReset: true };

  const diff = (before: number | null, after: number | null): number | null => {
    if (before === null || after === null) return null;
    const delta = after - before;
    return delta < 0 ? null : delta;
  };

  return {
    life,
    print: diff(previous.print, current.print),
    copy: diff(previous.copy, current.copy),
    isReset: false,
  };
}

/**
 * Classifies a counter delta into a job type (§B8.4, GAP-08, DEC-06).
 *
 * Where vendor counters exist the answer is measured. Where they do not, the
 * type is `unknown` — never `print`. This is the single most consequential line
 * in the reporting chain: `prtMarkerLifeCount` counts photocopies, and on an
 * MFP fleet at a sports club, where reception copies membership forms and ID
 * documents all day, calling that "printing" is not a rounding error.
 */
export function classifyDelta(delta: CounterDelta): {
  jobType: 'print' | 'copy' | 'unknown';
  impressions: number;
  /** Residual the vendor counters did not account for — faxes, internal pages. */
  unclassified: number;
} {
  if (delta.print === null && delta.copy === null) {
    return { jobType: 'unknown', impressions: delta.life, unclassified: delta.life };
  }

  const printed = delta.print ?? 0;
  const copied = delta.copy ?? 0;
  const unclassified = Math.max(0, delta.life - printed - copied);

  // Where both moved, the larger share names the event. A single poll cycle
  // containing both a print and a copy is reported as one entry either way —
  // the counter cannot separate them, and §B8.3 requires that limitation be
  // stated rather than papered over.
  if (printed > 0 && printed >= copied) {
    return { jobType: 'print', impressions: printed, unclassified };
  }
  if (copied > 0) {
    return { jobType: 'copy', impressions: copied, unclassified };
  }
  return { jobType: 'unknown', impressions: delta.life, unclassified };
}

/* ------------------------------------------------------------------ state  */

export interface StateReading {
  status: PrinterStatus;
  stateReasons: string[];
}

/**
 * Device state from `hrPrinterDetectedErrorState`, used where IPP is absent
 * (§B7.4, step 2).
 *
 * The bit field is decoded into the same IPP-style keywords the IPP path
 * produces, so downstream code — the safety gate, the dashboard, the
 * notification text — has one vocabulary regardless of which protocol answered.
 */
export async function readState(printer: PrinterWithSecrets): Promise<StateReading | null> {
  const values = await snmpGet(printer, [
    HOST_RESOURCES.printerDetectedErrorState,
    HOST_RESOURCES.printerStatus,
  ]);

  const raw = values.get(HOST_RESOURCES.printerDetectedErrorState);
  if (raw === null || raw === undefined) return null;

  const octets = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'latin1');
  const reasons = decodeErrorState(octets);

  const BLOCKING = new Set([
    'media-empty',
    'media-jam',
    'door-open',
    'marker-supply-empty',
    'offline',
    'service-request',
    'input-tray-missing',
    'output-area-full',
  ]);

  const blocked = reasons.some((reason) => BLOCKING.has(reason));
  return {
    status: blocked ? 'offline' : reasons.length > 0 ? 'degraded' : 'online',
    stateReasons: reasons,
  };
}

/* --------------------------------------------------------------- supplies  */

export interface SupplyReading {
  index: number;
  name: string;
  colorant: string | null;
  level: number | null;
  maxLevel: number | null;
}

/**
 * Enumerates toner and ink cartridges.
 *
 * Levels are walked rather than fetched by index because the number of supplies
 * varies from one (mono laser) to five or more (colour MFP with waste toner),
 * and guessing wrong either misses a cartridge or reads a non-existent one.
 *
 * The Printer-MIB uses negative levels as sentinels: -1 "other", -2 "unknown",
 * -3 "some remaining, amount unquantified". Treating those as literal levels
 * produces a gauge reading minus three percent, which is exactly the kind of
 * nonsense that makes an operator ignore the dashboard.
 */
export async function readSupplies(printer: PrinterWithSecrets): Promise<SupplyReading[]> {
  const [descriptions, levels, capacities, colorants] = await Promise.all([
    snmpWalk(printer, PRINTER_MIB.suppliesDescription),
    snmpWalk(printer, PRINTER_MIB.suppliesLevel),
    snmpWalk(printer, PRINTER_MIB.suppliesMaxCapacity),
    snmpWalk(printer, PRINTER_MIB.markerColorantValue),
  ]);

  const indexOf = (oid: string): number => {
    const last = oid.split('.').at(-1);
    const parsed = last === undefined ? Number.NaN : Number.parseInt(last, 10);
    return Number.isFinite(parsed) ? parsed : -1;
  };

  const byIndex = new Map<number, SupplyReading>();

  for (const entry of descriptions) {
    const index = indexOf(entry.oid);
    if (index < 0) continue;
    byIndex.set(index, {
      index,
      name: asString(entry.value) ?? `Supply ${index}`,
      colorant: null,
      level: null,
      maxLevel: null,
    });
  }

  for (const entry of levels) {
    const supply = byIndex.get(indexOf(entry.oid));
    if (!supply) continue;
    const value = asInteger(entry.value);
    supply.level = value !== null && value >= 0 ? value : null;
  }

  for (const entry of capacities) {
    const supply = byIndex.get(indexOf(entry.oid));
    if (!supply) continue;
    const value = asInteger(entry.value);
    supply.maxLevel = value !== null && value > 0 ? value : null;
  }

  for (const entry of colorants) {
    const supply = byIndex.get(indexOf(entry.oid));
    if (!supply) continue;
    supply.colorant = asString(entry.value);
  }

  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** Percentage remaining, or null where the device does not quantify it. */
export function supplyPercent(supply: SupplyReading): number | null {
  if (supply.level === null || supply.maxLevel === null || supply.maxLevel <= 0) return null;
  return Math.round((supply.level / supply.maxLevel) * 1000) / 10;
}
