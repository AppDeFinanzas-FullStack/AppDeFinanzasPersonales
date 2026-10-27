import { SkipInput, Step1Input, Step2Input, Step3Input } from '@finanzas/contracts';
import { Router } from 'express';

import {
  createOnboardingController,
  type OnboardingControllerDeps,
} from '../controllers/onboarding.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface OnboardingRoutesDeps extends OnboardingControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/onboarding` (plan §4.10.2). */
export const onboardingRouter = (deps: OnboardingRoutesDeps): Router => {
  const controller = createOnboardingController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...withSession, controller.get);
  router.post('/step1', ...withSession, validate(Step1Input), controller.step1);
  router.post('/step2', ...withSession, validate(Step2Input), controller.step2);
  router.post('/step3', ...withSession, validate(Step3Input), controller.step3);
  router.post('/skip', ...withSession, validate(SkipInput), controller.skip);
  router.post('/skip-all', ...withSession, controller.skipAll);

  return router;
};
