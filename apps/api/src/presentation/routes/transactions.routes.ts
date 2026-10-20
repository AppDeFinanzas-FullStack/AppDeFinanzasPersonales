import {
  BatchDeleteInput,
  BatchRecategorizeInput,
  CreateTransactionInput,
  UndoInput,
  UpdateTransactionInput,
} from '@finanzas/contracts';
import { Router } from 'express';

import {
  createTransactionsController,
  type TransactionsControllerDeps,
} from '../controllers/transactions.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface TransactionsRoutesDeps extends TransactionsControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/transactions` (plan §4.6.2); the fixed paths go before `/:id`. */
export const transactionsRouter = (deps: TransactionsRoutesDeps): Router => {
  const controller = createTransactionsController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...withSession, controller.list);
  router.get('/summary', ...withSession, controller.summary);
  router.post('/', ...withSession, validate(CreateTransactionInput), controller.create);
  router.post('/undo', ...withSession, validate(UndoInput), controller.undo);
  router.post('/batch-delete', ...withSession, validate(BatchDeleteInput), controller.batchDelete);
  router.post(
    '/batch-recategorize',
    ...withSession,
    validate(BatchRecategorizeInput),
    controller.batchRecategorize,
  );
  router.get('/:id', ...withSession, controller.get);
  router.patch('/:id', ...withSession, validate(UpdateTransactionInput), controller.update);
  router.delete('/:id', ...withSession, controller.remove);

  return router;
};
