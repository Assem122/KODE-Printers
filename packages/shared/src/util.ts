import type { ColorMode, Sides } from './constants.js';
import type { PrintOptions } from './types.js';

/**
 * Pure functions shared by server and client.
 *
 * Everything here is deterministic and I/O-free, which is why it can live on
 * both sides. The impression calculation in particular *must* be identical in
 * both places: the client uses it to warn about a large job and the server uses
 * it to seed the attribution ledger, and a disagreement between the two would
 * show up as phantom walk-up jobs.
 */

/* ------------------------------------------------------------ impressions  */

export interface ImpressionInput {
  /** Pages after any page-range selection has been applied. */
  pages: number;
  copies: number;
  sides: Sides;
}

/**
 * An impression is one side of one sheet marked by the print engine — the unit
 * the SNMP page counter actually counts (§ glossary, §B4.7).
 *
 * The subtlety worth stating: duplex does **not** halve impressions. It halves
 * *sheets*. A 10-page duplex job still marks 10 impressions across 5 sheets, so
 * the ledger figure is `pages × copies` regardless of sides. Getting this
 * backwards would make every duplex job under-consume its ledger entry and leak
 * the remainder into a fabricated walk-up job.
 */
export function computeImpressions({ pages, copies, sides }: ImpressionInput): number {
  void sides; // documented above: sides changes sheets, never impressions
  return Math.max(0, Math.round(pages) * Math.max(1, Math.round(copies)));
}

/** Physical sheets consumed. This is the number that maps to paper and to cost. */
export function computeSheets({ pages, copies, sides }: ImpressionInput): number {
  const perCopy = sides === 'one-sided' ? pages : Math.ceil(pages / 2);
  return Math.max(0, perCopy * Math.max(1, Math.round(copies)));
}

/** Sheets a duplex job saved versus printing the same thing one-sided. */
export function sheetsSavedByDuplex(input: ImpressionInput): number {
  if (input.sides === 'one-sided') return 0;
  return computeSheets({ ...input, sides: 'one-sided' }) - computeSheets(input);
}

/* ------------------------------------------------------------- page ranges */

/**
 * Expands 1-based inclusive ranges into a sorted, de-duplicated page list,
 * clamped to the document. An empty range list means the whole document.
 */
export function expandPageRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  totalPages: number,
): number[] {
  if (totalPages <= 0) return [];
  if (ranges.length === 0) return Array.from({ length: totalPages }, (_, i) => i + 1);

  const selected = new Set<number>();
  for (const [rawFrom, rawTo] of ranges) {
    const from = Math.max(1, Math.min(rawFrom, rawTo));
    const to = Math.min(totalPages, Math.max(rawFrom, rawTo));
    for (let page = from; page <= to; page += 1) selected.add(page);
  }
  return [...selected].sort((a, b) => a - b);
}

/** Renders ranges back to the compact form a person reads: "1-3, 7, 11-12". */
export function formatPageRanges(ranges: ReadonlyArray<readonly [number, number]>): string {
  if (ranges.length === 0) return 'All pages';
  return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(', ');
}

/** Parses the compact form a person types. Invalid fragments are dropped, not thrown. */
export function parsePageRanges(input: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const fragment of input.split(/[,;]/)) {
    const trimmed = fragment.trim();
    if (trimmed === '') continue;
    const single = /^(\d+)$/.exec(trimmed);
    if (single?.[1]) {
      const page = Number(single[1]);
      if (page > 0) out.push([page, page]);
      continue;
    }
    const span = /^(\d+)\s*[-–]\s*(\d+)$/.exec(trimmed);
    if (span?.[1] && span[2]) {
      const from = Number(span[1]);
      const to = Number(span[2]);
      if (from > 0 && to > 0) out.push([Math.min(from, to), Math.max(from, to)]);
    }
  }
  return out;
}

/* -------------------------------------------------------------------- cost */

export interface CostInput {
  monoImpressions: number;
  colorImpressions: number;
  costPerPageMono: number;
  costPerPageColor: number;
}

export function computeCost(input: CostInput): number {
  const total =
    input.monoImpressions * input.costPerPageMono + input.colorImpressions * input.costPerPageColor;
  return Math.round(total * 100) / 100;
}

/**
 * CO2e for a print run. The default factor is a coarse cradle-to-gate estimate
 * for office paper plus toner; it is configurable precisely because it is an
 * estimate, and the UI labels it as such rather than presenting it as measured.
 */
export function computeCo2Grams(impressions: number, gramsPerImpression: number): number {
  return Math.round(impressions * gramsPerImpression * 10) / 10;
}

/* ---------------------------------------------------------------- cursors  */

export interface Cursor {
  /** ISO timestamp of the last row on the previous page. */
  t: string;
  /** Its id, breaking ties within the same timestamp. */
  i: number;
}

/**
 * Keyset cursors, base64url. Opaque to the client by construction: it holds
 * `(created_at, id)` so the next query is an index seek rather than an OFFSET
 * scan. §B5.4 forbids offset pagination because it degrades badly once the jobs
 * table holds a year of data.
 */
export function encodeCursor(cursor: Cursor): string {
  return base64UrlEncode(JSON.stringify(cursor));
}

export function decodeCursor(value: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(value));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Cursor).t === 'string' &&
      typeof (parsed as Cursor).i === 'number' &&
      Number.isFinite((parsed as Cursor).i) &&
      !Number.isNaN(Date.parse((parsed as Cursor).t))
    ) {
      return { t: (parsed as Cursor).t, i: (parsed as Cursor).i };
    }
    return null;
  } catch {
    return null;
  }
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* -------------------------------------------------------------- filenames  */

// Printer firmware emits control bytes in filenames, and they must reach
// neither the filesystem nor a rendered list.
// eslint-disable-next-line no-control-regex -- matching control bytes is the point
const UNSAFE_FILENAME = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Makes a filename safe to store and to display.
 *
 * Filenames arriving from printer firmware are untrusted input (§B16.3) and
 * have historically been the vector for both path traversal and display
 * spoofing. Non-Latin characters survive: a scan named in Arabic must keep its
 * name, because the person who scanned it needs to recognise it.
 */
export function sanitizeFilename(input: string, fallback = 'document'): string {
  const withoutPath = input.split(/[/\\]/).pop() ?? input;
  const cleaned = withoutPath
    .replace(UNSAFE_FILENAME, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 200)
    .trim();
  if (cleaned === '' || WINDOWS_RESERVED.test(cleaned)) return fallback;
  return cleaned;
}

export function fileExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  if (index <= 0 || index === filename.length - 1) return '';
  return filename.slice(index + 1).toLowerCase();
}

/* ------------------------------------------------------------- formatting  */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours}h ${minutes}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/* ------------------------------------------------------------- exp backoff */

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration. Fifty printers polled on a shared four-second timer
 * arrive as a thundering herd at the switch; spreading them is what keeps one
 * unreachable building from consuming the poll budget for the whole fleet
 * (§B7.4, §B8.2).
 */
export function backoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

/** Deterministic ±jitterRatio around a base interval, for staggered polling. */
export function jitteredInterval(
  baseMs: number,
  jitterRatio = 0.25,
  random: () => number = Math.random,
): number {
  const delta = baseMs * jitterRatio;
  return Math.round(baseMs - delta + random() * delta * 2);
}

/* ------------------------------------------------------------ print helpers */

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  copies: 1,
  sides: 'one-sided',
  colorMode: 'grayscale',
  media: 'iso_a4_210x297mm',
  pageRanges: [],
  orientation: 'portrait',
  watermark: false,
  holdForRelease: false,
};

export function isDuplex(sides: Sides): boolean {
  return sides !== 'one-sided';
}

export function colorModeLabel(mode: ColorMode): string {
  return mode === 'color' ? 'Colour' : 'Black & white';
}

/** Human summary of a job's options, for the job list and notifications. */
export function describePrintOptions(options: Partial<PrintOptions>): string {
  const parts: string[] = [];
  if (options.copies && options.copies > 1) parts.push(`${options.copies} copies`);
  parts.push(colorModeLabel(options.colorMode ?? 'grayscale'));
  if (options.sides && isDuplex(options.sides)) parts.push('Double-sided');
  if (options.pageRanges?.length) parts.push(formatPageRanges(options.pageRanges));
  return parts.join(' · ');
}

/* ---------------------------------------------------------------- guards   */

export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

/** Groups an array by a derived key, preserving insertion order. */
export function groupBy<T, K extends string | number>(
  items: readonly T[],
  keyOf: (item: T) => K,
): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}
