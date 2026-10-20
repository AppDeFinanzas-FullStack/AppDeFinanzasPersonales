import { Router } from 'express';

import { createFxController, type FxControllerDeps } from '../controllers/fx.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';

export interface RatesRoutesDeps extends FxControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/rates` (plan §4.3.2). */
export const ratesRouter = (deps: RatesRoutesDeps): Router => {
  const controller = createFxController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/current', ...withSession, controller.current);
  router.get('/history', ...withSession, controller.history);

  return router;
};
