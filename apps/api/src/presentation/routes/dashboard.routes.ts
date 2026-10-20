import { Router } from 'express';

import {
  createDashboardController,
  type DashboardControllerDeps,
} from '../controllers/dashboard.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';

export interface DashboardRoutesDeps extends DashboardControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/dashboard` (plan §4.8.2). */
export const dashboardRouter = (deps: DashboardRoutesDeps): Router => {
  const controller = createDashboardController(deps);
  const router = Router();

  router.get('/', requireSession(deps.session), trackActivity(deps.session), controller.get);

  return router;
};
