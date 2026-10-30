import {
  ChangePwdInput,
  ConfirmInput,
  ForgotInput,
  ResendInput,
  ResetInput,
  SignInInput,
  SignUpInput,
} from '@finanzas/contracts';
import { Router } from 'express';

import { createAuthController, type AuthControllerDeps } from '../controllers/auth.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface AuthRoutesDeps extends AuthControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/auth/*` (plan §4.1.2). */
export const authRouter = (deps: AuthRoutesDeps): Router => {
  const controller = createAuthController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.post('/sign-up', validate(SignUpInput), controller.signUp);
  router.post('/sign-in', validate(SignInInput), controller.signIn);
  router.post('/confirmation/resend', validate(ResendInput), controller.resendConfirmation);
  router.post('/confirm', validate(ConfirmInput), controller.confirm);
  router.post('/confirmation/status', controller.confirmationStatus);
  router.post('/password/forgot', validate(ForgotInput), controller.forgotPassword);
  router.post('/password/reset', validate(ResetInput), controller.resetPassword);
  router.post(
    '/password/change',
    ...withSession,
    validate(ChangePwdInput),
    controller.changePassword,
  );
  router.post('/sign-out', ...withSession, controller.signOut);
  router.post('/sign-out-all', ...withSession, controller.signOutAll);

  return router;
};
