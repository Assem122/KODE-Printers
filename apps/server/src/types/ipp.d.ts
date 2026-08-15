/**
 * Ambient types for the `ipp` package, which ships none.
 *
 * ADR-001 requires a maintained IPP client rather than a hand-rolled encoder,
 * so this declaration is the cost of that decision: a narrow, honest surface
 * covering only the three operations §B6.3 names. Everything else on the
 * package's API is deliberately left undeclared — if a future change needs
 * another operation, adding it here is a conscious step rather than an
 * accidental `any`.
 */
declare module 'ipp' {
  /**
   * IPP attribute values. The wire format is typed, and the library surfaces
   * that as a union rather than strings, which is why option mapping in
   * `services/transport/ipp.ts` has to be explicit about integers vs keywords.
   */
  export type IppValue = string | number | boolean | Buffer | Date | IppValue[];

  export interface IppAttributes {
    /** Operation name; `serialize` maps it to the wire operation code. */
    operation?: string;
    'operation-attributes-tag'?: Record<string, IppValue>;
    'job-attributes-tag'?: Record<string, IppValue>;
    'printer-attributes-tag'?: Record<string, IppValue>;
    'unsupported-attributes-tag'?: Record<string, IppValue>;
    'job-template'?: Record<string, IppValue>;
    data?: Buffer;
  }

  export interface IppResponse extends IppAttributes {
    version?: string;
    statusCode?: string;
    id?: number;
  }

  export interface PrinterOptions {
    version?: string;
    charset?: string;
    language?: string;
    uri?: string;
  }

  export class Printer {
    constructor(url: string, options?: PrinterOptions);
    execute(
      operation: string,
      message: IppAttributes,
      callback: (error: Error | null, response: IppResponse) => void,
    ): void;
  }

  export function serialize(message: IppAttributes): Buffer;
  export function parse(buffer: Buffer): IppResponse;
}
