import { todayFor } from '@finanzas/domain';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RecurringRuleRow, Repositories } from '../../src/application/ports/repositories.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createAllocationEvent, createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import {
  createOccurrence,
  deleteRecurringOf,
  occurrencesOf,
  uniqueRuleName,
} from '../factories/recurring.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes `generateDue(tx, userId, rule, today)` and the job `recurring.generate` (plan
 * §4.14.3, §4.0), but not how they are built nor wired. These tests assume:
 * - The container built with `RELEASE=1.2` exposes `recurringGenerator`, whose
 *   `generateDue(tx, userId, rule, today)` runs inside the caller's transaction: `tx` is the
 *   `Repositories` of the running `UnitOfWork` (taken with `userLock`), `rule` the
 *   `RecurringRuleRow` read in that transaction and `today` the local date `YYYY-MM-DD`.
 * - The container registers `recurring.generate` in `container.jobs` with a per-user scope, so
 *   `jobs.catchUpUser(userId)` and `jobs.tick()` generate what is due for the user, with "today"
 *   taken from the system clock in the user's timezone (`auth_user.timezone`, RNF-20).
 * - An occurrence created in auto mode whose transaction was saved is `registered`, and the
 *   transaction is dated on the occurrence's date. A pending occurrence (confirm mode, or auto mode
 *   blocked by `BalanceGuard`) has a `pending_since` and a `recurring_pending` notification with the
 *   key `recurring_pending:{occurrenceId}` that waits for the decision `occurrence` of that id.
 * - `generated_count` grows by one per generated occurrence, `last_generated_date` is the last
 *   generated date, and a rule whose count reaches N or whose end date has passed is `finished`.
 *
 * Rules are written straight by SQL (daily ones, which the factory does not build) and the results
 * are read straight by SQL. `market_rate` is global (ADR-12): the rows this file writes are on its
 * own dates, and whatever was there is put back at the end.
 */
interface RecurringGeneratorUnderTest {
  generateDue(tx: Repositories, userId: string, rule: RecurringRuleRow, today: string): Promise<unknown>;
}

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.2',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

const prisma = testPrisma();
const RATE_DATES = ['2091-11-19', '2091-11-20'];

interface SavedRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

let container: Container;
let savedRates: SavedRate[] = [];
const usedUserIds: string[] = [];

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  savedRates = await prisma.$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate WHERE rate_date = ANY(${RATE_DATES}::date[])`;
  await prisma.$executeRaw`DELETE FROM market_rate WHERE rate_date = ANY(${RATE_DATES}::date[])`;
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate WHERE rate_date = ANY(${RATE_DATES}::date[])`;
  for (const row of savedRates) {
    await prisma.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
  await deleteRecurringOf(usedUserIds);
  await deleteGoalsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

async function newUser(timezone = 'America/La_Paz'): Promise<TestUser> {
  const user = await createUser({ timezone });
  usedUserIds.push(user.id);
  return user;
}

function generator(): RecurringGeneratorUnderTest {
  return (container as unknown as { recurringGenerator: RecurringGeneratorUnderTest })
    .recurringGenerator;
}

/** Runs `generateDue` for the rule with that `today`, in a transaction of the user. */
async function generate(userId: string, ruleId: string, today: string): Promise<void> {
  await container.uow.run(
    async (repos) => {
      const rule = await repos.recurringRules.lockForUpdate(ruleId);
      if (rule === null) {
        throw new Error('The rule does not exist');
      }
      await generator().generateDue(repos, userId, rule, today);
    },
    { userLock: userId },
  );
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Every date from `from` to `to`, both included. */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

type RuleEnd =
  | { type: 'none' }
  | { type: 'count'; count: number }
  | { type: 'until'; date: string };

interface DailyRuleOptions {
  name?: string;
  kind?: 'expense' | 'income' | 'transfer';
  amount?: string | null;
  accountId: string;
  destAccountId?: string | null;
  categoryId?: string | null;
  startDate: string;
  end?: RuleEnd;
  mode?: 'auto' | 'confirm';
  status?: 'active' | 'paused';
  generatedCount?: number;
  lastGeneratedDate?: string | null;
}

interface DailyRule {
  id: string;
  name: string;
}

/** Writes a daily rule of the user straight in `recurring_rule` (plan §3.6). */
async function insertDailyRule(userId: string, options: DailyRuleOptions): Promise<DailyRule> {
  const id = uuidv7();
  const name = options.name ?? uniqueRuleName();
  const kind = options.kind ?? 'expense';
  const amount = options.amount === undefined ? '150.00' : options.amount;
  const mode = options.mode ?? (amount === null ? 'confirm' : 'auto');
  const end = options.end ?? { type: 'none' };
  const status = options.status ?? 'active';
  await prisma.$executeRaw`
    INSERT INTO recurring_rule (id, user_id, name, kind, amount, account_id, dest_account_id,
                                category_id, frequency, start_date, end_type, end_date, end_count,
                                mode, status, paused_at, generated_count, last_generated_date)
    VALUES (${id}::uuid, ${userId}::uuid, ${name}, ${kind}::entry_kind, ${amount}::numeric,
            ${options.accountId}::uuid, ${options.destAccountId ?? null}::uuid,
            ${options.categoryId ?? null}::uuid, 'daily', ${options.startDate}::date,
            ${end.type}::rule_end_type, ${end.type === 'until' ? end.date : null}::date,
            ${end.type === 'count' ? end.count : null}::smallint, ${mode}::rule_mode,
            ${status}::rule_status, ${status === 'paused' ? new Date() : null}::timestamptz,
            ${options.generatedCount ?? 0}::int, ${options.lastGeneratedDate ?? null}::date)`;
  return { id, name };
}

/** A daily expense rule over a new bank account and a new expense category of the user. */
async function expenseRule(
  userId: string,
  options: Partial<DailyRuleOptions> & { startDate: string },
): Promise<DailyRule & { accountId: string; categoryId: string }> {
  const accountId =
    options.accountId ??
    (await createAccount(userId, { type: 'bank', initialBalance: '100000.00' })).id;
  const categoryId = options.categoryId ?? (await createCategory(userId, { kind: 'expense' })).id;
  const rule = await insertDailyRule(userId, { ...options, accountId, categoryId });
  return { ...rule, accountId, categoryId };
}

interface StoredRuleState {
  status: string;
  generatedCount: number;
  lastGeneratedDate: string | null;
}

async function ruleState(ruleId: string): Promise<StoredRuleState | undefined> {
  const rows = await prisma.$queryRaw<StoredRuleState[]>`
    SELECT status::text AS status, generated_count AS "generatedCount",
           to_char(last_generated_date, 'YYYY-MM-DD') AS "lastGeneratedDate"
      FROM recurring_rule WHERE id = ${ruleId}::uuid`;
  return rows[0];
}

interface StoredRecurringTransaction {
  id: string;
  kind: string;
  date: string;
  origin: string;
  categoryId: string | null;
  recurringRuleId: string | null;
  recurringLabel: string | null;
  declaredRate: string | null;
}

/** The live transactions of the user, by date. */
async function transactionsOf(userId: string): Promise<StoredRecurringTransaction[]> {
  return prisma.$queryRaw<StoredRecurringTransaction[]>`
    SELECT id::text AS id, kind::text AS kind, to_char(date, 'YYYY-MM-DD') AS date,
           origin::text AS origin, category_id::text AS "categoryId",
           recurring_rule_id::text AS "recurringRuleId", recurring_label AS "recurringLabel",
           declared_rate::text AS "declaredRate"
      FROM ledger_transaction
     WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
     ORDER BY date, id`;
}

async function entriesOf(transactionId: string): Promise<{ accountId: string; amount: string }[]> {
  return prisma.$queryRaw<{ accountId: string; amount: string }[]>`
    SELECT account_id::text AS "accountId", amount::text AS amount
      FROM ledger_entry WHERE transaction_id = ${transactionId}::uuid
     ORDER BY account_id`;
}

interface StoredNotification {
  type: string;
  eventKey: string;
  decisionKind: string | null;
  decisionRef: string | null;
}

async function notificationsOf(userId: string): Promise<StoredNotification[]> {
  return prisma.$queryRaw<StoredNotification[]>`
    SELECT type::text AS type, event_key AS "eventKey", decision_kind AS "decisionKind",
           decision_ref::text AS "decisionRef"
      FROM notification WHERE user_id = ${userId}::uuid
     ORDER BY event_key`;
}

async function pendingSinceOf(occurrenceId: string): Promise<Date | null | undefined> {
  const rows = await prisma.$queryRaw<{ pendingSince: Date | null }[]>`
    SELECT pending_since AS "pendingSince" FROM recurring_occurrence WHERE id = ${occurrenceId}::uuid`;
  return rows[0]?.pendingSince;
}

async function expectPendingWithNotice(userId: string, occurrenceId: string): Promise<void> {
  expect(await pendingSinceOf(occurrenceId)).toBeInstanceOf(Date);
  const notices = await notificationsOf(userId);
  expect(notices).toContainEqual({
    type: 'recurring_pending',
    eventKey: `recurring_pending:${occurrenceId}`,
    decisionKind: 'occurrence',
    decisionRef: occurrenceId,
  });
}

async function marketRate(kind: string, rateDate: string, value: string): Promise<void> {
  const source = kind === 'official' ? 'bcb' : 'paralelo_bo';
  await prisma.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${kind}::market_rate_kind, ${rateDate}::date, ${value}::numeric,
            ${new Date(`${rateDate}T12:00:00Z`)}, ${source}::rate_source)`;
}

/** Parallel bid and ask around the median and the official rate of that day. */
async function marketOn(rateDate: string, bid: string, median: string, ask: string): Promise<void> {
  await marketRate('parallel_bid', rateDate, bid);
  await marketRate('parallel_median', rateDate, median);
  await marketRate('parallel_ask', rateDate, ask);
  await marketRate('official', rateDate, '6.96');
}

async function setTimezone(userId: string, timezone: string): Promise<void> {
  await prisma.$executeRaw`UPDATE auth_user SET timezone = ${timezone} WHERE id = ${userId}::uuid`;
}

const datesOf = async (ruleId: string): Promise<string[]> =>
  (await occurrencesOf(ruleId)).map((row) => row.scheduledDate);

// ---------- Automático bloqueado ----------

describe('recurring.generate: automático bloqueado pasa a pendiente', () => {
  it('RF-M14-05 Automático bloqueado pasa a pendiente: un efectivo con 30 y una regla de 50 dejan un pendiente y ningún gasto', async () => {
    const user = await newUser();
    const cash = await createAccount(user.id, { type: 'cash', initialBalance: '30.00' });
    const rule = await expenseRule(user.id, {
      name: uniqueRuleName('Pasaje'),
      amount: '50.00',
      accountId: cash.id,
      startDate: '2090-03-10',
    });

    await generate(user.id, rule.id, '2090-03-10');

    const occurrences = await occurrencesOf(rule.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ scheduledDate: '2090-03-10', status: 'pending' });
    expect(await transactionsOf(user.id)).toEqual([]);
    await expectPendingWithNotice(user.id, occurrences[0]?.id ?? '');
  });

  it('EC-M4-03 un recurrente automático que dejaría el efectivo en negativo no se registra y pasa a pendiente', async () => {
    const user = await newUser();
    const cash = await createAccount(user.id, { type: 'cash', initialBalance: '30.00' });
    const rule = await expenseRule(user.id, {
      amount: '50.00',
      accountId: cash.id,
      startDate: '2090-03-12',
    });

    await generate(user.id, rule.id, '2090-03-12');

    const occurrences = await occurrencesOf(rule.id);
    expect(occurrences.map((row) => row.status)).toEqual(['pending']);
    expect(await transactionsOf(user.id)).toEqual([]);
    expect((await ruleState(rule.id))?.generatedCount).toBe(1);
  });

  it('EC-M12-05 una ocurrencia automática que tocaría un apartado no se registra y queda pendiente', async () => {
    const user = await newUser();
    const bank = await createAccount(user.id, { type: 'bank', initialBalance: '500.00' });
    const goal = await createGoal(user.id);
    await createAllocationEvent(user.id, goal.id, bank.id, { amount: '400.00' });
    const rule = await expenseRule(user.id, {
      amount: '200.00',
      accountId: bank.id,
      startDate: '2090-03-15',
    });

    await generate(user.id, rule.id, '2090-03-15');

    const occurrences = await occurrencesOf(rule.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe('pending');
    expect(await transactionsOf(user.id)).toEqual([]);
    await expectPendingWithNotice(user.id, occurrences[0]?.id ?? '');
  });
});

// ---------- Movimiento creado ----------

describe('recurring.generate: movimiento del recurrente', () => {
  it('RF-M6-10 el movimiento lleva origin recurring y el nombre de la regla en recurring_label', async () => {
    const user = await newUser();
    const rule = await expenseRule(user.id, {
      name: uniqueRuleName('Internet'),
      amount: '150.00',
      startDate: '2090-04-10',
    });

    await generate(user.id, rule.id, '2090-04-10');

    const transactions = await transactionsOf(user.id);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      kind: 'expense',
      date: '2090-04-10',
      origin: 'recurring',
      categoryId: rule.categoryId,
      recurringRuleId: rule.id,
      recurringLabel: rule.name,
    });
    expect(await entriesOf(transactions[0]?.id ?? '')).toEqual([
      { accountId: rule.accountId, amount: '-150.00' },
    ]);
    expect((await occurrencesOf(rule.id)).map((row) => row.status)).toEqual(['registered']);
  });

  it('RF-M14-06 una transferencia automática entre monedas usa la precarga de RF-M3-07 del día de cada ocurrencia', async () => {
    const user = await newUser();
    const bank = await createAccount(user.id, { type: 'bank', initialBalance: '10000.00' });
    const usd = await createAccount(user.id, { type: 'savings', currencyCode: 'USD' });
    await marketOn('2091-11-19', '10.00', '10.05', '10.10');
    await marketOn('2091-11-20', '10.30', '10.40', '10.50');
    const rule = await insertDailyRule(user.id, {
      kind: 'transfer',
      amount: '1050.00',
      accountId: bank.id,
      destAccountId: usd.id,
      startDate: '2091-11-19',
    });

    await generate(user.id, rule.id, '2091-11-20');

    const transfers = await transactionsOf(user.id);
    expect(transfers.map((row) => [row.kind, row.date, row.declaredRate])).toEqual([
      ['transfer', '2091-11-19', '10.10'],
      ['transfer', '2091-11-20', '10.50'],
    ]);
    const lastEntries = await entriesOf(transfers[1]?.id ?? '');
    expect(lastEntries).toContainEqual({ accountId: bank.id, amount: '-1050.00' });
    expect(lastEntries).toContainEqual({ accountId: usd.id, amount: '100.00' });
  });

  it('TASK-226 en modo confirmación la ocurrencia queda pendiente con el aviso recurring_pending y sin movimiento', async () => {
    const user = await newUser();
    const rule = await expenseRule(user.id, {
      amount: null,
      mode: 'confirm',
      startDate: '2090-04-20',
    });

    await generate(user.id, rule.id, '2090-04-20');

    const occurrences = await occurrencesOf(rule.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ scheduledDate: '2090-04-20', status: 'pending' });
    expect(await transactionsOf(user.id)).toEqual([]);
    await expectPendingWithNotice(user.id, occurrences[0]?.id ?? '');
    expect((await ruleState(rule.id))?.generatedCount).toBe(1);
  });
});

// ---------- Puesta al día ----------

describe('recurring.generate: puesta al día tras una caída', () => {
  it('EC-M14-03 tras 2 días caído crea las ocurrencias de esos días una sola vez', async () => {
    const user = await newUser();
    const rule = await expenseRule(user.id, {
      amount: '20.00',
      startDate: '2090-05-08',
      generatedCount: 1,
      lastGeneratedDate: '2090-05-08',
    });
    await createOccurrence(user.id, rule.id, { scheduledDate: '2090-05-08', status: 'registered' });

    await generate(user.id, rule.id, '2090-05-11');
    await generate(user.id, rule.id, '2090-05-11');

    expect(await datesOf(rule.id)).toEqual(['2090-05-08', '2090-05-09', '2090-05-10', '2090-05-11']);
    expect((await transactionsOf(user.id)).map((row) => row.date)).toEqual([
      '2090-05-09',
      '2090-05-10',
      '2090-05-11',
    ]);
    expect(await ruleState(rule.id)).toMatchObject({
      status: 'active',
      generatedCount: 4,
      lastGeneratedDate: '2090-05-11',
    });
  });

  it('RF-M14-12 una fecha que ya tiene ocurrencia no se vuelve a generar ni a registrar', async () => {
    const user = await newUser();
    const rule = await expenseRule(user.id, { amount: '20.00', startDate: '2090-05-20' });
    await createOccurrence(user.id, rule.id, { scheduledDate: '2090-05-21', status: 'skipped' });

    await generate(user.id, rule.id, '2090-05-22');

    const occurrences = await occurrencesOf(rule.id);
    expect(occurrences.map((row) => [row.scheduledDate, row.status])).toEqual([
      ['2090-05-20', 'registered'],
      ['2090-05-21', 'skipped'],
      ['2090-05-22', 'registered'],
    ]);
    expect((await transactionsOf(user.id)).map((row) => row.date)).toEqual([
      '2090-05-20',
      '2090-05-22',
    ]);
  });

  it('RNF-13 una generación interrumpida no deja nada y la siguiente la retoma sin duplicar ni omitir', async () => {
    const user = await newUser();
    const rule = await expenseRule(user.id, { amount: '20.00', startDate: '2090-06-01' });

    await expect(
      container.uow.run(
        async (repos) => {
          const row = await repos.recurringRules.lockForUpdate(rule.id);
          if (row === null) {
            throw new Error('The rule does not exist');
          }
          await generator().generateDue(repos, user.id, row, '2090-06-03');
          throw new Error('Interrupted');
        },
        { userLock: user.id },
      ),
    ).rejects.toThrow('Interrupted');
    expect(await datesOf(rule.id)).toEqual([]);

    await generate(user.id, rule.id, '2090-06-03');

    expect(await datesOf(rule.id)).toEqual(['2090-06-01', '2090-06-02', '2090-06-03']);
    expect(await transactionsOf(user.id)).toHaveLength(3);
  });
});

// ---------- Fin de la regla ----------

describe('recurring.generate: fin de la regla', () => {
  it('TASK-226 al llegar a N ocurrencias la regla queda finalizada y no genera más', async () => {
    const user = await newUser();
    const rule = await expenseRule(user.id, {
      amount: '20.00',
      startDate: '2090-07-01',
      end: { type: 'count', count: 2 },
    });

    await generate(user.id, rule.id, '2090-07-05');

    expect(await datesOf(rule.id)).toEqual(['2090-07-01', '2090-07-02']);
    expect(await ruleState(rule.id)).toMatchObject({ status: 'finished', generatedCount: 2 });
  });

  it('TASK-226 al pasar la fecha de fin la regla queda finalizada y solo genera hasta el fin', async () => {
    const user = await newUser();
    const rule = await expenseRule(user.id, {
      amount: '20.00',
      startDate: '2090-07-10',
      end: { type: 'until', date: '2090-07-11' },
    });

    await generate(user.id, rule.id, '2090-07-14');

    expect(await datesOf(rule.id)).toEqual(['2090-07-10', '2090-07-11']);
    expect((await ruleState(rule.id))?.status).toBe('finished');
  });
});

// ---------- Fechas locales ----------

describe('recurring.generate: fechas locales', () => {
  it('RF-M14-04 un cambio de zona horaria que mueve hoy hacia atrás o salta un día no repite ni pierde fechas', async () => {
    const user = await newUser();
    const rule = await expenseRule(user.id, { amount: '20.00', startDate: '2090-08-10' });

    for (const today of ['2090-08-10', '2090-08-09', '2090-08-10', '2090-08-12', '2090-08-11']) {
      await generate(user.id, rule.id, today);
    }

    expect(await datesOf(rule.id)).toEqual(['2090-08-10', '2090-08-11', '2090-08-12']);
    expect((await transactionsOf(user.id)).map((row) => row.date)).toEqual([
      '2090-08-10',
      '2090-08-11',
      '2090-08-12',
    ]);
  });

  it('RNF-20 en los cambios de horario de verano (00:00 inexistente y hora repetida) cada fecha local se genera una sola vez', async () => {
    const timezone = 'America/Santiago';
    const user = await newUser(timezone);
    // 2090-09-03 00:00 does not exist in Santiago (23:00 -> 01:00); on 2090-04-01 23:00 repeats.
    for (const startUtc of ['2090-09-02T00:00:00Z', '2090-04-01T00:00:00Z']) {
      const start = Date.parse(startUtc);
      const instants = Array.from({ length: 49 }, (_, hour) => new Date(start + hour * HOUR_MS));
      const first = todayFor(timezone, instants[0] ?? new Date(start));
      const last = todayFor(timezone, instants[48] ?? new Date(start));
      const rule = await expenseRule(user.id, {
        amount: null,
        mode: 'confirm',
        startDate: first,
      });

      for (const instant of instants) {
        await generate(user.id, rule.id, todayFor(timezone, instant));
      }

      expect(await datesOf(rule.id)).toEqual(datesBetween(first, last));
    }
  }, 120_000);
});

// ---------- Job recurring.generate ----------

describe('job recurring.generate', () => {
  it('EC-M14-03 la puesta al día del usuario genera una sola vez las fechas pendientes hasta hoy en su zona', async () => {
    const user = await newUser('America/La_Paz');
    const today = todayFor(user.timezone, new Date());
    const account = await createAccount(user.id, { initialBalanceDate: '2020-01-01' });
    const rule = await expenseRule(user.id, {
      amount: null,
      mode: 'confirm',
      accountId: account.id,
      startDate: addDays(today, -2),
    });

    await container.jobs.catchUpUser(user.id);
    await container.jobs.catchUpUser(user.id);

    expect(await datesOf(rule.id)).toEqual(datesBetween(addDays(today, -2), today));
    const notices = (await notificationsOf(user.id)).filter((n) => n.type === 'recurring_pending');
    expect(notices).toHaveLength(3);
  });

  it('RF-M14-12 dos puestas al día simultáneas del mismo usuario no duplican ocurrencias', async () => {
    const user = await newUser('America/La_Paz');
    const today = todayFor(user.timezone, new Date());
    const account = await createAccount(user.id, { initialBalanceDate: '2020-01-01' });
    const rule = await expenseRule(user.id, {
      amount: null,
      mode: 'confirm',
      accountId: account.id,
      startDate: addDays(today, -1),
    });

    await Promise.all([container.jobs.catchUpUser(user.id), container.jobs.catchUpUser(user.id)]);

    expect(await datesOf(rule.id)).toEqual([addDays(today, -1), today]);
  });

  it('RNF-13 el tick genera las ocurrencias de las reglas activas y no toca las pausadas', async () => {
    const user = await newUser('America/La_Paz');
    const today = todayFor(user.timezone, new Date());
    const account = await createAccount(user.id, { initialBalanceDate: '2020-01-01' });
    const active = await expenseRule(user.id, {
      amount: null,
      mode: 'confirm',
      accountId: account.id,
      startDate: addDays(today, -1),
    });
    const paused = await expenseRule(user.id, {
      amount: null,
      mode: 'confirm',
      accountId: account.id,
      startDate: addDays(today, -1),
      status: 'paused',
    });

    await container.jobs.tick();

    expect(await datesOf(active.id)).toEqual([addDays(today, -1), today]);
    expect(await datesOf(paused.id)).toEqual([]);
  });

  it('RF-M14-04 un cambio de zona horaria del usuario entre corridas del job no repite ni pierde fechas', async () => {
    const west = 'Pacific/Pago_Pago';
    const east = 'Pacific/Kiritimati';
    const user = await newUser(west);
    const westToday = todayFor(west, new Date());
    const start = addDays(westToday, -2);
    const account = await createAccount(user.id, { initialBalanceDate: '2020-01-01' });
    const rule = await expenseRule(user.id, {
      amount: null,
      mode: 'confirm',
      accountId: account.id,
      startDate: start,
    });

    await container.jobs.catchUpUser(user.id);
    expect(await datesOf(rule.id)).toEqual(datesBetween(start, westToday));

    await setTimezone(user.id, east);
    await container.jobs.catchUpUser(user.id);
    const eastToday = todayFor(east, new Date());
    expect(await datesOf(rule.id)).toEqual(datesBetween(start, eastToday));

    await setTimezone(user.id, west);
    await container.jobs.catchUpUser(user.id);
    expect(await datesOf(rule.id)).toEqual(datesBetween(start, eastToday));
  });

  it('RNF-20 el job toma hoy en la zona horaria del perfil del usuario', async () => {
    const east = 'Pacific/Kiritimati';
    const user = await newUser(east);
    const eastToday = todayFor(east, new Date());
    const account = await createAccount(user.id, { initialBalanceDate: '2020-01-01' });
    const rule = await expenseRule(user.id, {
      amount: null,
      mode: 'confirm',
      accountId: account.id,
      startDate: eastToday,
    });

    await container.jobs.catchUpUser(user.id);

    expect(await datesOf(rule.id)).toEqual([eastToday]);
  });
});
