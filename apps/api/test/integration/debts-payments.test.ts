import type { DebtDto, DebtsSummaryDto, PaymentInput } from '@finanzas/contracts';
import { proposeSplit } from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
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
import {
  createDebt,
  findStoredDebt,
  storedPaymentIdsOf,
  type CreateDebtOptions,
} from '../factories/debt.factory.js';
import { createAllocationEvent, createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { countTransactionsOf, findStoredTransaction } from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `POST /api/debts/:id/payments` (plan §4.13.2), its errors, the contract
 * `PaymentInput` (plan §4.13.1) and the payment of plan §4.13.3. It does not fix the method of
 * `DebtsService` behind the endpoint. These tests assume, like `create` (TASK-211):
 * - `pay(ctx, debtId, input)` registers the payment `input` (a `PaymentInput`) on the debt and
 *   resolves to `{ created, debt }`: `created` is `true` for a new payment and `false` when its id
 *   already existed (ADR-11, RNF-11); `debt` is the `DebtDto` after the payment.
 * - Errors are `AppError`s with the code of the catalogue (ADR-09): `PAYMENT_EXCEEDS_BALANCE`
 *   (422, `data.pending`), `SPLIT_INVALID` (422, `data.reason`), `DEBT_CLOSED` (409),
 *   `NEGATIVE_BALANCE` and `EARMARK_CONFIRMATION_REQUIRED` (409). Another user's debt or account
 *   does not exist (`NOT_FOUND`, RN-09). A rejected payment saves nothing.
 * - The linked transactions use the ids of `input.account` (`capitalTransactionId` and
 *   `interestTransactionId`), with `origin = debt_payment`: capital in the system category
 *   "Deudas y préstamos" (`debts`) and interest in "Intereses" (`debts_interest`).
 * - In a BOB↔USD pair the declared rate is kept as `rate_usd_bob` (plan §4.6.1), like the initial
 *   movement of TASK-211.
 *
 * `market_rate` is global (ADR-12): the file saves its rows, empties the table before each test
 * and puts the rows back at the end.
 */
interface DebtsListResult {
  debts: DebtDto[];
  summary: DebtsSummaryDto;
}

interface DebtsServiceUnderTest {
  pay(
    ctx: RatesContext,
    debtId: string,
    input: PaymentInput,
  ): Promise<{ created: boolean; debt: DebtDto }>;
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
  await deleteGoalsOf(usedUserIds);
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

const ctxAt = (userId: string, now: Date): RatesContext => ({
  userId,
  timezone: TZ,
  now,
  traceId: uuidv7(),
});

const ctxFor = (userId: string): RatesContext => ctxAt(userId, NOW);

async function newUser(): Promise<string> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  return user.id;
}

async function newAccount(userId: string, options: CreateAccountOptions = {}): Promise<string> {
  const account = await createAccount(userId, {
    type: 'bank',
    initialBalance: '5000.00',
    initialBalanceDate: '2090-01-01',
    ...options,
  });
  return account.id;
}

/** A debt with `interestUnpaid` already carried to today, so nothing more accrues before paying. */
async function debtWithInterestToday(
  userId: string,
  options: CreateDebtOptions = {},
): Promise<string> {
  const debt = await createDebt(userId, {
    principal: '2000.00',
    startDate: '2090-01-01',
    interestRate: '2',
    interestPeriod: 'monthly',
    interestUnpaid: '42.30',
    accruedThrough: TODAY,
    ...options,
  });
  return debt.id;
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

function paymentInput(overrides: Partial<PaymentInput> = {}): PaymentInput {
  return {
    id: uuidv7(),
    amount: '100.00',
    interestPart: '0.00',
    capitalPart: '100.00',
    date: TODAY,
    ...overrides,
  };
}

interface LinkedIds {
  capitalTransactionId: string;
  interestTransactionId: string;
}

function linkedIds(): LinkedIds {
  return { capitalTransactionId: uuidv7(), interestTransactionId: uuidv7() };
}

/** A `debt_payment` row as it is stored. */
interface StoredPayment {
  id: string;
  amount: string;
  interestPart: string;
  capitalPart: string;
  date: string;
  accountId: string | null;
  declaredRate: string | null;
  accountAmount: string | null;
  capitalTransactionId: string | null;
  interestTransactionId: string | null;
}

async function findStoredPayment(id: string): Promise<StoredPayment | null> {
  const rows = await prisma.$queryRaw<StoredPayment[]>`
    SELECT id::text AS id, amount::text AS amount, interest_part::text AS "interestPart",
           capital_part::text AS "capitalPart", to_char(date, 'YYYY-MM-DD') AS date,
           account_id::text AS "accountId", declared_rate::text AS "declaredRate",
           account_amount::text AS "accountAmount",
           capital_transaction_id::text AS "capitalTransactionId",
           interest_transaction_id::text AS "interestTransactionId"
      FROM debt_payment
     WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
}

/** Current balance of the account through the ledger (RN-01). */
async function balanceOf(userId: string, accountId: string): Promise<string> {
  const balances = await uow.run((repos: Repositories) => repos.ledger.balances([accountId]), {
    userLock: userId,
    readOnly: true,
  });
  return (balances.get(accountId) ?? new Decimal(NaN)).toFixed(2);
}

async function earmarkedOf(userId: string, accountId: string): Promise<string> {
  const rows = await uow.run(
    (repos: Repositories) => repos.goalAllocations.earmarkedByAccount(accountId),
    { userLock: userId },
  );
  return rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2);
}

async function systemKeyOf(categoryId: string | null): Promise<string | null> {
  if (categoryId === null) {
    return null;
  }
  const rows = await prisma.$queryRaw<{ key: string | null }[]>`
    SELECT system_key::text AS key FROM category WHERE id = ${categoryId}::uuid`;
  return rows[0]?.key ?? null;
}

const findDebt = (result: DebtsListResult, id: string): DebtDto | undefined =>
  result.debts.find((debt) => debt.id === id);

/** Asserts a rejected payment left the debt, its payments and the ledger untouched. */
async function expectNothingSaved(
  userId: string,
  debtId: string,
  capitalOutstanding: string,
): Promise<void> {
  expect(await storedPaymentIdsOf(debtId)).toEqual([]);
  expect((await findStoredDebt(debtId))?.capitalOutstanding).toBe(capitalOutstanding);
  expect(await countTransactionsOf(userId)).toBe(0);
}

// ---------- Tests ----------

describe('DebtsService.pay: interés y desglose', () => {
  it('RF-M13-04 Interés sobre el capital pendiente: después de pagar 1.000 el interés corre sobre 1.000 y lo acumulado antes no cambia', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      direction: 'i_owe',
      principal: '2000.00',
      startDate: '2090-06-05',
      interestRate: '2',
      interestPeriod: 'monthly',
    });

    // A payment dated in the past still reduces the capital only from when it is registered.
    const result = await debts.pay(
      ctxFor(userId),
      debt.id,
      paymentInput({
        amount: '1000.00',
        interestPart: '0.00',
        capitalPart: '1000.00',
        date: '2090-06-06',
      }),
    );

    // 10 days × 2000 × 0.02 ÷ 30 = 13.333… accrued before the payment, carried to today.
    const stored = await findStoredDebt(debt.id);
    expect(stored?.capitalOutstanding).toBe('1000.00');
    expect(stored?.accruedThrough).toBe(TODAY);
    expect(stored?.interestUnpaid).toBe('13.3333333333');
    expect(result.debt.capitalOutstanding).toBe('1000.00');
    expect(result.debt.interestAccrued).toBe('13.33');
    expect(result.debt.pending).toBe('1013.33');

    // 10 days later: 13.333… + 10 × 1000 × 0.02 ÷ 30 = 20.00.
    const later = findDebt(
      await debts.list(ctxAt(userId, new Date('2090-06-25T16:00:00Z')), 'debt'),
      debt.id,
    );
    expect(later?.capitalOutstanding).toBe('1000.00');
    expect(later?.interestAccrued).toBe('20.00');
    expect(later?.pending).toBe('1020.00');
  });

  it('RF-M13-04 pagar interés lo resta del acumulado al día sin recalcular el resto', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '2000.00',
      startDate: '2090-06-05',
      interestRate: '2',
      interestPeriod: 'monthly',
    });

    await debts.pay(
      ctxFor(userId),
      debt.id,
      paymentInput({ amount: '10.00', interestPart: '10.00', capitalPart: '0.00' }),
    );

    const stored = await findStoredDebt(debt.id);
    expect(stored?.capitalOutstanding).toBe('2000.00');
    expect(stored?.interestUnpaid).toBe('3.3333333333');
    expect(stored?.accruedThrough).toBe(TODAY);
  });

  it('RF-M13-05 Desglose precargado: interés 42,30 y capital 457,70, y al guardar desde el Banco 42,30 cuentan como gasto en "Intereses"', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { type: 'bank', initialBalance: '5000.00' });
    const debtId = await debtWithInterestToday(userId, { direction: 'i_owe' });
    const listed = findDebt(await debts.list(ctxFor(userId), 'debt'), debtId);
    expect(listed?.interestAccrued).toBe('42.30');
    expect(listed?.capitalOutstanding).toBe('2000.00');

    const split = proposeSplit(
      new Decimal('500.00'),
      new Decimal(listed?.interestAccrued ?? 'NaN'),
      new Decimal(listed?.capitalOutstanding ?? 'NaN'),
    );
    expect(split.interestPart.toFixed(2)).toBe('42.30');
    expect(split.capitalPart.toFixed(2)).toBe('457.70');

    const ids = linkedIds();
    const input = paymentInput({
      amount: '500.00',
      interestPart: split.interestPart.toFixed(2),
      capitalPart: split.capitalPart.toFixed(2),
      account: { accountId, ...ids },
    });
    const result = await debts.pay(ctxFor(userId), debtId, input);

    expect(result.created).toBe(true);
    const interest = await findStoredTransaction(ids.interestTransactionId);
    expect(interest?.kind).toBe('expense');
    expect(interest?.origin).toBe('debt_payment');
    expect(await systemKeyOf(interest?.categoryId ?? null)).toBe('debts_interest');
    expect(interest?.entries.map((e) => [e.accountId, e.amount])).toEqual([[accountId, '-42.30']]);
    const { cards } = await dashboard.cards(ctxFor(userId), '2090-06');
    expect(cards.expense).toBe('42.30');
  });

  it('RF-M13-08 en "Debo" el capital es un gasto en "Deudas y préstamos" que no cuenta en el Inicio', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { initialBalance: '5000.00' });
    const debtId = await debtWithInterestToday(userId, { direction: 'i_owe' });
    const ids = linkedIds();

    await debts.pay(
      ctxFor(userId),
      debtId,
      paymentInput({
        amount: '500.00',
        interestPart: '42.30',
        capitalPart: '457.70',
        account: { accountId, ...ids },
      }),
    );

    const capital = await findStoredTransaction(ids.capitalTransactionId);
    expect(capital?.kind).toBe('expense');
    expect(capital?.origin).toBe('debt_payment');
    expect(await systemKeyOf(capital?.categoryId ?? null)).toBe('debts');
    expect(capital?.entries.map((e) => [e.accountId, e.amount])).toEqual([[accountId, '-457.70']]);
    expect(await balanceOf(userId, accountId)).toBe('4500.00');
    const { cards } = await dashboard.cards(ctxFor(userId), '2090-06');
    expect(cards.expense).toBe('42.30');
    expect(cards.income).toBe('0.00');
  });

  it('RF-M13-08 en "Me deben" el interés es un ingreso en "Intereses" que cuenta y el capital un ingreso que no cuenta', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { initialBalance: '100.00' });
    const debtId = await debtWithInterestToday(userId, { direction: 'owed_to_me' });
    const ids = linkedIds();

    await debts.pay(
      ctxFor(userId),
      debtId,
      paymentInput({
        amount: '500.00',
        interestPart: '42.30',
        capitalPart: '457.70',
        account: { accountId, ...ids },
      }),
    );

    const interest = await findStoredTransaction(ids.interestTransactionId);
    const capital = await findStoredTransaction(ids.capitalTransactionId);
    expect(interest?.kind).toBe('income');
    expect(await systemKeyOf(interest?.categoryId ?? null)).toBe('debts_interest');
    expect(interest?.entries.map((e) => e.amount)).toEqual(['42.30']);
    expect(capital?.kind).toBe('income');
    expect(await systemKeyOf(capital?.categoryId ?? null)).toBe('debts');
    expect(capital?.entries.map((e) => e.amount)).toEqual(['457.70']);
    expect(await balanceOf(userId, accountId)).toBe('600.00');
    const { cards } = await dashboard.cards(ctxFor(userId), '2090-06');
    expect(cards.income).toBe('42.30');
    expect(cards.expense).toBe('0.00');
  });

  it('TASK-212 el pago resta del capital y del interés y queda guardado con sus transacciones vinculadas', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId);
    const debtId = await debtWithInterestToday(userId);
    const ids = linkedIds();
    const input = paymentInput({
      amount: '500.00',
      interestPart: '42.30',
      capitalPart: '457.70',
      account: { accountId, ...ids },
      note: 'Cuota de junio',
    });

    const result = await debts.pay(ctxFor(userId), debtId, input);

    const stored = await findStoredDebt(debtId);
    expect(stored?.capitalOutstanding).toBe('1542.30');
    expect(new Decimal(stored?.interestUnpaid ?? 'NaN').isZero()).toBe(true);
    expect(stored?.status).toBe('active');
    expect(await findStoredPayment(input.id)).toMatchObject({
      amount: '500.00',
      interestPart: '42.30',
      capitalPart: '457.70',
      date: TODAY,
      accountId,
      capitalTransactionId: ids.capitalTransactionId,
      interestTransactionId: ids.interestTransactionId,
    });
    expect(result.debt.payments.map((p) => p.id)).toEqual([input.id]);
    expect(result.debt.pending).toBe('1542.30');
  });

  it('TASK-212 un pago sin cuenta no crea movimientos', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, { principal: '1000.00' });
    const input = paymentInput({ amount: '300.00', interestPart: '0.00', capitalPart: '300.00' });

    await debts.pay(ctxFor(userId), debt.id, input);

    expect(await storedPaymentIdsOf(debt.id)).toEqual([input.id]);
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('700.00');
    expect(await countTransactionsOf(userId)).toBe(0);
  });

  it('TASK-212 la deuda pasa a pagada cuando el capital y el interés quedan en 0', async () => {
    const userId = await newUser();
    const debtId = await debtWithInterestToday(userId, { principal: '300.00' });

    const result = await debts.pay(
      ctxFor(userId),
      debtId,
      paymentInput({ amount: '342.30', interestPart: '42.30', capitalPart: '300.00' }),
    );

    expect(result.debt.status).toBe('paid');
    expect(result.debt.pending).toBe('0.00');
    const stored = await findStoredDebt(debtId);
    expect(stored?.status).toBe('paid');
    expect(new Decimal(stored?.capitalOutstanding ?? 'NaN').isZero()).toBe(true);
    expect(new Decimal(stored?.interestUnpaid ?? 'NaN').isZero()).toBe(true);
  });

  it('RF-M13-05 una parte de interés mayor que el interés acumulado da SPLIT_INVALID', async () => {
    const userId = await newUser();
    const debtId = await debtWithInterestToday(userId);

    const error = await rejectionOf(
      debts.pay(
        ctxFor(userId),
        debtId,
        paymentInput({ amount: '100.00', interestPart: '50.00', capitalPart: '50.00' }),
      ),
    );

    expect(error.code).toBe('SPLIT_INVALID');
    expect(error.status).toBe(422);
    expect(error.data).toHaveProperty('reason');
    await expectNothingSaved(userId, debtId, '2000.00');
  });

  it('RF-M13-05 una parte de capital mayor que el capital pendiente da SPLIT_INVALID', async () => {
    const userId = await newUser();
    const debtId = await debtWithInterestToday(userId, {
      principal: '1000.00',
      capitalOutstanding: '100.00',
    });

    const error = await rejectionOf(
      debts.pay(
        ctxFor(userId),
        debtId,
        paymentInput({ amount: '120.00', interestPart: '0.00', capitalPart: '120.00' }),
      ),
    );

    expect(error.code).toBe('SPLIT_INVALID');
    await expectNothingSaved(userId, debtId, '100.00');
  });

  it('RF-M13-05 un desglose cuya suma no es el monto del pago da SPLIT_INVALID', async () => {
    const userId = await newUser();
    const debtId = await debtWithInterestToday(userId);

    const error = await rejectionOf(
      debts.pay(
        ctxFor(userId),
        debtId,
        paymentInput({ amount: '100.00', interestPart: '10.00', capitalPart: '80.00' }),
      ),
    );

    expect(error.code).toBe('SPLIT_INVALID');
    await expectNothingSaved(userId, debtId, '2000.00');
  });
});

describe('DebtsService.pay: saldo y fecha', () => {
  it('EC-M13-01 un pago mayor que el saldo pendiente da PAYMENT_EXCEEDS_BALANCE con el saldo', async () => {
    const userId = await newUser();
    const debtId = await debtWithInterestToday(userId, { principal: '1000.00' });

    const error = await rejectionOf(
      debts.pay(
        ctxFor(userId),
        debtId,
        paymentInput({ amount: '1042.31', interestPart: '42.30', capitalPart: '1000.01' }),
      ),
    );

    expect(error.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect(error.status).toBe(422);
    expect(error.data).toMatchObject({ pending: '1042.30' });
    await expectNothingSaved(userId, debtId, '1000.00');
  });

  it('RF-M13-06 el saldo pendiente es capital más interés no pagado y un pago por el saldo exacto se acepta', async () => {
    const userId = await newUser();
    const debtId = await debtWithInterestToday(userId, { principal: '1000.00' });

    const result = await debts.pay(
      ctxFor(userId),
      debtId,
      paymentInput({ amount: '1042.30', interestPart: '42.30', capitalPart: '1000.00' }),
    );

    expect(result.created).toBe(true);
    expect(result.debt.pending).toBe('0.00');
  });

  it('RF-M13-06 sin interés, un pago de un centavo más que el capital da PAYMENT_EXCEEDS_BALANCE', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, { principal: '1000.00' });

    const error = await rejectionOf(
      debts.pay(
        ctxFor(userId),
        debt.id,
        paymentInput({ amount: '1000.01', interestPart: '0.00', capitalPart: '1000.01' }),
      ),
    );

    expect(error.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect(error.data).toMatchObject({ pending: '1000.00' });
    await expectNothingSaved(userId, debt.id, '1000.00');
  });

  it('RF-M13-07 una fecha anterior al inicio da SPLIT_INVALID', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, { principal: '1000.00', startDate: '2090-03-10' });

    const error = await rejectionOf(
      debts.pay(ctxFor(userId), debt.id, paymentInput({ date: '2090-03-09' })),
    );

    expect(error.code).toBe('SPLIT_INVALID');
    expect(error.status).toBe(422);
    await expectNothingSaved(userId, debt.id, '1000.00');
  });

  it('RF-M13-07 una fecha posterior a hoy se rechaza', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, { principal: '1000.00', startDate: '2090-03-10' });

    const error = await rejectionOf(
      debts.pay(ctxFor(userId), debt.id, paymentInput({ date: '2090-06-16' })),
    );

    expect([400, 422]).toContain(error.status);
    await expectNothingSaved(userId, debt.id, '1000.00');
  });

  it('RF-M13-07 la fecha de inicio y la de hoy son fechas válidas para un pago', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, { principal: '1000.00', startDate: '2090-03-10' });
    const first = paymentInput({ date: '2090-03-10' });
    const second = paymentInput({ date: TODAY });

    await debts.pay(ctxFor(userId), debt.id, first);
    await debts.pay(ctxFor(userId), debt.id, second);

    expect(await storedPaymentIdsOf(debt.id)).toEqual([first.id, second.id]);
    expect((await findStoredPayment(first.id))?.date).toBe('2090-03-10');
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('800.00');
  });

  it('TASK-212 una deuda pagada da DEBT_CLOSED', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, { status: 'paid', capitalOutstanding: '0.00' });

    const error = await rejectionOf(
      debts.pay(
        ctxFor(userId),
        debt.id,
        paymentInput({ amount: '0.01', interestPart: '0.00', capitalPart: '0.01' }),
      ),
    );

    expect(error.code).toBe('DEBT_CLOSED');
    expect(error.status).toBe(409);
    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
  });

  it('TASK-212 una deuda condonada da DEBT_CLOSED', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, { status: 'forgiven', principal: '500.00' });

    const error = await rejectionOf(debts.pay(ctxFor(userId), debt.id, paymentInput()));

    expect(error.code).toBe('DEBT_CLOSED');
    expect(error.status).toBe(409);
    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
    expect((await findStoredDebt(debt.id))?.status).toBe('forgiven');
  });
});

describe('DebtsService.pay: cuenta', () => {
  it('EC-M13-03 un pago que deja el efectivo en negativo da NEGATIVE_BALANCE y no guarda nada', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { type: 'cash', initialBalance: '100.00' });
    const debt = await createDebt(userId, { direction: 'i_owe', principal: '1000.00' });

    const error = await rejectionOf(
      debts.pay(
        ctxFor(userId),
        debt.id,
        paymentInput({
          amount: '500.00',
          interestPart: '0.00',
          capitalPart: '500.00',
          account: { accountId, ...linkedIds() },
        }),
      ),
    );

    expect(error.code).toBe('NEGATIVE_BALANCE');
    await expectNothingSaved(userId, debt.id, '1000.00');
    expect(await balanceOf(userId, accountId)).toBe('100.00');
  });

  it('EC-M13-04 un pago desde una cuenta con apartados pide confirmación y al reenviar con los retiros se guarda', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { type: 'bank', initialBalance: '4800.00' });
    const goal = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, accountId, { amount: '300.00' });
    const debt = await createDebt(userId, { direction: 'i_owe', principal: '5000.00' });
    const input = paymentInput({
      amount: '4600.00',
      interestPart: '0.00',
      capitalPart: '4600.00',
      account: { accountId, ...linkedIds() },
    });

    const error = await rejectionOf(debts.pay(ctxFor(userId), debt.id, input));

    expect(error.code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(error.status).toBe(409);
    expect(error.data).toMatchObject({ shortfall: '100.00' });
    await expectNothingSaved(userId, debt.id, '5000.00');
    expect(await earmarkedOf(userId, accountId)).toBe('300.00');

    await debts.pay(ctxFor(userId), debt.id, {
      ...input,
      earmarkWithdrawals: [{ goalId: goal.id, accountId, amount: '100.00' }],
    });

    expect(await storedPaymentIdsOf(debt.id)).toEqual([input.id]);
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('400.00');
    expect(await balanceOf(userId, accountId)).toBe('200.00');
    expect(await earmarkedOf(userId, accountId)).toBe('200.00');
  });

  it('RF-M13-09 con la cuenta en otra moneda guarda la tasa declarada y el monto de la cuenta sin residuo', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { currencyCode: 'BOB', initialBalance: '5000.00' });
    const debtId = await debtWithInterestToday(userId, {
      direction: 'i_owe',
      principal: '1000.00',
      currencyCode: 'USD',
      interestUnpaid: '10.10',
    });
    const ids = linkedIds();
    const input = paymentInput({
      amount: '110.40',
      interestPart: '10.10',
      capitalPart: '100.30',
      account: { accountId, declaredRate: '6.95', ...ids },
    });

    await debts.pay(ctxFor(userId), debtId, input);

    // 110.40 USD × 6.95 = 767.28 Bs. Rounding each part apart would give 70.20 + 697.09 = 767.29.
    const payment = await findStoredPayment(input.id);
    expect(payment?.declaredRate).toBe('6.95');
    expect(payment?.accountAmount).toBe('767.28');
    const interest = await findStoredTransaction(ids.interestTransactionId);
    const capital = await findStoredTransaction(ids.capitalTransactionId);
    const entries = [...(interest?.entries ?? []), ...(capital?.entries ?? [])];
    expect(entries.every((e) => e.accountId === accountId)).toBe(true);
    expect(entries.reduce((sum, e) => sum.plus(e.amount), new Decimal(0)).toFixed(2)).toBe(
      '-767.28',
    );
    expect(capital?.rateUsdBob).toBe('6.95');
    expect(capital?.rateCurBob).toBe('1.00');
    expect(await balanceOf(userId, accountId)).toBe('4232.72');
    const debt = await findStoredDebt(debtId);
    expect(debt?.capitalOutstanding).toBe('899.70');
  });

  it('RN-09 la deuda de otro usuario no existe (NOT_FOUND)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const debt = await createDebt(owner, { principal: '1000.00' });

    const error = await rejectionOf(debts.pay(ctxFor(other), debt.id, paymentInput()));

    expect(error.code).toBe('NOT_FOUND');
    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('1000.00');
  });

  it('RN-09 la cuenta de otro usuario no existe para el pago (NOT_FOUND)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const accountId = await newAccount(owner, { initialBalance: '1000.00' });
    const debt = await createDebt(other, { principal: '1000.00' });

    const error = await rejectionOf(
      debts.pay(
        ctxFor(other),
        debt.id,
        paymentInput({ account: { accountId, ...linkedIds() } }),
      ),
    );

    expect(error.code).toBe('NOT_FOUND');
    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
    expect(await balanceOf(owner, accountId)).toBe('1000.00');
  });
});

describe('DebtsService.pay: idempotencia', () => {
  it('RNF-11 dos pagos con el mismo id registran uno', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { initialBalance: '5000.00' });
    const debtId = await debtWithInterestToday(userId);
    const input = paymentInput({
      amount: '500.00',
      interestPart: '42.30',
      capitalPart: '457.70',
      account: { accountId, ...linkedIds() },
    });

    const first = await debts.pay(ctxFor(userId), debtId, input);
    const second = await debts.pay(ctxFor(userId), debtId, input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await storedPaymentIdsOf(debtId)).toEqual([input.id]);
    expect((await findStoredDebt(debtId))?.capitalOutstanding).toBe('1542.30');
    expect(await countTransactionsOf(userId)).toBe(2);
    expect(await balanceOf(userId, accountId)).toBe('4500.00');
  });

  it('RNF-11 dos pagos simultáneos con el mismo id registran uno', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, { principal: '1000.00' });
    const input = paymentInput({ amount: '400.00', interestPart: '0.00', capitalPart: '400.00' });

    const results = await Promise.all([
      debts.pay(ctxFor(userId), debt.id, input),
      debts.pay(ctxFor(userId), debt.id, input),
    ]);

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(await storedPaymentIdsOf(debt.id)).toEqual([input.id]);
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('600.00');
  });
});
