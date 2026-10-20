import { Router } from 'express';

export const healthRouter = (): Router => {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.status(204).end();
  });
  return router;
};
