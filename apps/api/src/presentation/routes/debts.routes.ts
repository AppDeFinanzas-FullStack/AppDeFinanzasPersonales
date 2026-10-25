import { CreateDebtInput, PaymentInput, UpdateDebtInput } from '@finanzas/contracts';
import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';

import { AppError } from '../../application/errors.js';

import {
  createDebtsController,
  type DebtsControllerDeps,
} from '../controllers/debts.controller.js';
import { releaseGate } from '../middlewares/release-gate.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate as validateBody } from '../middlewares/validate.js';

export interface DebtsRoutesDeps extends DebtsControllerDeps {
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

/** `/api/debts` (plan §4.13.2), behind the release of the debts (M13, V1.1, ADR-18). */
export const debtsRouter = (deps: DebtsRoutesDeps): Router => {
  const controller = createDebtsController(deps);
  const guarded = [releaseGate('M13'), requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...guarded, controller.list);
  router.post('/', ...guarded, validate(CreateDebtInput), controller.create);
  router.patch('/:id', ...guarded, validate(UpdateDebtInput), controller.update);
  router.post('/:id/payments', ...guarded, validate(PaymentInput), controller.pay);
  router.delete('/:id/payments/last', ...guarded, controller.deleteLastPayment);
  router.post('/:id/forgive', ...guarded, controller.forgive);
  router.delete('/:id', ...guarded, controller.remove);

  return router;
};
