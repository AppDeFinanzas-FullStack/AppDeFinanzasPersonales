import type { Express } from 'express';
import { uuidv7 } from 'uuidv7';

import { createFxJobs } from '../application/jobs/fx.js';
import { createJobs, type Jobs } from '../application/jobs/tick.js';
import type { Clock } from '../application/ports/clock.js';
import type { IdGenerator } from '../application/ports/id-generator.js';
import type { Repositories } from '../application/ports/repositories.js';
import type { UnitOfWork } from '../application/ports/unit-of-work.js';
import { todayFor } from '../domain/index.js';
import type { Env } from '../infrastructure/config/env.js';
import { createFakeBcbGateway } from '../infrastructure/integrations/bcb.fake.js';
import { createBcbGateway } from '../infrastructure/integrations/bcb.js';
import { createFakeRatesGateway } from '../infrastructure/integrations/paralelo-bo.fake.js';
import { createParaleloBoGateway } from '../infrastructure/integrations/paralelo-bo.js';
import { createJobRuns } from '../infrastructure/persistence/job-runs.js';
import {
  buildPrismaClient,
  type PrismaClient,
} from '../infrastructure/persistence/prisma-client.js';
import { createCurrencyRepository } from '../infrastructure/persistence/repositories/currency.repository.js';
import { createMarketRateRepository } from '../infrastructure/persistence/repositories/market-rate.repository.js';
import { createUserFxEventRepository } from '../infrastructure/persistence/repositories/user-fx-event.repository.js';
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

/** Repositories of one transaction; each module adds its own here (plan §1.4). */
const NO_USER = '00000000-0000-0000-0000-000000000000';

const buildRepositories = (tx: TransactionClient, userId: string | undefined): Repositories => ({
  marketRates: createMarketRateRepository(tx),
  currencies: createCurrencyRepository(tx, userId ?? NO_USER),
  userFxEvents: createUserFxEventRepository(tx, userId ?? NO_USER),
});

const PARALELO_BO_URL = 'https://paralelo.bo/mcp';
const BCB_URL = 'https://www.bcb.gob.bo/bcb_tco_publico_ultima_cotizacion.php';
const SOURCE_TIMEOUT_MS = 10_000;

/** Real sources (paralelo.bo and the BCB) or their fakes, by `env.INTEGRATIONS` (plan §1.4). */
const buildRateSources = (env: Env) =>
  env.INTEGRATIONS === 'real'
    ? {
        rates: createParaleloBoGateway({ url: PARALELO_BO_URL, timeoutMs: SOURCE_TIMEOUT_MS }),
        bcb: createBcbGateway({ url: BCB_URL, timeoutMs: SOURCE_TIMEOUT_MS }),
      }
    : { rates: createFakeRatesGateway(), bcb: createFakeBcbGateway() };

export const buildContainer = (env: Env): Container => {
  const prisma = buildPrismaClient(env);
  const jobRuns = createJobRuns(prisma);
  const uow = createUnitOfWork(prisma, buildRepositories);
  const jobs = createJobs({ jobRuns, clock: systemClock, release: env.RELEASE });
  const fxJobs = createFxJobs({ ...buildRateSources(env), uow, jobRuns, clock: systemClock });
  jobs.registerJob('fx.fetchParallel', () => fxJobs.fetchParallel());
  jobs.registerJob('fx.fetchOfficial', () => fxJobs.fetchOfficial());
  return { env, prisma, uow, clock: systemClock, ids: uuidv7Ids, jobs };
};

export const createApp = (container: Container): Express =>
  createExpressApp({
    webOrigin: container.env.WEB_ORIGIN,
    jobs: { secret: container.env.JOBS_SECRET, jobs: container.jobs },
  });
