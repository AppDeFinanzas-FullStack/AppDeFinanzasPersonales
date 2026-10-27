import type { SkipInput, Step1Input, Step2Input, Step3Input } from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type {
  OnboardingContext,
  OnboardingService,
} from '../../application/services/onboarding.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { OnboardingPresenter } from '../presenters/onboarding.presenter.js';

export interface OnboardingControllerDeps {
  onboardingService: OnboardingService;
  clock: Pick<Clock, 'now'>;
}

export interface OnboardingController {
  get: RequestHandler;
  step1: RequestHandler;
  step2: RequestHandler;
  step3: RequestHandler;
  skip: RequestHandler;
  skipAll: RequestHandler;
}

const sessionOf = (req: Request): SessionContext => {
  if (req.auth === undefined) {
    throw new AppError('SESSION_EXPIRED');
  }
  return req.auth;
};

const traceIdOf = (locals: Record<string, unknown>): string => {
  const traceId = locals['traceId'];
  return typeof traceId === 'string' ? traceId : '';
};

/**
 * Handlers of `/api/onboarding` (plan §4.10.2). The bodies were validated by the router; the user
 * always comes from the session, so one user's Onboarding never moves another's (RNF-14).
 */
export function createOnboardingController({
  onboardingService,
  clock,
}: OnboardingControllerDeps): OnboardingController {
  const contextOf = (req: Request, locals: Record<string, unknown>): OnboardingContext => {
    const session = sessionOf(req);
    return {
      userId: session.userId,
      timezone: session.timezone,
      now: clock.now(),
      traceId: traceIdOf(locals),
    };
  };

  return {
    async get(req, res) {
      const state = await onboardingService.get(contextOf(req, res.locals));
      res.status(200).json(OnboardingPresenter.toDto(state));
    },

    async step1(req, res) {
      const progress = await onboardingService.step1(
        contextOf(req, res.locals),
        req.body as Step1Input,
      );
      res.status(200).json(OnboardingPresenter.progress(progress));
    },

    async step2(req, res) {
      const progress = await onboardingService.step2(
        contextOf(req, res.locals),
        req.body as Step2Input,
      );
      res.status(200).json(OnboardingPresenter.progress(progress));
    },

    async step3(req, res) {
      const progress = await onboardingService.step3(
        contextOf(req, res.locals),
        req.body as Step3Input,
      );
      res.status(200).json(OnboardingPresenter.progress(progress));
    },

    async skip(req, res) {
      const progress = await onboardingService.skip(
        contextOf(req, res.locals),
        req.body as SkipInput,
      );
      res.status(200).json(OnboardingPresenter.progress(progress));
    },

    async skipAll(req, res) {
      const progress = await onboardingService.skipAll(contextOf(req, res.locals));
      res.status(200).json(OnboardingPresenter.progress(progress));
    },
  };
}
