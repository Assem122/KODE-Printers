import { Router } from 'express';
import { setupLockdown } from '../middlewares/setupLockdown.js';
import { authRouter } from './auth.js';
import { collectorAgentRouter, collectorsRouter } from './collectors.js';
import { healthRouter } from './health.js';
import { jobsRouter } from './jobs.js';
import { auditRouter, notificationsRouter } from './notifications.js';
import { printersRouter } from './printers.js';
import { scansRouter } from './scans.js';
import { quotasRouter, settingsRouter } from './settings.js';
import { sitesRouter } from './sites.js';
import { statsRouter } from './stats.js';
import { streamRouter } from './stream.js';
import { templatesRouter } from './templates.js';
import { usersRouter } from './users.js';

/**
 * Route mounting.
 *
 * Mount order is not arbitrary. `/health` and `/auth` come first because they
 * are the two groups that must work when something else is broken — a readiness
 * probe that sits behind a failing middleware tells the process manager the
 * wrong thing.
 */
export const apiRouter = Router();

// GAP-01: while an account still holds the seeded password the system is not in
// service. Mounted first so the refusal cannot be reached around, and ahead of
// the health routes only because it lets those two through explicitly.
apiRouter.use(setupLockdown);

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);

apiRouter.use('/sites', sitesRouter);
apiRouter.use('/printers', printersRouter);
apiRouter.use('/jobs', jobsRouter);
apiRouter.use('/scans', scansRouter);
apiRouter.use('/templates', templatesRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/stats', statsRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/audit', auditRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/quotas', quotasRouter);

// Two distinct surfaces for collectors: `/collectors` is the admin's view and
// takes a user session; `/collectors/agent` takes a collector API key. Keeping
// them apart means a collector key can never reach an administrative route.
apiRouter.use('/collectors/agent', collectorAgentRouter);
apiRouter.use('/collectors', collectorsRouter);

apiRouter.use('/stream', streamRouter);
