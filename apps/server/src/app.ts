import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { AppError } from '@kode/shared';
import { config } from './config/index.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { requestContext } from './middlewares/context.js';
import { generalLimiter } from './middlewares/rateLimit.js';
import { apiRouter } from './routes/index.js';
import { logger } from './utilities/logger.js';

/**
 * Express assembly.
 *
 * Middleware order is the whole file. Each position below is load-bearing, and
 * getting one wrong produces a bug that looks like something else entirely:
 *
 *  1. `trust proxy`   — before anything reads `req.ip`, or every request looks
 *                       like it came from the reverse proxy and one user's typo
 *                       rate-limits the building (§B18.3).
 *  2. requestContext  — before logging, so every line carries the request id.
 *  3. helmet / cors   — before routes, so a rejected origin never reaches a
 *                       handler.
 *  4. body parsers    — after CORS, so a preflight is answered without parsing.
 *  5. rate limiting   — after parsing, because the login limiter keys on the
 *                       username in the body.
 *  6. routes
 *  7. SPA fallback    — after the API, so `/api/nope` 404s as JSON rather than
 *                       returning index.html.
 *  8. error handler   — last, always.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxyHops);
  app.set('etag', 'strong');

  app.use(requestContext);

  app.use(
    pinoHttp({
      logger,
      // requestId is already mixed in by the async-local context; repeating it
      // per line would double every log entry's most common field.
      genReqId: (req: IncomingMessage) =>
        (req as IncomingMessage & { requestId?: string }).requestId ?? 'unknown',
      autoLogging: {
        ignore: (req: IncomingMessage) =>
          req.url === '/api/health' ||
          req.url === '/api/health/ready' ||
          req.url?.startsWith('/api/stream') === true,
      },
      // §B13.1 / INV-08: never log a token. The SSE route carries its access
      // token in the query string (EventSource cannot set headers), so the
      // query is stripped rather than trusted to be uninteresting.
      customProps: (req: IncomingMessage) => ({ path: (req.url ?? '').split('?')[0] }),
      serializers: {
        req: (req: { method: string; url?: string }) => ({
          method: req.method,
          url: (req.url ?? '').split('?')[0],
        }),
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The SPA is built with hashed assets and no inline scripts; styles
          // need 'unsafe-inline' because CSS-in-JS injects a style tag.
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          // 'self' only: the app talks to its own origin and nothing else.
          connectSrc: ["'self'"],
          objectSrc: ["'self'"], // inline PDF preview in the scan hub
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      // TLS terminates at the proxy, which is where HSTS belongs; setting it
      // here on a plaintext loopback listener would be advisory at best.
      hsts: false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'same-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin requests and non-browser clients send no Origin header.
        if (!origin) {
          callback(null, true);
          return;
        }
        if (config.http.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new AppError('FORBIDDEN', 'This origin is not allowed.'));
      },
      credentials: true, // the refresh cookie
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  app.use('/api', generalLimiter);
  app.use('/api', apiRouter);

  /* --------------------------------------------------------------- the SPA */

  const clientDir = join(process.cwd(), 'public');
  if (existsSync(clientDir)) {
    app.use(
      express.static(clientDir, {
        // Hashed filenames are immutable; index.html and the service worker
        // must never be, or a deploy is invisible until the cache expires.
        maxAge: '1y',
        etag: true,
        index: false,
        setHeaders(res, path) {
          if (
            path.endsWith('index.html') ||
            path.endsWith('sw.js') ||
            path.endsWith('manifest.webmanifest')
          ) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );

    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(join(clientDir, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
