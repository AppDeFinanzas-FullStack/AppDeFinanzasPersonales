import { ResetSettingsInput, UpdateSettingsInput } from '@finanzas/contracts';
import { Router } from 'express';

import {
  createSettingsController,
  type SettingsControllerDeps,
} from '../controllers/settings.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface SettingsRoutesDeps extends Omit<SettingsControllerDeps, 'clock'> {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/settings` (plan §4.9.2). */
export const settingsRouter = (deps: SettingsRoutesDeps): Router => {
  const controller = createSettingsController({ ...deps, clock: deps.session.clock });
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...withSession, controller.get);
  router.patch('/', ...withSession, validate(UpdateSettingsInput), controller.update);
  router.post('/reset', ...withSession, validate(ResetSettingsInput), controller.reset);

  return router;
};
