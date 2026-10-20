import { UpdateMeInput } from '@finanzas/contracts';
import { Router } from 'express';

import { createMeController, type MeControllerDeps } from '../controllers/me.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface MeRoutesDeps extends MeControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/me` (plan §4.1.2). */
export const meRouter = (deps: MeRoutesDeps): Router => {
  const controller = createMeController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...withSession, controller.get);
  router.patch('/', ...withSession, validate(UpdateMeInput), controller.update);

  return router;
};
