import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { AppError, expandPageRanges, fileExtension } from '@kode/shared';
import { subsystem } from '../../utilities/logger.js';

const log = subsystem('pipeline:prepare');

/**
 * Document inspection and manipulation.
 *
 * INV-09 lives here: no uploaded byte reaches a converter or a printer before
 * `verifyMagicBytes` passes.
 */

/* ------------------------------------------------------------ magic bytes  */

interface Signature {
  extensions: readonly string[];
  matches: (head: Buffer) => boolean;
}

const startsWith = (bytes: readonly number[]) => (head: Buffer) =>
  bytes.every((byte, index) => head[index] === byte);

const SIGNATURES: readonly Signature[] = [
  { extensions: ['pdf'], matches: startsWith([0x25, 0x50, 0x44, 0x46]) }, // %PDF
  { extensions: ['png'], matches: startsWith([0x89, 0x50, 0x4e, 0x47]) },
  { extensions: ['jpg', 'jpeg'], matches: startsWith([0xff, 0xd8, 0xff]) },
  // Legacy OLE compound file: .doc, .xls, .ppt
  {
    extensions: ['doc', 'xls', 'ppt'],
    matches: startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  },
  // OOXML and ODF are both ZIP containers.
  {
    extensions: ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'],
    matches: (head) =>
      head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05),
  },
  { extensions: ['rtf'], matches: startsWith([0x7b, 0x5c, 0x72, 0x74, 0x66]) }, // {\rtf
];

/**
 * Signatures that are refused outright regardless of the claimed extension.
 *
 * The scenario §B17.2 requires a test for: an executable renamed to `.pdf`.
 * Extension checks alone would pass it straight into LibreOffice.
 */
const EXECUTABLE_SIGNATURES: ReadonlyArray<{ label: string; matches: (head: Buffer) => boolean }> =
  [
    { label: 'Windows executable', matches: startsWith([0x4d, 0x5a]) }, // MZ
    { label: 'Linux executable', matches: startsWith([0x7f, 0x45, 0x4c, 0x46]) }, // ELF
    { label: 'Mach-O executable', matches: startsWith([0xcf, 0xfa, 0xed, 0xfe]) },
    { label: 'Java class file', matches: startsWith([0xca, 0xfe, 0xba, 0xbe]) },
    { label: 'shell script', matches: startsWith([0x23, 0x21]) }, // #!
  ];

export interface MagicByteVerdict {
  ok: boolean;
  detectedAs?: string;
  reason?: string;
}

/**
 * Confirms a file is what its extension claims.
 *
 * This is an integrity check, not a malware scan — §B16.1 is explicit that it
 * "does not detect an exploit inside a well-formed document", and process
 * isolation is the control for that. What it does stop is the cheap attack:
 * anything carrying an executable signature, and any file whose real format
 * disagrees with its name.
 */
export function verifyMagicBytes(content: Buffer, filename: string): MagicByteVerdict {
  const head = content.subarray(0, 16);
  const extension = fileExtension(filename);

  for (const signature of EXECUTABLE_SIGNATURES) {
    if (signature.matches(head)) {
      return {
        ok: false,
        reason: `This file is a ${signature.label}, not a document. It has been rejected.`,
      };
    }
  }

  // Plain text and CSV have no signature; anything that is valid UTF-8 and free
  // of NUL bytes qualifies. Refusing them for lacking magic bytes would reject
  // the single most common thing anyone prints.
  if (extension === 'txt' || extension === 'csv') {
    if (content.includes(0x00)) {
      return { ok: false, reason: 'This file claims to be text but contains binary data.' };
    }
    return { ok: true, detectedAs: 'text' };
  }

  const expected = SIGNATURES.find((signature) => signature.extensions.includes(extension));
  if (!expected) {
    return { ok: false, reason: `Files of type .${extension} are not accepted.` };
  }

  if (!expected.matches(head)) {
    const actual = SIGNATURES.find((signature) => signature.matches(head));
    return {
      ok: false,
      reason: actual
        ? `This file is named .${extension} but is actually a ${actual.extensions[0]} file.`
        : `This file does not appear to be a valid .${extension} document.`,
    };
  }

  return { ok: true, detectedAs: extension };
}

/* -------------------------------------------------------------- page count */

export interface PageCountResult {
  pages: number;
  /**
   * True when the count came from the byte-scan fallback rather than a parsed
   * document. §B10.3: these numbers feed reports, so an estimate MUST be
   * flagged — `jobs.page_count_estimated` carries it through to the UI.
   */
  estimated: boolean;
}

export async function countPdfPages(content: Buffer): Promise<PageCountResult> {
  try {
    const document = await PDFDocument.load(content, { ignoreEncryption: true });
    return { pages: document.getPageCount(), estimated: false };
  } catch (error) {
    log.warn({ err: String(error) }, 'pdf-lib could not parse the document; estimating page count');
    return { pages: estimatePagesByScan(content), estimated: true };
  }
}

/**
 * Counts `/Type /Page` occurrences.
 *
 * Unreliable by construction — object streams compress page dictionaries out of
 * reach, and `/Pages` nodes can be miscounted — which is exactly why its result
 * is flagged. It exists so a document pdf-lib cannot parse still prints with a
 * plausible figure rather than failing outright.
 */
function estimatePagesByScan(content: Buffer): number {
  const text = content.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return Math.max(1, matches?.length ?? 1);
}

/* --------------------------------------------------------- page selection  */

/**
 * Extracts the selected pages into a new document.
 *
 * Done server-side rather than passed as an IPP `page-ranges` attribute for one
 * reason: the impression count must be *known*, because the ledger is seeded
 * from it. If the device applied the range itself, the counter delta would not
 * match what we recorded and the difference would surface as a phantom walk-up.
 */
export async function selectPages(
  content: Buffer,
  ranges: ReadonlyArray<readonly [number, number]>,
): Promise<{ content: Buffer; pages: number }> {
  if (ranges.length === 0) {
    const { pages } = await countPdfPages(content);
    return { content, pages };
  }

  const source = await PDFDocument.load(content, { ignoreEncryption: true });
  const total = source.getPageCount();
  const wanted = expandPageRanges(ranges, total);

  if (wanted.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `That page range is outside the document, which has ${total} page${total === 1 ? '' : 's'}.`,
      { details: { totalPages: total } },
    );
  }

  const output = await PDFDocument.create();
  const copied = await output.copyPages(
    source,
    wanted.map((page) => page - 1),
  );
  for (const page of copied) output.addPage(page);

  return { content: Buffer.from(await output.save()), pages: wanted.length };
}

/* ------------------------------------------------------------- watermark   */

/**
 * Stamps a footer identifying who printed the document and when.
 *
 * For confidential material this turns a photocopy found in a corridor into
 * something traceable. Drawn as a footer rather than a diagonal overlay because
 * a membership form still has to be legible and signable.
 */
export async function applyWatermark(content: Buffer, text: string): Promise<Buffer> {
  try {
    const document = await PDFDocument.load(content, { ignoreEncryption: true });
    const font = await document.embedFont(StandardFonts.Helvetica);
    const size = 7;

    for (const page of document.getPages()) {
      const { width } = page.getSize();
      const label = text.slice(0, 120);
      const textWidth = font.widthOfTextAtSize(label, size);
      page.drawText(label, {
        x: Math.max(12, (width - textWidth) / 2),
        y: 12,
        size,
        font,
        color: rgb(0.45, 0.45, 0.45),
        rotate: degrees(0),
      });
    }

    return Buffer.from(await document.save());
  } catch (error) {
    // A watermark is a nice-to-have. Failing the job over it would be a poor
    // trade, so the document is returned unstamped and the caller records it.
    log.warn({ err: String(error) }, 'watermark could not be applied');
    return content;
  }
}

/* ------------------------------------------------------------ image → PDF  */

/**
 * Wraps an image in a PDF page, scaled to fit A4 with a margin.
 *
 * Sending a raw JPEG to port 9100 produces either nothing or a page of garbage,
 * depending on the device. Wrapping it means "print this photo of the sign-in
 * sheet from my phone" works, which is most of what the mobile PWA is for.
 */
export async function imageToPdf(content: Buffer, filename: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  const extension = fileExtension(filename);

  const image =
    extension === 'png' ? await document.embedPng(content) : await document.embedJpg(content);

  const A4 = { width: 595.28, height: 841.89 };
  const margin = 36;
  const maxWidth = A4.width - margin * 2;
  const maxHeight = A4.height - margin * 2;

  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  const width = image.width * scale;
  const height = image.height * scale;

  const page = document.addPage([A4.width, A4.height]);
  page.drawImage(image, {
    x: (A4.width - width) / 2,
    y: (A4.height - height) / 2,
    width,
    height,
  });

  return Buffer.from(await document.save());
}

/** Wraps plain text in a PDF, so the RAW path never receives interpretable text. */
export async function textToPdf(content: Buffer): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Courier);
  const size = 10;
  const lineHeight = size * 1.35;
  const A4 = { width: 595.28, height: 841.89 };
  const margin = 48;
  const usableWidth = A4.width - margin * 2;
  const charsPerLine = Math.floor(usableWidth / font.widthOfTextAtSize('M', size));
  const linesPerPage = Math.floor((A4.height - margin * 2) / lineHeight);

  const lines = content
    .toString('utf8')
    .replace(/\t/g, '    ')
    .split(/\r?\n/)
    .flatMap((line) => wrap(line, Math.max(20, charsPerLine)));

  for (let offset = 0; offset < Math.max(lines.length, 1); offset += linesPerPage) {
    const page = document.addPage([A4.width, A4.height]);
    const slice = lines.slice(offset, offset + linesPerPage);
    slice.forEach((line, index) => {
      page.drawText(line, {
        x: margin,
        y: A4.height - margin - index * lineHeight,
        size,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    });
  }

  return Buffer.from(await document.save());
}

function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  for (let index = 0; index < line.length; index += width) {
    out.push(line.slice(index, index + width));
  }
  return out;
}
