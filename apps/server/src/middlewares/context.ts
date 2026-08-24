import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ulid } from 'ulid';
import type { Role } from '@kode/shared';
import { runWithContext } from '../utilities/logger.js';

/**
 * Request identity and the async-local context.
 *
 * §B5.2 calls `requestId` "the join key between a user's complaint and the
 * logs". It only earns that if it is on the response, in the error body, and on
 * every log line the request produced — which is what `runWithContext` gives
 * without threading a logger through every function signature.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      actor?: {
        id: number;
        username: string;
        role: Role;
        department: string | null;
        /** Read by `requirePasswordChanged`, which is why it is loaded here. */
        mustChangePassword: boolean;
      };
      /** Set when the caller is a site collector rather than a person. */
      collectorId?: number;
    }
  }
}

export const requestContext: RequestHandler = (req, res, next) => {
  // ULIDs are lexicographically sortable by time, so grepping a log for a range
  // of ids returns them in order — which a UUID would not.
  const inbound = req.get('x-request-id');
  const requestId = inbound && /^[A-Za-z0-9_-]{8,64}$/.test(inbound) ? inbound : ulid();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const ip = clientIp(req);
  runWithContext({ requestId, ...(ip === null ? {} : { ip }) }, () => {
    next();
  });
};

/**
 * The client address, respecting the configured proxy depth.
 *
 * §B18.3 requires `trust proxy` to be set so rate limiting sees the real client
 * rather than the reverse proxy — without it every request appears to come from
 * 127.0.0.1 and one user's typo locks out the building.
 */
export function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket.remoteAddress ?? null;
  if (!ip) return null;
  // Express reports IPv4-mapped IPv6 for loopback; INET columns accept either,
  // but reports read better without the prefix.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * INV-11 — every asynchronous handler is wrapped so a rejected promise becomes
 * a structured error rather than an unhandled rejection that terminates the
 * process.
 *
 * Express 4 does not await handlers, so a `throw` inside an async function
 * escapes the router entirely. This is not optional hygiene; without it a
 * single failed query takes down the API.
 */
export type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void> | void;

export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
