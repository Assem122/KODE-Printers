/**
 * Enumerations shared by the database CHECK constraints, the API validators and
 * the client. Defined once so a value can never be legal in one layer and
 * rejected in another.
 */

export const ROLES = ['admin', 'user'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Deliberately two roles. §B12.1 considered and rejected a third: at club scale
 * it adds a permission matrix to maintain without a real separation of duty.
 */

export const PRINTER_STATUSES = ['online', 'offline', 'degraded', 'unknown'] as const;
export type PrinterStatus = (typeof PRINTER_STATUSES)[number];

export const TRANSPORTS = ['auto', 'ipp', 'raw9100'] as const;
export type TransportPreference = (typeof TRANSPORTS)[number];

export const TRANSPORTS_USED = ['ipp', 'raw9100'] as const;
export type TransportUsed = (typeof TRANSPORTS_USED)[number];

export const SNMP_VERSIONS = ['1', '2c', '3', 'disabled'] as const;
export type SnmpVersion = (typeof SNMP_VERSIONS)[number];

export const JOB_SOURCES = ['app', 'walkup', 'manual'] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

/**
 * `unknown` is load-bearing, not a placeholder. §B8.4: a device without vendor
 * print/copy counters cannot distinguish a print from a photocopy, and
 * recording such an event as `print` is the measurement flaw the document calls
 * out in A7.1. Reports MUST label these "device activity".
 */
export const JOB_TYPES = ['print', 'scan', 'copy', 'fax', 'unknown'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  'queued',
  'held', // awaiting release at the device — the hold-and-release feature
  'processing',
  'sent',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses from which no further transition happens. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

export const COLOR_MODES = ['color', 'grayscale'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const SIDES = ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'] as const;
export type Sides = (typeof SIDES)[number];

export const MEDIA_SIZES = [
  'iso_a4_210x297mm',
  'iso_a3_297x420mm',
  'iso_a5_148x210mm',
  'na_letter_8.5x11in',
  'na_legal_8.5x14in',
] as const;
export type MediaSize = (typeof MEDIA_SIZES)[number];

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SCAN_STATUSES = ['unclaimed', 'claimed', 'archived'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/**
 * IPP `printer-state-reasons` values mapped to our three-state model. The keys
 * are the IPP keywords with any `-report`/`-warning`/`-error` suffix stripped.
 * §B7.4.
 */
export const STATE_REASON_SEVERITY: Readonly<Record<string, Severity>> = {
  none: 'info',
  'toner-low': 'warning',
  'marker-supply-low': 'warning',
  'media-low': 'warning',
  'developer-low': 'warning',
  'opc-life-over': 'warning',
  'toner-empty': 'critical',
  'marker-supply-empty': 'critical',
  'media-empty': 'critical',
  'media-jam': 'critical',
  jam: 'critical',
  'door-open': 'critical',
  'cover-open': 'critical',
  'input-tray-missing': 'critical',
  'output-area-full': 'critical',
  shutdown: 'critical',
  offline: 'critical',
  paused: 'critical',
  'service-request': 'critical',
} as const;

/**
 * Reasons that mean "do not send anything to this device right now".
 *
 * This is the core of the printer-safety promise: a job destined for a jammed
 * or empty device is held, not fired into the void where it becomes a paper
 * spill or a silent loss.
 */
export const BLOCKING_STATE_REASONS: ReadonlySet<string> = new Set([
  'media-jam',
  'jam',
  'media-empty',
  'toner-empty',
  'marker-supply-empty',
  'door-open',
  'cover-open',
  'input-tray-missing',
  'output-area-full',
  'shutdown',
  'offline',
  'service-request',
  /**
   * Not a device state: this one is raised by `reconcileIdentity` when the
   * serial number at a printer's address stops matching the record (ADR-006).
   *
   * It belongs here because the consequence is worse than a jam. §B7.1 already
   * stops *polling* a mismatched device, on the grounds that absorbing another
   * unit's counters corrupts the audit trail. Sending to one is the same
   * mistake pointed the other way: the address now answers for a machine
   * nobody has identified, possibly in a different building or a different
   * organisation, and the document goes to whoever is standing next to it.
   * Holding the job until an administrator confirms what is physically there
   * costs a delay; not holding it costs a confidentiality breach.
   */
  'device-mismatch',
]);

export const AUDIT_ACTIONS = [
  'user.create',
  'user.update',
  'user.deactivate',
  'user.password_set',
  /** An administrator minted a set-password or reset link. */
  'user.setup_link',
  /** Someone redeemed one and chose their own password. */
  'user.password_chosen',
  'user.printers_set',
  'printer.create',
  'printer.update',
  'printer.deactivate',
  'printer.delete',
  'printer.probe',
  'printer.drain',
  'zone.create',
  'zone.update',
  'collector.create',
  'collector.revoke',
  'settings.update',
  'template.create',
  'template.update',
  'template.delete',
  'auth.login_success',
  'auth.login_failure',
  'auth.logout_all',
  'auth.token_reuse',
  'job.cancel',
  'job.retry',
  'job.release',
  /** An administrator recording activity the system could not observe. §B8.5. */
  'job.manual_entry',
  'scan.claim',
  'scan.delete',
  'retention.purge',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Upload allow-list. Re-verified against magic bytes before any byte is used. §B10.2. */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  'pdf',
  'txt',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'rtf',
  'csv',
  'png',
  'jpg',
  'jpeg',
] as const;
export type AllowedExtension = (typeof ALLOWED_UPLOAD_EXTENSIONS)[number];

export const PAGINATION = {
  defaultLimit: 50,
  maxLimit: 200,
  /** §B5.4 — an export wider than this is a memory-exhaustion vector. */
  maxExportRangeDays: 366,
} as const;
