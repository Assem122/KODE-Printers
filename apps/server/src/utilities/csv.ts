/**
 * CSV rendering.
 *
 * INV-04 forbids string interpolation into SQL. This is the presentation
 * equivalent: a field is escaped once, here, rather than at each call site
 * where someone will eventually forget a document name containing a comma.
 */

/**
 * Escapes one field per RFC 4180, with one addition.
 *
 * A field beginning `=`, `+`, `-` or `@` is interpreted by Excel and Sheets as
 * a **formula**. A document named `=cmd|'/c calc'!A1` becomes executable when
 * an administrator opens the export — this is CSV injection, and the export is
 * precisely the artefact that gets emailed around. Prefixing a single quote
 * neutralises it while leaving the text readable.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  // `String(anObject)` yields "[object Object]", which is never what a report
  // wants. Objects reaching a CSV cell are a caller bug; JSON at least makes
  // the bug visible in the output rather than silently uniform.
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'bigint') text = String(value);
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else text = JSON.stringify(value) ?? '';

  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}
