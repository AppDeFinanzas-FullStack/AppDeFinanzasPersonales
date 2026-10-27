import type { ResumeInput } from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import type { RatesContext } from '../../src/application/services/rates.service.js';
import type { RecurringGenerator } from '../../src/application/shared/recurring-generator.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import {
  deleteRecurringOf,
  occurrencesOf,
  uniqueRuleName,
} from '../factories/recurring.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes `pause`, `skipped` and `resume` of `RecurringService` (plan §4.14.2) and
 * `ResumeInput` of `@finanzas/contracts`, but not their signatures. These tests assume:
 * - `createRecurringService(deps)` takes, as in TASK-227 and TASK-228, `uow`, `generator`, `rates`,
 *   `ledgerHooks` and `clock` from the container built with `RELEASE=1.2`.
 * - `pause(ctx, ruleId)` mirrors `POST /api/recurring/:id/pause` and stores `ctx.now` as the pause
 *   instant; `skipped(ctx, ruleId)` mirrors `GET /api/recurring/:id/skipped` and returns the skipped
 *   dates as `YYYY-MM-DD` strings, in order; `resume(ctx, ruleId, input)` mirrors
 *   `POST /api/recurring/:id/resume` with `input` as its body.
 * - The skipped dates are those after the local date of the pause and before today
 *   (`skippedDates` of `packages/domain/recurrence`), where "today" is the local date of `ctx.now`
 *   in `ctx.timezone`.
 * - Errors are `AppError`s: `INVALID_STATE` and `DATE_NOT_SKIPPED`.
 * - A registered skipped date leaves a movement `origin = recurring` on that date; a skipped date
 *   that stays pending leaves a `pending` occurrence on that date and no movement.
 *
 * Every rule is weekly on Fridays and written by SQL. Its last generated occurrence is Friday
 * 2093-03-20, it is paused on Saturday 2093-03-21 and resumed on Saturday 2093-04-11, three weeks
 * later, so the skipped Fridays are 2093-03-27, 2093-04-03 and 2093-04-10. `market_rate` is global
 * (ADR-12): the rows this file writes are on its own dates, every kind with the same value so the
 * rate of the day does not depend on the user's reference, and whatever was there is put back.
 */
interface RecurringServiceUnderTest {
  pause(ctx: RatesContext, ruleId: string): Promise<unknown>;
  skipped(ctx: RatesContext, ruleId: string): Promise<string[]>;
  resume(ctx: RatesContext, ruleId: string, input: ResumeInput): Promise<unknown>;
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
const FRIDAY = 5;
/** The last Friday generated before the pause. */
const LAST_GENERATED = '2093-03-20';
/** 12:00 of Saturday 2093-03-21 in La Paz (UTC-4). */
const PAUSED_AT = new Date('2093-03-21T16:00:00Z');
/** 12:00 of Saturday 2093-04-11 in La Paz, three weeks after the pause. */
const RESUMED_AT = new Date('2093-04-11T16:00:00Z');
const SKIPPED = ['2093-03-27', '2093-04-03', '2093-04-10'];
/** The USD rate of each day, the same for every kind; the day of the resume has another one. */
const RATES: Record<string, string> = {
  '2093-03-01': '9.00',
  '2093-03-27': '9.10',
  '2093-04-03': '9.20',
  '2093-04-10': '9.30',
  '2093-04-11': '9.90',
};
const RATE_DATES = Object.keys(RATES);
const KINDS = ['parallel_bid', 'parallel_median', 'parallel_ask', 'official'];

interface SavedRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

let container: Container;
let recurring: RecurringServiceUnderTest;
let savedRates: SavedRate[] = [];
const usedUserIds: string[] = [];

async function marketRate(kind: string, rateDate: string, value: string): Promise<void> {
  const source = kind === 'official' ? 'bcb' : 'paralelo_bo';
  await prisma.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${kind}::market_rate_kind, ${rateDate}::date, ${value}::numeric,
            ${new Date(`${rateDate}T12:00:00Z`)}, ${source}::rate_source)`;
}

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  recurring = createRecurringService({
    uow: container.uow,
    generator: container.recurringGenerator,
    rates: container.ratesService,
    ledgerHooks: container.ledgerHooks,
    clock: container.clock,
  });
  savedRates = await prisma.$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate WHERE rate_date = ANY(${RATE_DATES}::date[])`;
  await prisma.$executeRaw`DELETE FROM market_rate WHERE rate_date = ANY(${RATE_DATES}::date[])`;
  for (const date of RATE_DATES) {
    for (const kind of KINDS) {
      await marketRate(kind, date, RATES[date] ?? '');
    }
  }
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

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const ctxAt = (userId: string, now: Date): RatesContext => ({
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

type RuleEnd =
  | { type: 'none' }
  | { type: 'count'; count: number }
  | { type: 'until'; date: string };

interface WeeklyRuleOptions {
  amount?: string;
  accountId?: string;
  end?: RuleEnd;
  status?: 'active' | 'paused' | 'finished';
  /** Fridays generated up to `LAST_GENERATED`, both included; 3 by default. */
  generatedCount?: number;
}

interface WeeklyRule {
  id: string;
  accountId: string;
  categoryId: string;
}

/**
 * Writes straight in `recurring_rule` a weekly expense on Fridays in auto mode, whose last generated
 * occurrence is `LAST_GENERATED` and that starts `generatedCount` Fridays before. A paused rule has
 * `PAUSED_AT` as its pause instant. By default it is paused, of 150.00 over a new BOB bank account
 * with plenty of balance and a new expense category of the user.
 */
async function weeklyRule(userId: string, options: WeeklyRuleOptions = {}): Promise<WeeklyRule> {
  const id = uuidv7();
  const accountId =
    options.accountId ??
    (
      await createAccount(userId, {
        type: 'bank',
        initialBalance: '100000.00',
        initialBalanceDate: '2093-01-01',
      })
    ).id;
  const categoryId = (await createCategory(userId, { kind: 'expense' })).id;
  const generatedCount = options.generatedCount ?? 3;
  const startDate = addDays(LAST_GENERATED, -7 * (generatedCount - 1));
  const end = options.end ?? { type: 'none' };
  const status = options.status ?? 'paused';
  await prisma.$executeRaw`
    INSERT INTO recurring_rule (id, user_id, name, kind, amount, account_id, dest_account_id,
                                category_id, frequency, weekday, start_date, end_type, end_date,
                                end_count, mode, status, paused_at, generated_count,
                                last_generated_date)
    VALUES (${id}::uuid, ${userId}::uuid, ${uniqueRuleName('Semanal')}, 'expense'::entry_kind,
            ${options.amount ?? '150.00'}::numeric, ${accountId}::uuid, NULL::uuid,
            ${categoryId}::uuid, 'weekly', ${FRIDAY}::smallint, ${startDate}::date,
            ${end.type}::rule_end_type, ${end.type === 'until' ? end.date : null}::date,
            ${end.type === 'count' ? end.count : null}::smallint, 'auto'::rule_mode,
            ${status}::rule_status, ${status === 'paused' ? PAUSED_AT : null}::timestamptz,
            ${generatedCount}::int, ${LAST_GENERATED}::date)`;
  return { id, accountId, categoryId };
}

interface StoredRule {
  status: string;
  pausedAt: Date | null;
}

async function ruleOf(ruleId: string): Promise<StoredRule | undefined> {
  const rows = await prisma.$queryRaw<StoredRule[]>`
    SELECT status::text AS status, paused_at AS "pausedAt"
      FROM recurring_rule WHERE id = ${ruleId}::uuid`;
  return rows[0];
}

interface StoredTransaction {
  id: string;
  kind: string;
  date: string;
  origin: string;
  categoryId: string | null;
  recurringRuleId: string | null;
  rateUsdBob: string | null;
}

async function transactionsOf(userId: string): Promise<StoredTransaction[]> {
  return prisma.$queryRaw<StoredTransaction[]>`
    SELECT id::text AS id, kind::text AS kind, to_char(date, 'YYYY-MM-DD') AS date,
           origin::text AS origin, category_id::text AS "categoryId",
           recurring_rule_id::text AS "recurringRuleId", rate_usd_bob::text AS "rateUsdBob"
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

async function statusOn(ruleId: string, date: string): Promise<string | undefined> {
  const occurrences = await occurrencesOf(ruleId);
  return occurrences.find((row) => row.scheduledDate === date)?.status;
}

// ---------- Pausar ----------

describe('RecurringService.pause', () => {
  it('TASK-230 pausar una regla activa la deja pausada', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { status: 'active' });

    await recurring.pause(ctxAt(userId, PAUSED_AT), rule.id);

    const stored = await ruleOf(rule.id);
    expect(stored?.status).toBe('paused');
    expect(stored?.pausedAt).toBeInstanceOf(Date);
  });

  it('TASK-230 pausar una regla ya pausada da INVALID_STATE', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { status: 'paused' });

    const error = await rejectionOf(recurring.pause(ctxAt(userId, RESUMED_AT), rule.id));

    expect(error.code).toBe('INVALID_STATE');
    expect((await ruleOf(rule.id))?.status).toBe('paused');
  });

  it('TASK-230 pausar una regla finalizada da INVALID_STATE', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { status: 'finished' });

    const error = await rejectionOf(recurring.pause(ctxAt(userId, PAUSED_AT), rule.id));

    expect(error.code).toBe('INVALID_STATE');
    expect((await ruleOf(rule.id))?.status).toBe('finished');
  });

  it('TASK-230 no pausa la regla de otro usuario', async () => {
    const ownerId = await newUser();
    const otherId = await newUser();
    const rule = await weeklyRule(ownerId, { status: 'active' });

    await rejectionOf(recurring.pause(ctxAt(otherId, PAUSED_AT), rule.id));

    expect(await ruleOf(rule.id)).toMatchObject({ status: 'active', pausedAt: null });
  });
});

// ---------- Saltadas ----------

describe('RecurringService.skipped', () => {
  it('RF-M14-09 Reanudar con ocurrencias saltadas: una regla semanal pausada 3 semanas ofrece las 3 fechas saltadas', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { status: 'active' });
    await recurring.pause(ctxAt(userId, PAUSED_AT), rule.id);

    const dates = await recurring.skipped(ctxAt(userId, RESUMED_AT), rule.id);

    expect(dates).toEqual(SKIPPED);
  });

  it('EC-M14-05 una regla de 12 veces con 11 generadas solo ofrece 1 fecha saltada', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { end: { type: 'count', count: 12 }, generatedCount: 11 });

    const dates = await recurring.skipped(ctxAt(userId, RESUMED_AT), rule.id);

    expect(dates).toEqual(['2093-03-27']);
  });

  it('EC-M14-06 si la fecha de fin pasó durante la pausa solo ofrece las fechas saltadas hasta el fin', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { end: { type: 'until', date: '2093-04-05' } });

    const dates = await recurring.skipped(ctxAt(userId, RESUMED_AT), rule.id);

    expect(dates).toEqual(['2093-03-27', '2093-04-03']);
  });

  it('TASK-230 no muestra las saltadas de la regla de otro usuario', async () => {
    const ownerId = await newUser();
    const otherId = await newUser();
    const rule = await weeklyRule(ownerId);

    await rejectionOf(recurring.skipped(ctxAt(otherId, RESUMED_AT), rule.id));
  });
});

// ---------- Reanudar ----------

describe('RecurringService.resume', () => {
  it('RF-M14-09 Reanudar con ocurrencias saltadas: registra las elegidas con su fecha original y la regla vuelve a estar activa', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { status: 'active' });
    await recurring.pause(ctxAt(userId, PAUSED_AT), rule.id);

    await recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, {
      registerDates: ['2093-03-27', '2093-04-10'],
    });

    const transactions = await transactionsOf(userId);
    expect(transactions.map((row) => row.date)).toEqual(['2093-03-27', '2093-04-10']);
    for (const transaction of transactions) {
      expect(transaction).toMatchObject({
        kind: 'expense',
        origin: 'recurring',
        categoryId: rule.categoryId,
        recurringRuleId: rule.id,
      });
      expect(await entriesOf(transaction.id)).toEqual([
        { accountId: rule.accountId, amount: '-150.00' },
      ]);
    }
    expect(await statusOn(rule.id, '2093-03-27')).toBe('registered');
    expect(await statusOn(rule.id, '2093-04-10')).toBe('registered');
    expect(await ruleOf(rule.id)).toMatchObject({ status: 'active', pausedAt: null });
  });

  it('RF-M14-09 cada saltada registrada lleva la tasa de su fecha, no la de hoy', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId);

    await recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, { registerDates: SKIPPED });

    const transactions = await transactionsOf(userId);
    expect(transactions.map((row) => [row.date, row.rateUsdBob])).toEqual([
      ['2093-03-27', '9.10'],
      ['2093-04-03', '9.20'],
      ['2093-04-10', '9.30'],
    ]);
  });

  it('RF-M14-09 reanudar sin elegir fechas no registra nada y la regla vuelve a estar activa', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId);

    await recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, { registerDates: [] });

    expect(await transactionsOf(userId)).toEqual([]);
    expect(await ruleOf(rule.id)).toMatchObject({ status: 'active', pausedAt: null });
  });

  it('RF-M14-09 una saltada que bloquearía el efectivo queda pendiente y no crea movimiento', async () => {
    const userId = await newUser();
    const cash = await createAccount(userId, {
      type: 'cash',
      initialBalance: '30.00',
      initialBalanceDate: '2093-01-01',
    });
    const rule = await weeklyRule(userId, { amount: '50.00', accountId: cash.id });

    await recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, { registerDates: ['2093-03-27'] });

    expect(await transactionsOf(userId)).toEqual([]);
    expect(await statusOn(rule.id, '2093-03-27')).toBe('pending');
  });

  it('RF-M14-09 registra en orden: la primera cabe en el efectivo y la siguiente queda pendiente', async () => {
    const userId = await newUser();
    const cash = await createAccount(userId, {
      type: 'cash',
      initialBalance: '60.00',
      initialBalanceDate: '2093-01-01',
    });
    const rule = await weeklyRule(userId, { amount: '50.00', accountId: cash.id });

    await recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, {
      registerDates: ['2093-03-27', '2093-04-03'],
    });

    const transactions = await transactionsOf(userId);
    expect(transactions.map((row) => row.date)).toEqual(['2093-03-27']);
    expect(await statusOn(rule.id, '2093-03-27')).toBe('registered');
    expect(await statusOn(rule.id, '2093-04-03')).toBe('pending');
  });

  it('EC-M14-05 de 2 saltadas elegidas en una regla de 12 veces con 11 generadas solo registra 1 y queda Finalizada', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { end: { type: 'count', count: 12 }, generatedCount: 11 });

    await recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, {
      registerDates: ['2093-03-27', '2093-04-03'],
    });

    const transactions = await transactionsOf(userId);
    expect(transactions.map((row) => row.date)).toEqual(['2093-03-27']);
    expect((await ruleOf(rule.id))?.status).toBe('finished');
  });

  it('EC-M14-06 si la fecha de fin pasó durante la pausa registra las saltadas hasta el fin y queda Finalizada', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { end: { type: 'until', date: '2093-04-05' } });

    await recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, {
      registerDates: ['2093-03-27', '2093-04-03'],
    });

    const transactions = await transactionsOf(userId);
    expect(transactions.map((row) => row.date)).toEqual(['2093-03-27', '2093-04-03']);
    expect((await ruleOf(rule.id))?.status).toBe('finished');
  });

  it('EC-M14-06 si la fecha de fin pasó durante la pausa y no elige fechas queda Finalizada', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { end: { type: 'until', date: '2093-04-05' } });

    await recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, { registerDates: [] });

    expect(await transactionsOf(userId)).toEqual([]);
    expect((await ruleOf(rule.id))?.status).toBe('finished');
  });

  it('TASK-230 una fecha que no es de la regla da DATE_NOT_SKIPPED y no registra nada', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId);

    const error = await rejectionOf(
      recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, {
        registerDates: ['2093-03-27', '2093-03-28'],
      }),
    );

    expect(error.code).toBe('DATE_NOT_SKIPPED');
    expect(await transactionsOf(userId)).toEqual([]);
    expect((await ruleOf(rule.id))?.status).toBe('paused');
  });

  it('TASK-230 una fecha generada antes de la pausa da DATE_NOT_SKIPPED', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId);

    const error = await rejectionOf(
      recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, { registerDates: [LAST_GENERATED] }),
    );

    expect(error.code).toBe('DATE_NOT_SKIPPED');
    expect(await transactionsOf(userId)).toEqual([]);
    expect((await ruleOf(rule.id))?.status).toBe('paused');
  });

  it('TASK-230 una fecha posterior al fin da DATE_NOT_SKIPPED', async () => {
    const userId = await newUser();
    const rule = await weeklyRule(userId, { end: { type: 'until', date: '2093-04-05' } });

    const error = await rejectionOf(
      recurring.resume(ctxAt(userId, RESUMED_AT), rule.id, { registerDates: ['2093-04-10'] }),
    );

    expect(error.code).toBe('DATE_NOT_SKIPPED');
    expect(await transactionsOf(userId)).toEqual([]);
  });

  it('TASK-230 no reanuda la regla de otro usuario', async () => {
    const ownerId = await newUser();
    const otherId = await newUser();
    const rule = await weeklyRule(ownerId);

    await rejectionOf(
      recurring.resume(ctxAt(otherId, RESUMED_AT), rule.id, { registerDates: SKIPPED }),
    );

    expect(await transactionsOf(ownerId)).toEqual([]);
    expect(await transactionsOf(otherId)).toEqual([]);
    expect((await ruleOf(rule.id))?.status).toBe('paused');
  });
});
