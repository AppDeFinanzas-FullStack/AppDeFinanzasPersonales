import {
  ConfirmOccurrenceInput,
  CreateRuleInput,
  ResumeInput,
  UpdateRuleInput,
} from '@finanzas/contracts';
import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';

import { AppError } from '../../application/errors.js';

import {
  createRecurringController,
  type RecurringControllerDeps,
} from '../controllers/recurring.controller.js';
import { releaseGate } from '../middlewares/release-gate.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate as validateBody } from '../middlewares/validate.js';

export interface RecurringRoutesDeps extends RecurringControllerDeps {
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

/** Whether the only problem of a new rule is an automatic mode without amount (RF-M14-14). */
const onlyMissesAutoAmount = (body: unknown): boolean => {
  try {
    const result = CreateRuleInput.safeParse(body);
    return (
      !result.success &&
      result.error.issues.every(
        (issue) => issue.code === 'custom' && issue.message === 'AMOUNT_REQUIRED_FOR_AUTO',
      )
    );
  } catch {
    return false;
  }
};

/** A new rule in automatic mode without amount answers `AMOUNT_REQUIRED_FOR_AUTO` (plan §4.14.2). */
const validateCreate: RequestHandler = (req, res, next) => {
  if (onlyMissesAutoAmount(req.body)) {
    next(new AppError('AMOUNT_REQUIRED_FOR_AUTO'));
    return;
  }
  validate(CreateRuleInput)(req, res, next);
};

/** `/api/recurring` (plan §4.14.2), behind the release of the recurring rules (M14, V1.2). */
export const recurringRouter = (deps: RecurringRoutesDeps): Router => {
  const controller = createRecurringController(deps);
  const guarded = [releaseGate('M14'), requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...guarded, controller.overview);
  router.post('/', ...guarded, validateCreate, controller.create);
  router.post(
    '/occurrences/:id/confirm',
    ...guarded,
    validate(ConfirmOccurrenceInput),
    controller.confirm,
  );
  router.post('/occurrences/:id/skip', ...guarded, controller.skip);
  router.patch('/:id', ...guarded, validate(UpdateRuleInput), controller.update);
  router.delete('/:id', ...guarded, controller.remove);
  router.post('/:id/pause', ...guarded, controller.pause);
  router.get('/:id/skipped', ...guarded, controller.skipped);
  router.post('/:id/resume', ...guarded, validate(ResumeInput), controller.resume);

  return router;
};
