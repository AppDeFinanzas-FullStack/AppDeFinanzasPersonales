import { randomUUID } from 'node:crypto';

import type { RateHistoryQuery } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import type { Express } from 'express';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../application/errors.js';
import { createBudgetsJobs } from '../application/jobs/budgets.js';
import { createMaintenance } from '../application/jobs/maintenance.js';
import {
  createScheduledNotifications,
  type ScheduledUser,
  type ScheduledUsers,
} from '../application/jobs/notifications.js';
import { createOutboxSend } from '../application/jobs/outbox.js';
import { createRecurringJobs, type RecurringUsers } from '../application/jobs/recurring.js';
import type { AuthGateway } from '../application/ports/auth-gateway.js';
import { createAuthService, type AuthService } from '../application/services/auth.service.js';
import { createExportService, type ExportService } from '../application/services/export.service.js';
import {
  createMeService,
  type MeService,
  type MeStore,
} from '../application/services/me.service.js';
import { createFxJobs, type FxJobs } from '../application/jobs/fx.js';
import {
  createCurrenciesService,
  type CurrenciesService,
} from '../application/services/currencies.service.js';
import {
  createFxSettingsService,
  type FxSettingsService,
} from '../application/services/fx-settings.service.js';
import { createRatesService, type RatesService } from '../application/services/rates.service.js';
import {
  createShortcutsService,
  type ShortcutsService,
} from '../application/services/shortcuts.service.js';
import { createDebtsService, type DebtsService } from '../application/services/debts.service.js';
import {
  createBudgetsService,
  type BudgetsService,
} from '../application/services/budgets.service.js';
import { createGoalsService, type GoalsService } from '../application/services/goals.service.js';
import {
  createRecurringService,
  type RecurringService,
} from '../application/services/recurring.service.js';
import {
  createAccountsService,
  type AccountsService,
} from '../application/services/accounts.service.js';
import {
  createCategoriesService,
  type CategoriesService,
} from '../application/services/categories.service.js';
import {
  createDashboardService,
  createDashboardViewService,
  type DashboardViewService,
} from '../application/services/dashboard.service.js';
import {
  createOnboardingService,
  type OnboardingService,
} from '../application/services/onboarding.service.js';
import {
  createSettingsService,
  type SettingsService,
} from '../application/services/settings.service.js';
import {
  createRegisterService,
  type RegisterService,
  type RegisterUsageReader,
} from '../application/services/register.service.js';
import {
  createNotificationPreferencesService,
  createNotificationsService,
  type NotificationPreferencesService,
  type NotificationRecord,
  type NotificationsService,
  type NotificationsStore,
} from '../application/services/notifications.service.js';
import {
  createTransactionsService,
  type TransactionsService,
} from '../application/services/transactions.service.js';
import { createJobs, type Jobs } from '../application/jobs/tick.js';
import type { Clock } from '../application/ports/clock.js';
import type { EmailGateway } from '../application/ports/email-gateway.js';
import type { IdGenerator } from '../application/ports/id-generator.js';
import type { QueryCounter } from '../application/ports/query-counter.js';
import type { ReadinessProbe } from '../application/ports/readiness.js';
import type { Repositories } from '../application/ports/repositories.js';
import type { UnitOfWork } from '../application/ports/unit-of-work.js';
import { createBudgetLedgerHook } from '../application/shared/budget-ledger-hook.js';
import {
  createGoalMilestones,
  type GoalNoticeUser,
  type GoalNoticeUsers,
} from '../application/shared/goal-milestones.js';
import { createLedgerHooks, type LedgerHooks } from '../application/shared/ledger-hooks.js';
import { createNotificationEmitter } from '../application/shared/notification-emitter.js';
import {
  createRecurringGenerator,
  type RecurringGenerator,
} from '../application/shared/recurring-generator.js';
import { bootstrapUser } from '../application/shared/user-bootstrap.js';
import { todayFor, type LocalDate } from '../domain/index.js';
import type { Env } from '../infrastructure/config/env.js';
import { createBetterAuthGateway } from '../infrastructure/auth/better-auth.js';
import { ResendEmailGateway } from '../infrastructure/integrations/resend.js';
import { FakeEmailGateway } from '../infrastructure/integrations/resend.fake.js';
import {
  createFakeBcbGateway,
  type FakeBcbGateway,
} from '../infrastructure/integrations/bcb.fake.js';
import { createBcbGateway } from '../infrastructure/integrations/bcb.js';
import {
  createFakeRatesGateway,
  type FakeRatesGateway,
} from '../infrastructure/integrations/paralelo-bo.fake.js';
import { createParaleloBoGateway } from '../infrastructure/integrations/paralelo-bo.js';
import { createZipStream } from '../infrastructure/export/csv-zip.js';
import { createJobRuns } from '../infrastructure/persistence/job-runs.js';
import { createMaintenanceStore } from '../infrastructure/persistence/maintenance-store.js';
import {
  buildPrismaClient,
  type PrismaClient,
} from '../infrastructure/persistence/prisma-client.js';
import { createQueryCounter } from '../infrastructure/persistence/query-counter.js';
import { createReadinessProbe } from '../infrastructure/persistence/readiness.js';
import { createEmailLinkRepository } from '../infrastructure/persistence/repositories/email-link.repository.js';
import { createEmailOutboxRepository } from '../infrastructure/persistence/repositories/email-outbox.repository.js';
import { createEmailSendLogRepository } from '../infrastructure/persistence/repositories/email-send-log.repository.js';
import { createLoginThrottleRepository } from '../infrastructure/persistence/repositories/login-throttle.repository.js';
import { createUserSettingsRepository } from '../infrastructure/persistence/repositories/user-settings.repository.js';
import { createUserRepository } from '../infrastructure/persistence/repositories/user.repository.js';
import { createCurrencyRepository } from '../infrastructure/persistence/repositories/currency.repository.js';
import { createMarketRateRepository } from '../infrastructure/persistence/repositories/market-rate.repository.js';
import { createUserFxEventRepository } from '../infrastructure/persistence/repositories/user-fx-event.repository.js';
import { createAccountRepository } from '../infrastructure/persistence/repositories/account.repository.js';
import { createLedgerRepository } from '../infrastructure/persistence/repositories/ledger.repository.js';
import { createCategoryRepository } from '../infrastructure/persistence/repositories/category.repository.js';
import { createShortcutRepository } from '../infrastructure/persistence/repositories/shortcut.repository.js';
import {
  createDashboardExpenseReader,
  createDashboardRepository,
} from '../infrastructure/persistence/repositories/dashboard.repository.js';
import { createExportRepository } from '../infrastructure/persistence/repositories/export.repository.js';
import { createNotificationRepository } from '../infrastructure/persistence/repositories/notification.repository.js';
import { createNotificationPreferenceRepository } from '../infrastructure/persistence/repositories/notification-preference.repository.js';
import { createRecurringOccurrenceRepository } from '../infrastructure/persistence/repositories/recurring-occurrence.repository.js';
import { createRecurringRuleRepository } from '../infrastructure/persistence/repositories/recurring-rule.repository.js';
import { createBudgetPeriodRepository } from '../infrastructure/persistence/repositories/budget-period.repository.js';
import { createBudgetRepository } from '../infrastructure/persistence/repositories/budget.repository.js';
import { createGoalAllocationRepository } from '../infrastructure/persistence/repositories/goal-allocation.repository.js';
import { createGoalRepository } from '../infrastructure/persistence/repositories/goal.repository.js';
import { createUndoActionRepository } from '../infrastructure/persistence/repositories/undo-action.repository.js';
import { createDebtRepository } from '../infrastructure/persistence/repositories/debt.repository.js';
import { createDebtPaymentRepository } from '../infrastructure/persistence/repositories/debt-payment.repository.js';
import {
  createUnitOfWork,
  type TransactionClient,
} from '../infrastructure/persistence/unit-of-work.js';
import { createApp as createExpressApp } from '../presentation/app.js';
import type {
  TestNotificationInput,
  TestRatesInput,
  TestSupportControllerDeps,
  TestUserCredentials,
} from '../presentation/internal/test-support.controller.js';
import type { MeReader } from '../presentation/controllers/auth.controller.js';
import type { BalanceSeriesReader } from '../presentation/controllers/accounts.controller.js';
import type { CategoryTreeReader } from '../presentation/controllers/categories.controller.js';
import type { RateHistoryReader } from '../presentation/controllers/fx.controller.js';
import type { MeProfile } from '../presentation/presenters/me.presenter.js';
import type { SessionRecord } from '../presentation/middlewares/require-session.js';

/**
 * Composition root (plan §1.4, ADR-19): the only place that knows every layer. It builds the
 * implementations of the application ports once and hands them to services and controllers.
 */
export interface Container {
  readonly env: Env;
  readonly prisma: PrismaClient;
  readonly uow: UnitOfWork;
  /** Operations and database time of each request, for `Server-Timing` (plan §4.0). */
  readonly queryCounter: QueryCounter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Job registry of the tick; each module registers its jobs here (plan §4.0). */
  readonly jobs: Jobs;
  /** Reactions to ledger changes; each module registers its handler here (plan §4.0). */
  readonly ledgerHooks: LedgerHooks;
  /** The occurrences of the recurring rules, generated in the caller's transaction (plan §4.14.3). */
  readonly recurringGenerator: RecurringGenerator;
  readonly auth: AuthGateway;
  readonly authService: AuthService;
  readonly meService: MeService;
  /** The ZIP of `GET /api/me/export` (plan §4.1.2). */
  readonly exportService: ExportService;
  readonly settingsService: SettingsService;
  readonly ratesService: RatesService;
  readonly fxSettingsService: FxSettingsService;
  readonly currenciesService: CurrenciesService;
  readonly accountsService: AccountsService;
  /** The budgets of `/api/budgets` (plan §4.11.2). */
  readonly budgetsService: BudgetsService;
  /** The goals of `/api/goals` (plan §4.12.2). */
  readonly goalsService: GoalsService;
  /** The rules and occurrences of `/api/recurring` (plan §4.14.2). */
  readonly recurringService: RecurringService;
  /** The debts of `/api/debts` (plan §4.13.2). */
  readonly debtsService: DebtsService;
  readonly shortcutsService: ShortcutsService;
  readonly categoriesService: CategoriesService;
  /** The category tree of `GET /api/categories` (plan §4.5.2). */
  readonly categoryTree: CategoryTreeReader;
  readonly transactionsService: TransactionsService;
  readonly registerService: RegisterService;
  /** The blocks of `GET /api/dashboard` (plan §4.8.2). */
  readonly dashboardService: DashboardViewService;
  /** The steps of `/api/onboarding` (plan §4.10.2). */
  readonly onboardingService: OnboardingService;
  /** The inbox of `/api/notifications` (plan §4.15.2). */
  readonly notificationsService: NotificationsService;
  /** The configuration of `/api/notification-preferences` (plan §4.15.2). */
  readonly notificationPreferencesService: NotificationPreferencesService;
  /** Daily balances of `GET /api/accounts/:id/balance-series` (plan §4.4.2). */
  readonly balanceSeries: BalanceSeriesReader;
  /** Daily rows of `GET /api/rates/history` (plan §4.3.2). */
  readonly rateHistory: RateHistoryReader;
  /** Starts `fx.fetchParallel` in the background, at most one at a time (RNF-04, RF-M3-04). */
  readonly refreshParallel: () => void;

  /** Test-support routes (plan §1.5); `null` unless `INTEGRATIONS=fake`. */
  readonly testSupport: TestSupportControllerDeps | null;
  /** Database check of `GET /api/health/ready` (plan §4.2.2). */
  readonly readiness: ReadinessProbe;
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

/** Real Resend gateway, or the in-memory fake when the environment asks for fake integrations. */
const createEmailGateway = (env: Env, fake: FakeEmailGateway | null): EmailGateway =>
  fake ?? new ResendEmailGateway({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });

/** Repositories of one transaction; each module adds its own here (plan §1.4). */
const NO_USER = '00000000-0000-0000-0000-000000000000';

const buildRepositories = (tx: TransactionClient, userId: string | undefined): Repositories => ({
  emailOutbox: createEmailOutboxRepository(tx),
  emailLinks: createEmailLinkRepository(tx),
  emailSendLog: createEmailSendLogRepository(tx),
  loginThrottle: createLoginThrottleRepository(tx),
  users: createUserRepository(tx),
  marketRates: createMarketRateRepository(tx),
  currencies: createCurrencyRepository(tx, userId ?? NO_USER),
  userFxEvents: createUserFxEventRepository(tx, userId ?? NO_USER),
  accounts: createAccountRepository(tx, userId ?? NO_USER),
  ledger: createLedgerRepository(tx, userId ?? NO_USER),
  undoActions: createUndoActionRepository(tx, userId ?? NO_USER),
  categories: createCategoryRepository(tx, userId ?? NO_USER),
  userSettings: createUserSettingsRepository(tx),
  shortcuts: createShortcutRepository(tx, userId ?? NO_USER),
  dashboard: createDashboardRepository(tx, userId ?? NO_USER),
  exports: createExportRepository(tx, userId ?? NO_USER),
  notifications: createNotificationRepository(tx),
  notificationPreferences: createNotificationPreferenceRepository(tx),
  recurringRules: createRecurringRuleRepository(tx, userId ?? NO_USER),
  recurringOccurrences: createRecurringOccurrenceRepository(tx, userId ?? NO_USER),
  debts: createDebtRepository(tx, userId ?? NO_USER),
  debtPayments: createDebtPaymentRepository(tx, userId ?? NO_USER),
  goals: createGoalRepository(tx, userId ?? NO_USER),
  goalAllocations: createGoalAllocationRepository(tx, userId ?? NO_USER),
  budgets: createBudgetRepository(tx, userId ?? NO_USER),
  budgetPeriods: createBudgetPeriodRepository(tx, userId ?? NO_USER),
});

const PARALELO_BO_URL = 'https://paralelo.bo/mcp';
const BCB_URL = 'https://www.bcb.gob.bo/bcb_tco_publico_ultima_cotizacion.php';
const SOURCE_TIMEOUT_MS = 10_000;

interface FakeRateSources {
  rates: FakeRatesGateway;
  bcb: FakeBcbGateway;
}

/**
 * Real sources (paralelo.bo and the BCB) or their fakes, by `env.INTEGRATIONS` (plan §1.4). The
 * fakes are also returned in `fake`, so the test-support routes can set them.
 */
const buildRateSources = (env: Env) => {
  if (env.INTEGRATIONS === 'real') {
    return {
      rates: createParaleloBoGateway({ url: PARALELO_BO_URL, timeoutMs: SOURCE_TIMEOUT_MS }),
      bcb: createBcbGateway({ url: BCB_URL, timeoutMs: SOURCE_TIMEOUT_MS }),
      fake: null,
    };
  }
  const fake: FakeRateSources = { rates: createFakeRatesGateway(), bcb: createFakeBcbGateway() };
  return { rates: fake.rates, bcb: fake.bcb, fake };
};

/**
 * `POST /internal/test/rates` (plan §1.5): sets the fake sources and forces `fx.fetchParallel`. A
 * missing rate keeps its last value; `failure` makes paralelo.bo fail until it is set to `null`.
 */
const createTestRatesSetter = (deps: { fake: FakeRateSources; fxJobs: FxJobs; clock: Clock }) => {
  let current: TestRatesInput = {};
  return async (input: TestRatesInput): Promise<void> => {
    current = {
      bid: input.bid ?? current.bid,
      ask: input.ask ?? current.ask,
      median: input.median ?? current.median,
      official: input.official ?? current.official,
      failure: input.failure === undefined ? current.failure : input.failure,
    };
    const observedAt = deps.clock.now();
    const decimal = (value: string | undefined) =>
      value === undefined ? null : new Decimal(value);
    const median = decimal(current.median);
    deps.fake.rates.configure({
      failure: current.failure ?? null,
      ...(median === null
        ? {}
        : {
            parallel: {
              median,
              bid: decimal(current.bid),
              ask: decimal(current.ask),
              observedAt,
            },
          }),
    });
    const official = decimal(current.official);
    if (official !== null) {
      const quote = { value: official, effectiveDate: null, observedAt };
      deps.fake.rates.configure({ official: quote });
      deps.fake.bcb.configure({ official: quote });
    }
    await deps.fxJobs.fetchParallel({ force: true });
  };
};

const HISTORY_DAYS: Record<RateHistoryQuery['range'], number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

/** The date `days` days before `date`, on the calendar (no timezone involved). */
const daysBefore = (date: LocalDate, days: number): LocalDate =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** One row per day of the range, ending today in the user's timezone (RN-07). */
const createRateHistoryReader = (uow: UnitOfWork): RateHistoryReader => ({
  daily(query, timezone, now) {
    const to = todayFor(timezone, now);
    const from = daysBefore(to, HISTORY_DAYS[query.range] - 1);
    return uow.run((repos) => repos.marketRates.series(query.kind, from, to), { readOnly: true });
  },
});

/** The row of the composite query of Registrar; `json` columns come already parsed. */
interface RegisterUsageRecord {
  categoryUses: { categoryId: string; uses: number; lastUsedAt: string }[];
  seeded: string[];
  lastExpense: string | null;
  lastIncome: string | null;
  lastTransfer: { from: string; to: string } | null;
}

/**
 * The reads of Registrar (plan §4.7.2): one composite query for the grid and the preselected
 * accounts, always bound to the user (RN-09). Uses count the live movements of the last 60 days by
 * exact category; the last account is the one of the last movement created of each kind. The
 * preloaded categories come in their order: each main one followed by its own subcategories.
 */
const createRegisterUsageReader = (prisma: PrismaClient): RegisterUsageReader => ({
  async read(userId, today) {
    const rows = await prisma.$queryRaw<RegisterUsageRecord[]>`
      SELECT
        (SELECT COALESCE(json_agg(json_build_object(
                  'categoryId', u.category_id::text, 'uses', u.uses, 'lastUsedAt', u.last_used)),
                '[]'::json)
           FROM (SELECT t.category_id, count(*)::int AS uses, max(t.created_at) AS last_used
                   FROM ledger_transaction t
                  WHERE t.user_id = ${userId}::uuid AND t.deleted_at IS NULL
                    AND t.kind IN ('expense', 'income') AND t.category_id IS NOT NULL
                    AND t.date > ${today}::date - 60
                  GROUP BY t.category_id) u) AS "categoryUses",
        (SELECT COALESCE(json_agg(s.id::text ORDER BY s.root_order, s.is_child, s.seed_order),
                         '[]'::json)
           FROM (SELECT c.id, c.seed_order, (c.parent_id IS NOT NULL) AS is_child,
                        COALESCE(p.seed_order, c.seed_order) AS root_order
                   FROM category c
                   LEFT JOIN category p ON p.user_id = c.user_id AND p.id = c.parent_id
                  WHERE c.user_id = ${userId}::uuid AND c.seed_order IS NOT NULL
                    AND c.status = 'active') s) AS seeded,
        (SELECT e.account_id::text
           FROM ledger_transaction t
           JOIN ledger_entry e ON e.user_id = t.user_id AND e.transaction_id = t.id
          WHERE t.user_id = ${userId}::uuid AND t.deleted_at IS NULL AND t.kind = 'expense'
          ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS "lastExpense",
        (SELECT e.account_id::text
           FROM ledger_transaction t
           JOIN ledger_entry e ON e.user_id = t.user_id AND e.transaction_id = t.id
          WHERE t.user_id = ${userId}::uuid AND t.deleted_at IS NULL AND t.kind = 'income'
          ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS "lastIncome",
        (SELECT json_build_object('from', o.account_id::text, 'to', i.account_id::text)
           FROM ledger_transaction t
           JOIN ledger_entry o ON o.user_id = t.user_id AND o.transaction_id = t.id AND o.amount < 0
           JOIN ledger_entry i ON i.user_id = t.user_id AND i.transaction_id = t.id AND i.amount > 0
          WHERE t.user_id = ${userId}::uuid AND t.deleted_at IS NULL AND t.kind = 'transfer'
          ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS "lastTransfer"`;
    const row = rows[0];
    return {
      categoryUses: (row?.categoryUses ?? []).map((use) => ({
        categoryId: use.categoryId,
        uses: use.uses,
        lastUsedAt: new Date(use.lastUsedAt),
      })),
      seeded: row?.seeded ?? [],
      lastAccount: { expense: row?.lastExpense ?? null, income: row?.lastIncome ?? null },
      lastTransfer: row?.lastTransfer ?? null,
    };
  },

  async createdSince(userId, since, limit) {
    // A fee is shown with its transfer, not on its own (RF-M6-05).
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id::text AS id
        FROM ledger_transaction t
       WHERE t.user_id = ${userId}::uuid AND t.deleted_at IS NULL AND t.origin <> 'fee'
         AND t.created_at >= ${since}::timestamptz
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ${limit}::int`;
    return rows.map((row) => row.id);
  },
});

/** The user's category tree of a kind and status. */
const createCategoryTreeReader = (uow: UnitOfWork): CategoryTreeReader => ({
  tree(userId, kind, status) {
    return uow.run((repos) => repos.categories.tree(kind, status), {
      userLock: userId,
      readOnly: true,
    });
  },
});

/** Daily balances of one of the user's accounts; `null` when the user has no such account. */
const createBalanceSeriesReader = (uow: UnitOfWork): BalanceSeriesReader => ({
  daily(userId, accountId, from, to) {
    return uow.run(
      async (repos) =>
        (await repos.accounts.get(accountId)) === null
          ? null
          : repos.ledger.balanceSeries(accountId, from, to),
      { userLock: userId, readOnly: true },
    );
  },
});

/** Runs `fx.fetchParallel` on demand without waiting for it; a run in flight is not repeated. */
const createParallelRefresher = (fxJobs: FxJobs): (() => void) => {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    fxJobs
      .fetchParallel({ force: true })
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
};

/** The users the recurring jobs walk and their timezone (plan §4.14.3, RNF-20). */
const createRecurringUsers = (prisma: PrismaClient): RecurringUsers => ({
  async withActiveRules() {
    const rows = await prisma.$queryRaw<{ userId: string }[]>`
      SELECT DISTINCT user_id::text AS "userId"
        FROM recurring_rule
       WHERE status = 'active'
       ORDER BY "userId"`;
    return rows.map((row) => row.userId);
  },
  async withExpiredPending(before) {
    const rows = await prisma.$queryRaw<{ userId: string }[]>`
      SELECT DISTINCT user_id::text AS "userId"
        FROM recurring_occurrence
       WHERE status = 'pending' AND pending_since < ${before}::timestamptz
       ORDER BY "userId"`;
    return rows.map((row) => row.userId);
  },
  async timezoneOf(userId) {
    const rows = await prisma.$queryRaw<{ timezone: string }[]>`
      SELECT timezone FROM auth_user WHERE id = ${userId}::uuid`;
    return rows[0]?.timezone ?? null;
  },
});

/** The users the `notifications.scheduled` job walks, with the timezone of their profile. */
const createScheduledUsers = (prisma: PrismaClient): ScheduledUsers => ({
  all: () =>
    prisma.$queryRaw<ScheduledUser[]>`
      SELECT id::text AS id, timezone FROM auth_user WHERE email_verified ORDER BY id`,
  async find(userId) {
    const rows = await prisma.$queryRaw<ScheduledUser[]>`
      SELECT id::text AS id, timezone FROM auth_user
       WHERE id = ${userId}::uuid AND email_verified`;
    return rows[0] ?? null;
  },
});

/**
 * The users the hourly rates job evaluates goal milestones for: the ones with goal notices turned
 * on and a goal that is not archived (plan §4.12.3).
 */
const createGoalNoticeUsers = (prisma: PrismaClient): GoalNoticeUsers => ({
  withGoalNotices: () =>
    prisma.$queryRaw<GoalNoticeUser[]>`
      SELECT u.id::text AS id, u.timezone
        FROM auth_user u
       WHERE EXISTS (SELECT 1 FROM notification_preference p
                      WHERE p.user_id = u.id AND p.type = 'goal_progress'::notification_type
                        AND p.enabled)
         AND EXISTS (SELECT 1 FROM goal g WHERE g.user_id = u.id AND g.archived_at IS NULL)
       ORDER BY u.id`,
});

/** The sessions, resolved by `requireSession` in one statement and renewed by `trackActivity`. */
const createSessionActivity = (prisma: PrismaClient) => ({
  async findByToken(token: string): Promise<SessionRecord | null> {
    const rows = await prisma.$queryRaw<SessionRecord[]>`
      SELECT s.id::text AS "sessionId", s.user_id::text AS "userId",
             s.expires_at AS "expiresAt", s.last_activity_at AS "lastActivityAt",
             u.timezone AS timezone
        FROM auth_session s
        JOIN auth_user u ON u.id = s.user_id
       WHERE s.token = ${token}`;
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

/** Reads and updates the profile of a user by id (plan §4.1.2). */
const createMeStore = (prisma: PrismaClient): MeStore => ({
  async findByUserId(userId) {
    const rows = await prisma.$queryRaw<MeProfile[]>`
      SELECT u.id::text AS id, u.name AS name, u.email AS email, u.timezone AS timezone,
             COALESCE(st.onboarding_step, 1)::int AS "onboardingStep",
             (st.onboarding_completed_at IS NOT NULL) AS "onboardingCompleted"
        FROM auth_user u
        LEFT JOIN user_settings st ON st.user_id = u.id
       WHERE u.id = ${userId}::uuid`;
    return rows[0] ?? null;
  },
  async update(userId, changes) {
    await prisma.$executeRaw`
      UPDATE auth_user
         SET name = COALESCE(${changes.name ?? null}, name),
             timezone = COALESCE(${changes.timezone ?? null}, timezone),
             updated_at = now()
       WHERE id = ${userId}::uuid`;
  },
  async findCredential(userId) {
    const rows = await prisma.$queryRaw<{ email: string; passwordHash: string | null }[]>`
      SELECT u.email AS email, a.password AS "passwordHash"
        FROM auth_user u
        LEFT JOIN auth_account a ON a.user_id = u.id AND a.provider_id = 'credential'
       WHERE u.id = ${userId}::uuid`;
    return rows[0] ?? null;
  },
  async deleteAccount(userId, email) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('user:' || ${userId}::text))`;
        await tx.$executeRaw`
          INSERT INTO email_outbox (id, to_address, kind, payload)
          VALUES (${uuidv7()}::uuid, ${email}, 'account_deleted'::email_kind, '{}'::jsonb)`;
        await tx.$executeRaw`DELETE FROM auth_user WHERE id = ${userId}::uuid`;
      },
      { timeout: 20_000 },
    );
  },
});

/** The row of a notification of the inbox, before it becomes a `NotificationRecord`. */
interface NotificationRow {
  id: string;
  type: NotificationRecord['type'];
  params: Record<string, unknown>;
  targetRoute: string;
  createdAt: Date;
  createdAtKey: string;
  readAt: Date | null;
  decisionKind: 'budget_period' | 'occurrence' | null;
  decisionRef: string | null;
  decisionStatus: 'waiting' | 'resolved' | null;
}

/** The notifications of the inbox (plan §3.7, §4.15.2), always bound to the user (RN-09). */
const createNotificationsStore = (prisma: PrismaClient): NotificationsStore => ({
  async list(userId, after, limit) {
    const rows = await prisma.$queryRaw<NotificationRow[]>`
      SELECT n.id::text AS id, n.type::text AS type, n.params AS params,
             n.target_route AS "targetRoute", n.created_at AS "createdAt",
             to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               AS "createdAtKey",
             n.read_at AS "readAt", n.decision_kind AS "decisionKind",
             n.decision_ref::text AS "decisionRef", n.decision_status::text AS "decisionStatus"
        FROM notification n
       WHERE n.user_id = ${userId}::uuid
         AND (${after === null}::boolean
              OR (n.created_at, n.id) <
                 (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ${limit}::int`;
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      params: row.params,
      targetRoute: row.targetRoute,
      createdAt: row.createdAt,
      createdAtKey: row.createdAtKey,
      readAt: row.readAt,
      decision:
        row.decisionKind === null || row.decisionRef === null || row.decisionStatus === null
          ? null
          : { kind: row.decisionKind, ref: row.decisionRef, status: row.decisionStatus },
    }));
  },
  async countUnread(userId) {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM notification
       WHERE user_id = ${userId}::uuid AND read_at IS NULL`;
    return rows[0]?.count ?? 0;
  },
  async markRead(userId, id) {
    const updated = await prisma.$executeRaw`
      UPDATE notification
         SET read_at = COALESCE(read_at, now())
       WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`;
    return updated === 1;
  },
  async markAllRead(userId) {
    await prisma.$executeRaw`
      UPDATE notification
         SET read_at = now()
       WHERE user_id = ${userId}::uuid AND read_at IS NULL`;
  },
  async remove(userId, id) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM notification WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`;
    return deleted === 1;
  },
});

/** Creates a confirmed user with the Onboarding finished and returns its credentials. */
const createTestUserFactory =
  (deps: { prisma: PrismaClient; uow: UnitOfWork; auth: AuthGateway }) =>
  async (): Promise<TestUserCredentials> => {
    const id = uuidv7();
    const email = `${id}@e2e.test`;
    const password = `Prueba-${randomUUID()}`;
    const passwordHash = await deps.auth.hashPassword(password);
    await deps.uow.run(async (repos) => {
      await repos.users.createUnconfirmed({ id, name: 'Usuario de prueba', email, passwordHash });
      await bootstrapUser(repos, id);
    });
    await deps.auth.markEmailVerified(id);
    await deps.prisma.$executeRaw`
      UPDATE user_settings SET onboarding_completed_at = now() WHERE user_id = ${id}::uuid`;
    return { email, password };
  };

/**
 * `POST /internal/test/notifications` (plan §1.5): creates the notification for the user with that
 * email, once per `eventKey` (RN-10). An unknown email answers 404.
 */
const createTestNotificationFactory =
  (uow: UnitOfWork) =>
  async ({ email, ...notification }: TestNotificationInput): Promise<void> => {
    await uow.run(async (repos) => {
      const user = await repos.users.findByEmail(email);
      if (user === null) {
        throw new AppError('NOT_FOUND');
      }
      await repos.notifications.insertIfAbsent({
        id: uuidv7(),
        userId: user.id,
        type: notification.type,
        eventKey: notification.eventKey,
        params: notification.params,
        targetRoute: notification.targetRoute,
        ...(notification.decision === undefined ? {} : { decision: notification.decision }),
      });
    });
  };

export const buildContainer = (env: Env): Container => {
  const queryCounter = createQueryCounter();
  const prisma = buildPrismaClient(env, queryCounter);
  const uow = createUnitOfWork(prisma, buildRepositories, queryCounter);
  const fakeEmail = env.INTEGRATIONS === 'fake' ? new FakeEmailGateway() : null;
  const jobRuns = createJobRuns(prisma);
  const jobs = createJobs({ jobRuns, clock: systemClock, release: env.RELEASE });
  const rateSources = buildRateSources(env);
  const ratesService = createRatesService({ uow });
  const notificationEmitter = createNotificationEmitter({ release: env.RELEASE });
  const recurringUsers = createRecurringUsers(prisma);
  const goalMilestones = createGoalMilestones({
    uow,
    rates: ratesService,
    notifications: notificationEmitter,
    timezones: recurringUsers,
    users: createGoalNoticeUsers(prisma),
    clock: systemClock,
  });
  const fxJobs = createFxJobs({
    rates: rateSources.rates,
    bcb: rateSources.bcb,
    uow,
    jobRuns,
    clock: systemClock,
    afterParallel: () => goalMilestones.afterRates(),
  });
  jobs.registerJob('fx.fetchParallel', () => fxJobs.fetchParallel());
  jobs.registerJob('fx.fetchOfficial', () => fxJobs.fetchOfficial());
  jobs.registerJob(
    'outbox.send',
    createOutboxSend({ uow, emailGateway: createEmailGateway(env, fakeEmail), clock: systemClock }),
  );
  const scheduledNotifications = createScheduledNotifications({
    uow,
    clock: systemClock,
    release: env.RELEASE,
    users: createScheduledUsers(prisma),
    rates: ratesService,
  });
  jobs.registerJob('notifications.scheduled', () => scheduledNotifications.run(), {
    forUser: (userId) => scheduledNotifications.forUser(userId),
  });
  const budgetsJobs = createBudgetsJobs({
    uow,
    clock: systemClock,
    notifications: notificationEmitter,
    ids: uuidv7Ids,
  });
  jobs.registerJob('budgets.close', () => budgetsJobs.close(), {
    forUser: (userId) => budgetsJobs.closeForUser(userId),
  });
  jobs.registerJob('budgets.defaultDecision', () => budgetsJobs.defaultDecision());
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
  const meService = createMeService({ store: createMeStore(prisma), auth });
  const settingsService = createSettingsService({ uow });
  const fxSettingsService = createFxSettingsService({ uow, ids: uuidv7Ids });
  const currenciesService = createCurrenciesService({ uow, ids: uuidv7Ids });
  const ledgerHooks = createLedgerHooks();
  ledgerHooks.register(
    createBudgetLedgerHook({
      notifications: notificationEmitter,
      ids: uuidv7Ids,
    }),
  );
  ledgerHooks.register(goalMilestones.ledgerHook);
  const recurringGenerator = createRecurringGenerator({
    rates: ratesService,
    ledgerHooks,
    notifications: notificationEmitter,
    timezones: recurringUsers,
    clock: systemClock,
  });
  const recurringJobs = createRecurringJobs({
    uow,
    generator: recurringGenerator,
    users: recurringUsers,
    clock: systemClock,
  });
  jobs.registerJob('recurring.generate', () => recurringJobs.generate(), {
    forUser: (userId) => recurringJobs.generateForUser(userId),
  });
  jobs.registerJob('recurring.expirePending', () => recurringJobs.expirePending(), {
    forUser: (userId) => recurringJobs.expirePendingForUser(userId),
  });
  const accountsService = createAccountsService({
    uow,
    rates: ratesService,
    ledgerHooks,
    recurring: { notifications: notificationEmitter },
  });
  const transactionsService = createTransactionsService({
    uow,
    rates: ratesService,
    ledgerHooks,
  });
  const shortcutsService = createShortcutsService({ uow });
  const registerService = createRegisterService({
    uow,
    usage: createRegisterUsageReader(prisma),
    accounts: accountsService,
    shortcuts: shortcutsService,
    transactions: transactionsService,
  });

  const dashboardService = createDashboardViewService({
    uow,
    dashboard: createDashboardService({ uow }),
    accounts: accountsService,
    transactions: transactionsService,
    expenses: createDashboardExpenseReader(prisma),
  });

  const fakeRates = rateSources.fake;
  const testSupport: TestSupportControllerDeps | null =
    fakeEmail === null || fakeRates === null
      ? null
      : {
          // Nothing else ticks in the end-to-end run: reading the mailbox also sends what is due,
          // so the polling client sees the email on its next read.
          mailbox: (to) => {
            jobs.tick().catch(() => undefined);
            return fakeEmail.inboxOf(to);
          },
          createUser: createTestUserFactory({ prisma, uow, auth }),
          setRates: createTestRatesSetter({ fake: fakeRates, fxJobs, clock: systemClock }),
          createNotification: createTestNotificationFactory(uow),
        };
  return {
    testSupport,
    env,
    prisma,
    uow,
    queryCounter,
    clock: systemClock,
    ids: uuidv7Ids,
    jobs,
    ledgerHooks,
    recurringGenerator,
    auth,
    authService,
    meService,
    exportService: createExportService({ uow, release: env.RELEASE, archive: createZipStream }),
    settingsService,
    ratesService,
    fxSettingsService,
    currenciesService,
    accountsService,
    budgetsService: createBudgetsService({
      uow,
      rates: ratesService,
      notifications: notificationEmitter,
      ids: uuidv7Ids,
      milestones: goalMilestones,
    }),
    goalsService: createGoalsService({ uow, rates: ratesService, milestones: goalMilestones }),
    recurringService: createRecurringService({
      uow,
      generator: recurringGenerator,
      rates: ratesService,
      ledgerHooks,
      clock: systemClock,
    }),
    debtsService: createDebtsService({ uow, rates: ratesService, ledgerHooks }),
    shortcutsService,
    categoriesService: createCategoriesService({
      uow,
      recurring: { notifications: notificationEmitter, timezones: recurringUsers, clock: systemClock },
    }),
    categoryTree: createCategoryTreeReader(uow),
    transactionsService,
    registerService,
    dashboardService,
    onboardingService: createOnboardingService({ uow, rates: ratesService }),
    notificationsService: createNotificationsService({
      store: createNotificationsStore(prisma),
    }),
    notificationPreferencesService: createNotificationPreferencesService({ uow }),
    balanceSeries: createBalanceSeriesReader(uow),
    rateHistory: createRateHistoryReader(uow),
    refreshParallel: createParallelRefresher(fxJobs),
    readiness: createReadinessProbe(prisma),
  };
};

export const createApp = (container: Container): Express => {
  const session = {
    sessions: createSessionActivity(container.prisma),
    clock: container.clock,
  };
  return createExpressApp({
    webOrigin: container.env.WEB_ORIGIN,
    queryCounter: container.queryCounter,
    jobs: { secret: container.env.JOBS_SECRET, jobs: container.jobs },
    ...(container.testSupport === null ? {} : { testSupport: container.testSupport }),
    auth: {
      authService: container.authService,
      sessions: container.auth,
      me: createMeReader(container.prisma),
      release: container.env.RELEASE,
      session,
    },
    me: {
      meService: container.meService,
      exportService: container.exportService,
      release: container.env.RELEASE,
      session,
    },
    settings: { settingsService: container.settingsService, session },
    rates: {
      ratesService: container.ratesService,
      rateHistory: container.rateHistory,
      refreshParallel: container.refreshParallel,
      clock: container.clock,
      session,
    },
    fx: { fxSettingsService: container.fxSettingsService, clock: container.clock, session },
    currencies: {
      currenciesService: container.currenciesService,
      clock: container.clock,
      session,
    },
    categories: {
      categoriesService: container.categoriesService,
      categoryTree: container.categoryTree,
      session,
    },
    accounts: {
      accountsService: container.accountsService,
      balanceSeries: container.balanceSeries,
      clock: container.clock,
      session,
    },
    transactions: {
      transactionsService: container.transactionsService,
      register: container.registerService,
      clock: container.clock,
      session,
    },
    dashboard: {
      dashboardService: container.dashboardService,
      clock: container.clock,
      session,
    },
    budgets: { budgetsService: container.budgetsService, clock: container.clock, session },
    goals: { goalsService: container.goalsService, clock: container.clock, session },
    recurring: {
      recurringService: container.recurringService,
      clock: container.clock,
      session,
    },
    debts: { debtsService: container.debtsService, clock: container.clock, session },
    notifications: { notificationsService: container.notificationsService, session },
    notificationPreferences: {
      notificationPreferencesService: container.notificationPreferencesService,
      session,
    },
    shortcuts: { shortcutsService: container.shortcutsService, session },
    register: { registerService: container.registerService, clock: container.clock, session },
    onboarding: {
      onboardingService: container.onboardingService,
      clock: container.clock,
      session,
    },
    readiness: container.readiness,
  });
};
