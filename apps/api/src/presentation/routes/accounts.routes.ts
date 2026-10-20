import {
  AdjustInput,
  ArchiveInput,
  CreateAccountInput,
  ReorderInput,
  RestoreInput,
  UpdateAccountInput,
} from '@finanzas/contracts';
import { Router } from 'express';
import { z } from 'zod';

import {
  createAccountsController,
  type AccountsControllerDeps,
} from '../controllers/accounts.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface AccountsRoutesDeps extends AccountsControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** A body that may be left out entirely, as in a bare `POST …/archive`. */
const optionalBody = <T extends z.ZodType>(schema: T) => z.preprocess((body) => body ?? {}, schema);

/** `/api/accounts` (plan §4.4.2). */
export const accountsRouter = (deps: AccountsRoutesDeps): Router => {
  const controller = createAccountsController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...withSession, controller.list);
  router.post('/', ...withSession, validate(CreateAccountInput), controller.create);
  router.put('/order', ...withSession, validate(ReorderInput), controller.reorder);
  router.patch('/:id', ...withSession, validate(UpdateAccountInput), controller.update);
  router.delete('/:id', ...withSession, controller.remove);
  router.post('/:id/adjust', ...withSession, validate(AdjustInput), controller.adjust);
  router.post(
    '/:id/archive',
    ...withSession,
    validate(optionalBody(ArchiveInput)),
    controller.archive,
  );
  router.post(
    '/:id/restore',
    ...withSession,
    validate(optionalBody(RestoreInput)),
    controller.restore,
  );
  router.get('/:id/balance-series', ...withSession, controller.balanceSeries);

  return router;
};
