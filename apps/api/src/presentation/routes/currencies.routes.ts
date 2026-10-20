import { CreateCurrencyInput, UpdateCurrencyInput } from '@finanzas/contracts';
import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';

import { AppError } from '../../application/errors.js';
import {
  createCurrenciesController,
  type CurrenciesControllerDeps,
} from '../controllers/currencies.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface CurrenciesRoutesDeps extends CurrenciesControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/**
 * Validates the body like `validate`, except that a well-formed rate under Bs 0.01 (the only
 * custom check of the rate in the contracts) gives `RATE_BELOW_MINIMUM` (EC-M3-07).
 */
const validateRate =
  (schema: ZodType): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req.body);
    const belowMinimum =
      !result.success &&
      result.error.issues.every((issue) => issue.code === 'custom' && issue.path[0] === 'rate');
    if (belowMinimum) {
      next(new AppError('RATE_BELOW_MINIMUM'));
      return;
    }
    validate(schema)(req, res, next);
  };

/** `{rate}` of a reactivation: the rate of `UpdateCurrencyInput`, but required (plan §4.3.3). */
const ActivateCurrencyInput = UpdateCurrencyInput.pick({ rate: true }).required();

/** `/api/currencies` (plan §4.3.2). */
export const currenciesRouter = (deps: CurrenciesRoutesDeps): Router => {
  const controller = createCurrenciesController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...withSession, controller.list);
  router.post('/', ...withSession, validateRate(CreateCurrencyInput), controller.create);
  router.patch('/:code', ...withSession, validateRate(UpdateCurrencyInput), controller.update);
  router.post('/:code/deactivate', ...withSession, controller.deactivate);
  router.post(
    '/:code/activate',
    ...withSession,
    validateRate(ActivateCurrencyInput),
    controller.activate,
  );

  return router;
};
