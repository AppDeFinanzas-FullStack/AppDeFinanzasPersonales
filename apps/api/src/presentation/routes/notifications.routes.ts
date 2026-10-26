import { PreferencesInput } from '@finanzas/contracts';
import { Router, type RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import {
  createNotificationPreferencesController,
  createNotificationsController,
  type NotificationPreferencesControllerDeps,
  type NotificationsControllerDeps,
} from '../controllers/notifications.controller.js';
import { releaseGate } from '../middlewares/release-gate.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface NotificationsRoutesDeps extends NotificationsControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/notifications` (plan §4.15.2), behind the release of the inbox (M15, V1.1). */
export const notificationsRouter = (deps: NotificationsRoutesDeps): Router => {
  const controller = createNotificationsController(deps);
  const guarded = [releaseGate('M15'), requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...guarded, controller.list);
  router.get('/unread-count', ...guarded, controller.unreadCount);
  router.post('/read-all', ...guarded, controller.markAllRead);
  router.post('/:id/read', ...guarded, controller.markRead);
  router.delete('/:id', ...guarded, controller.remove);

  return router;
};

export interface NotificationPreferencesRoutesDeps extends NotificationPreferencesControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** The configuration of the notices exists only from the V1.2 on (RF-M15-07). */
const configurationGate: RequestHandler = (_req, _res, next) => {
  next(process.env['RELEASE'] === '1.2' ? undefined : new AppError('RELEASE_NOT_AVAILABLE'));
};

/** `/api/notification-preferences` (plan §4.15.2), behind the V1.2 (RF-M15-07). */
export const notificationPreferencesRouter = (deps: NotificationPreferencesRoutesDeps): Router => {
  const controller = createNotificationPreferencesController(deps);
  const guarded = [configurationGate, requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...guarded, controller.list);
  router.patch('/', ...guarded, validate(PreferencesInput), controller.update);

  return router;
};
