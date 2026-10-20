import { FxSettingsInput, ManualUsdInput } from '@finanzas/contracts';
import { Router } from 'express';

import {
  createFxController,
  createFxSettingsController,
  type FxControllerDeps,
  type FxSettingsControllerDeps,
} from '../controllers/fx.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

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

export interface FxRoutesDeps extends FxSettingsControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/fx-settings` and `/api/fx/manual` (plan §4.3.2); mounted on `/api`. */
export const fxRouter = (deps: FxRoutesDeps): Router => {
  const controller = createFxSettingsController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.patch(
    '/fx-settings',
    ...withSession,
    validate(FxSettingsInput),
    controller.updateSettings,
  );
  router.put('/fx/manual', ...withSession, validate(ManualUsdInput), controller.setManual);
  router.delete('/fx/manual', ...withSession, controller.clearManual);

  return router;
};
