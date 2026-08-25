import type { Job, Printer } from '@kode/shared';

/**
 * Plain language, in one place.
 *
 * The server's vocabulary is IPP's: `media-empty`, `marker-supply-low`,
 * `walkup`, `sent`. That vocabulary is correct and it belongs in the audit
 * record, where an engineer reads it — but it had been reaching the screen
 * verbatim, so the fleet board told a receptionist her printer was
 * "MEDIA EMPTY" twice over, in capitals.
 *
 * Every translation lives here rather than in each screen. Two reasons: the
 * same condition has to read identically on the home page, the fleet board and
 * the job list, and a keyword that has no phrase yet must fail visibly in one
 * place instead of silently rendering as a hyphenated fragment somewhere.
 */

/* ══════════════════════════════════════════════════════════════════ printers */

/**
 * Conditions that mean the printer cannot print at all.
 *
 * These mirror `BLOCKING_STATE_REASONS` on the server — the same set the
 * dispatch gate refuses on — so the interface never says "Ready" about a
 * device the queue is holding jobs back from.
 */
const STOPPED: Readonly<Record<string, string>> = {
  'media-empty': 'Out of paper',
  'media-jam': 'Paper jam',
  jam: 'Paper jam',
  'toner-empty': 'Out of ink',
  'marker-supply-empty': 'Out of ink',
  'door-open': 'A door is open',
  'cover-open': 'A cover is open',
  'input-tray-missing': 'A paper tray is missing',
  'output-area-full': 'The output tray is full',
  shutdown: 'Switched off',
  offline: 'Cannot be reached',
  'service-request': 'Needs servicing',
  'device-mismatch': 'This is not the printer we have on record',
};

/**
 * Conditions worth mentioning that do not stop anything.
 *
 * Kept apart from the list above because the difference decides whether a job
 * will print. A printer that is low on toner still prints; one that is out of
 * paper does not, and a screen that renders both the same way teaches people
 * to ignore the warning that mattered.
 */
const NIGGLES: Readonly<Record<string, string>> = {
  'toner-low': 'Running low on ink',
  'marker-supply-low': 'Running low on ink',
  'developer-low': 'Running low on developer',
  'media-low': 'Running low on paper',
  'output-area-almost-full': 'The output tray is nearly full',
  'opc-life-over': 'The drum is due for replacement',
  'marker-supply-missing': 'A cartridge is missing',
  'output-media-low': 'Running low on paper',
  'output-tray-missing': 'An output tray is missing',
  paused: 'Paused at the device',
};

export type PrinterCondition =
  | { kind: 'stopped'; text: string }
  | { kind: 'attention'; text: string }
  | { kind: 'unknown'; text: string }
  | { kind: 'ready'; text: string };

/**
 * What to say about a printer, and how loudly.
 *
 * Returns a `kind` as well as the words so callers colour it consistently
 * instead of each deciding for itself what counts as bad.
 */
export function printerCondition(printer: Printer): PrinterCondition {
  for (const reason of printer.stateReasons) {
    const stopped = STOPPED[reason];
    if (stopped) return { kind: 'stopped', text: stopped };
  }

  for (const reason of printer.stateReasons) {
    const niggle = NIGGLES[reason];
    if (niggle) return { kind: 'attention', text: niggle };
  }

  /* `offline` and `unknown` without a reason attached.
   *
   * A printer nobody can reach is not "ready", and saying so is the difference
   * between someone walking to a machine and someone picking another one. */
  if (printer.status === 'offline') return { kind: 'stopped', text: 'Cannot be reached' };
  if (printer.status === 'unknown') {
    return { kind: 'unknown', text: 'Not checked yet' };
  }
  if (printer.status === 'degraded') {
    return { kind: 'attention', text: 'Needs attention' };
  }

  if (printer.isDraining) return { kind: 'attention', text: 'Finishing up before maintenance' };
  if (!printer.isActive) return { kind: 'unknown', text: 'Turned off' };

  return { kind: 'ready', text: 'Ready' };
}

/** Ink level and how long it is expected to last, when the device reports it. */
export function inkPhrase(printer: Printer): string | null {
  const supply = printer.supplies.find((entry) => entry.percent !== null);
  if (supply?.percent == null) return null;

  const level = `${Math.round(supply.percent)}% ink left`;
  return supply.estimatedDaysRemaining === null
    ? level
    : `${level} · about ${supply.estimatedDaysRemaining} day${supply.estimatedDaysRemaining === 1 ? '' : 's'}`;
}

/* ══════════════════════════════════════════════════════════════════════ jobs */

/**
 * One line describing what happened, in the right tense.
 *
 * The tense is the whole point. "Ahmed printed Price list.xlsx" is a lie while
 * the job is still sitting in the queue, and it was being told for every job
 * regardless of status — which made the activity list read as though
 * everything had succeeded.
 */
export function jobHeadline(job: Job): string {
  const document = job.documentName ?? 'a document';

  if (job.source === 'walkup') {
    if (job.jobType === 'copy') return 'Someone made a photocopy at the printer';
    if (job.jobType === 'print') return 'Someone printed something at the printer';
    // DEC-06: with no vendor counter a print and a photocopy are the same
    // event to us, and calling it either would be inventing a fact.
    return 'Someone used the printer directly';
  }

  if (job.source === 'manual') {
    return `${job.usernameSnapshot} recorded ${document} by hand`;
  }

  switch (job.status) {
    case 'completed':
    case 'sent':
      return `${job.usernameSnapshot} printed ${document}`;
    case 'failed':
      return `${document} did not print`;
    case 'cancelled':
      return `${job.usernameSnapshot} cancelled ${document}`;
    case 'held':
      return `${document} is waiting to be released`;
    case 'processing':
      return `${document} is printing now`;
    default:
      return `${document} is waiting to print`;
  }
}

export type JobTone = 'good' | 'bad' | 'waiting' | 'neutral';

export interface JobStatusLabel {
  text: string;
  tone: JobTone;
}

/** The short status word beside a job, and how to colour it. */
export function jobStatus(job: Job): JobStatusLabel {
  if (job.source === 'walkup') return { text: 'At the printer', tone: 'neutral' };

  switch (job.status) {
    case 'completed':
    case 'sent':
      return { text: 'Printed', tone: 'good' };
    case 'failed':
      return { text: 'Did not print', tone: 'bad' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'neutral' };
    case 'held':
      return { text: 'Held', tone: 'waiting' };
    case 'processing':
      return { text: 'Printing', tone: 'waiting' };
    default:
      return { text: 'Waiting', tone: 'waiting' };
  }
}

/** Maps a job tone onto the badge modifiers the stylesheet already defines. */
export function badgeToneFor(tone: JobTone): '' | 'online' | 'offline' | 'degraded' {
  if (tone === 'good') return 'online';
  if (tone === 'bad') return 'offline';
  if (tone === 'waiting') return 'degraded';
  return '';
}

/* ═════════════════════════════════════════════════════════════════ formatting */

/**
 * A time a person would say out loud.
 *
 * Today gets a clock time, this week gets a weekday, anything older gets a
 * date. Seconds are never shown: nobody has ever needed them in a job list,
 * and they made every row a wall of digits.
 */
export function friendlyTime(iso: string): string {
  const then = new Date(iso);
  const elapsed = Date.now() - then.getTime();

  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) {
    const minutes = Math.round(elapsed / 60_000);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  const isToday = then.toDateString() === new Date().toDateString();
  if (isToday) return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (elapsed < 7 * 86_400_000) {
    return then.toLocaleDateString(undefined, { weekday: 'long' });
  }

  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "3 pages", "1 page". The unit people actually use for impressions. */
export function pageCount(job: Job): string {
  const pages = job.impressions ?? job.pages;
  return `${pages} page${pages === 1 ? '' : 's'}`;
}
