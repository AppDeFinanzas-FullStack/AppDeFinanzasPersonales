import type { Express } from 'express';
import { uuidv7 } from 'uuidv7';

import { createOutboxSend } from '../application/jobs/outbox.js';
import { createAuthService, type AuthService } from '../application/services/auth.service.js';
import { createJobs, type Jobs } from '../application/jobs/tick.js';
import type { Clock } from '../application/ports/clock.js';
import type { EmailGateway } from '../application/ports/email-gateway.js';
import type { IdGenerator } from '../application/ports/id-generator.js';
import type { Repositories } from '../application/ports/repositories.js';
import type { UnitOfWork } from '../application/ports/unit-of-work.js';
import { todayFor } from '../domain/index.js';
import type { Env } from '../infrastructure/config/env.js';
import { createBetterAuthGateway } from '../infrastructure/auth/better-auth.js';
import { ResendEmailGateway } from '../infrastructure/integrations/resend.js';
import { FakeEmailGateway } from '../infrastructure/integrations/resend.fake.js';
import { createJobRuns } from '../infrastructure/persistence/job-runs.js';
import {
  buildPrismaClient,
  type PrismaClient,
} from '../infrastructure/persistence/prisma-client.js';
import { createEmailLinkRepository } from '../infrastructure/persistence/repositories/email-link.repository.js';
import { createEmailOutboxRepository } from '../infrastructure/persistence/repositories/email-outbox.repository.js';
import { createLoginThrottleRepository } from '../infrastructure/persistence/repositories/login-throttle.repository.js';
import { createUserRepository } from '../infrastructure/persistence/repositories/user.repository.js';
import {
  createUnitOfWork,
  type TransactionClient,
} from '../infrastructure/persistence/unit-of-work.js';
import { createApp as createExpressApp } from '../presentation/app.js';

/**
 * Composition root (plan §1.4, ADR-19): the only place that knows every layer. It builds the
 * implementations of the application ports once and hands them to services and controllers.
 */
export interface Container {
  readonly env: Env;
  readonly prisma: PrismaClient;
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Job registry of the tick; each module registers its jobs here (plan §4.0). */
  readonly jobs: Jobs;
  readonly authService: AuthService;
}

/** System clock: the current instant, and today's date in the user's timezone (RN-07). */
const systemClock: Clock = {
  now: () => new Date(),
  todayFor: (timezone) => todayFor(timezone, new Date()),
};

/** UUID v7 ids, time ordered like the ones the clients generate (ADR-11). */
const uuidv7Ids: IdGenerator = {
  next: () => uuidv7(),
};

/** Sender of the account emails; the environment has no variable for it yet. */
const EMAIL_FROM = 'Finanzas <onboarding@resend.dev>';

/** Real Resend gateway, or the in-memory fake when the environment asks for fake integrations. */
const createEmailGateway = (env: Env): EmailGateway =>
  env.INTEGRATIONS === 'fake'
    ? new FakeEmailGateway()
    : new ResendEmailGateway({ apiKey: env.RESEND_API_KEY, from: EMAIL_FROM });

/** Repositories of one transaction; each module adds its own here (plan §1.4). */
const buildRepositories = (tx: TransactionClient): Repositories => ({
  emailOutbox: createEmailOutboxRepository(tx),
  emailLinks: createEmailLinkRepository(tx),
  loginThrottle: createLoginThrottleRepository(tx),
  users: createUserRepository(tx),
});

export const buildContainer = (env: Env): Container => {
  const prisma = buildPrismaClient(env);
  const uow = createUnitOfWork(prisma, buildRepositories);
  const jobs = createJobs({
    jobRuns: createJobRuns(prisma),
    clock: systemClock,
    release: env.RELEASE,
  });
  jobs.registerJob(
    'outbox.send',
    createOutboxSend({ uow, emailGateway: createEmailGateway(env), clock: systemClock }),
  );
  const authService = createAuthService({
    uow,
    auth: createBetterAuthGateway({ prisma, secret: env.AUTH_SECRET }),
    hmacSecret: env.HMAC_SECRET,
    webOrigin: env.WEB_ORIGIN,
  });
  return {
    env,
    prisma,
    uow,
    clock: systemClock,
    ids: uuidv7Ids,
    jobs,
    authService,
  };
};

export const createApp = (container: Container): Express =>
  createExpressApp({
    webOrigin: container.env.WEB_ORIGIN,
    jobs: { secret: container.env.JOBS_SECRET, jobs: container.jobs },
  });
