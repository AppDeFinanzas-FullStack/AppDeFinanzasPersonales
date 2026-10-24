import type { DebtDto, DebtsSummaryDto, PaymentInput } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
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
  createDebtPayment,
  findStoredDebt,
  storedPaymentIdsOf,
  type CreateDebtOptions,
} from '../factories/debt.factory.js';
import { deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { findStoredTransaction } from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `DELETE /api/debts/:id/payments/last` (plan §4.13.2), its errors and the removal
 * of the last payment of plan §4.13.3. It does not fix the method of `DebtsService` behind the
 * endpoint. These tests assume, like `pay` (TASK-212):
 * - `deleteLastPayment(ctx, debtId)` removes the debt's last payment (the one with the greatest
 *   `created_at`). The tests read the result through `list` and the stored rows, not through what
 *   the method resolves to.
 * - Errors are `AppError`s with the code of the catalogue (ADR-09): `DEBT_FORGIVEN` (409) and
 *   `NEGATIVE_BALANCE`. Another user's debt does not exist (`NOT_FOUND`, RN-09). A rejected
 *   removal changes nothing.
 * - The linked transactions of the payment are removed: they no longer count in the balance and
 *   are either gone or marked as deleted.
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
  deleteLastPayment(ctx: RatesContext, debtId: string): Promise<unknown>;
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

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z'); // 12:00 in La Paz
const TODAY = '2090-06-15';
/** Ten days after `NOW`. */
const LATER = new Date('2090-06-25T16:00:00Z');
const LATER_DAY = '2090-06-25';
/** Twenty days after `NOW`. */
const MUCH_LATER = new Date('2090-07-05T16:00:00Z');

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

/** Current balance of the account through the ledger (RN-01). */
async function balanceOf(userId: string, accountId: string): Promise<string> {
  const balances = await uow.run((repos: Repositories) => repos.ledger.balances([accountId]), {
    userLock: userId,
    readOnly: true,
  });
  return (balances.get(accountId) ?? new Decimal(NaN)).toFixed(2);
}

/** A removed transaction is either gone or marked as deleted. */
async function expectTransactionRemoved(id: string): Promise<void> {
  const stored = await findStoredTransaction(id);
  if (stored !== null) {
    expect(stored.deletedAt).not.toBeNull();
  }
}

async function expectTransactionAlive(id: string): Promise<void> {
  const stored = await findStoredTransaction(id);
  expect(stored).not.toBeNull();
  expect(stored?.deletedAt ?? null).toBeNull();
}

const money = (value: string | undefined): string => new Decimal(value ?? 'NaN').toFixed(2);

const findDebt = (result: DebtsListResult, id: string): DebtDto | undefined =>
  result.debts.find((debt) => debt.id === id);

// ---------- Tests ----------

describe('DebtsService.deleteLastPayment: deuda pagada', () => {
  it('EC-M13-07 eliminar el último pago de una deuda Pagada la devuelve a Activa con el capital y el interés restablecidos', async () => {
    const userId = await newUser();
    const debtId = await debtWithInterestToday(userId, { principal: '300.00' });
    const input = paymentInput({ amount: '342.30', interestPart: '42.30', capitalPart: '300.00' });
    const paid = await debts.pay(ctxFor(userId), debtId, input);
    expect(paid.debt.status).toBe('paid');

    await debts.deleteLastPayment(ctxAt(userId, LATER), debtId);

    const stored = await findStoredDebt(debtId);
    expect(stored?.status).toBe('active');
    expect(stored?.capitalOutstanding).toBe('300.00');
    expect(money(stored?.interestUnpaid)).toBe('42.30');
    expect(stored?.accruedThrough).toBe(LATER_DAY);
    expect(await storedPaymentIdsOf(debtId)).toEqual([]);

    const listed = findDebt(await debts.list(ctxAt(userId, LATER), 'debt'), debtId);
    expect(listed?.status).toBe('active');
    expect(listed?.capitalOutstanding).toBe('300.00');
    expect(listed?.interestAccrued).toBe('42.30');
    expect(listed?.pending).toBe('342.30');
    expect(listed?.payments).toEqual([]);
  });

  it('EC-M13-07 el interés corre sobre el capital restablecido desde el momento de la eliminación', async () => {
    const userId = await newUser();
    const debtId = await debtWithInterestToday(userId, { principal: '300.00' });
    await debts.pay(
      ctxFor(userId),
      debtId,
      paymentInput({ amount: '342.30', interestPart: '42.30', capitalPart: '300.00' }),
    );

    await debts.deleteLastPayment(ctxAt(userId, LATER), debtId);

    // Paid between NOW and LATER: nothing accrues. From LATER, 10 days × 300 × 0.02 ÷ 30 = 2.00.
    // Running it from the payment (20 days) would give 4.00.
    const listed = findDebt(await debts.list(ctxAt(userId, MUCH_LATER), 'debt'), debtId);
    expect(listed?.capitalOutstanding).toBe('300.00');
    expect(listed?.interestAccrued).toBe('44.30');
    expect(listed?.pending).toBe('344.30');
  });

  it('EC-M13-07 una deuda Pagada con la fecha límite pasada vuelve a Vencida', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '300.00',
      startDate: '2090-01-01',
      dueDate: '2090-06-01',
      accruedThrough: TODAY,
    });
    await debts.pay(
      ctxFor(userId),
      debt.id,
      paymentInput({ amount: '300.00', interestPart: '0.00', capitalPart: '300.00' }),
    );
    expect((await findStoredDebt(debt.id))?.status).toBe('paid');

    await debts.deleteLastPayment(ctxAt(userId, LATER), debt.id);

    expect((await findStoredDebt(debt.id))?.status).toBe('active');
    const listed = findDebt(await debts.list(ctxAt(userId, LATER), 'debt'), debt.id);
    expect(listed?.status).toBe('overdue');
    expect(listed?.pending).toBe('300.00');
  });

  it('EC-M13-07 se borran las transacciones vinculadas del pago y el saldo de la cuenta se restablece', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { initialBalance: '5000.00' });
    const debtId = await debtWithInterestToday(userId, { direction: 'i_owe', principal: '300.00' });
    const ids = linkedIds();
    const input = paymentInput({
      amount: '342.30',
      interestPart: '42.30',
      capitalPart: '300.00',
      account: { accountId, ...ids },
    });
    await debts.pay(ctxFor(userId), debtId, input);
    expect(await balanceOf(userId, accountId)).toBe('4657.70');

    await debts.deleteLastPayment(ctxAt(userId, LATER), debtId);

    await expectTransactionRemoved(ids.capitalTransactionId);
    await expectTransactionRemoved(ids.interestTransactionId);
    expect(await balanceOf(userId, accountId)).toBe('5000.00');
    expect(await storedPaymentIdsOf(debtId)).toEqual([]);
    expect((await findStoredDebt(debtId))?.status).toBe('active');
  });
});

describe('DebtsService.deleteLastPayment: interés acumulado', () => {
  it('RF-M13-04 eliminar el último pago no recalcula lo ya acumulado: lleva el interés a hoy y suma el capital y el interés que cubría el pago', async () => {
    const userId = await newUser();
    const debtId = await debtWithInterestToday(userId);
    await debts.pay(
      ctxFor(userId),
      debtId,
      paymentInput({ amount: '500.00', interestPart: '42.30', capitalPart: '457.70' }),
    );
    expect((await findStoredDebt(debtId))?.capitalOutstanding).toBe('1542.30');

    await debts.deleteLastPayment(ctxAt(userId, LATER), debtId);

    // Carried to LATER on 1542.30: 10 × 1542.30 × 0.02 ÷ 30 = 10.282, plus the 42.30 the payment
    // covered. Recalculating as if there had been no payment would give 42.30 + 13.33 = 55.63.
    const stored = await findStoredDebt(debtId);
    expect(stored?.capitalOutstanding).toBe('2000.00');
    expect(new Decimal(stored?.interestUnpaid ?? 'NaN').toFixed(3)).toBe('52.582');
    expect(stored?.accruedThrough).toBe(LATER_DAY);
    const listed = findDebt(await debts.list(ctxAt(userId, LATER), 'debt'), debtId);
    expect(listed?.capitalOutstanding).toBe('2000.00');
    expect(listed?.interestAccrued).toBe('52.58');
    expect(listed?.pending).toBe('2052.58');
  });

  it('RF-M13-04 desde la eliminación el interés corre sobre el capital restablecido sin tocar lo anterior', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '2000.00',
      startDate: '2090-06-05',
      interestRate: '2',
      interestPeriod: 'monthly',
    });
    // 10 days × 2000 × 0.02 ÷ 30 = 13.333… carried to TODAY by the payment.
    await debts.pay(
      ctxFor(userId),
      debt.id,
      paymentInput({ amount: '1000.00', interestPart: '0.00', capitalPart: '1000.00' }),
    );

    await debts.deleteLastPayment(ctxAt(userId, LATER), debt.id);

    // 13.333… + 10 × 1000 × 0.02 ÷ 30 = 20.00 up to LATER; recalculating would give 26.67.
    const atDeletion = findDebt(await debts.list(ctxAt(userId, LATER), 'debt'), debt.id);
    expect(atDeletion?.capitalOutstanding).toBe('2000.00');
    expect(atDeletion?.interestAccrued).toBe('20.00');
    // From LATER on 2000: 10 × 2000 × 0.02 ÷ 30 = 13.333…, so 33.33.
    const after = findDebt(await debts.list(ctxAt(userId, MUCH_LATER), 'debt'), debt.id);
    expect(after?.capitalOutstanding).toBe('2000.00');
    expect(after?.interestAccrued).toBe('33.33');
    expect(after?.pending).toBe('2033.33');
  });
});

describe('DebtsService.deleteLastPayment: último pago', () => {
  it('EC-M13-05 la operación siempre actúa sobre el pago registrado último, aunque su fecha sea anterior', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '1000.00',
      startDate: '2090-01-01',
      capitalOutstanding: '700.00',
      accruedThrough: TODAY,
    });
    const first = await createDebtPayment(userId, debt.id, {
      capitalPart: '200.00',
      date: '2090-06-10',
      createdAt: new Date('2090-06-10T15:00:00Z'),
    });
    const last = await createDebtPayment(userId, debt.id, {
      capitalPart: '100.00',
      date: '2090-03-01',
      createdAt: new Date('2090-06-12T15:00:00Z'),
    });

    await debts.deleteLastPayment(ctxFor(userId), debt.id);

    expect(await storedPaymentIdsOf(debt.id)).toEqual([first.id]);
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('800.00');
    const listed = findDebt(await debts.list(ctxFor(userId), 'debt'), debt.id);
    expect(listed?.payments.map((p) => p.id)).toEqual([first.id]);
    expect(listed?.payments.map((p) => p.id)).not.toContain(last.id);
  });

  it('EC-M13-05 al eliminar otra vez se elimina el siguiente último pago', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '1000.00',
      startDate: '2090-01-01',
      capitalOutstanding: '700.00',
      accruedThrough: TODAY,
    });
    await createDebtPayment(userId, debt.id, {
      capitalPart: '200.00',
      date: '2090-06-10',
      createdAt: new Date('2090-06-10T15:00:00Z'),
    });
    await createDebtPayment(userId, debt.id, {
      capitalPart: '100.00',
      date: '2090-03-01',
      createdAt: new Date('2090-06-12T15:00:00Z'),
    });

    await debts.deleteLastPayment(ctxFor(userId), debt.id);
    await debts.deleteLastPayment(ctxFor(userId), debt.id);

    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('1000.00');
  });

  it('EC-M13-05 solo se borran las transacciones del último pago; las del anterior quedan', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { initialBalance: '5000.00' });
    const debt = await createDebt(userId, {
      direction: 'i_owe',
      principal: '1000.00',
      accruedThrough: TODAY,
    });
    const firstIds = linkedIds();
    const lastIds = linkedIds();
    const firstInput = paymentInput({
      amount: '200.00',
      capitalPart: '200.00',
      account: { accountId, ...firstIds },
    });
    const lastInput = paymentInput({
      amount: '300.00',
      capitalPart: '300.00',
      account: { accountId, ...lastIds },
    });
    await debts.pay(ctxFor(userId), debt.id, firstInput);
    await debts.pay(ctxFor(userId), debt.id, lastInput);
    expect(await balanceOf(userId, accountId)).toBe('4500.00');

    await debts.deleteLastPayment(ctxFor(userId), debt.id);

    expect(await storedPaymentIdsOf(debt.id)).toEqual([firstInput.id]);
    await expectTransactionRemoved(lastIds.capitalTransactionId);
    await expectTransactionAlive(firstIds.capitalTransactionId);
    expect(await balanceOf(userId, accountId)).toBe('4800.00');
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('800.00');
  });

  it('EC-M13-05 con una deuda condonada da DEBT_FORGIVEN y no cambia nada', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      status: 'forgiven',
      principal: '1000.00',
      capitalOutstanding: '900.00',
      forgivenAmount: '900.00',
      accruedThrough: TODAY,
    });
    const payment = await createDebtPayment(userId, debt.id, {
      capitalPart: '100.00',
      date: '2090-06-10',
    });

    const error = await rejectionOf(debts.deleteLastPayment(ctxFor(userId), debt.id));

    expect(error.code).toBe('DEBT_FORGIVEN');
    expect(error.status).toBe(409);
    expect(await storedPaymentIdsOf(debt.id)).toEqual([payment.id]);
    const stored = await findStoredDebt(debt.id);
    expect(stored?.status).toBe('forgiven');
    expect(stored?.capitalOutstanding).toBe('900.00');
  });
});

describe('DebtsService.deleteLastPayment: cuenta y aislamiento', () => {
  it('TASK-213 si borrar las transacciones deja el efectivo en negativo da NEGATIVE_BALANCE y no cambia nada', async () => {
    const userId = await newUser();
    const cashId = await newAccount(userId, { type: 'cash', initialBalance: '0.00' });
    const owedToMe = await createDebt(userId, {
      direction: 'owed_to_me',
      principal: '1000.00',
      accruedThrough: TODAY,
    });
    const iOwe = await createDebt(userId, {
      direction: 'i_owe',
      principal: '1000.00',
      accruedThrough: TODAY,
    });
    const ids = linkedIds();
    const received = paymentInput({
      amount: '500.00',
      capitalPart: '500.00',
      account: { accountId: cashId, ...ids },
    });
    await debts.pay(ctxFor(userId), owedToMe.id, received);
    await debts.pay(
      ctxFor(userId),
      iOwe.id,
      paymentInput({
        amount: '450.00',
        capitalPart: '450.00',
        account: { accountId: cashId, ...linkedIds() },
      }),
    );
    expect(await balanceOf(userId, cashId)).toBe('50.00');

    const error = await rejectionOf(debts.deleteLastPayment(ctxFor(userId), owedToMe.id));

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(await storedPaymentIdsOf(owedToMe.id)).toEqual([received.id]);
    expect((await findStoredDebt(owedToMe.id))?.capitalOutstanding).toBe('500.00');
    await expectTransactionAlive(ids.capitalTransactionId);
    expect(await balanceOf(userId, cashId)).toBe('50.00');
  });

  it('RN-09 la deuda de otro usuario no existe (NOT_FOUND) y su pago queda', async () => {
    const owner = await newUser();
    const other = await newUser();
    const debt = await createDebt(owner, {
      principal: '1000.00',
      capitalOutstanding: '900.00',
      accruedThrough: TODAY,
    });
    const payment = await createDebtPayment(owner, debt.id, { capitalPart: '100.00' });

    const error = await rejectionOf(debts.deleteLastPayment(ctxFor(other), debt.id));

    expect(error.code).toBe('NOT_FOUND');
    expect(await storedPaymentIdsOf(debt.id)).toEqual([payment.id]);
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('900.00');
  });
});
