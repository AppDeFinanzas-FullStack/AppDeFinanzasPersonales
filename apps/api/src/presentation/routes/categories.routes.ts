import {
  CreateCategoryInput,
  MergeInput,
  ReorderCategoriesInput,
  RestoreCategoryInput,
  UpdateCategoryInput,
} from '@finanzas/contracts';
import { Router } from 'express';

import {
  createCategoriesController,
  type CategoriesControllerDeps,
} from '../controllers/categories.controller.js';
import { requireSession, type RequireSessionDeps } from '../middlewares/require-session.js';
import { trackActivity, type TrackActivityDeps } from '../middlewares/track-activity.js';
import { validate } from '../middlewares/validate.js';

export interface CategoriesRoutesDeps extends CategoriesControllerDeps {
  session: RequireSessionDeps & TrackActivityDeps;
}

/** `/api/categories` (plan §4.5.2). */
export const categoriesRouter = (deps: CategoriesRoutesDeps): Router => {
  const controller = createCategoriesController(deps);
  const withSession = [requireSession(deps.session), trackActivity(deps.session)];
  const router = Router();

  router.get('/', ...withSession, controller.list);
  router.post('/', ...withSession, validate(CreateCategoryInput), controller.create);
  router.put('/order', ...withSession, validate(ReorderCategoriesInput), controller.reorder);
  router.get('/merge-preview', ...withSession, controller.mergePreview);
  router.post('/merge', ...withSession, validate(MergeInput), controller.merge);
  router.patch('/:id', ...withSession, validate(UpdateCategoryInput), controller.update);
  router.delete('/:id', ...withSession, controller.remove);
  router.get('/:id/archive-impact', ...withSession, controller.archiveImpact);
  router.post('/:id/archive', ...withSession, controller.archive);
  router.post('/:id/restore', ...withSession, validate(RestoreCategoryInput), controller.restore);

  return router;
};
