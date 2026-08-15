import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { ALLOWED_UPLOAD_EXTENSIONS, AppError, fileExtension, sanitizeFilename } from '@kode/shared';
import { config } from '../config/index.js';

/**
 * Upload handling (§B10.2).
 *
 * Memory storage rather than disk, deliberately. INV-09 requires the magic-byte
 * check to pass *before* any byte reaches a converter or a printer, and the
 * cleanest way to guarantee that is for the bytes never to touch the filesystem
 * until they have been verified. With a 100 MB cap and a queue concurrency of
 * two, the memory cost is bounded and small.
 *
 * The extension allow-list here is the *first* gate, not the only one — it is
 * cheap and rejects obvious junk before it is buffered. `verifyMagicBytes` in
 * the pipeline is the gate that actually decides.
 */

const storage = multer.memoryStorage();

export const uploadDocument = multer({
  storage,
  limits: {
    fileSize: config.storage.maxUploadBytes,
    files: 1,
    // Multipart bodies also carry the options blob; a low field cap stops a
    // request with ten thousand fields consuming parse time.
    fields: 12,
    parts: 16,
  },
  fileFilter: (_req, file, callback) => {
    const extension = fileExtension(file.originalname);
    if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
      callback(
        new AppError(
          'FILE_TYPE_REJECTED',
          `Files of type .${extension || '(none)'} cannot be printed. ` +
            'Accepted: PDF, Word, Excel, PowerPoint, images and plain text.',
          { details: { extension } },
        ),
      );
      return;
    }
    callback(null, true);
  },
}).single('file');

/** Multi-file variant for the merge-and-print flow. */
export const uploadDocuments = multer({
  storage,
  limits: { fileSize: config.storage.maxUploadBytes, files: 10, fields: 12, parts: 32 },
  fileFilter: (_req, file, callback) => {
    const extension = fileExtension(file.originalname);
    if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
      callback(
        new AppError('FILE_TYPE_REJECTED', `Files of type .${extension} cannot be printed.`),
      );
      return;
    }
    callback(null, true);
  },
}).array('files', 10);

/**
 * The name a file is stored under.
 *
 * Random, not derived from the upload. A user-supplied name reaching the
 * filesystem is the classic path-traversal vector, and even sanitised it
 * invites collisions between two people printing `report.pdf` in the same
 * second. The original name is kept in `jobs.document_name`, where it is data
 * rather than a path.
 */
export function storedFilenameFor(originalName: string): string {
  const extension = fileExtension(sanitizeFilename(originalName)) || 'bin';
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${randomUUID()}.${extension}`;
}
