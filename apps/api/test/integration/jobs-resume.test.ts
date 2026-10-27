import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBudgetsJobs } from '../../src/application/jobs/budgets.js';
import { createScheduledNotifications } from '../../src/application/jobs/notifications.js';
import { createRecurringJobs } from '../../src/application/jobs/recurring.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createNotificationEmitter } from '../../src/application/shared/notification-emitter.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createBudget, createBudgetPeriod, deleteBudgetsOf } from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createDebt } from '../factories/debt.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createRule, deleteRecurringOf, uniqueRuleName } from '../factories/recurring.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testDatabaseUrl, testPrisma } from './setup/db.js';

/**
 * RNF-13 (plan §5.3): an automatic process that is interrupted resumes without duplicating or
 * omitting what was pending. For `budgets.close`, `recurring.generate` and `notifications.scheduled`
 * every test runs the job over a batch of three users, interrupts it in the middle of the batch,
 * runs it again and compares the result with a run of the same job over an identical batch that was
 * never interrupted. The three jobs are built here with a clock that stays at a fixed instant (the
 * interfaces already fixed by TASK-200, TASK-226 and TASK-215):
 * - `createBudgetsJobs({ uow, clock, notifications, ids })` returns `{ close, closeForUser, ... }`.
 * - `createRecurringJobs({ uow, generator, users, clock })` returns `{ generate, generateForUser, ... }`.
 * - `createScheduledNotifications({ uow, clock, release, users })` returns `{ run, forUser }`.
 *
 * The interruption is a `UnitOfWork` that runs the work of one user and then fails before the
 * commit, as a crashed process would: the transaction of that user is rolled back and the job
 * rejects with `Interrupted`. The `UnitOfWork` also keeps each job within the users of the test, as
 * the database is shared with the other suites.
 */
const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: testDatabaseUrl(),
  AUTH_SECRET: 'auth-secret-for-the-jobs-resume-test-0123456789',
  HMAC_SECRET: 'hmac-secret-for-the-jobs-resume-test-0123456789',
  JOBS_SECRET: 'jobs-secret-for-the-jobs-resume-test-0123456789',
  RESEND_API_KEY: 're_resend-key-for-the-jobs-resume-test',
  RELEASE: '1.2',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

const prisma = testPrisma();
const LA_PAZ = 'America/La_Paz'; // UTC-4, no daylight saving.
/** Each test builds up to six users and runs a job over them. */
const JOB_TIMEOUT_MS = 60_000;
const usedUserIds: string[] = [];

let container: Container;

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
});

afterAll(async () => {
  await deleteRecurringOf(usedUserIds);
  await deleteBudgetsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

/** A clock that stays at `instant`. */
function clockAt(instant: Date): Clock {
  return {
    now: () => new Date(instant.getTime()),
    todayFor: (timezone) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(instant),
  };
}

/** The instant of that local time in La Paz (UTC-4). */
const laPaz = (date: string, time: string): Date => new Date(`${date}T${time}:00-04:00`);

interface Interruption {
  /** The user whose transaction fails before the commit; `null` when nothing is interrupted. */
  failUser: string | null;
}

/**
 * The unit of work of the test: the budget owners the job walks are only the users of the batch,
 * and the transaction of `interruption.failUser` runs its whole work and then fails, so it rolls
 * back (RNF-13).
 */
function interruptibleUow(
  users: string[],
  interruption: Interruption,
  inner: UnitOfWork = container.uow,
): UnitOfWork {
  return {
    run: (fn, opts) =>
      inner.run(async (repos: Repositories) => {
        const budgets = repos.budgets;
        const scoped: Repositories = {
          ...repos,
          budgets: {
            ...budgets,
            async ownersWithEndedPeriods(now) {
              const owners = await budgets.ownersWithEndedPeriods(now);
              return owners.filter((owner) => users.includes(owner));
            },
          },
        };
        const value = await fn(scoped);
        if (opts?.userLock !== undefined && opts.userLock === interruption.failUser) {
          throw new Error('Interrupted');
        }
        return value;
      }, opts),
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The text with every id replaced by its label, so the same data of two users compares equal. */
function labelled(text: string, labels: Map<string, string>): string {
  return text.replace(UUID, (id) => labels.get(id) ?? 'unknown-id');
}

async function newUser(): Promise<TestUser> {
  const user = await createUser({ timezone: LA_PAZ });
  usedUserIds.push(user.id);
  return user;
}

interface NotificationRow {
  type: string;
  eventKey: string;
  decisionStatus: string | null;
}

async function notificationsOf(userId: string): Promise<NotificationRow[]> {
  return prisma.$queryRaw<NotificationRow[]>`
    SELECT type::text AS type, event_key AS "eventKey", decision_status::text AS "decisionStatus"
      FROM notification WHERE user_id = ${userId}::uuid`;
}

/** The notices of the user as `type key status`, ids replaced by their labels, sorted. */
async function noticesOf(userId: string, labels: Map<string, string>): Promise<string[]> {
  return (await notificationsOf(userId))
    .map((row) => `${row.type} ${labelled(row.eventKey, labels)} ${row.decisionStatus ?? '-'}`)
    .sort();
}

/** Runs the job with the transaction of `failUser` failing; the job must reject, then it is healthy again. */
async function interruptedOnce(
  interruption: Interruption,
  failUser: string,
  run: () => Promise<void>,
): Promise<void> {
  interruption.failUser = failUser;
  await expect(run()).rejects.toThrow('Interrupted');
  interruption.failUser = null;
}

// ---------- budgets.close ----------

const OUTAGE = new Date('2092-07-03T15:00:00Z');
const MAY = { startDate: '2092-05-01', endDate: '2092-05-31' };

interface BudgetUser {
  userId: string;
  budgetId: string;
  labels: Map<string, string>;
}

/** A user whose May budget period ended and whose system was down until July 3rd. */
async function budgetUser(): Promise<BudgetUser> {
  const user = await newUser();
  await createAccount(user.id, { initialBalance: '10000.00', initialBalanceDate: '2092-01-01' });
  const category = await createCategory(user.id);
  const budget = await createBudget(user.id, {
    categoryId: category.id,
    amount: '500.00',
    thresholds: [80, 100],
  });
  await createBudgetPeriod(user.id, budget, MAY);
  return { userId: user.id, budgetId: budget.id, labels: new Map() };
}

interface PeriodRow {
  id: string;
  start: string;
  end: string;
  amount: string;
  carryoverIn: string;
  status: string;
  decisionDeadline: Date | null;
}

async function periodsOf(budgetId: string): Promise<PeriodRow[]> {
  return prisma.$queryRaw<PeriodRow[]>`
    SELECT id::text AS id, to_char(start_date, 'YYYY-MM-DD') AS start,
           to_char(end_date, 'YYYY-MM-DD') AS "end", amount::text AS amount,
           carryover_in::text AS "carryoverIn", status::text AS status,
           decision_deadline AS "decisionDeadline"
      FROM budget_period WHERE budget_id = ${budgetId}::uuid ORDER BY start_date`;
}

interface BudgetSnapshot {
  periods: string[];
  notices: string[];
}

/** Periods and notices of the user, with no id: the same history of two users compares equal. */
async function budgetSnapshot(user: BudgetUser): Promise<BudgetSnapshot> {
  const periods = await periodsOf(user.budgetId);
  const labels = new Map(periods.map((period) => [period.id, `period-${period.start}`] as const));
  return {
    periods: periods.map(
      (period) =>
        `${period.start}..${period.end} ${period.status} ${period.amount} carry ${period.carryoverIn} ` +
        `deadline ${period.decisionDeadline?.toISOString() ?? '-'}`,
    ),
    notices: await noticesOf(user.userId, labels),
  };
}

function budgetJobs(users: BudgetUser[], interruption: Interruption) {
  return createBudgetsJobs({
    uow: interruptibleUow(
      users.map((user) => user.userId),
      interruption,
    ),
    clock: clockAt(OUTAGE),
    notifications: createNotificationEmitter({ release: '1.2' }),
    ids: { next: () => uuidv7() },
  });
}

/** What a complete run leaves for each user: May and June closed, July open (RF-M11-10). */
const COMPLETE_PERIODS = [
  `2092-05-01..2092-05-31 closed_pending 500.00 carry 0.00 deadline ${new Date(OUTAGE.getTime() + 7 * 86_400_000).toISOString()}`,
  `2092-06-01..2092-06-30 closed_pending 500.00 carry 0.00 deadline ${new Date(OUTAGE.getTime() + 7 * 86_400_000).toISOString()}`,
  '2092-07-01..2092-07-31 open 500.00 carry 0.00 deadline -',
];
const COMPLETE_NOTICES = [
  'period_close period_close:period-2092-05-01 waiting',
  'period_close period_close:period-2092-06-01 waiting',
];

describe(
  'RNF-13 budgets.close se retoma tras una interrupción',
  { timeout: JOB_TIMEOUT_MS },
  () => {
    it('RNF-13 un cierre interrumpido a mitad de un lote de 3 usuarios, al repetirse, deja lo mismo que una corrida sin interrupción', async () => {
      const control = [await budgetUser(), await budgetUser(), await budgetUser()];
      const batch = [await budgetUser(), await budgetUser(), await budgetUser()];
      await budgetJobs(control, { failUser: null }).close();
      const interruption: Interruption = { failUser: null };
      const jobs = budgetJobs(batch, interruption);

      await interruptedOnce(interruption, batch[1]?.userId ?? '', () => jobs.close());
      await jobs.close();

      for (const [index, user] of batch.entries()) {
        const expected = await budgetSnapshot(control[index] as BudgetUser);
        expect(await budgetSnapshot(user)).toEqual(expected);
        expect(expected).toEqual({ periods: COMPLETE_PERIODS, notices: COMPLETE_NOTICES });
      }
    });

    it('RNF-12 tras reintentar, cada período se decide una sola vez: un período siguiente y un aviso por cierre', async () => {
      const batch = [await budgetUser(), await budgetUser(), await budgetUser()];
      const interruption: Interruption = { failUser: null };
      const jobs = budgetJobs(batch, interruption);

      await interruptedOnce(interruption, batch[0]?.userId ?? '', () => jobs.close());
      await jobs.close();
      const afterRetry = await Promise.all(batch.map((user) => budgetSnapshot(user)));
      await jobs.close();
      await jobs.closeForUser(batch[2]?.userId ?? '');

      for (const [index, user] of batch.entries()) {
        const snapshot = await budgetSnapshot(user);
        expect(snapshot).toEqual(afterRetry[index]);
        expect(snapshot.periods).toHaveLength(3);
        expect(snapshot.notices).toHaveLength(2);
      }
    });

    it('RNF-13 si la corrida se interrumpe dos veces seguidas, la tercera completa todo sin duplicar', async () => {
      const control = [await budgetUser(), await budgetUser(), await budgetUser()];
      const batch = [await budgetUser(), await budgetUser(), await budgetUser()];
      await budgetJobs(control, { failUser: null }).close();
      const interruption: Interruption = { failUser: null };
      const jobs = budgetJobs(batch, interruption);

      // The batch stops at the user that fails, so the second interruption hits the same user again.
      await interruptedOnce(interruption, batch[1]?.userId ?? '', () => jobs.close());
      await interruptedOnce(interruption, batch[1]?.userId ?? '', () => jobs.close());
      await jobs.close();

      for (const [index, user] of batch.entries()) {
        expect(await budgetSnapshot(user)).toEqual(
          await budgetSnapshot(control[index] as BudgetUser),
        );
      }
    });

    it('RNF-13 la puesta al día del usuario interrumpido retoma su cierre sin tocar a los demás', async () => {
      const batch = [await budgetUser(), await budgetUser()];
      const interruption: Interruption = { failUser: null };
      const jobs = budgetJobs(batch, interruption);

      await interruptedOnce(interruption, batch[0]?.userId ?? '', () =>
        jobs.closeForUser(batch[0]?.userId ?? ''),
      );
      await jobs.closeForUser(batch[0]?.userId ?? '');

      expect(await budgetSnapshot(batch[0] as BudgetUser)).toEqual({
        periods: COMPLETE_PERIODS,
        notices: COMPLETE_NOTICES,
      });
      const untouched = await periodsOf(batch[1]?.budgetId ?? '');
      expect(untouched.map((period) => period.status)).toEqual(['open']);
    });
  },
);

// ---------- recurring.generate ----------

const RECURRING_START = '2092-03-01';
/** 12:00 of 2092-03-04 in La Paz: the system was down since 2092-03-01. */
const RECURRING_NOW = laPaz('2092-03-04', '12:00');

type RuleEnd = { type: 'none' } | { type: 'count'; count: number };

interface RecurringUser {
  userId: string;
  autoRuleId: string;
  confirmRuleId: string;
}

async function insertDailyRule(
  userId: string,
  options: { accountId: string; categoryId: string; amount: string | null; end: RuleEnd },
): Promise<string> {
  const id = uuidv7();
  const mode = options.amount === null ? 'confirm' : 'auto';
  const { end } = options;
  await prisma.$executeRaw`
    INSERT INTO recurring_rule (id, user_id, name, kind, amount, account_id, dest_account_id,
                                category_id, frequency, start_date, end_type, end_date, end_count,
                                mode, status, paused_at, generated_count, last_generated_date)
    VALUES (${id}::uuid, ${userId}::uuid, ${uniqueRuleName('Diaria')}, 'expense'::entry_kind,
            ${options.amount}::numeric, ${options.accountId}::uuid, NULL::uuid,
            ${options.categoryId}::uuid, 'daily', ${RECURRING_START}::date,
            ${end.type}::rule_end_type, NULL::date,
            ${end.type === 'count' ? end.count : null}::smallint, ${mode}::rule_mode,
            'active'::rule_status, NULL::timestamptz, 0::int, NULL::date)`;
  return id;
}

/**
 * A user with two daily rules since 2092-03-01: an automatic expense of 20.00 with no end and a
 * rule in confirmation mode that ends after 3 occurrences.
 */
async function recurringUser(): Promise<RecurringUser> {
  const user = await newUser();
  const account = await createAccount(user.id, {
    type: 'bank',
    initialBalance: '100000.00',
    initialBalanceDate: '2092-01-01',
  });
  const category = await createCategory(user.id, { kind: 'expense' });
  const common = { accountId: account.id, categoryId: category.id };
  const autoRuleId = await insertDailyRule(user.id, {
    ...common,
    amount: '20.00',
    end: { type: 'none' },
  });
  const confirmRuleId = await insertDailyRule(user.id, {
    ...common,
    amount: null,
    end: { type: 'count', count: 3 },
  });
  return { userId: user.id, autoRuleId, confirmRuleId };
}

function recurringJobs(users: RecurringUser[], interruption: Interruption) {
  const ids = users.map((user) => user.userId);
  return createRecurringJobs({
    uow: interruptibleUow(ids, interruption),
    generator: container.recurringGenerator,
    users: {
      withActiveRules: () => Promise.resolve(ids),
      withExpiredPending: () => Promise.resolve([]),
      async timezoneOf(userId) {
        const rows = await prisma.$queryRaw<{ timezone: string }[]>`
          SELECT timezone FROM auth_user WHERE id = ${userId}::uuid`;
        return rows[0]?.timezone ?? null;
      },
    },
    clock: clockAt(RECURRING_NOW),
  });
}

interface OccurrenceRow {
  id: string;
  scheduledDate: string;
  status: string;
}

async function occurrencesOfRule(ruleId: string): Promise<OccurrenceRow[]> {
  return prisma.$queryRaw<OccurrenceRow[]>`
    SELECT id::text AS id, to_char(scheduled_date, 'YYYY-MM-DD') AS "scheduledDate",
           status::text AS status
      FROM recurring_occurrence WHERE rule_id = ${ruleId}::uuid ORDER BY scheduled_date`;
}

interface RuleState {
  status: string;
  generatedCount: number;
  lastGeneratedDate: string | null;
}

async function ruleStateOf(ruleId: string): Promise<RuleState | undefined> {
  const rows = await prisma.$queryRaw<RuleState[]>`
    SELECT status::text AS status, generated_count AS "generatedCount",
           to_char(last_generated_date, 'YYYY-MM-DD') AS "lastGeneratedDate"
      FROM recurring_rule WHERE id = ${ruleId}::uuid`;
  return rows[0];
}

async function transactionDatesOf(userId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ date: string; amount: string }[]>`
    SELECT to_char(t.date, 'YYYY-MM-DD') AS date, e.amount::text AS amount
      FROM ledger_transaction t JOIN ledger_entry e ON e.transaction_id = t.id
     WHERE t.user_id = ${userId}::uuid AND t.deleted_at IS NULL
     ORDER BY t.date, t.id`;
  return rows.map((row) => `${row.date} ${row.amount}`);
}

interface RecurringSnapshot {
  auto: string[];
  confirm: string[];
  autoState: RuleState | undefined;
  confirmState: RuleState | undefined;
  transactions: string[];
  notices: string[];
}

/** Occurrences, rules, movements and notices of the user, with no id. */
async function recurringSnapshot(user: RecurringUser): Promise<RecurringSnapshot> {
  const auto = await occurrencesOfRule(user.autoRuleId);
  const confirm = await occurrencesOfRule(user.confirmRuleId);
  const labels = new Map<string, string>([
    ...auto.map((row) => [row.id, `auto-${row.scheduledDate}`] as const),
    ...confirm.map((row) => [row.id, `confirm-${row.scheduledDate}`] as const),
  ]);
  const describe = (row: OccurrenceRow): string => `${row.scheduledDate} ${row.status}`;
  return {
    auto: auto.map(describe),
    confirm: confirm.map(describe),
    autoState: await ruleStateOf(user.autoRuleId),
    confirmState: await ruleStateOf(user.confirmRuleId),
    transactions: await transactionDatesOf(user.userId),
    notices: await noticesOf(user.userId, labels),
  };
}

/** What a complete run leaves for each user on 2092-03-04. */
const COMPLETE_RECURRING: RecurringSnapshot = {
  auto: [
    '2092-03-01 registered',
    '2092-03-02 registered',
    '2092-03-03 registered',
    '2092-03-04 registered',
  ],
  confirm: ['2092-03-01 pending', '2092-03-02 pending', '2092-03-03 pending'],
  autoState: { status: 'active', generatedCount: 4, lastGeneratedDate: '2092-03-04' },
  confirmState: { status: 'finished', generatedCount: 3, lastGeneratedDate: '2092-03-03' },
  transactions: [
    '2092-03-01 -20.00',
    '2092-03-02 -20.00',
    '2092-03-03 -20.00',
    '2092-03-04 -20.00',
  ],
  notices: [
    'recurring_pending recurring_pending:confirm-2092-03-01 waiting',
    'recurring_pending recurring_pending:confirm-2092-03-02 waiting',
    'recurring_pending recurring_pending:confirm-2092-03-03 waiting',
  ],
};

describe(
  'RNF-13 recurring.generate se retoma tras una interrupción',
  { timeout: JOB_TIMEOUT_MS },
  () => {
    it('RNF-13 una generación interrumpida a mitad de un lote de 3 usuarios, al repetirse, deja lo mismo que una corrida sin interrupción', async () => {
      const control = [await recurringUser(), await recurringUser(), await recurringUser()];
      const batch = [await recurringUser(), await recurringUser(), await recurringUser()];
      await recurringJobs(control, { failUser: null }).generate();
      const interruption: Interruption = { failUser: null };
      const jobs = recurringJobs(batch, interruption);

      await interruptedOnce(interruption, batch[1]?.userId ?? '', () => jobs.generate());
      await jobs.generate();

      for (const [index, user] of batch.entries()) {
        const expected = await recurringSnapshot(control[index] as RecurringUser);
        expect(await recurringSnapshot(user)).toEqual(expected);
        expect(expected).toEqual(COMPLETE_RECURRING);
      }
    });

    it('RF-M14-12 tras reintentar no hay dos ocurrencias de la misma regla para la misma fecha ni fechas omitidas', async () => {
      const batch = [await recurringUser(), await recurringUser(), await recurringUser()];
      const interruption: Interruption = { failUser: null };
      const jobs = recurringJobs(batch, interruption);

      await interruptedOnce(interruption, batch[2]?.userId ?? '', () => jobs.generate());
      await jobs.generate();
      await jobs.generate();
      await jobs.generateForUser(batch[2]?.userId ?? '');

      for (const user of batch) {
        const auto = await occurrencesOfRule(user.autoRuleId);
        expect(auto.map((row) => row.scheduledDate)).toEqual([
          '2092-03-01',
          '2092-03-02',
          '2092-03-03',
          '2092-03-04',
        ]);
        const confirm = await occurrencesOfRule(user.confirmRuleId);
        expect(confirm.map((row) => row.scheduledDate)).toEqual([
          '2092-03-01',
          '2092-03-02',
          '2092-03-03',
        ]);
        expect(await transactionDatesOf(user.userId)).toHaveLength(4);
      }
    });

    it('RNF-12 tras reintentar, cada ocurrencia pendiente tiene un solo aviso', async () => {
      const batch = [await recurringUser(), await recurringUser(), await recurringUser()];
      const interruption: Interruption = { failUser: null };
      const jobs = recurringJobs(batch, interruption);

      await interruptedOnce(interruption, batch[0]?.userId ?? '', () => jobs.generate());
      await jobs.generate();
      await jobs.generate();

      for (const user of batch) {
        const pending = (await notificationsOf(user.userId)).filter(
          (row) => row.type === 'recurring_pending',
        );
        expect(pending).toHaveLength(3);
        expect(new Set(pending.map((row) => row.eventKey)).size).toBe(3);
      }
    });

    it('RNF-13 si la corrida se interrumpe dos veces seguidas en usuarios distintos, la tercera completa todo sin duplicar', async () => {
      const control = [await recurringUser(), await recurringUser(), await recurringUser()];
      const batch = [await recurringUser(), await recurringUser(), await recurringUser()];
      await recurringJobs(control, { failUser: null }).generate();
      const interruption: Interruption = { failUser: null };
      const jobs = recurringJobs(batch, interruption);

      await interruptedOnce(interruption, batch[0]?.userId ?? '', () => jobs.generate());
      await interruptedOnce(interruption, batch[2]?.userId ?? '', () => jobs.generate());
      await jobs.generate();

      for (const [index, user] of batch.entries()) {
        expect(await recurringSnapshot(user)).toEqual(
          await recurringSnapshot(control[index] as RecurringUser),
        );
      }
    });
  },
);

// ---------- notifications.scheduled ----------

/** 21:00 of 2092-10-20 in La Paz: past 08:00 and at the default hour of `log_day`. */
const NOTICES_NOW = laPaz('2092-10-20', '21:00');

interface NoticeUser {
  user: TestUser;
  labels: Map<string, string>;
}

/**
 * A user with the four kinds of notice due on 2092-10-20: a debt that falls due in 3 days, a debt
 * due today, a monthly rule whose payment is tomorrow and the "Registrar el día" notice.
 */
async function noticeUser(): Promise<NoticeUser> {
  const user = await newUser();
  const soon = await createDebt(user.id, { dueDate: '2092-10-23', startDate: '2092-01-01' });
  const today = await createDebt(user.id, {
    direction: 'owed_to_me',
    person: 'Ana',
    dueDate: '2092-10-20',
    startDate: '2092-01-01',
  });
  const rule = await createRule(user.id, {
    dayOfMonth: 21,
    startDate: '2092-01-21',
    amount: '100.00',
  });
  await prisma.$executeRaw`
    UPDATE notification_preference SET enabled = true
     WHERE user_id = ${user.id}::uuid AND type = 'log_day'::notification_type`;
  const labels = new Map<string, string>([
    [soon.id, 'debt-soon'],
    [today.id, 'debt-today'],
    [rule.id, 'rule'],
  ]);
  return { user, labels };
}

function scheduledJob(users: NoticeUser[], interruption: Interruption) {
  const scheduled = users.map(({ user }) => ({ id: user.id, timezone: user.timezone }));
  return createScheduledNotifications({
    uow: interruptibleUow(
      scheduled.map((user) => user.id),
      interruption,
    ),
    clock: clockAt(NOTICES_NOW),
    release: '1.2',
    users: {
      all: () => Promise.resolve(scheduled),
      find: (userId) => Promise.resolve(scheduled.find((user) => user.id === userId) ?? null),
    },
  });
}

/** What a complete run leaves for each user on 2092-10-20. */
const COMPLETE_NOTICES_OF_THE_DAY = [
  'log_day log_day:2092-10-20 -',
  'payment_upcoming debt:debt-soon:due:2092-10-23:d-3 -',
  'payment_upcoming debt:debt-today:due:2092-10-20:d0 -',
  'payment_upcoming recurring:rule:2092-10-21 -',
];

describe(
  'RNF-13 notifications.scheduled se retoma tras una interrupción',
  { timeout: JOB_TIMEOUT_MS },
  () => {
    it('RNF-13 una corrida interrumpida a mitad de un lote de 3 usuarios, al repetirse, deja los mismos avisos que una sin interrupción', async () => {
      const control = [await noticeUser(), await noticeUser(), await noticeUser()];
      const batch = [await noticeUser(), await noticeUser(), await noticeUser()];
      await scheduledJob(control, { failUser: null }).run();
      const interruption: Interruption = { failUser: null };
      const job = scheduledJob(batch, interruption);

      await interruptedOnce(interruption, batch[1]?.user.id ?? '', () => job.run());
      await job.run();

      for (const [index, { user, labels }] of batch.entries()) {
        const twin = control[index] as NoticeUser;
        const expected = await noticesOf(twin.user.id, twin.labels);
        expect(await noticesOf(user.id, labels)).toEqual(expected);
        expect(expected).toEqual(COMPLETE_NOTICES_OF_THE_DAY);
      }
    });

    it('RNF-12 tras reintentar, un aviso se genera una sola vez por evento aunque el job corra otra vez', async () => {
      const batch = [await noticeUser(), await noticeUser(), await noticeUser()];
      const interruption: Interruption = { failUser: null };
      const job = scheduledJob(batch, interruption);

      await interruptedOnce(interruption, batch[2]?.user.id ?? '', () => job.run());
      await job.run();
      await job.run();
      await job.forUser(batch[2]?.user.id ?? '');

      for (const { user, labels } of batch) {
        const notices = await noticesOf(user.id, labels);
        expect(notices).toEqual(COMPLETE_NOTICES_OF_THE_DAY);
        const keys = (await notificationsOf(user.id)).map((row) => row.eventKey);
        expect(new Set(keys).size).toBe(keys.length);
      }
    });

    it('RNF-13 si la corrida se interrumpe dos veces seguidas en usuarios distintos, la tercera completa todo sin duplicar', async () => {
      const batch = [await noticeUser(), await noticeUser(), await noticeUser()];
      const interruption: Interruption = { failUser: null };
      const job = scheduledJob(batch, interruption);

      await interruptedOnce(interruption, batch[0]?.user.id ?? '', () => job.run());
      await interruptedOnce(interruption, batch[1]?.user.id ?? '', () => job.run());
      await job.run();

      for (const { user, labels } of batch) {
        expect(await noticesOf(user.id, labels)).toEqual(COMPLETE_NOTICES_OF_THE_DAY);
      }
    });

    it('RNF-13 la puesta al día del usuario interrumpido retoma sus avisos sin duplicar', async () => {
      const batch = [await noticeUser(), await noticeUser()];
      const interruption: Interruption = { failUser: null };
      const job = scheduledJob(batch, interruption);
      const [first, second] = batch as [NoticeUser, NoticeUser];

      await interruptedOnce(interruption, first.user.id, () => job.forUser(first.user.id));
      await job.forUser(first.user.id);
      await job.forUser(first.user.id);

      expect(await noticesOf(first.user.id, first.labels)).toEqual(COMPLETE_NOTICES_OF_THE_DAY);
      expect(await noticesOf(second.user.id, second.labels)).toEqual([]);
    });
  },
);
