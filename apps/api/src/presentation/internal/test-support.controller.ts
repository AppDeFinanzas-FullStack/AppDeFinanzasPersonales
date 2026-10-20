import { Router } from 'express';

import { AppError } from '../../application/errors.js';

/** Credentials of a user created for the end-to-end tests. */
export interface TestUserCredentials {
  email: string;
  password: string;
}

export interface TestSupportControllerDeps {
  /** The emails the fake gateway holds for that recipient. */
  mailbox: (to: string) => readonly unknown[];
  /** Creates a confirmed user with the Onboarding finished. */
  createUser: () => Promise<TestUserCredentials>;
}

/**
 * `/internal/test/*` (plan §1.5): mounted only with `INTEGRATIONS=fake`, so the end-to-end suite can
 * read the confirmation links and get ready-to-use users.
 */
export const testSupportRouter = ({ mailbox, createUser }: TestSupportControllerDeps): Router => {
  const router = Router();
  router.get('/mailbox', (req, res) => {
    const to = req.query['to'];
    if (typeof to !== 'string' || to === '') {
      throw new AppError('VALIDATION_ERROR', { issues: [{ path: 'to', code: 'invalid_type' }] });
    }
    res.status(200).json(mailbox(to));
  });
  router.post('/users', async (_req, res) => {
    res.status(201).json(await createUser());
  });
  return router;
};
