import { CreateBudgetInput, DecisionInput, UpdateBudgetInput } from '@finanzas/contracts';
import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';

import { AppError } from '../../application/errors.js';

import {
  createBudgetsController,
  type BudgetsControllerDeps,
} from '../controllers/budgets.controller.js';
import { releaseGate } from '../middlewares/release-gate.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate as validateBody } from '../middlewares/validate.js';

export interface BudgetsRoutesDeps extends BudgetsControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/**
 * Validates the body; a value that a refinement can not even read (such as a text that is not a
 * number) is a validation error, not a failure of the server.
 */
const validate =
  (schema: ZodType): RequestHandler =>
  (req, res, next) => {
    try {
      validateBody(schema)(req, res, next);
    } catch {
      next(new AppError('VALIDATION_ERROR'));
    }
  };

/** The currency of a budget is fixed once it is created (plan §4.11.2). */
const currencyImmutable: RequestHandler = (req, _res, next) => {
  const body: unknown = req.body;
  const changesCurrency = typeof body === 'object' && body !== null && 'currencyCode' in body;
  next(changesCurrency ? new AppError('CURRENCY_IMMUTABLE') : undefined);
};

/** `/api/budgets` (plan §4.11.2), behind the release of the budgets (M11, V1.1). */
export const budgetsRouter = (deps: BudgetsRoutesDeps): Router => {
  const controller = createBudgetsController(deps);
  const guarded = [releaseGate('M11'), requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...guarded, controller.list);
  router.post('/', ...guarded, validate(CreateBudgetInput), controller.create);
  router.get('/:id', ...guarded, controller.get);
  router.patch(
    '/:id',
    ...guarded,
    currencyImmutable,
    validate(UpdateBudgetInput),
    controller.update,
  );
  router.delete('/:id', ...guarded, controller.remove);
  router.post('/:id/pause', ...guarded, controller.pause);
  router.post('/:id/resume', ...guarded, controller.resume);
  router.post('/:id/reset-carryover', ...guarded, controller.resetCarryover);
  router.post(
    '/:id/periods/:periodId/decision',
    ...guarded,
    validate(DecisionInput),
    controller.decide,
  );

  return router;
};
