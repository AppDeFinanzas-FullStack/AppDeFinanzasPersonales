import {
  CreateShortcutInput,
  ReorderShortcutsInput,
  UpdateShortcutInput,
} from '@finanzas/contracts';
import { Router } from 'express';

import {
  createShortcutsController,
  type ShortcutsControllerDeps,
} from '../controllers/shortcuts.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface ShortcutsRoutesDeps extends ShortcutsControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/shortcuts` (plan §4.7.2). */
export const shortcutsRouter = (deps: ShortcutsRoutesDeps): Router => {
  const controller = createShortcutsController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...withSession, controller.list);
  router.post('/', ...withSession, validate(CreateShortcutInput), controller.create);
  router.put('/order', ...withSession, validate(ReorderShortcutsInput), controller.reorder);
  router.patch('/:id', ...withSession, validate(UpdateShortcutInput), controller.update);
  router.delete('/:id', ...withSession, controller.remove);

  return router;
};
