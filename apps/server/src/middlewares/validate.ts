import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';

/**
 * Schema validation.
 *
 * Parsed output replaces the raw input on the request, so a handler downstream
 * always sees coerced, defaulted, trimmed values and never the original strings
 * from the wire. Validating without replacing is the common half-measure: it
 * catches bad input but leaves every handler doing `Number(req.query.limit)`
 * anyway, and one of them eventually forgets.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validated: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

type Source = 'body' | 'query' | 'params';

function validate(source: Source, schema: ZodTypeAny): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(result.error);
      return;
    }
    // zod's generic `safeParse` returns `any`; the typed accessors below
    // are what give the value a shape at the point of use.
    req.validated = { ...req.validated, [source]: result.data as unknown };
    next();
  };
}

export const validateBody = (schema: ZodTypeAny): RequestHandler => validate('body', schema);
export const validateQuery = (schema: ZodTypeAny): RequestHandler => validate('query', schema);
export const validateParams = (schema: ZodTypeAny): RequestHandler => validate('params', schema);

/** Typed accessors, so handlers read validated data without casting at each use. */
export function body<T extends ZodTypeAny>(req: Express.Request, _schema: T): z.output<T> {
  return req.validated.body;
}

export function query<T extends ZodTypeAny>(req: Express.Request, _schema: T): z.output<T> {
  return req.validated.query;
}

export function params<T extends ZodTypeAny>(req: Express.Request, _schema: T): z.output<T> {
  return req.validated.params;
}
