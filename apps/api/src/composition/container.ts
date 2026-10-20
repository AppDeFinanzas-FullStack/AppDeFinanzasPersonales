import type { Express } from 'express';
import { uuidv7 } from 'uuidv7';

import { createMaintenance } from '../application/jobs/maintenance.js';
import { createOutboxSend } from '../application/jobs/outbox.js';
import type { AuthGateway } from '../application/ports/auth-gateway.js';
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
import { createMaintenanceStore } from '../infrastructure/persistence/maintenance-store.js';
import {
  buildPrismaClient,
  type PrismaClient,
} from '../infrastructure/persistence/prisma-client.js';
import { createEmailLinkRepository } from '../infrastructure/persistence/repositories/email-link.repository.js';
import { createEmailOutboxRepository } from '../infrastructure/persistence/repositories/email-outbox.repository.js';
import { createEmailSendLogRepository } from '../infrastructure/persistence/repositories/email-send-log.repository.js';
import { createLoginThrottleRepository } from '../infrastructure/persistence/repositories/login-throttle.repository.js';
import { createUserRepository } from '../infrastructure/persistence/repositories/user.repository.js';
import {
  createUnitOfWork,
  type TransactionClient,
} from '../infrastructure/persistence/unit-of-work.js';
import { createApp as createExpressApp } from '../presentation/app.js';
import type { MeReader } from '../presentation/controllers/auth.controller.js';
import type { MeProfile } from '../presentation/presenters/me.presenter.js';
import type { SessionActivity } from '../presentation/middlewares/require-session.js';

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
  readonly auth: AuthGateway;
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
  emailSendLog: createEmailSendLogRepository(tx),
  loginThrottle: createLoginThrottleRepository(tx),
  users: createUserRepository(tx),
});

/** Activity of the sessions, read and renewed by `requireSession` and `trackActivity`. */
const createSessionActivity = (prisma: PrismaClient) => ({
  async findActivity(sessionId: string): Promise<SessionActivity | null> {
    const rows = await prisma.$queryRaw<SessionActivity[]>`
      SELECT s.last_activity_at AS "lastActivityAt", u.timezone AS timezone
        FROM auth_session s
        JOIN auth_user u ON u.id = s.user_id
       WHERE s.id = ${sessionId}::uuid`;
    return rows[0] ?? null;
  },
  async touch(sessionId: string, at: Date): Promise<void> {
    await prisma.$executeRaw`
      UPDATE auth_session SET last_activity_at = ${at} WHERE id = ${sessionId}::uuid`;
  },
});

/** The profile of the user behind a session, for the `MeDto` of the answers. */
const createMeReader = (prisma: PrismaClient): MeReader => ({
  async findBySession(sessionId) {
    const rows = await prisma.$queryRaw<MeProfile[]>`
      SELECT u.id::text AS id, u.name AS name, u.email AS email, u.timezone AS timezone,
             COALESCE(st.onboarding_step, 1)::int AS "onboardingStep",
             (st.onboarding_completed_at IS NOT NULL) AS "onboardingCompleted"
        FROM auth_session s
        JOIN auth_user u ON u.id = s.user_id
        LEFT JOIN user_settings st ON st.user_id = u.id
       WHERE s.id = ${sessionId}::uuid`;
    return rows[0] ?? null;
  },
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
  jobs.registerJob(
    'maintenance',
    createMaintenance({ store: createMaintenanceStore(prisma), clock: systemClock }),
  );
  const auth = createBetterAuthGateway({ prisma, secret: env.AUTH_SECRET });
  const authService = createAuthService({
    uow,
    auth,
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
    auth,
    authService,
  };
};

export const createApp = (container: Container): Express =>
  createExpressApp({
    webOrigin: container.env.WEB_ORIGIN,
    jobs: { secret: container.env.JOBS_SECRET, jobs: container.jobs },
    auth: {
      authService: container.authService,
      sessions: container.auth,
      me: createMeReader(container.prisma),
      release: container.env.RELEASE,
      session: {
        auth: container.auth,
        sessions: createSessionActivity(container.prisma),
        clock: container.clock,
      },
    },
  });
