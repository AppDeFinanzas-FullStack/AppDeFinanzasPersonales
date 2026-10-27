import type {
  CreateDebtInput,
  DebtDto,
  DebtsSummaryDto,
  DeleteDebtInput,
  PaymentInput,
  UpdateDebtInput,
} from '@finanzas/contracts';
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
} from '../factories/debt.factory.js';
import { deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { countTransactionsOf, findStoredTransaction } from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `PATCH /api/debts/:id`, `POST /api/debts/:id/forgive` and `DELETE /api/debts/:id`
 * (plan §4.13.2) and their errors. It does not fix the methods of `DebtsService` behind them. These
 * tests assume, following the other services (`update`/`remove` in goals and accounts):
 * - `update(ctx, debtId, input: UpdateDebtInput)` edits the debt (RF-M13-10).
 * - `forgive(ctx, debtId)` forgives the pending balance (RF-M13-12).
 * - `remove(ctx, debtId, input: DeleteDebtInput)` deletes the debt (RF-M13-11).
 * The tests read the result through `list` and the stored rows, not through what the methods
 * resolve to. Errors are `AppError`s with the code of the catalogue (ADR-09); another user's debt
 * does not exist (`NOT_FOUND`, RN-09). A rejected operation changes nothing.
 *
 * "Movements" of a debt are its ledger transactions: the initial one and those of its payments.
 * The payments here only carry capital, so each one has exactly one movement.
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
  pay(
    ctx: RatesContext,
    debtId: string,
    input: PaymentInput,
  ): Promise<{ created: boolean; debt: DebtDto }>;
  list(ctx: RatesContext, view: 'debt' | 'person'): Promise<DebtsListResult>;
  update(ctx: RatesContext, debtId: string, input: UpdateDebtInput): Promise<unknown>;
  forgive(ctx: RatesContext, debtId: string): Promise<unknown>;
  remove(ctx: RatesContext, debtId: string, input: DeleteDebtInput): Promise<unknown>;
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
  const account = await createAccount(userId, {
    type: 'bank',
    initialBalance: '5000.00',
    initialBalanceDate: '2090-01-01',
    ...options,
  });
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
    startDate: '2090-06-01',
    ...overrides,
  };
}

/** A capital-only payment linked to the account: exactly one movement. */
function capitalPayment(accountId: string, amount: string): PaymentInput {
  return {
    id: uuidv7(),
    amount,
    interestPart: '0.00',
    capitalPart: amount,
    date: TODAY,
    account: { accountId, capitalTransactionId: uuidv7(), interestTransactionId: uuidv7() },
  };
}

/** Current balance of the account through the ledger (RN-01). */
async function balanceOf(userId: string, accountId: string): Promise<string> {
  const balances = await uow.run((repos: Repositories) => repos.ledger.balances([accountId]), {
    userLock: userId,
    readOnly: true,
  });
  return (balances.get(accountId) ?? new Decimal(NaN)).toFixed(2);
}

interface LiveTransaction {
  id: string;
  origin: string;
  categoryId: string | null;
}

/** The user's transactions that are not deleted, ordered by date and id. */
async function liveTransactionsOf(userId: string): Promise<LiveTransaction[]> {
  return prisma.$queryRaw<LiveTransaction[]>`
    SELECT id::text AS id, origin::text AS origin, category_id::text AS "categoryId"
      FROM ledger_transaction
     WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
     ORDER BY date, id`;
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

const money = (value: string | null | undefined): string => new Decimal(value ?? 'NaN').toFixed(2);

const findDebt = (result: DebtsListResult, id: string): DebtDto | undefined =>
  result.debts.find((debt) => debt.id === id);

/**
 * A "Me deben" debt of 1000.00 created with its initial movement (an expense in the account) and a
 * capital payment of 200.00 received in the account: two movements.
 */
async function owedToMeWithMovements(
  userId: string,
  accountId: string,
): Promise<{ debtId: string; initialId: string; paymentTxId: string }> {
  const initialId = uuidv7();
  const input = debtInput({
    direction: 'owed_to_me',
    initialMovement: { transactionId: initialId, accountId },
  });
  await debts.create(ctxFor(userId), input);
  const payment = capitalPayment(accountId, '200.00');
  await debts.pay(ctxFor(userId), input.id, payment);
  return {
    debtId: input.id,
    initialId,
    paymentTxId: payment.account?.capitalTransactionId ?? '',
  };
}

// ---------- Tests ----------

describe('DebtsService.forgive', () => {
  it('RF-M13-12 Condonar: una deuda "Me deben" con saldo pendiente Bs 300,00 queda Condonada y no se crea ningún movimiento', async () => {
    const userId = await newUser();
    await newAccount(userId);
    const debt = await createDebt(userId, {
      direction: 'owed_to_me',
      principal: '300.00',
      accruedThrough: TODAY,
    });
    const before = await countTransactionsOf(userId);

    await debts.forgive(ctxFor(userId), debt.id);

    const stored = await findStoredDebt(debt.id);
    expect(stored?.status).toBe('forgiven');
    expect(money(stored?.forgivenAmount)).toBe('300.00');
    expect(await countTransactionsOf(userId)).toBe(before);
    const listed = findDebt(await debts.list(ctxFor(userId), 'debt'), debt.id);
    expect(listed?.status).toBe('forgiven');
    expect(listed?.forgivenAmount).toBe('300.00');
  });

  it('RF-M13-12 el monto condonado es el saldo pendiente, capital más interés al día', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      direction: 'owed_to_me',
      principal: '2000.00',
      interestRate: '2',
      interestPeriod: 'monthly',
      interestUnpaid: '42.30',
      accruedThrough: TODAY,
    });

    await debts.forgive(ctxFor(userId), debt.id);

    const stored = await findStoredDebt(debt.id);
    expect(stored?.status).toBe('forgiven');
    expect(money(stored?.forgivenAmount)).toBe('2042.30');
    const listed = findDebt(await debts.list(ctxFor(userId), 'debt'), debt.id);
    expect(listed?.forgivenAmount).toBe('2042.30');
  });

  it('RF-M13-12 condonar una deuda con pagos vinculados a una cuenta no toca sus movimientos ni el saldo', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId);
    const { debtId } = await owedToMeWithMovements(userId, accountId);
    const before = await countTransactionsOf(userId);
    const balance = await balanceOf(userId, accountId);

    await debts.forgive(ctxFor(userId), debtId);

    const stored = await findStoredDebt(debtId);
    expect(stored?.status).toBe('forgiven');
    expect(money(stored?.forgivenAmount)).toBe('800.00');
    expect(await countTransactionsOf(userId)).toBe(before);
    expect(await balanceOf(userId, accountId)).toBe(balance);
  });

  it('TASK-214 condonar una deuda Pagada da DEBT_CLOSED y no cambia nada', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      status: 'paid',
      capitalOutstanding: '0.00',
      accruedThrough: TODAY,
    });

    const error = await rejectionOf(debts.forgive(ctxFor(userId), debt.id));

    expect(error.code).toBe('DEBT_CLOSED');
    expect(error.status).toBe(409);
    const stored = await findStoredDebt(debt.id);
    expect(stored?.status).toBe('paid');
    expect(stored?.forgivenAmount).toBeNull();
  });

  it('TASK-214 condonar una deuda ya Condonada da DEBT_CLOSED', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      status: 'forgiven',
      capitalOutstanding: '900.00',
      forgivenAmount: '900.00',
      accruedThrough: TODAY,
    });

    const error = await rejectionOf(debts.forgive(ctxFor(userId), debt.id));

    expect(error.code).toBe('DEBT_CLOSED');
    expect(money((await findStoredDebt(debt.id))?.forgivenAmount)).toBe('900.00');
  });

  it('RN-09 condonar la deuda de otro usuario da NOT_FOUND y no la cambia', async () => {
    const owner = await newUser();
    const other = await newUser();
    const debt = await createDebt(owner, { accruedThrough: TODAY });

    const error = await rejectionOf(debts.forgive(ctxFor(other), debt.id));

    expect(error.code).toBe('NOT_FOUND');
    expect((await findStoredDebt(debt.id))?.status).toBe('active');
  });
});

describe('DebtsService.update', () => {
  it('RF-M13-10 en una deuda Activa se editan la persona, la nota y la fecha límite', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      person: 'Juan',
      note: 'Antes',
      dueDate: '2090-09-01',
      accruedThrough: TODAY,
    });

    await debts.update(ctxFor(userId), debt.id, {
      person: 'María',
      note: 'Después',
      dueDate: '2090-12-31',
    });

    const stored = await findStoredDebt(debt.id);
    expect(stored?.person).toBe('María');
    expect(stored?.personKey).toBe('maria');
    expect(stored?.note).toBe('Después');
    expect(stored?.dueDate).toBe('2090-12-31');
  });

  it('RF-M13-10 extender la fecha límite de una deuda Vencida la saca de vencida', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, { dueDate: '2090-06-01', accruedThrough: TODAY });
    expect(findDebt(await debts.list(ctxFor(userId), 'debt'), debt.id)?.status).toBe('overdue');

    await debts.update(ctxFor(userId), debt.id, { dueDate: '2090-12-31' });

    expect((await findStoredDebt(debt.id))?.dueDate).toBe('2090-12-31');
    expect(findDebt(await debts.list(ctxFor(userId), 'debt'), debt.id)?.status).toBe('active');
  });

  it('RF-M13-10 bajar el monto original por debajo del capital pagado da PRINCIPAL_BELOW_PAID y no cambia nada', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '1000.00',
      capitalOutstanding: '700.00',
      accruedThrough: TODAY,
    });
    await createDebtPayment(userId, debt.id, { capitalPart: '300.00', date: '2090-06-10' });

    const error = await rejectionOf(
      debts.update(ctxFor(userId), debt.id, { principal: '250.00' }),
    );

    expect(error.code).toBe('PRINCIPAL_BELOW_PAID');
    expect(error.status).toBe(422);
    const stored = await findStoredDebt(debt.id);
    expect(stored?.principal).toBe('1000.00');
    expect(stored?.capitalOutstanding).toBe('700.00');
  });

  it('RF-M13-10 bajar el monto original sin quedar por debajo de lo pagado lo cambia y el capital pendiente sigue al monto', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '1000.00',
      capitalOutstanding: '700.00',
      accruedThrough: TODAY,
    });
    await createDebtPayment(userId, debt.id, { capitalPart: '300.00', date: '2090-06-10' });

    await debts.update(ctxFor(userId), debt.id, { principal: '500.00' });

    const stored = await findStoredDebt(debt.id);
    expect(stored?.principal).toBe('500.00');
    expect(stored?.capitalOutstanding).toBe('200.00');
    const listed = findDebt(await debts.list(ctxFor(userId), 'debt'), debt.id);
    expect(listed?.principal).toBe('500.00');
    expect(listed?.pending).toBe('200.00');
  });

  it('RF-M13-10 el monto original igual al capital pagado se acepta', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '1000.00',
      capitalOutstanding: '700.00',
      accruedThrough: TODAY,
    });
    await createDebtPayment(userId, debt.id, { capitalPart: '300.00', date: '2090-06-10' });

    await debts.update(ctxFor(userId), debt.id, { principal: '300.00' });

    expect((await findStoredDebt(debt.id))?.principal).toBe('300.00');
  });

  it('RF-M13-10 subir el monto original de una deuda Activa lo cambia', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      principal: '1000.00',
      capitalOutstanding: '700.00',
      accruedThrough: TODAY,
    });
    await createDebtPayment(userId, debt.id, { capitalPart: '300.00', date: '2090-06-10' });

    await debts.update(ctxFor(userId), debt.id, { principal: '1500.00' });

    const stored = await findStoredDebt(debt.id);
    expect(stored?.principal).toBe('1500.00');
    expect(stored?.capitalOutstanding).toBe('1200.00');
  });

  it('RF-M13-10 en una deuda Pagada se editan la persona y la nota', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      status: 'paid',
      capitalOutstanding: '0.00',
      accruedThrough: TODAY,
    });

    await debts.update(ctxFor(userId), debt.id, { person: 'Pedro', note: 'Saldada' });

    const stored = await findStoredDebt(debt.id);
    expect(stored?.person).toBe('Pedro');
    expect(stored?.note).toBe('Saldada');
    expect(stored?.status).toBe('paid');
  });

  it('RF-M13-10 en una deuda Pagada cambiar la fecha límite da FIELD_LOCKED y no cambia nada', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      status: 'paid',
      capitalOutstanding: '0.00',
      dueDate: '2090-09-01',
      accruedThrough: TODAY,
    });

    const error = await rejectionOf(
      debts.update(ctxFor(userId), debt.id, { person: 'Pedro', dueDate: '2090-12-31' }),
    );

    expect(error.code).toBe('FIELD_LOCKED');
    expect(error.status).toBe(422);
    const stored = await findStoredDebt(debt.id);
    expect(stored?.dueDate).toBe('2090-09-01');
    expect(stored?.person).toBe('Juan');
  });

  it('RF-M13-10 en una deuda Condonada cambiar el monto original da FIELD_LOCKED', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      status: 'forgiven',
      principal: '1000.00',
      capitalOutstanding: '900.00',
      forgivenAmount: '900.00',
      accruedThrough: TODAY,
    });

    const error = await rejectionOf(
      debts.update(ctxFor(userId), debt.id, { principal: '1200.00' }),
    );

    expect(error.code).toBe('FIELD_LOCKED');
    expect((await findStoredDebt(debt.id))?.principal).toBe('1000.00');
  });

  it('RF-M13-10 en una deuda Condonada se editan la persona y la nota', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      status: 'forgiven',
      capitalOutstanding: '900.00',
      forgivenAmount: '900.00',
      accruedThrough: TODAY,
    });

    await debts.update(ctxFor(userId), debt.id, { person: 'Ana', note: 'Perdonada' });

    const stored = await findStoredDebt(debt.id);
    expect(stored?.person).toBe('Ana');
    expect(stored?.note).toBe('Perdonada');
    expect(stored?.status).toBe('forgiven');
  });

  it('RN-09 editar la deuda de otro usuario da NOT_FOUND y no la cambia', async () => {
    const owner = await newUser();
    const other = await newUser();
    const debt = await createDebt(owner, { person: 'Juan', accruedThrough: TODAY });

    const error = await rejectionOf(debts.update(ctxFor(other), debt.id, { person: 'Intruso' }));

    expect(error.code).toBe('NOT_FOUND');
    expect((await findStoredDebt(debt.id))?.person).toBe('Juan');
  });
});

describe('DebtsService.remove', () => {
  it('RF-M13-11 una deuda sin ningún movimiento se elimina directamente, con sus pagos', async () => {
    const userId = await newUser();
    const debt = await createDebt(userId, {
      capitalOutstanding: '900.00',
      accruedThrough: TODAY,
    });
    await createDebtPayment(userId, debt.id, { capitalPart: '100.00', date: '2090-06-10' });

    await debts.remove(ctxFor(userId), debt.id, {});

    expect(await findStoredDebt(debt.id)).toBeNull();
    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
  });

  it('RF-M13-11 sin elegir da MOVEMENTS_CHOICE_REQUIRED con la cuenta de movimientos, el inicial incluido, y no cambia nada', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId);
    const { debtId, initialId, paymentTxId } = await owedToMeWithMovements(userId, accountId);

    const error = await rejectionOf(debts.remove(ctxFor(userId), debtId, {}));

    expect(error.code).toBe('MOVEMENTS_CHOICE_REQUIRED');
    expect(error.status).toBe(409);
    expect(error.data).toMatchObject({ count: 2 });
    expect(await findStoredDebt(debtId)).not.toBeNull();
    await expectTransactionAlive(initialId);
    await expectTransactionAlive(paymentTxId);
  });

  it('RF-M13-11 una deuda con solo el movimiento inicial pide elegir con count 1', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId);
    const input = debtInput({ initialMovement: { transactionId: uuidv7(), accountId } });
    await debts.create(ctxFor(userId), input);

    const error = await rejectionOf(debts.remove(ctxFor(userId), input.id, {}));

    expect(error.code).toBe('MOVEMENTS_CHOICE_REQUIRED');
    expect(error.data).toMatchObject({ count: 1 });
    expect(await findStoredDebt(input.id)).not.toBeNull();
  });

  it('RF-M13-11 keep elimina la deuda y deja sus movimientos como movimientos normales (origin = manual, misma categoría)', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId);
    const { debtId } = await owedToMeWithMovements(userId, accountId);
    const before = await liveTransactionsOf(userId);
    expect(before).toHaveLength(2);
    const balance = await balanceOf(userId, accountId);

    await debts.remove(ctxFor(userId), debtId, { movements: 'keep' });

    expect(await findStoredDebt(debtId)).toBeNull();
    expect(await storedPaymentIdsOf(debtId)).toEqual([]);
    const after = await liveTransactionsOf(userId);
    expect(after).toHaveLength(2);
    expect(after.map((tx) => tx.origin)).toEqual(['manual', 'manual']);
    expect(after.map((tx) => tx.categoryId).sort()).toEqual(
      before.map((tx) => tx.categoryId).sort(),
    );
    expect(await balanceOf(userId, accountId)).toBe(balance);
  });

  it('RF-M13-11 delete elimina la deuda y sus movimientos, y el saldo de la cuenta se restablece', async () => {
    const userId = await newUser();
    const accountId = await newAccount(userId, { initialBalance: '5000.00' });
    const { debtId, initialId, paymentTxId } = await owedToMeWithMovements(userId, accountId);
    expect(await balanceOf(userId, accountId)).toBe('4200.00');

    await debts.remove(ctxFor(userId), debtId, { movements: 'delete' });

    expect(await findStoredDebt(debtId)).toBeNull();
    expect(await storedPaymentIdsOf(debtId)).toEqual([]);
    await expectTransactionRemoved(initialId);
    await expectTransactionRemoved(paymentTxId);
    expect(await liveTransactionsOf(userId)).toEqual([]);
    expect(await balanceOf(userId, accountId)).toBe('5000.00');
  });

  it('RF-M13-11 delete respeta el bloqueo de negativos: si deja el efectivo en negativo da NEGATIVE_BALANCE y no cambia nada', async () => {
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
    const received = capitalPayment(cashId, '500.00');
    await debts.pay(ctxFor(userId), owedToMe.id, received);
    await debts.pay(ctxFor(userId), iOwe.id, capitalPayment(cashId, '450.00'));
    expect(await balanceOf(userId, cashId)).toBe('50.00');

    const error = await rejectionOf(
      debts.remove(ctxFor(userId), owedToMe.id, { movements: 'delete' }),
    );

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(await findStoredDebt(owedToMe.id)).not.toBeNull();
    expect(await storedPaymentIdsOf(owedToMe.id)).toEqual([received.id]);
    await expectTransactionAlive(received.account?.capitalTransactionId ?? '');
    expect(await balanceOf(userId, cashId)).toBe('50.00');
  });

  it('RN-09 eliminar la deuda de otro usuario da NOT_FOUND y la deuda queda', async () => {
    const owner = await newUser();
    const other = await newUser();
    const debt = await createDebt(owner, { accruedThrough: TODAY });

    const error = await rejectionOf(debts.remove(ctxFor(other), debt.id, {}));

    expect(error.code).toBe('NOT_FOUND');
    expect(await findStoredDebt(debt.id)).not.toBeNull();
  });
});
