import { Router } from 'express';
import { errors } from '@kode/shared';
import { pool } from '../db/pool.js';
import { usersModel } from '../models/users.js';
import { asyncHandler } from '../middlewares/context.js';
import { verifyAccessToken } from '../services/auth/index.js';
import { events } from '../services/events.js';
import { permittedPrinterIds } from '../services/printerAccess.js';
import { subsystem } from '../utilities/logger.js';

const log = subsystem('route:stream');

/**
 * The live-update stream.
 *
 * ADR-004 made printing asynchronous, so the client needs to learn outcomes
 * without polling. This is that channel.
 *
 * The token arrives as a query parameter rather than an Authorization header
 * because `EventSource` cannot set headers — a genuine browser limitation, not
 * a shortcut. Two things make that acceptable here: the token is the 15-minute
 * access token rather than the refresh token, and the URL is never logged with
 * its query string (see the pino-http config in `app.ts`). Over TLS on the club
 * network, that is a reasonable trade for dropping a polling loop.
 */
export const streamRouter = Router();

streamRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const token =
      typeof req.query['token'] === 'string'
        ? req.query['token']
        : req.get('authorization')?.replace(/^Bearer\s+/i, '');

    if (!token) throw errors.unauthenticated();

    const claims = verifyAccessToken(token);
    const user = await usersModel.find(pool, claims.sub);
    if (!user?.isActive) throw errors.unauthenticated('This account is no longer active.');

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and some corporate proxies buffer responses by default, which
      // holds every event until the connection closes — making the stream
      // useless in exactly the deployments most likely to have a proxy.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Tell the browser to wait 3s before reconnecting. The default of 3s is
    // already sensible; stating it makes the behaviour explicit rather than
    // dependent on the implementation.
    res.write('retry: 3000\n\n');
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

    // INV-01 reaching the live channel. The REST list paths already scope by
    // this set; the stream did not, so a scan's filename reached every signed-in
    // browser regardless of who could use the device it came from.
    const permitted = await permittedPrinterIds({
      id: user.id,
      username: user.username,
      role: user.role,
    });

    const unsubscribe = events.subscribe({
      userId: user.id,
      isAdmin: user.role === 'admin',
      permittedPrinterIds: new Set(permitted ?? []),
      response: res,
    });

    log.debug({ userId: user.id }, 'live stream opened');

    req.on('close', () => {
      unsubscribe();
      log.debug({ userId: user.id }, 'live stream closed');
    });
  }),
);
