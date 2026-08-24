import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { AppError, fileExtension } from '@kode/shared';
import { config } from '../../config/index.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';
import { textToPdf } from './prepare.js';
import { runSandboxed, withTempDir } from './sandbox.js';

const log = subsystem('pipeline:convert');

/**
 * Document conversion (§B10.3).
 *
 * The governing behaviour, preserved from the delivered build because it is
 * right: **every stage is best-effort**. A failed stage falls back to the
 * previous stage's output rather than failing the job. Someone printing a
 * slightly malformed spreadsheet gets their pages, not an error.
 *
 * What changes here are the three defects §B10.3 names:
 *   GAP-16 — concurrent `soffice` invocations collided on a shared profile lock
 *            and the second silently hung. Every invocation now gets its own
 *            `-env:UserInstallation` directory.
 *   GAP-17 — no timeouts. Handled in `sandbox.ts`.
 *   GAP-20 — no isolation. Also `sandbox.ts`.
 */

/** Formats LibreOffice must handle before anything can be sent to a printer. */
const OFFICE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'csv',
  'txt',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

export function needsOfficeConversion(filename: string): boolean {
  return OFFICE_EXTENSIONS.has(fileExtension(filename));
}

export function isImage(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(filename));
}

export interface ConversionOutcome {
  content: Buffer;
  contentType: string;
  /** Stages that failed and fell back, for `jobs.notes`. */
  degradations: string[];
}

/**
 * Office or image → PDF via headless LibreOffice.
 *
 * The `-env:UserInstallation` flag is the fix for GAP-16 and is not optional.
 * Without it, two concurrent conversions contend for `~/.config/libreoffice`
 * and the loser either hangs until the timeout or exits zero having produced
 * nothing — the second being far worse, because it looks like success.
 */
export async function officeToPdf(
  input: Buffer,
  originalFilename: string,
  jobId: number,
): Promise<Buffer> {
  return withTempDir(`lo-${jobId}`, async (dir) => {
    const safeName = `input${extname(originalFilename) || '.tmp'}`;
    const inputPath = join(dir, safeName);
    const profileDir = join(dir, 'profile');
    const outDir = join(dir, 'out');

    await writeFile(inputPath, input);

    await runSandboxed({
      command: config.convert.libreOfficePath,
      args: [
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        '--nofirststartwizard',
        `-env:UserInstallation=file://${profileDir.replace(/\\/g, '/')}`,
        '--convert-to',
        'pdf:writer_pdf_Export',
        '--outdir',
        outDir,
        inputPath,
      ],
      cwd: dir,
      env: { TMPDIR: dir },
    });

    const produced = await readdir(outDir).catch(() => [] as string[]);
    const pdfName = produced.find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!pdfName) {
      throw new AppError('CONVERSION_FAILED', 'The document could not be converted to PDF.', {
        details: { originalFilename: basename(originalFilename) },
      });
    }
    return readFile(join(outDir, pdfName));
  });
}

/**
 * Converts a PDF to greyscale with Ghostscript.
 *
 * Done server-side rather than relying on the device because it is the one
 * place the outcome is certain. A `print-color-mode: monochrome` attribute is
 * honoured by IPP devices, but over RAW the equivalent PJL line is advisory —
 * and a colour page printed on a colour device costs roughly ten times a mono
 * one, so "probably mono" is not good enough for a cost report.
 */
export async function toGrayscale(input: Buffer, jobId: number): Promise<Buffer> {
  return withTempDir(`gs-gray-${jobId}`, async (dir) => {
    const inputPath = join(dir, 'input.pdf');
    const outputPath = join(dir, 'output.pdf');
    await writeFile(inputPath, input);

    await runSandboxed({
      command: config.convert.ghostscriptPath,
      args: [
        '-sDEVICE=pdfwrite',
        '-dProcessColorModel=/DeviceGray',
        '-sColorConversionStrategy=Gray',
        '-dOverrideICC',
        '-dNOPAUSE',
        '-dBATCH',
        // SAFER, like every other Ghostscript invocation here. It was NOSAFER,
        // which disables the file-access restrictions on a parser pointed at an
        // uploaded document — undoing most of what sandbox.ts is for. The ICC
        // override above needs no such privilege.
        '-dSAFER',
        '-dQUIET',
        `-sOutputFile=${outputPath}`,
        inputPath,
      ],
      cwd: dir,
      env: { TMPDIR: dir },
    });

    return readFile(outputPath);
  });
}

/**
 * PDF → PostScript, for devices that do not accept `application/pdf`.
 *
 * §B6.1 notes this stage becomes unnecessary on IPP Everywhere devices, which
 * mandate PDF acceptance — so the pipeline skips it entirely when the device's
 * capabilities say PDF is supported, dropping a Ghostscript invocation from the
 * hot path.
 */
export async function pdfToPostScript(input: Buffer, jobId: number): Promise<Buffer> {
  return withTempDir(`gs-ps-${jobId}`, async (dir) => {
    const inputPath = join(dir, 'input.pdf');
    const outputPath = join(dir, 'output.ps');
    await writeFile(inputPath, input);

    await runSandboxed({
      command: config.convert.ghostscriptPath,
      args: [
        '-sDEVICE=ps2write',
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        '-dQUIET',
        `-sOutputFile=${outputPath}`,
        inputPath,
      ],
      cwd: dir,
      env: { TMPDIR: dir },
    });

    return readFile(outputPath);
  });
}

/**
 * Runs a conversion stage, falling back to the input on failure.
 *
 * The fallback is what makes the pipeline forgiving, and the recorded
 * degradation is what stops it being dishonest: a job that printed in colour
 * because greyscale conversion failed says so in its notes, so the cost report
 * is not quietly wrong.
 *
 * A timeout is re-thrown rather than swallowed. §B14 requires a hung conversion
 * to kill the process and fail the job cleanly — falling back would hand the
 * printer a document the pipeline never finished preparing.
 */
export async function stage(
  name: string,
  input: Buffer,
  fn: () => Promise<Buffer>,
  degradations: string[],
): Promise<Buffer> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError && error.code === 'CONVERSION_TIMEOUT') throw error;
    log.warn({ stage: name, ...serialiseError(error) }, 'conversion stage failed; falling back');
    degradations.push(name);
    return input;
  }
}

/**
 * A stage whose output the device cannot do without.
 *
 * The fallback in `stage()` is right for an *enhancement*. A job that printed
 * in colour because greyscale conversion failed is still the document someone
 * asked for, and the recorded degradation keeps the cost report honest.
 *
 * It is wrong for a *format* conversion, and quietly so. A printer cannot
 * render OOXML: handing it raw `.docx` bytes produces a tray of garbage rather
 * than a document, so the fallback delivers nothing the user wanted while
 * reporting success. For plain text it is worse than useless, because raw text
 * on the RAW/9100 path is exactly the PJL injection surface ADR-015 exists to
 * close.
 *
 * So the three format-normalising stages fail the job instead, with a message
 * that names the file.
 */
export async function requiredStage(
  name: string,
  filename: string,
  fn: () => Promise<Buffer>,
): Promise<Buffer> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError) throw error;
    log.warn({ stage: name, ...serialiseError(error) }, 'required conversion stage failed');
    throw new AppError(
      'CONVERSION_FAILED',
      `"${basename(filename)}" could not be prepared for printing.`,
      { details: { stage: name }, retryable: false, cause: error },
    );
  }
}

/**
 * Plain text to PDF, by whichever converter can manage it.
 *
 * Two are tried because they fail in different places. LibreOffice renders any
 * script the installed fonts cover, which on this image means Arabic and CJK;
 * pdf-lib's standard fonts are WinAnsi-encoded and throw on the first character
 * outside Latin-1, which for a club whose documents are not in English is a
 * routine input rather than an edge case. But LibreOffice is an OS binary a
 * host may not have and pdf-lib is always present, so each covers the other's
 * gap.
 *
 * If both fail the job fails. That is deliberate: the alternative is handing
 * the transport the original bytes, and plain text is the one payload a device
 * will interpret as instructions.
 */
export async function textToPdfStrict(
  input: Buffer,
  filename: string,
  jobId: number,
  degradations: string[],
): Promise<Buffer> {
  try {
    return await officeToPdf(input, filename, jobId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'CONVERSION_TIMEOUT') throw error;
    log.warn(
      { stage: 'text-office-to-pdf', ...serialiseError(error) },
      'LibreOffice could not render the text; falling back to the built-in writer',
    );
    degradations.push('text-office-to-pdf');
  }

  try {
    return await textToPdf(input);
  } catch (error) {
    throw new AppError(
      'CONVERSION_FAILED',
      `"${basename(filename)}" could not be turned into a printable document. If it contains ` +
        'Arabic or other non-Latin text, the document converter is not available on this ' +
        'server. Save it as a PDF and try again.',
      { details: { stage: 'text-to-pdf' }, retryable: false, cause: error },
    );
  }
}
