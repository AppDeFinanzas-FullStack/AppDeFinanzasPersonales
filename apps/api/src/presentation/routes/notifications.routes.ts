import { Router } from 'express';

import {
  createNotificationsController,
  type NotificationsControllerDeps,
} from '../controllers/notifications.controller.js';
import { releaseGate } from '../middlewares/release-gate.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';

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
