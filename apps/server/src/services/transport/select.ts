import {
  AppError,
  DEFAULT_PRINT_OPTIONS,
  type PrintOptions,
  type TransportUsed,
} from '@kode/shared';
import type { Db } from '../../db/pool.js';
import { printersModel, type PrinterWithSecrets } from '../../models/printers.js';
import { subsystem } from '../../utilities/logger.js';
import { defaultIppUri, IppError, probeIpp, sendIpp } from './ipp.js';
import { sendRaw } from './raw9100.js';
import type { PjlOptions } from './pjl.js';

const log = subsystem('transport:select');

/**
 * Transport selection and send (§B6.2, ADR-001).
 *
 * IPP first, RAW/9100 as fallback. The whole subtlety is in how a failure is
 * interpreted, and the document is unusually direct about it:
 *
 *   "A protocol-level IPP failure demotes the printer to RAW permanently until
 *    the next probe. A transient failure MUST NOT demote it: a printer that is
 *    merely asleep is not a printer without IPP. Conflating the two is the most
 *    likely defect in this section."
 *
 * So the demotion path runs only for `kind === 'protocol'`, and a transient
 * failure propagates as retryable without touching the stored capability.
 */

export type Transport = TransportUsed;

export interface SendRequest {
  printer: PrinterWithSecrets;
  document: Buffer;
  /** MIME type of `document` after the conversion pipeline has run. */
  contentType: string;
  options: PrintOptions;
  jobName: string;
  username: string;
  timeoutMs?: number;
}

export interface SendOutcome {
  transport: Transport;
  jobUri: string | null;
  ippJobId: number | null;
  bytesWritten: number | null;
  durationMs: number;
}

/**
 * Decides which transport to use, probing once if the answer is unknown.
 *
 * The `unknown` case is not an error: a printer added five seconds ago has no
 * capability record yet. Probing lazily here means an admin can add a device
 * and print to it immediately, rather than having to remember to run a probe.
 */
export async function selectTransport(
  db: Db,
  printer: PrinterWithSecrets,
): Promise<{ transport: Transport; printer: PrinterWithSecrets }> {
  if (printer.transport === 'ipp') return { transport: 'ipp', printer };
  if (printer.transport === 'raw9100') return { transport: 'raw9100', printer };

  const supported = printer.capabilities.ipp.supported;
  if (supported === true) return { transport: 'ipp', printer };
  if (supported === false) return { transport: 'raw9100', printer };

  // Unknown — probe once, persist, then decide.
  const refreshed = await probeAndPersist(db, printer);
  return {
    transport: refreshed.capabilities.ipp.supported === true ? 'ipp' : 'raw9100',
    printer: refreshed,
  };
}

/**
 * Runs the capability probe and stores the result.
 *
 * A failed probe is recorded as `supported: false` only when it failed for a
 * protocol reason. A timeout leaves the answer unknown, so a device that was
 * asleep at onboarding gets probed again rather than being written off as
 * IPP-less forever.
 */
export async function probeAndPersist(
  db: Db,
  printer: PrinterWithSecrets,
): Promise<PrinterWithSecrets> {
  const uri = printer.ippUri ?? defaultIppUri(printer.ipAddress);

  try {
    const probed = await probeIpp(uri);
    const { makeAndModel, ...capabilities } = probed;

    await printersModel.saveCapabilities(db, printer.id, capabilities, { ippUri: uri });
    if (makeAndModel) {
      await printersModel.update(db, printer.id, parseMakeAndModel(makeAndModel));
    }

    log.info({ printerId: printer.id, uri }, 'IPP probe succeeded');
    return { ...printer, ippUri: uri, capabilities };
  } catch (error) {
    const kind = error instanceof IppError ? error.kind : 'protocol';

    if (kind === 'transient') {
      log.warn({ printerId: printer.id, uri }, 'IPP probe timed out; capability left unknown');
      return printer;
    }

    const capabilities = {
      ...printer.capabilities,
      ipp: { supported: false, versions: [], uri: null },
      probedVia: 'none' as const,
    };
    await printersModel.saveCapabilities(db, printer.id, capabilities);
    log.info({ printerId: printer.id }, 'IPP not supported; falling back to RAW/9100');
    return { ...printer, capabilities };
  }
}

/**
 * Sends a prepared document, falling back from IPP to RAW where appropriate.
 */
export async function send(db: Db, request: SendRequest): Promise<SendOutcome> {
  const startedAt = Date.now();
  const { transport, printer } = await selectTransport(db, request.printer);

  if (transport === 'ipp') {
    const uri = printer.ippUri ?? defaultIppUri(printer.ipAddress);
    try {
      const result = await sendIpp({
        uri,
        document: request.document,
        documentFormat: negotiateFormat(printer, request.contentType),
        jobName: request.jobName,
        username: request.username,
        copies: request.options.copies,
        sides: request.options.sides,
        colorMode: request.options.colorMode,
        media: request.options.media,
        orientation: request.options.orientation,
        pageRanges: request.options.pageRanges,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      });

      return {
        transport: 'ipp',
        jobUri: result.jobUri,
        ippJobId: result.jobId,
        bytesWritten: request.document.length,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const kind = error instanceof IppError ? error.kind : 'protocol';

      if (kind === 'transient') {
        // Do NOT demote. The device is busy or asleep; the queue will retry.
        throw new AppError('PRINTER_UNREACHABLE', 'The printer is not responding right now.', {
          details: { printerId: printer.id, transport: 'ipp' },
          retryable: true,
          cause: error,
        });
      }

      if (kind === 'rejected') {
        // The device understood us and said no — retrying changes nothing.
        throw new AppError('PRINTER_UNREACHABLE', 'The printer rejected this job.', {
          details: { printerId: printer.id, transport: 'ipp' },
          retryable: false,
          cause: error,
        });
      }

      log.warn(
        { printerId: printer.id, err: String(error) },
        'IPP protocol failure; demoting to RAW/9100 until the next probe',
      );
      await printersModel.saveCapabilities(db, printer.id, {
        ...printer.capabilities,
        ipp: { supported: false, versions: [], uri: null },
      });
      // Fall through to RAW below.
    }
  }
  const result = await sendRaw({
    host: printer.ipAddress,
    document: request.document,
    contentType: request.contentType,
    pjl: toPjlOptions(request),
    ...(request.timeoutMs === undefined ? {} : { writeTimeoutMs: request.timeoutMs }),
  });
  return {
    transport: 'raw9100',
    jobUri: null,
    ippJobId: null,
    bytesWritten: result.bytesWritten,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Picks the document format to declare.
 *
 * PDF is preferred where the device advertises it, because that is the format
 * the pipeline already produced and it lets the Ghostscript PostScript stage be
 * skipped entirely — §B6.1 notes this drops a dependency from the hot path on
 * IPP Everywhere devices.
 */
function negotiateFormat(printer: PrinterWithSecrets, produced: string): string {
  const supported = printer.capabilities.formats;
  if (supported.length === 0) return produced;
  if (supported.includes(produced)) return produced;
  if (supported.includes('application/pdf') && produced === 'application/pdf') {
    return 'application/pdf';
  }
  if (supported.includes('application/octet-stream')) return 'application/octet-stream';
  return produced;
}

function toPjlOptions(request: SendRequest): PjlOptions {
  const options = { ...DEFAULT_PRINT_OPTIONS, ...request.options };
  return {
    copies: options.copies,
    sides: options.sides,
    colorMode: options.colorMode,
    media: options.media,
    orientation: options.orientation,
    jobName: request.jobName,
    username: request.username,
    contentType: request.contentType,
  };
}
/**
 * Splits an IPP `printer-make-and-model` string into vendor and model.
 *
 * Devices report "HP LaserJet MFP M428fdw" or "Xerox VersaLink C405"; the first
 * token is reliably the manufacturer and the rest is the model.
 */
function parseMakeAndModel(value: string): { vendor: string; model: string } {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex <= 0) return { vendor: trimmed, model: trimmed };
  return {
    vendor: trimmed.slice(0, spaceIndex),
    model: trimmed.slice(spaceIndex + 1),
  };
}
