import type { CreateDebtInput, DebtDto, DebtsSummaryDto } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createCurrenciesService } from '../../src/application/services/currencies.service.js';
import { createDashboardService } from '../../src/application/services/dashboard.service.js';
import {
  createRatesService,
  type RatesContext,
  type RatesService,
} from '../../src/application/services/rates.service.js';
import { createLedgerHooks, type LedgerHooks } from '../../src/application/shared/ledger-hooks.js';
import { createAccountRepository } from '../../src/infrastructure/persistence/repositories/account.repository.js';
import { createCategoryRepository } from '../../src/infrastructure/persistence/repositories/category.repository.js';
import { createCurrencyRepository } from '../../src/infrastructure/persistence/repositories/currency.repository.js';
import { createDashboardRepository } from '../../src/infrastructure/persistence/repositories/dashboard.repository.js';
import { createDebtPaymentRepository } from '../../src/infrastructure/persistence/repositories/debt-payment.repository.js';
import { createDebtRepository } from '../../src/infrastructure/persistence/repositories/debt.repository.js';
import { createGoalAllocationRepository } from '../../src/infrastructure/persistence/repositories/goal-allocation.repository.js';
import { createGoalRepository } from '../../src/infrastructure/persistence/repositories/goal.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createMarketRateRepository } from '../../src/infrastructure/persistence/repositories/market-rate.repository.js';
import { createUndoActionRepository } from '../../src/infrastructure/persistence/repositories/undo-action.repository.js';
import { createUserFxEventRepository } from '../../src/infrastructure/persistence/repositories/user-fx-event.repository.js';
import { createUserSettingsRepository } from '../../src/infrastructure/persistence/repositories/user-settings.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount, type CreateAccountOptions } from '../factories/account.factory.js';
import { createDebt, findStoredDebt } from '../factories/debt.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { countTransactionsOf, findStoredTransaction } from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `GET /api/debts?view=debt|person` and `POST /api/debts` (plan §4.13.2), the
 * contracts `CreateDebtInput`, `DebtDto` and `DebtsSummaryDto` (plan §4.13.1) and the request context
 * `{ userId, timezone, now, traceId }` (plan §1.4). It does not fix how the service is built. These
 * tests assume, like those of `GoalsService` and `TransactionsService`:
 * - `createDebtsService({ uow, rates, ledgerHooks })` builds it over the `UnitOfWork`, the
 *   `RatesService` and the `LedgerHooks`; `BalanceGuard` is `application/shared/balance-guard.ts`.
 * - `create(ctx, input)` resolves to `{ created, debt }`: `created` is `true` for a new debt and
 *   `false` when the id already existed with the same data (ADR-11); `debt` is a `DebtDto`.
 * - `list(ctx, view)` resolves to `{ debts, summary }`: the user's `DebtDto`s with the interest
 *   carried to today (without writing) and the `DebtsSummaryDto`; with `view = 'person'` the summary
 *   brings `byPerson`.
 * - Amounts are decimal text with two decimals (ADR-03). Errors are `AppError`s with the code of
 *   the catalogue (ADR-09); another user's account does not exist (`NOT_FOUND`, RN-09).
 * - The initial movement in a BOB↔USD pair keeps the declared rate as `rate_usd_bob` (plan §4.6.1,
 *   "Convención de la tasa declarada"), and its account amount is the debt amount by the rate,
 *   rounded half up to two decimals (RF-M13-09).
 * - Debts register their check in `CurrencyUsage` as the module `debts` (plan §4.3.3).
 *
 * `market_rate` is global (ADR-12): the file saves its rows, empties the table before each test
 * and puts the rows back at the end.
 */
interface DebtsListResult {
  debts: DebtDto[];
  summary: DebtsSummaryDto;
}

interface DebtsServiceUnderTest {
  create(ctx: RatesContext, input: CreateDebtInput): Promise<{ created: boolean; debt: DebtDto }>;
  list(ctx: RatesContext, view: 'debt' | 'person'): Promise<DebtsListResult>;
}

type CreateDebtsService = (deps: {
  uow: UnitOfWork;
  rates: RatesService;
  ledgerHooks: LedgerHooks;
}) => DebtsServiceUnderTest;

const { createDebtsService } =
  (await import('../../src/application/services/debts.service.js')) as unknown as {
    createDebtsService: CreateDebtsService;
  };

interface DashboardCards {
  cards(ctx: RatesContext, month: string): Promise<{ cards: { income: string; expense: string } }>;
}

const NIL_USER = '00000000-0000-0000-0000-000000000000';
const prisma = testPrisma();

const uow: UnitOfWork = createUnitOfWork(prisma, (tx, userId) => ({
  marketRates: createMarketRateRepository(tx),
  currencies: createCurrencyRepository(tx, userId ?? NIL_USER),
  userFxEvents: createUserFxEventRepository(tx, userId ?? NIL_USER),
  userSettings: createUserSettingsRepository(tx),
  accounts: createAccountRepository(tx, userId ?? NIL_USER),
  ledger: createLedgerRepository(tx, userId ?? NIL_USER),
  undoActions: createUndoActionRepository(tx, userId ?? NIL_USER),
  categories: createCategoryRepository(tx, userId ?? NIL_USER),
  dashboard: createDashboardRepository(tx, userId ?? NIL_USER),
  debts: createDebtRepository(tx, userId ?? NIL_USER),
  debtPayments: createDebtPaymentRepository(tx, userId ?? NIL_USER),
  goals: createGoalRepository(tx, userId ?? NIL_USER),
  goalAllocations: createGoalAllocationRepository(tx, userId ?? NIL_USER),
}));

const rates = createRatesService({ uow });
const debts = createDebtsService({ uow, rates, ledgerHooks: createLedgerHooks() });
const dashboard = createDashboardService({ uow }) as unknown as DashboardCards;
const currencies = createCurrenciesService({ uow, ids: { next: () => uuidv7() } });

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z'); // 12:00 in La Paz
const TODAY = '2090-06-15';

interface SavedRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

let savedRates: SavedRate[] = [];
const usedUserIds: string[] = [];

beforeAll(async () => {
  savedRates = await prisma.$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate`;
});

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate`;
  await marketOn('2090-01-01', '10.40');
  await marketOn(TODAY, '10.40');
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate`;
  for (const row of savedRates) {
    await prisma.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
  if (usedUserIds.length > 0) {
    await prisma.$executeRaw`DELETE FROM debt WHERE user_id = ANY(${usedUserIds}::uuid[])`;
  }
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

type Kind = 'parallel_bid' | 'parallel_ask' | 'parallel_median' | 'official';

async function marketRate(kind: Kind, rateDate: string, value: string): Promise<void> {
  const source = kind === 'official' ? 'bcb' : 'paralelo_bo';
  await prisma.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${kind}::market_rate_kind, ${rateDate}::date, ${value}::numeric,
            ${new Date(`${rateDate}T12:00:00Z`)}, ${source}::rate_source)`;
}

/** Parallel bid, ask and median and the official rate of that day. */
async function marketOn(rateDate: string, median: string): Promise<void> {
  const value = new Decimal(median);
  await marketRate('parallel_bid', rateDate, value.minus('0.10').toFixed(2));
  await marketRate('parallel_ask', rateDate, value.plus('0.10').toFixed(2));
  await marketRate('parallel_median', rateDate, median);
  await marketRate('official', rateDate, '6.96');
}

const ctxFor = (userId: string): RatesContext => ({
  userId,
  timezone: TZ,
  now: NOW,
  traceId: uuidv7(),
});

async function newUser(): Promise<string> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  return user.id;
}

async function newAccount(userId: string, options: CreateAccountOptions = {}): Promise<string> {
  const account = await createAccount(userId, { initialBalanceDate: '2090-01-01', ...options });
  return account.id;
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

function debtInput(overrides: Partial<CreateDebtInput> = {}): CreateDebtInput {
  return {
    id: uuidv7(),
    direction: 'i_owe',
    person: 'Juan',
    principal: '1000.00',
    currencyCode: 'BOB',
    startDate: TODAY,
    ...overrides,
  };
}

async function countDebts(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM debt WHERE user_id = ${userId}::uuid`;
  return rows[0]?.n ?? 0;
}

/** Current balance of the account through the ledger (RN-01). */
async function balanceOf(userId: string, accountId: string): Promise<string> {
  const balances = await uow.run((repos: Repositories) => repos.ledger.balances([accountId]), {
    userLock: userId,
    readOnly: true,
  });
  return (balances.get(accountId) ?? new Decimal(NaN)).toFixed(2);
}

async function systemKeyOf(categoryId: string | null): Promise<string | null> {
  if (categoryId === null) {
    return null;
  }
  const rows = await prisma.$queryRaw<{ key: string | null; kind: string }[]>`
    SELECT system_key::text AS key, kind::text AS kind FROM category WHERE id = ${categoryId}::uuid`;
  return rows[0]?.key ?? null;
}

async function originIdOf(transactionId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ originId: string | null }[]>`
    SELECT origin_id::text AS "originId" FROM ledger_transaction WHERE id = ${transactionId}::uuid`;
  return rows[0]?.originId ?? null;
}

const findDebt = (result: DebtsListResult, id: string): DebtDto | undefined =>
  result.debts.find((debt) => debt.id === id);

// ---------- Tests ----------

describe('DebtsService.create', () => {
  it('TASK-211 crea la deuda con capital_outstanding = principal y accrued_through = start_date', async () => {
    const userId = await newUser();
    const input = debtInput({ principal: '1200.00', startDate: '2090-03-10' });

    const result = await debts.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    expect(result.debt.id).toBe(input.id);
    const stored = await findStoredDebt(input.id);
    expect(stored).toMatchObject({
      userId,
      direction: 'i_owe',
      person: 'Juan',
      principal: '1200.00',
      status: 'active',
      capitalOutstanding: '1200.00',
      accruedThrough: '2090-03-10',
    });
    expect(new Decimal(stored?.interestUnpaid ?? 'NaN').isZero()).toBe(true);
  });

  it('TASK-211 crear es idempotente: dos create con el mismo id dejan una fila', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId);
    const input = debtInput({
      initialMovement: { transactionId: uuidv7(), accountId },
    });

    const first = await debts.create(ctxFor(userId), input);
    const second = await debts.create(ctxFor(userId), input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await countDebts(userId)).toBe(1);
    expect(await countTransactionsOf(userId)).toBe(1);
    expect(await balanceOf(userId, accountId)).toBe('1000.00');
  });

  it('RF-M13-01 una fecha de inicio posterior a hoy se rechaza y no se guarda nada', async () => {
    const userId = await newUser();

    const error = await rejectionOf(
      debts.create(ctxFor(userId), debtInput({ startDate: '2090-06-16' })),
    );

    expect([400, 422]).toContain(error.status);
    expect(await countDebts(userId)).toBe(0);
  });

  it('RF-M13-01 una fecha de inicio de hoy se acepta', async () => {
    const userId = await newUser();
    const input = debtInput({ startDate: TODAY });

    const result = await debts.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    expect((await findStoredDebt(input.id))?.accruedThrough).toBe(TODAY);
  });

  it('RNF-28 la deuda 201 da LIMIT_REACHED y no se crea', async () => {
    const userId = await newUser();
    for (let i = 0; i < 200; i += 1) {
      await createDebt(userId, { startDate: '2090-01-01' });
    }
    const input = debtInput();

    const error = await rejectionOf(debts.create(ctxFor(userId), input));

    expect(error.code).toBe('LIMIT_REACHED');
    expect(await findStoredDebt(input.id)).toBeNull();
    expect(await countDebts(userId)).toBe(200);
  });

  it('EC-M13-08 una deuda creada hoy con inicio el 1 de enero tiene interés desde el 1 de enero', async () => {
    const userId = await newUser();
    const input = debtInput({
      principal: '1000.00',
      startDate: '2090-01-01',
      interest: { rate: '12', period: 'yearly' },
    });

    const result = await debts.create(ctxFor(userId), input);
    const listed = findDebt(await debts.list(ctxFor(userId), 'debt'), input.id);

    // 165 days from 2090-01-01 to 2090-06-15: 1000 × 0.12 ÷ 365 × 165 = 54.2465…
    expect(result.debt.interestAccrued).toBe('54.25');
    expect(result.debt.capitalOutstanding).toBe('1000.00');
    expect(listed?.interestAccrued).toBe('54.25');
    expect(listed?.pending).toBe('1054.25');
    expect((await findStoredDebt(input.id))?.accruedThrough).toBe('2090-01-01');
  });

  it('RF-M13-08 el movimiento inicial de "Debo" es un ingreso en "Deudas y préstamos" que no cuenta en el Inicio', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { initialBalance: '100.00' });
    const transactionId = uuidv7();
    const input = debtInput({
      direction: 'i_owe',
      principal: '500.00',
      initialMovement: { transactionId, accountId },
    });

    await debts.create(ctxFor(userId), input);

    const stored = await findStoredTransaction(transactionId);
    expect(stored?.kind).toBe('income');
    expect(stored?.origin).toBe('debt_initial');
    expect(await systemKeyOf(stored?.categoryId ?? null)).toBe('debts');
    expect(await originIdOf(transactionId)).toBe(input.id);
    expect(stored?.entries.map((e) => [e.accountId, e.amount])).toEqual([[accountId, '500.00']]);
    expect(await balanceOf(userId, accountId)).toBe('600.00');
    const { cards } = await dashboard.cards(ctxFor(userId), '2090-06');
    expect(cards.income).toBe('0.00');
  });

  it('RF-M13-08 el movimiento inicial de "Me deben" es un gasto en "Deudas y préstamos" que no cuenta en el Inicio', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { initialBalance: '800.00' });
    const transactionId = uuidv7();
    const input = debtInput({
      direction: 'owed_to_me',
      principal: '300.00',
      initialMovement: { transactionId, accountId },
    });

    await debts.create(ctxFor(userId), input);

    const stored = await findStoredTransaction(transactionId);
    expect(stored?.kind).toBe('expense');
    expect(stored?.origin).toBe('debt_initial');
    expect(await systemKeyOf(stored?.categoryId ?? null)).toBe('debts');
    expect(stored?.entries.map((e) => [e.accountId, e.amount])).toEqual([[accountId, '-300.00']]);
    expect(await balanceOf(userId, accountId)).toBe('500.00');
    const { cards } = await dashboard.cards(ctxFor(userId), '2090-06');
    expect(cards.expense).toBe('0.00');
  });

  it('TASK-211 un movimiento inicial que deja el efectivo en negativo da NEGATIVE_BALANCE y no guarda nada', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { type: 'cash', initialBalance: '100.00' });
    const input = debtInput({
      direction: 'owed_to_me',
      principal: '500.00',
      initialMovement: { transactionId: uuidv7(), accountId },
    });

    const error = await rejectionOf(debts.create(ctxFor(userId), input));

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(await findStoredDebt(input.id)).toBeNull();
    expect(await countTransactionsOf(userId)).toBe(0);
    expect(await balanceOf(userId, accountId)).toBe('100.00');
  });

  it('RF-M13-09 con la cuenta en otra moneda guarda la tasa declarada y el monto convertido sin residuo', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { currencyCode: 'BOB' });
    const transactionId = uuidv7();
    const input = debtInput({
      direction: 'i_owe',
      principal: '123.45',
      currencyCode: 'USD',
      initialMovement: { transactionId, accountId, declaredRate: '6.97' },
    });

    await debts.create(ctxFor(userId), input);

    // 123.45 USD × 6.97 = 860.4465 Bs -> 860.45 in the account; the debt keeps 123.45 USD.
    const stored = await findStoredTransaction(transactionId);
    expect(stored?.rateUsdBob).toBe('6.97');
    expect(stored?.rateCurBob).toBe('1.00');
    expect(stored?.entries.map((e) => [e.accountId, e.amount])).toEqual([[accountId, '860.45']]);
    const debt = await findStoredDebt(input.id);
    expect(debt?.principal).toBe('123.45');
    expect(debt?.capitalOutstanding).toBe('123.45');
  });

  it('RN-09 la cuenta de otro usuario no existe para el movimiento inicial (NOT_FOUND)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const accountId = await newAccount(owner, { initialBalance: '100.00' });
    const input = debtInput({ initialMovement: { transactionId: uuidv7(), accountId } });

    const error = await rejectionOf(debts.create(ctxFor(other), input));

    expect(error.code).toBe('NOT_FOUND');
    expect(await findStoredDebt(input.id)).toBeNull();
    expect(await balanceOf(owner, accountId)).toBe('100.00');
  });
});

describe('DebtsService.list y resumen', () => {
  it('RF-M13-02 el interés mensual se calcula al día al leer, sin escribir', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '1000.00',
      startDate: '2090-06-05',
      interestRate: '10',
      interestPeriod: 'monthly',
    });

    const listed = findDebt(await debts.list(ctxFor(userId), 'debt'), debt.id);

    // 10 days × 1000 × 0.10 ÷ 30 = 33.333…
    expect(listed?.capitalOutstanding).toBe('1000.00');
    expect(listed?.interestAccrued).toBe('33.33');
    expect(listed?.pending).toBe('1033.33');
    const stored = await findStoredDebt(debt.id);
    expect(stored?.accruedThrough).toBe('2090-06-05');
    expect(new Decimal(stored?.interestUnpaid ?? 'NaN').isZero()).toBe(true);
  });

  it('RF-M13-02 el interés anual usa la tasa ÷ 365 y se suma al ya acumulado sin redondearlo antes', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '1000.00',
      startDate: '2090-01-01',
      interestRate: '36.5',
      interestPeriod: 'yearly',
      interestUnpaid: '0.0040000000',
      accruedThrough: '2090-06-05',
    });

    const listed = findDebt(await debts.list(ctxFor(userId), 'debt'), debt.id);

    // 0.004 + 10 days × 1000 × 0.365 ÷ 365 = 10.004 -> 10.00
    expect(listed?.interestAccrued).toBe('10.00');
    expect(listed?.pending).toBe('1010.00');
    expect((await findStoredDebt(debt.id))?.interestUnpaid).toBe('0.0040000000');
  });

  it('RF-M13-13 el resumen da el total que se debe y el que deben al usuario', async () => {
    const userId = await newUser();
    await createDebt(userId, { direction: 'i_owe', person: 'Ana', principal: '300.00' });
    await createDebt(userId, { direction: 'i_owe', person: 'Luis', principal: '200.00' });
    await createDebt(userId, { direction: 'owed_to_me', person: 'Eva', principal: '450.00' });

    const { summary } = await debts.list(ctxFor(userId), 'debt');

    expect(summary.iOwe).toBe('500.00');
    expect(summary.owedToMe).toBe('450.00');
  });

  it('RF-M13-13 el resumen convierte a la base con la referencia vigente', async () => {
    const userId = await newUser();
    await createDebt(userId, { direction: 'i_owe', principal: '100.00', currencyCode: 'USD' });
    await createDebt(userId, { direction: 'i_owe', principal: '50.00', currencyCode: 'BOB' });
    const rate = await rates.currentRateFor(ctxFor(userId), 'USD');
    expect(rate).not.toBeNull();

    const { summary } = await debts.list(ctxFor(userId), 'debt');

    const expected = new Decimal(100)
      .times(rate ?? 0)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .plus(50)
      .toFixed(2);
    expect(summary.iOwe).toBe(expected);
    expect(summary.owedToMe).toBe('0.00');
  });

  it('EC-M13-06 la misma persona en "Debo" y "Me deben" muestra el neto en la vista por persona', async () => {
    const userId = await newUser();
    await createDebt(userId, { direction: 'i_owe', person: 'José', principal: '300.00' });
    await createDebt(userId, { direction: 'owed_to_me', person: 'jose', principal: '500.00' });

    const { summary } = await debts.list(ctxFor(userId), 'person');

    const people = summary.byPerson ?? [];
    expect(people).toHaveLength(1);
    expect(people[0]?.personKey).toBe('jose');
    expect(new Decimal(people[0]?.net ?? 'NaN').abs().toFixed(2)).toBe('200.00');
    expect(summary.iOwe).toBe('300.00');
    expect(summary.owedToMe).toBe('500.00');
  });

  it('RF-M13-13 la vista por persona agrupa sin distinguir mayúsculas ni tildes y separa personas distintas', async () => {
    const userId = await newUser();
    await createDebt(userId, { direction: 'owed_to_me', person: 'María', principal: '100.00' });
    await createDebt(userId, { direction: 'owed_to_me', person: 'MARIA', principal: '50.00' });
    await createDebt(userId, { direction: 'owed_to_me', person: 'Pedro', principal: '70.00' });

    const { summary } = await debts.list(ctxFor(userId), 'person');

    const byKey = Object.fromEntries(
      (summary.byPerson ?? []).map((row) => [row.personKey, new Decimal(row.net).abs().toFixed(2)]),
    );
    expect(byKey).toEqual({ maria: '150.00', pedro: '70.00' });
  });

  it('RN-09 un usuario no ve las deudas de otro', async () => {
    const owner = await newUser();
    const other = await newUser();
    const debt = await createDebt(owner, { principal: '900.00' });

    const otherList = await debts.list(ctxFor(other), 'person');
    const ownerList = await debts.list(ctxFor(owner), 'debt');

    expect(otherList.debts.map((d) => d.id)).not.toContain(debt.id);
    expect(otherList.summary.iOwe).toBe('0.00');
    expect(ownerList.debts.map((d) => d.id)).toContain(debt.id);
  });
});

describe('DebtsService: uso de monedas', () => {
  it('EC-M3-05 desactivar la moneda de una deuda activa da CURRENCY_IN_USE con debts', async () => {
    const userId = await newUser();
    await currencies.create(
      { userId, timezone: TZ, now: NOW },
      { code: 'EUR', symbol: 'EUR', rate: new Decimal('7.50') },
    );
    await createDebt(userId, { currencyCode: 'EUR' });

    const error = await rejectionOf(
      currencies.deactivate({ userId, timezone: TZ, now: NOW }, 'EUR'),
    );

    expect(error.code).toBe('CURRENCY_IN_USE');
    expect(error.data?.['usedBy']).toContain('debts');
  });

  it('EC-M3-05 una deuda pagada no impide desactivar su moneda', async () => {
    const userId = await newUser();
    await currencies.create(
      { userId, timezone: TZ, now: NOW },
      { code: 'EUR', symbol: 'EUR', rate: new Decimal('7.50') },
    );
    await createDebt(userId, { currencyCode: 'EUR', status: 'paid', capitalOutstanding: '0.00' });

    await currencies.deactivate({ userId, timezone: TZ, now: NOW }, 'EUR');

    const rows = await prisma.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM currency
       WHERE user_id = ${userId}::uuid AND code = 'EUR'`;
    expect(rows[0]?.status).toBe('inactive');
  });
});
