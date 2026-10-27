import type { CreateRuleInput, RecurringOverviewDto, RuleDto } from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import type { RatesContext } from '../../src/application/services/rates.service.js';
import { CurrencyUsage } from '../../src/application/shared/currency-usage.js';
import type { RecurringGenerator } from '../../src/application/shared/recurring-generator.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import {
  createRule,
  deleteRecurringOf,
  occurrencesOf,
  uniqueRuleName,
} from '../factories/recurring.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes `create` and `overview` of `RecurringService` (plan §4.14.2) and the DTOs of
 * `@finanzas/contracts` (plan §4.14.1), but not how the service is built. These tests assume:
 * - `createRecurringService(deps)` of `application/services/recurring.service.ts` takes an object
 *   with, at least, `uow` and `generator` (the `RecurringGenerator` of TASK-226); the test also
 *   passes `rates`, `ledgerHooks` and `clock` from the container built with `RELEASE=1.2`.
 * - `create(ctx, input)` -> `{ created, rule: RuleDto }`, with `created = false` when a rule with
 *   that `id` already exists (ADR-11). `overview(ctx)` -> `RecurringOverviewDto`.
 * - "Today" is the local date of `ctx.now` in `ctx.timezone` (RF-M14-03).
 * - Errors are `AppError`s: `START_DATE_IN_PAST` (422) and `LIMIT_REACHED`.
 * - A rule without amount ("monto por definir", RF-M14-14) has no `amount` in its DTOs.
 * - `next3` are the next 3 dates of the rule; the spec does not say whether they include
 *   `nextDate`, so both readings are accepted. `installment` is "Cuota X de N" of the next
 *   occurrence (`installment` of `packages/domain/recurrence`).
 */
interface RecurringServiceUnderTest {
  create(ctx: RatesContext, input: CreateRuleInput): Promise<{ created: boolean; rule: RuleDto }>;
  overview(ctx: RatesContext): Promise<RecurringOverviewDto>;
}
type CreateRecurringService = (deps: {
  uow: UnitOfWork;
  generator: RecurringGenerator;
  rates: Container['ratesService'];
  ledgerHooks: Container['ledgerHooks'];
  clock: Container['clock'];
}) => RecurringServiceUnderTest;

const { createRecurringService } =
  (await import('../../src/application/services/recurring.service.js')) as unknown as {
    createRecurringService: CreateRecurringService;
  };

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
const TZ = 'America/La_Paz';
/** 15:00 of 2090-06-15 in La Paz (UTC-4). */
const NOW = new Date('2090-06-15T19:00:00Z');
const TODAY = '2090-06-15';

let container: Container;
let recurring: RecurringServiceUnderTest;
const usedUserIds: string[] = [];

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  recurring = createRecurringService({
    uow: container.uow,
    generator: container.recurringGenerator,
    rates: container.ratesService,
    ledgerHooks: container.ledgerHooks,
    clock: container.clock,
  });
});

afterAll(async () => {
  await deleteRecurringOf(usedUserIds);
  await deleteGoalsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const ctxFor = (userId: string, now: Date = NOW): RatesContext => ({
  userId,
  timezone: TZ,
  now,
  traceId: uuidv7(),
});

async function newUser(): Promise<string> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  return user.id;
}

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('The promise was expected to reject');
}

/** A bank account in BOB with plenty of balance and an expense category of the user. */
async function accountAndCategory(
  userId: string,
): Promise<{ accountId: string; categoryId: string }> {
  const account = await createAccount(userId, {
    type: 'bank',
    initialBalance: '100000.00',
    initialBalanceDate: '2090-01-01',
  });
  const category = await createCategory(userId, { kind: 'expense' });
  return { accountId: account.id, categoryId: category.id };
}

/** A monthly expense rule of 150.00 in auto mode, with no end, starting today. */
function ruleInput(
  base: { accountId: string; categoryId: string },
  overrides: Partial<CreateRuleInput> = {},
): CreateRuleInput {
  return {
    id: uuidv7(),
    name: uniqueRuleName('Internet'),
    kind: 'expense',
    amount: '150.00',
    accountId: base.accountId,
    categoryId: base.categoryId,
    frequency: { type: 'monthly', day: 15 },
    startDate: TODAY,
    end: { type: 'none' },
    mode: 'auto',
    ...overrides,
  };
}

async function countRules(userId: string, id?: string): Promise<number> {
  const rows =
    id === undefined
      ? await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM recurring_rule WHERE user_id = ${userId}::uuid`
      : await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM recurring_rule
           WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
  return rows[0]?.n ?? 0;
}

interface StoredTransaction {
  date: string;
  origin: string;
  recurringRuleId: string | null;
}

async function transactionsOf(userId: string): Promise<StoredTransaction[]> {
  return prisma.$queryRaw<StoredTransaction[]>`
    SELECT to_char(date, 'YYYY-MM-DD') AS date, origin::text AS origin,
           recurring_rule_id::text AS "recurringRuleId"
      FROM ledger_transaction
     WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
     ORDER BY date, id`;
}

interface SqlMonthlyRule {
  accountId: string;
  categoryId: string;
  day: number;
  startDate: string;
  amount: string | null;
  mode: 'auto' | 'confirm';
  endCount: number | null;
  generatedCount: number;
  lastGeneratedDate: string | null;
}

/** Writes a monthly expense rule straight in `recurring_rule` (plan §3.6). */
async function insertMonthlyRule(userId: string, options: SqlMonthlyRule): Promise<string> {
  const id = uuidv7();
  const endType = options.endCount === null ? 'none' : 'count';
  await prisma.$executeRaw`
    INSERT INTO recurring_rule (id, user_id, name, kind, amount, account_id, category_id, frequency,
                                day_of_month, start_date, end_type, end_count, mode, status,
                                generated_count, last_generated_date)
    VALUES (${id}::uuid, ${userId}::uuid, ${uniqueRuleName('Cuota')}, 'expense'::entry_kind,
            ${options.amount}::numeric, ${options.accountId}::uuid, ${options.categoryId}::uuid,
            'monthly', ${options.day}::smallint, ${options.startDate}::date,
            ${endType}::rule_end_type, ${options.endCount}::smallint, ${options.mode}::rule_mode,
            'active'::rule_status, ${options.generatedCount}::int,
            ${options.lastGeneratedDate}::date)`;
  return id;
}

function ruleOf(overview: RecurringOverviewDto, id: string): RuleDto {
  const rule = overview.rules.find((item) => item.id === id);
  if (rule === undefined) {
    throw new Error(`The overview has no rule ${id}`);
  }
  return rule;
}

async function usageOf(userId: string, code: string): Promise<string[]> {
  return container.uow.run(async (repos) => CurrencyUsage.check(repos, userId, code), {
    userLock: userId,
  });
}

// ---------- Crear ----------

describe('RecurringService.create: fecha de inicio y ocurrencia de hoy', () => {
  it('EC-M14-07 una regla creada a las 15:00 que empieza hoy crea la ocurrencia de hoy al guardar', async () => {
    const userId = await newUser();
    const input = ruleInput(await accountAndCategory(userId));

    const result = await recurring.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    const occurrences = await occurrencesOf(input.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ scheduledDate: TODAY, status: 'registered' });
    expect(await transactionsOf(userId)).toEqual([
      { date: TODAY, origin: 'recurring', recurringRuleId: input.id },
    ]);
  });

  it('RF-M14-03 si la regla empieza hoy en modo confirmación, el pendiente de hoy se genera al guardarla', async () => {
    const userId = await newUser();
    const input = ruleInput(await accountAndCategory(userId), {
      amount: undefined,
      mode: 'confirm',
    });

    await recurring.create(ctxFor(userId), input);

    const occurrences = await occurrencesOf(input.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ scheduledDate: TODAY, status: 'pending' });
    expect(await transactionsOf(userId)).toEqual([]);
  });

  it('RF-M14-03 un inicio pasado da START_DATE_IN_PAST y no se crea la regla', async () => {
    const userId = await newUser();
    const input = ruleInput(await accountAndCategory(userId), { startDate: '2090-06-14' });

    const error = await rejectionOf(recurring.create(ctxFor(userId), input));

    expect(error.code).toBe('START_DATE_IN_PAST');
    expect(error.status).toBe(422);
    expect(await countRules(userId, input.id)).toBe(0);
    expect(await occurrencesOf(input.id)).toEqual([]);
  });

  it('RF-M14-03 hoy se toma en la zona horaria del usuario: a las 22:00 en La Paz, el día UTC siguiente no es hoy', async () => {
    const userId = await newUser();
    const base = await accountAndCategory(userId);
    // 2090-06-16T02:00Z is 2090-06-15 22:00 in La Paz.
    const lateNight = new Date('2090-06-16T02:00:00Z');
    const today = ruleInput(base, { startDate: TODAY });

    const created = await recurring.create(ctxFor(userId, lateNight), today);

    expect(created.created).toBe(true);
    expect((await occurrencesOf(today.id)).map((row) => row.scheduledDate)).toEqual([TODAY]);
  });

  it('RF-M14-03 una regla que empieza en el futuro no genera ocurrencias al guardarla', async () => {
    const userId = await newUser();
    const input = ruleInput(await accountAndCategory(userId), {
      startDate: '2090-06-20',
      frequency: { type: 'monthly', day: 20 },
    });

    const result = await recurring.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    expect(await countRules(userId, input.id)).toBe(1);
    expect(await occurrencesOf(input.id)).toEqual([]);
    expect(await transactionsOf(userId)).toEqual([]);
  });

  it('TASK-227 crear es idempotente: dos llamadas con el mismo id dejan una regla y una ocurrencia', async () => {
    const userId = await newUser();
    const input = ruleInput(await accountAndCategory(userId));

    const first = await recurring.create(ctxFor(userId), input);
    const second = await recurring.create(ctxFor(userId), input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.rule.id).toBe(input.id);
    expect(await countRules(userId, input.id)).toBe(1);
    expect(await occurrencesOf(input.id)).toHaveLength(1);
    expect(await transactionsOf(userId)).toHaveLength(1);
  });

  it('RNF-28 la regla 101 da LIMIT_REACHED y no se crea', async () => {
    const userId = await newUser();
    const base = await accountAndCategory(userId);
    for (let i = 0; i < 100; i += 1) {
      await createRule(userId, base);
    }
    const input = ruleInput(base, { startDate: '2090-06-20' });

    const error = await rejectionOf(recurring.create(ctxFor(userId), input));

    expect(error.code).toBe('LIMIT_REACHED');
    expect(await countRules(userId, input.id)).toBe(0);
    expect(await countRules(userId)).toBe(100);
  });
});

// ---------- Vista general ----------

describe('RecurringService.overview: reglas, pendientes y próximos vencimientos', () => {
  it('RF-M14-13 la vista general trae la próxima fecha, las 3 siguientes y la cuota', async () => {
    const userId = await newUser();
    const base = await accountAndCategory(userId);
    const ruleId = await insertMonthlyRule(userId, {
      ...base,
      day: 20,
      startDate: '2090-03-20',
      amount: '300.00',
      mode: 'auto',
      endCount: 12,
      generatedCount: 3,
      lastGeneratedDate: '2090-05-20',
    });

    const rule = ruleOf(await recurring.overview(ctxFor(userId)), ruleId);

    expect(rule.nextDate).toBe('2090-06-20');
    expect([
      ['2090-06-20', '2090-07-20', '2090-08-20'],
      ['2090-07-20', '2090-08-20', '2090-09-20'],
    ]).toContainEqual(rule.next3);
    expect(rule.installment).toEqual({ current: 4, total: 12 });
    expect(rule).toMatchObject({ status: 'active', amount: '300.00', currency: 'BOB' });
  });

  it('RF-M14-13 una regla de N veces creada hoy muestra la próxima fecha del mes siguiente y la cuota 2 de N', async () => {
    const userId = await newUser();
    const input = ruleInput(await accountAndCategory(userId), { end: { type: 'count', count: 12 } });
    await recurring.create(ctxFor(userId), input);

    const rule = ruleOf(await recurring.overview(ctxFor(userId)), input.id);

    expect(rule.nextDate).toBe('2090-07-15');
    expect(rule.installment).toEqual({ current: 2, total: 12 });
  });

  it('RF-M14-13 una regla sin fin por cantidad no muestra cuota', async () => {
    const userId = await newUser();
    const input = ruleInput(await accountAndCategory(userId), {
      startDate: '2090-06-20',
      frequency: { type: 'monthly', day: 20 },
    });
    await recurring.create(ctxFor(userId), input);

    const rule = ruleOf(await recurring.overview(ctxFor(userId)), input.id);

    expect(rule.nextDate).toBe('2090-06-20');
    expect(rule.next3).toHaveLength(3);
    expect(rule.installment).toBeNull();
  });

  it('RF-M14-13 los pendientes de confirmar aparecen en la vista general', async () => {
    const userId = await newUser();
    const input = ruleInput(await accountAndCategory(userId), {
      amount: '80.00',
      mode: 'confirm',
    });
    await recurring.create(ctxFor(userId), input);

    const overview = await recurring.overview(ctxFor(userId));

    expect(overview.pending).toHaveLength(1);
    expect(overview.pending[0]).toMatchObject({
      ruleId: input.id,
      ruleName: input.name,
      date: TODAY,
      amount: '80.00',
      currency: 'BOB',
      accountId: input.accountId,
    });
  });

  it('RF-M14-13 los próximos vencimientos traen las fechas de los próximos 30 días y no las posteriores', async () => {
    const userId = await newUser();
    const input = ruleInput(await accountAndCategory(userId), {
      amount: '120.00',
      startDate: '2090-06-20',
      frequency: { type: 'monthly', day: 20 },
    });
    await recurring.create(ctxFor(userId), input);

    const overview = await recurring.overview(ctxFor(userId));
    const dates = overview.upcoming30
      .filter((item) => item.ruleId === input.id)
      .map((item) => item.date);

    expect(dates).toEqual(['2090-06-20']);
    expect(overview.upcoming30).toContainEqual(
      expect.objectContaining({
        ruleId: input.id,
        ruleName: input.name,
        date: '2090-06-20',
        amount: '120.00',
        currency: 'BOB',
      }),
    );
  });

  it('RF-M14-14 una regla sin monto se muestra como "monto por definir"', async () => {
    const userId = await newUser();
    const input = ruleInput(await accountAndCategory(userId), {
      amount: undefined,
      mode: 'confirm',
      frequency: { type: 'weekly', weekday: 4 },
    });
    await recurring.create(ctxFor(userId), input);

    const overview = await recurring.overview(ctxFor(userId));

    const rule = ruleOf(overview, input.id);
    expect(rule.mode).toBe('confirm');
    expect(rule.amount).toBeUndefined();
    const upcoming = overview.upcoming30.filter((item) => item.ruleId === input.id);
    expect(upcoming.length).toBeGreaterThan(0);
    for (const item of upcoming) {
      expect(item.amount).toBeUndefined();
    }
    const pending = overview.pending.filter((item) => item.ruleId === input.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.amount).toBeUndefined();
  });

  it('TASK-227 la vista general solo trae las reglas y pendientes del usuario', async () => {
    const owner = await newUser();
    const other = await newUser();
    const input = ruleInput(await accountAndCategory(owner), {
      amount: undefined,
      mode: 'confirm',
    });
    await recurring.create(ctxFor(owner), input);

    const overview = await recurring.overview(ctxFor(other));

    expect(overview.rules).toEqual([]);
    expect(overview.pending).toEqual([]);
    expect(overview.upcoming30).toEqual([]);
  });
});

// ---------- CurrencyUsage ----------

describe('RecurringService: uso de monedas', () => {
  it('TASK-227 una regla no eliminada registra en CurrencyUsage el uso de su moneda', async () => {
    const userId = await newUser();
    const usd = await createAccount(userId, {
      type: 'savings',
      currencyCode: 'USD',
      initialBalance: '1000.00',
      initialBalanceDate: '2090-01-01',
      // Archived, the account itself no longer uses USD: only the rule does.
      status: 'archived',
    });
    const category = await createCategory(userId, { kind: 'expense' });
    const ruleId = await insertMonthlyRule(userId, {
      accountId: usd.id,
      categoryId: category.id,
      day: 20,
      startDate: '2090-06-20',
      amount: '10.00',
      mode: 'auto',
      endCount: null,
      generatedCount: 0,
      lastGeneratedDate: null,
    });

    const withRule = await usageOf(userId, 'USD');

    expect(withRule.length).toBeGreaterThan(0);
    expect(withRule).not.toContain('accounts');

    await prisma.$executeRaw`DELETE FROM recurring_rule WHERE id = ${ruleId}::uuid`;

    expect(await usageOf(userId, 'USD')).toEqual([]);
  });
});
