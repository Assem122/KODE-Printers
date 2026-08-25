import type { Job, Printer } from '@kode/shared';
export type PrinterCondition = {
    kind: 'stopped';
    text: string;
} | {
    kind: 'attention';
    text: string;
} | {
    kind: 'unknown';
    text: string;
} | {
    kind: 'ready';
    text: string;
};
/**
 * What to say about a printer, and how loudly.
 *
 * Returns a `kind` as well as the words so callers colour it consistently
 * instead of each deciding for itself what counts as bad.
 */
export declare function printerCondition(printer: Printer): PrinterCondition;
/** Ink level and how long it is expected to last, when the device reports it. */
export declare function inkPhrase(printer: Printer): string | null;
/**
 * One line describing what happened, in the right tense.
 *
 * The tense is the whole point. "Ahmed printed Price list.xlsx" is a lie while
 * the job is still sitting in the queue, and it was being told for every job
 * regardless of status — which made the activity list read as though
 * everything had succeeded.
 */
export declare function jobHeadline(job: Job): string;
export type JobTone = 'good' | 'bad' | 'waiting' | 'neutral';
export interface JobStatusLabel {
    text: string;
    tone: JobTone;
}
/** The short status word beside a job, and how to colour it. */
export declare function jobStatus(job: Job): JobStatusLabel;
/** Maps a job tone onto the badge modifiers the stylesheet already defines. */
export declare function badgeToneFor(tone: JobTone): '' | 'online' | 'offline' | 'degraded';
/**
 * A time a person would say out loud.
 *
 * Today gets a clock time, this week gets a weekday, anything older gets a
 * date. Seconds are never shown: nobody has ever needed them in a job list,
 * and they made every row a wall of digits.
 */
export declare function friendlyTime(iso: string): string;
/** "3 pages", "1 page". The unit people actually use for impressions. */
export declare function pageCount(job: Job): string;
//# sourceMappingURL=plain.d.ts.map