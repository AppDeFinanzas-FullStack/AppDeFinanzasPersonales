import { NotificationType, Uuid } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import { Router } from 'express';
import { z } from 'zod';

import { AppError } from '../../application/errors.js';
import type { RateFailure } from '../../application/ports/rates-gateway.js';
import { validate } from '../middlewares/validate.js';

/** Credentials of a user created for the end-to-end tests. */
export interface TestUserCredentials {
  email: string;
  password: string;
}

/** Rates of the fake sources as decimal text (ADR-03); a missing field keeps its value. */
export interface TestRatesInput {
  bid?: string | undefined;
  ask?: string | undefined;
  median?: string | undefined;
  official?: string | undefined;
  /** A failure of the source, or `null` to clear it. */
  failure?: RateFailure | null | undefined;
}

/** A notification created for a user of the end-to-end tests (plan §3.7, §4.15.3). */
export interface TestNotificationInput {
  /** The email of the user that receives it. */
  email: string;
  type: NotificationType;
  eventKey: string;
  params: Record<string, unknown>;
  targetRoute: string;
  decision?: { kind: 'budget_period' | 'occurrence'; ref: string } | undefined;
}

export interface TestSupportControllerDeps {
  /** The emails the fake gateway holds for that recipient. */
  mailbox: (to: string) => readonly unknown[];
  /** Creates a confirmed user with the Onboarding finished. */
  createUser: () => Promise<TestUserCredentials>;
  /** Sets the fake rate sources and forces the capture of the parallel rates. */
  setRates: (input: TestRatesInput) => Promise<void>;
  /** Creates an in-app notification for the user with that email. */
  createNotification: (input: TestNotificationInput) => Promise<void>;
}

const RATE_FORMAT = /^\d{1,12}(\.\d{1,2})?$/;
const MIN_RATE = '0.01';

// Zod 4 keeps running refinements after a failed regex, and Decimal throws on garbage,
// so the minimum is only checked when the format is valid.
const TestRate = z
  .string()
  .regex(RATE_FORMAT)
  .refine((v) => RATE_FORMAT.test(v) && new Decimal(v).gte(MIN_RATE));

const RATE_FAILURES = [
  'TIMEOUT',
  'INVALID_VALUE',
  'SOURCE_ERROR',
] as const satisfies readonly RateFailure[];

const TestRatesBody = z.object({
  bid: TestRate.optional(),
  ask: TestRate.optional(),
  median: TestRate.optional(),
  official: TestRate.optional(),
  failure: z.enum(RATE_FAILURES).nullable().optional(),
});

const TestNotificationBody = z.object({
  email: z.string().trim().toLowerCase().min(1),
  type: NotificationType,
  eventKey: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).default({}),
  targetRoute: z.string().regex(/^\/(?!\/)/),
  decision: z.object({ kind: z.enum(['budget_period', 'occurrence']), ref: Uuid }).optional(),
});

/**
 * `/internal/test/*` (plan §1.5): mounted only with `INTEGRATIONS=fake`, so the end-to-end suite can
 * read the confirmation links, get ready-to-use users, fix the exchange rates and create notifications.
 */
export const testSupportRouter = ({
  mailbox,
  createUser,
  setRates,
  createNotification,
}: TestSupportControllerDeps): Router => {
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
  router.post('/rates', validate(TestRatesBody), async (req, res) => {
    await setRates(req.body as TestRatesInput);
    res.status(204).end();
  });
  router.post('/notifications', validate(TestNotificationBody), async (req, res) => {
    await createNotification(req.body as TestNotificationInput);
    res.status(201).end();
  });
  return router;
};
