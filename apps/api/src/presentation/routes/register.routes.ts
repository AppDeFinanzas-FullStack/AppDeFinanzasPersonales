import { Router } from 'express';

import {
  createRegisterController,
  type RegisterControllerDeps,
} from '../controllers/register.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';

export interface RegisterRoutesDeps extends RegisterControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/register` (plan §4.7.2). */
export const registerRouter = (deps: RegisterRoutesDeps): Router => {
  const controller = createRegisterController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/context', ...withSession, controller.context);

  return router;
};
