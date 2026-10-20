import { UpdateSettingsInput } from '@finanzas/contracts';
import { Router } from 'express';

import {
  createSettingsController,
  type SettingsControllerDeps,
} from '../controllers/settings.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface SettingsRoutesDeps extends SettingsControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/settings` (plan §4.9.2). */
export const settingsRouter = (deps: SettingsRoutesDeps): Router => {
  const controller = createSettingsController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...withSession, controller.get);
  router.patch('/', ...withSession, validate(UpdateSettingsInput), controller.update);

  return router;
};
