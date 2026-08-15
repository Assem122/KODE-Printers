import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, isAppError, type ErrorDetails } from '@kode/shared';
import { config } from '../config/index.js';
import { pgConstraint, pgErrorCode, PG_ERRORS } from '../db/sql.js';
import { serialiseError, subsystem } from '../utilities/logger.js';

const log = subsystem('http');

/**
 * The single error renderer.
 *
 * Two invariants meet here:
 *   INV-12 — stack traces and driver-level error text never appear in a
 *            response body.
 *   §B5.2  — every non-2xx body matches the error envelope exactly.
 *
 * Both are guaranteed structurally: only an `AppError` is ever rendered.
 * Anything else is logged in full and rendered as `INTERNAL_ERROR`, so a new
 * `throw new Error('...')` added anywhere in the codebase cannot leak its
 * message to a client by accident.
 */

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND' as const,
      message: `No route matches ${req.method} ${req.path}.`,
      requestId: req.requestId,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    // A stream already began — an SSE connection or a CSV export. Ending it is
    // all that is left; a JSON body appended here would corrupt what was sent.
    log.error({ ...serialiseError(error) }, 'error after response started');
    res.end();
    return;
  }
  void next;

  const appError = toAppError(error);

  const logPayload = {
    method: req.method,
    path: req.path,
    code: appError.code,
    status: appError.status,
    ...serialiseError(error),
  };

  // 5xx is a fault on our side and deserves attention; 4xx is the client being
  // told no, which is normal traffic and should not fill the error log.
  if (appError.status >= 500) log.error(logPayload, 'request failed');
  else log.info(logPayload, 'request rejected');

  if (appError.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(appError.retryAfterSeconds));
  }

  res.status(appError.status).json(appError.toBody(req.requestId));
};

function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    return new AppError('VALIDATION_FAILED', firstZodMessage(error), {
      details: zodDetails(error),
    });
  }

  const pgCode = pgErrorCode(error);
  if (pgCode) return fromPostgres(pgCode, error);

  // Multer signals an oversize upload with this code.
  if ((error as { code?: string }).code === 'LIMIT_FILE_SIZE') {
    return new AppError('FILE_TOO_LARGE', 'That file is larger than the upload limit.', {
      details: { limitBytes: config.storage.maxUploadBytes },
    });
  }

  if (error instanceof SyntaxError && 'body' in error) {
    return new AppError('VALIDATION_FAILED', 'The request body was not valid JSON.');
  }

  return new AppError('INTERNAL_ERROR', 'Something went wrong on our side.', { cause: error });
}

/**
 * Translates the Postgres errors that represent a *user-visible* condition.
 *
 * Everything else stays generic. A constraint name is internal detail, and the
 * ones surfaced here are only those where the user can actually do something
 * differently.
 */
function fromPostgres(code: string, error: unknown): AppError {
  const constraint = pgConstraint(error);

  switch (code) {
    case PG_ERRORS.uniqueViolation:
      return new AppError('CONFLICT', uniqueMessage(constraint), {
        ...(constraint ? { details: { constraint } } : {}),
        cause: error,
      });

    case PG_ERRORS.restrictViolation:
      // Two different refusals share this code. The append-only trigger on
      // audit_log raises it too, and answering that with advice about disabling
      // a printer sends whoever is debugging somewhere useless.
      if (isAuditLogWrite(error)) {
        return new AppError('FORBIDDEN', 'The audit log cannot be changed once written.', {
          cause: error,
        });
      }
      // INV-05 reaching the surface: the database refused to delete a printer
      // that has job history, which is exactly what it is there for.
      return new AppError(
        'PRINTER_HAS_HISTORY',
        'This printer has print history and cannot be deleted. Disable it instead — ' +
          'its records stay readable and it disappears from every picker.',
        { cause: error },
      );

    case PG_ERRORS.foreignKeyViolation:
      return new AppError('VALIDATION_FAILED', 'That reference does not exist.', { cause: error });

    case PG_ERRORS.checkViolation:
      return new AppError('VALIDATION_FAILED', 'That value is outside the allowed range.', {
        cause: error,
      });

    case PG_ERRORS.queryCanceled:
      return new AppError('INTERNAL_ERROR', 'That request took too long and was stopped.', {
        retryable: true,
        cause: error,
      });

    case PG_ERRORS.serializationFailure:
    case PG_ERRORS.deadlockDetected:
      return new AppError('INTERNAL_ERROR', 'The system was busy. Please try again.', {
        retryable: true,
        cause: error,
      });

    default:
      return new AppError('INTERNAL_ERROR', 'Something went wrong on our side.', { cause: error });
  }
}

/**
 * Whether a restrict violation came from the audit_log append-only trigger.
 *
 * The trigger raises through `RAISE EXCEPTION`, so there is no constraint name
 * to key on and the driver leaves `table` unset. The message it raises is the
 * only reliable marker, and it is checked second so a future core error that
 * does carry the table still resolves correctly.
 */
function isAuditLogWrite(error: unknown): boolean {
  const table = (error as { table?: unknown }).table;
  if (typeof table === 'string') return table === 'audit_log';
  return error instanceof Error && error.message.includes('audit_log is append-only');
}

function uniqueMessage(constraint: string | null): string {
  switch (constraint) {
    case 'users_username_key':
      return 'That username is already taken.';
    case 'printers_ip_active_uq':
      return 'Another active printer already uses that IP address.';
    case 'printers_serial_uq':
      return 'A printer with that serial number is already registered.';
    case 'sites_code_key':
      return 'That site code is already in use.';
    case 'sites_name_key':
      return 'That site name is already in use.';
    case 'print_templates_name_key':
      return 'A template with that name already exists.';
    case 'scan_reservation_active_uq':
      return 'Someone else is already waiting for a scan from this printer.';
    default:
      return 'That record already exists.';
  }
}

function firstZodMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'The request was not valid.';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function zodDetails(error: ZodError): ErrorDetails {
  const details: ErrorDetails = {};
  for (const issue of error.issues.slice(0, 20)) {
    details[issue.path.join('.') || '_'] = issue.message;
  }
  return details;
}
