import {
  CreateGoalInput,
  DedicateInput,
  EarmarkInput,
  ReleaseInput,
  UpdateGoalInput,
} from '@finanzas/contracts';
import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';

import { AppError } from '../../application/errors.js';

import {
  createGoalsController,
  type GoalsControllerDeps,
} from '../controllers/goals.controller.js';
import { releaseGate } from '../middlewares/release-gate.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate as validateBody } from '../middlewares/validate.js';

export interface GoalsRoutesDeps extends GoalsControllerDeps {
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

/** `/api/goals` (plan §4.12.2), behind the release of the goals (M12, V1.1). */
export const goalsRouter = (deps: GoalsRoutesDeps): Router => {
  const controller = createGoalsController(deps);
  const guarded = [releaseGate('M12'), requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...guarded, controller.list);
  router.post('/', ...guarded, validate(CreateGoalInput), controller.create);
  router.get('/:id', ...guarded, controller.get);
  router.patch('/:id', ...guarded, validate(UpdateGoalInput), controller.update);
  router.delete('/:id', ...guarded, controller.remove);
  router.post('/:id/earmarks', ...guarded, validate(EarmarkInput), controller.earmark);
  router.post('/:id/earmarks/release', ...guarded, validate(ReleaseInput), controller.release);
  router.post('/:id/dedicate', ...guarded, validate(DedicateInput), controller.dedicate);
  router.post('/:id/use-and-close', ...guarded, controller.useAndClose);
  router.post('/:id/archive', ...guarded, controller.archive);
  router.post('/:id/restore', ...guarded, controller.restore);
  router.post('/:id/celebrated', ...guarded, controller.celebrated);

  return router;
};
