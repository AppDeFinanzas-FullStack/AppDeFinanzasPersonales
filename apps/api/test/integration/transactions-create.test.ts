import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import {
  createRatesService,
  type RatesContext,
  type RatesService,
} from '../../src/application/services/rates.service.js';
import {
  createLedgerHooks,
  type LedgerChange,
  type LedgerHooks,
} from '../../src/application/shared/ledger-hooks.js';
import { createAccountRepository } from '../../src/infrastructure/persistence/repositories/account.repository.js';
import { createCategoryRepository } from '../../src/infrastructure/persistence/repositories/category.repository.js';
import { createCurrencyRepository } from '../../src/infrastructure/persistence/repositories/currency.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createMarketRateRepository } from '../../src/infrastructure/persistence/repositories/market-rate.repository.js';
import { createUndoActionRepository } from '../../src/infrastructure/persistence/repositories/undo-action.repository.js';
import { createUserFxEventRepository } from '../../src/infrastructure/persistence/repositories/user-fx-event.repository.js';
import { createUserSettingsRepository } from '../../src/infrastructure/persistence/repositories/user-settings.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount, type CreateAccountOptions } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import {
  countEntriesOf,
  countTransactionsOf,
  expenseInput,
  findStoredTransaction,
  incomeInput,
  type SimpleTransactionInput,
  undoActionsOf,
} from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `TransactionsService.create(ctx, input)` (plan §1.4), the request context
 * `{ userId, timezone, now, traceId }` (plan §1.4), the input `CreateTransactionInput` (plan §4.6.1),
 * the errors of `POST /api/transactions` (plan §4.6.2) and that `POST` answers 201 with
 * `{ transaction, undoToken }` or 200 with the existing one (TASK-127). It does not fix how the
 * service is built nor how it tells a new movement from a repeated one. These tests assume:
 * - `createTransactionsService({ uow, rates, ledgerHooks })` builds it over the `UnitOfWork`, the
 *   `RatesService` (`createRatesService({ uow })`) and the `LedgerHooks`. `BalanceGuard` is the
 *   module of `application/shared/balance-guard.ts`.
 * - `create(ctx, input)` resolves to `{ created, transaction, undoToken }`: `created` is `true` when
 *   the movement is new (201) and `false` when the id already existed with the same data (200);
 *   `transaction.id` is the id of the movement; on a new movement `undoToken` is the id of its
 *   `undo_action(create)`.
 * - "Today" is the date of `ctx.now` in `ctx.timezone` (RN-07), and the rates of the movement are
 *   taken for that `ctx` (`RatesService.ratesForMovement`).
 * - A rejection is an `AppError` with the code and the status of the catalogue (ADR-09); an account
 *   or a category of another user does not exist for the user (`NOT_FOUND`, RNF-14).
 * - The active manual value is read back through `RatesService.current(ctx).inUse`.
 *
 * The service module is imported with those types (below), so the file stays typed before the
 * module exists and the type check fails if its shape does not match.
 *
 * `market_rate` is global (ADR-12): the file saves its rows, empties the table before each test
 * and puts the rows back at the end. Integration files run one after another.
 */
interface CreateResult {
  /** `true`: a new movement (201); `false`: the existing one with the same id and data (200). */
  created: boolean;
  transaction: { id: string };
  undoToken: string | null;
}

interface TransactionsServiceUnderTest {
  create(ctx: RatesContext, input: SimpleTransactionInput): Promise<CreateResult>;
}

type CreateTransactionsService = (deps: {
  uow: UnitOfWork;
  rates: RatesService;
  ledgerHooks: LedgerHooks;
}) => TransactionsServiceUnderTest;

const { createTransactionsService } =
  (await import('../../src/application/services/transactions.service.js')) as {
    createTransactionsService: CreateTransactionsService;
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
}));

const rates = createRatesService({ uow });

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z'); // 12:00 in La Paz
const TODAY = '2090-06-15';

type Kind = 'parallel_bid' | 'parallel_ask' | 'parallel_median' | 'official';

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
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate`;
  for (const row of savedRates) {
    await prisma.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

function newService() {
  const ledgerHooks = createLedgerHooks();
  const service = createTransactionsService({ uow, rates, ledgerHooks });
  return { service, ledgerHooks };
}

function ctxFor(userId: string, now: Date = NOW, timezone: string = TZ) {
  return { userId, timezone, now, traceId: uuidv7() };
}

async function newUserId(): Promise<string> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  return user.id;
}

/** A new user with one account and one active expense and income category of its own. */
async function setup(account: CreateAccountOptions = {}) {
  const userId = await newUserId();
  const created = await createAccount(userId, {
    initialBalanceDate: '2090-01-01',
    ...account,
  });
  const expenseCategoryId = (await createCategory(userId, { kind: 'expense' })).id;
  const incomeCategoryId = (await createCategory(userId, { kind: 'income' })).id;
  return { userId, accountId: created.id, expenseCategoryId, incomeCategoryId };
}

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

/** Activates the manual USD value, as `PUT /api/fx/manual` leaves it (plan §4.3.2). */
async function setManual(userId: string, value: string, since: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE user_settings SET manual_usd_value = ${value}::numeric, manual_usd_since = ${since}
     WHERE user_id = ${userId}::uuid`;
  await prisma.$executeRaw`
    INSERT INTO user_fx_event (id, user_id, kind, currency_code, reference, value, effective_at)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, 'manual_usd_on'::fx_event_kind, 'USD', NULL,
            ${value}::numeric, ${since})`;
}

async function manualOnEventsOf(userId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ value: string }[]>`
    SELECT value::text AS value FROM user_fx_event
     WHERE user_id = ${userId}::uuid AND kind = 'manual_usd_on'
     ORDER BY effective_at`;
  return rows.map((r) => r.value);
}

/** Current balance of the account through the ledger (RN-01). */
async function balanceOf(userId: string, accountId: string): Promise<string> {
  const balances = await uow.run((repos: Repositories) => repos.ledger.balances([accountId]), {
    userLock: userId,
    readOnly: true,
  });
  return (balances.get(accountId) ?? new Decimal(NaN)).toFixed(2);
}

/** The rejection of the promise, which must be an `AppError`. */
async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('The promise was expected to reject');
}

async function expectNothingStored(userId: string): Promise<void> {
  expect(await countTransactionsOf(userId)).toBe(0);
  expect(await countEntriesOf(userId)).toBe(0);
  expect(await undoActionsOf(userId)).toEqual([]);
}

// ---------- Tests ----------

describe('TransactionsService.create: gastos e ingresos', () => {
  it('TASK-121 un gasto crea la transaccion y un asiento negativo en la cuenta', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, {
      amount: '35.00',
      date: TODAY,
      note: 'Almuerzo',
    });

    const result = await service.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    expect(result.transaction.id).toBe(input.id);
    const stored = await findStoredTransaction(input.id);
    expect(stored).toMatchObject({
      userId,
      kind: 'expense',
      date: TODAY,
      note: 'Almuerzo',
      categoryId: expenseCategoryId,
      origin: 'manual',
      deletedAt: null,
    });
    expect(stored?.entries).toEqual([
      { accountId, amount: '-35.00', currencyCode: 'BOB', date: TODAY },
    ]);
    expect(await balanceOf(userId, accountId)).toBe('65.00');
  });

  it('TASK-121 un ingreso crea un asiento positivo en la cuenta', async () => {
    const { userId, accountId, incomeCategoryId } = await setup({
      type: 'cash',
      initialBalance: '0.00',
    });
    const { service } = newService();
    const input = incomeInput(accountId, incomeCategoryId, { amount: '120.50', date: TODAY });

    const result = await service.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    const stored = await findStoredTransaction(input.id);
    expect(stored?.kind).toBe('income');
    expect(stored?.categoryId).toBe(incomeCategoryId);
    expect(stored?.entries).toEqual([
      { accountId, amount: '120.50', currencyCode: 'BOB', date: TODAY },
    ]);
    expect(await balanceOf(userId, accountId)).toBe('120.50');
  });

  it('RF-M6-01 acepta los montos limite 0,01 y 999.999.999,99 y los guarda exactos', async () => {
    const { userId, accountId, expenseCategoryId, incomeCategoryId } = await setup();
    const { service } = newService();
    const big = incomeInput(accountId, incomeCategoryId, { amount: '999999999.99', date: TODAY });
    const small = expenseInput(accountId, expenseCategoryId, { amount: '0.01', date: TODAY });

    await service.create(ctxFor(userId), big);
    await service.create(ctxFor(userId), small);

    expect((await findStoredTransaction(big.id))?.entries[0]?.amount).toBe('999999999.99');
    expect((await findStoredTransaction(small.id))?.entries[0]?.amount).toBe('-0.01');
    expect(await balanceOf(userId, accountId)).toBe('999999999.98');
  });

  it('TASK-121 crea un undo_action(create) y devuelve su token', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '50.00' });
    const { service } = newService();

    const result = await service.create(
      ctxFor(userId),
      expenseInput(accountId, expenseCategoryId, { date: TODAY }),
    );

    const undo = await undoActionsOf(userId);
    expect(undo).toHaveLength(1);
    expect(undo[0]).toEqual({ id: result.undoToken, kind: 'create' });
  });

  it('TASK-121 llama a LedgerHooks.afterChange con la fecha, la categoria y la cuenta', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '50.00' });
    const { service, ledgerHooks } = newService();
    const handler = vi.fn<
      (tx: Repositories, userId: string, change: LedgerChange) => Promise<void>
    >(() => Promise.resolve());
    ledgerHooks.register(handler);

    await service.create(
      ctxFor(userId),
      expenseInput(accountId, expenseCategoryId, { date: '2090-06-10' }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const [, hookUserId, change] = handler.mock.calls[0] ?? [];
    expect(hookUserId).toBe(userId);
    expect(change).toEqual({
      dates: ['2090-06-10'],
      categoryIds: [expenseCategoryId],
      accountIds: [accountId],
    });
  });

  it('TASK-121 una cuenta archivada da ACCOUNT_ARCHIVED y no se guarda nada', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({
      initialBalance: '100.00',
      status: 'archived',
    });
    const { service } = newService();

    const error = await rejectionOf(
      service.create(ctxFor(userId), expenseInput(accountId, expenseCategoryId, { date: TODAY })),
    );

    expect(error.code).toBe('ACCOUNT_ARCHIVED');
    expect(error.status).toBe(409);
    await expectNothingStored(userId);
  });

  it('TASK-121 una categoria archivada da CATEGORY_ARCHIVED y no se guarda nada', async () => {
    const { userId, accountId } = await setup({ initialBalance: '100.00' });
    const archived = await createCategory(userId, { kind: 'expense', status: 'archived' });
    const { service } = newService();

    const error = await rejectionOf(
      service.create(ctxFor(userId), expenseInput(accountId, archived.id, { date: TODAY })),
    );

    expect(error.code).toBe('CATEGORY_ARCHIVED');
    expect(error.status).toBe(409);
    await expectNothingStored(userId);
  });

  it('TASK-121 un gasto con una categoria de ingreso da CATEGORY_KIND_MISMATCH', async () => {
    const { userId, accountId, incomeCategoryId, expenseCategoryId } = await setup({
      initialBalance: '100.00',
    });
    const { service } = newService();

    const asExpense = await rejectionOf(
      service.create(ctxFor(userId), expenseInput(accountId, incomeCategoryId, { date: TODAY })),
    );
    const asIncome = await rejectionOf(
      service.create(ctxFor(userId), incomeInput(accountId, expenseCategoryId, { date: TODAY })),
    );

    expect(asExpense.code).toBe('CATEGORY_KIND_MISMATCH');
    expect(asExpense.status).toBe(422);
    expect(asIncome.code).toBe('CATEGORY_KIND_MISMATCH');
    await expectNothingStored(userId);
  });

  it('TASK-121 aislamiento: la cuenta o la categoria de otro usuario no existen (NOT_FOUND)', async () => {
    const owner = await setup({ initialBalance: '100.00' });
    const other = await setup({ initialBalance: '100.00' });
    const { service } = newService();

    const foreignAccount = await rejectionOf(
      service.create(
        ctxFor(other.userId),
        expenseInput(owner.accountId, other.expenseCategoryId, { date: TODAY }),
      ),
    );
    const foreignCategory = await rejectionOf(
      service.create(
        ctxFor(other.userId),
        expenseInput(other.accountId, owner.expenseCategoryId, { date: TODAY }),
      ),
    );

    expect(foreignAccount.code).toBe('NOT_FOUND');
    expect(foreignCategory.code).toBe('NOT_FOUND');
    await expectNothingStored(other.userId);
    await expectNothingStored(owner.userId);
    expect(await balanceOf(owner.userId, owner.accountId)).toBe('100.00');
  });
});

describe('RF-M6-14 idempotencia (ADR-11)', () => {
  it('RF-M6-14 Doble toque no duplica: dos create con el mismo id dejan 1 fila; 201 y luego 200', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, { amount: '35.00', date: TODAY });

    const first = await service.create(ctxFor(userId), input);
    const second = await service.create(ctxFor(userId), { ...input });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.transaction.id).toBe(input.id);
    expect(await countTransactionsOf(userId)).toBe(1);
    expect(await countEntriesOf(userId)).toBe(1);
    expect(await balanceOf(userId, accountId)).toBe('65.00');
  });

  it('RF-M6-14 dos create simultaneos con el mismo id: uno crea y el otro devuelve el existente', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, { amount: '35.00', date: TODAY });

    const results = await Promise.all([
      service.create(ctxFor(userId), input),
      service.create(ctxFor(userId), { ...input }),
    ]);

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(await countTransactionsOf(userId)).toBe(1);
    expect(await countEntriesOf(userId)).toBe(1);
    expect(await balanceOf(userId, accountId)).toBe('65.00');
  });

  it('RF-M6-14 el mismo id con otros datos da IDEMPOTENCY_CONFLICT y no cambia la fila', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, { amount: '35.00', date: TODAY });
    await service.create(ctxFor(userId), input);

    const error = await rejectionOf(service.create(ctxFor(userId), { ...input, amount: '40.00' }));

    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(error.status).toBe(409);
    expect(await countTransactionsOf(userId)).toBe(1);
    expect((await findStoredTransaction(input.id))?.entries[0]?.amount).toBe('-35.00');
  });
});

describe('RN-07 fecha del movimiento', () => {
  // 03:00 UTC del 15/06 es 23:00 del 14/06 en La Paz.
  const LATE_NIGHT = new Date('2090-06-15T03:00:00Z');

  it('RN-07 la fecha de manana en la zona del usuario da FUTURE_DATE y no se guarda nada', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    const { service } = newService();

    const error = await rejectionOf(
      service.create(
        ctxFor(userId, LATE_NIGHT),
        expenseInput(accountId, expenseCategoryId, { date: '2090-06-15' }),
      ),
    );

    expect(error.code).toBe('FUTURE_DATE');
    expect(error.status).toBe(422);
    await expectNothingStored(userId);
  });

  it('RN-07 la fecha de hoy y una fecha pasada en la zona del usuario se aceptan', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    const { service } = newService();
    const today = expenseInput(accountId, expenseCategoryId, { date: '2090-06-14' });
    const past = expenseInput(accountId, expenseCategoryId, { date: '2090-02-01' });

    const first = await service.create(ctxFor(userId, LATE_NIGHT), today);
    const second = await service.create(ctxFor(userId, LATE_NIGHT), past);

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect((await findStoredTransaction(today.id))?.date).toBe('2090-06-14');
    expect((await findStoredTransaction(past.id))?.date).toBe('2090-02-01');
  });

  it('RN-07 el mismo instante en una zona donde ya es 15/06 acepta esa fecha', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, { date: '2090-06-15' });

    const result = await service.create(ctxFor(userId, LATE_NIGHT, 'Asia/Tokyo'), input);

    expect(result.created).toBe(true);
    expect((await findStoredTransaction(input.id))?.date).toBe('2090-06-15');
  });
});

describe('RF-M3-06 / RN-04 tasas guardadas en el movimiento', () => {
  it('RF-M3-06 un gasto en BOB guarda rate_usd_bob (la referencia en uso de hoy) y rate_cur_bob 1', async () => {
    await marketOn(TODAY, '10.40');
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, { date: TODAY });

    await service.create(ctxFor(userId), input);

    const stored = await findStoredTransaction(input.id);
    expect(stored?.rateCurBob).toBe('1.00');
    expect(stored?.rateUsdBob).toBe('10.40');
  });

  it('RF-M3-06 con el valor manual activo, un gasto de hoy guarda el valor manual', async () => {
    await marketOn(TODAY, '10.40');
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    await setManual(userId, '9.80', new Date('2090-06-01T12:00:00Z'));
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, { date: TODAY });

    await service.create(ctxFor(userId), input);

    expect((await findStoredTransaction(input.id))?.rateUsdBob).toBe('9.80');
  });

  it('RF-M3-06 un gasto con fecha pasada guarda la tasa del historial de ese dia', async () => {
    await marketOn('2090-06-10', '10.00');
    await marketOn(TODAY, '10.40');
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, { date: '2090-06-10' });

    await service.create(ctxFor(userId), input);

    expect((await findStoredTransaction(input.id))?.rateUsdBob).toBe('10.00');
  });

  it('RN-03 RN-04 un gasto en una cuenta en USD va en USD y guarda las dos tasas', async () => {
    await marketOn(TODAY, '10.40');
    const { userId, accountId, expenseCategoryId } = await setup({
      currencyCode: 'USD',
      initialBalance: '100.00',
    });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, { amount: '20.00', date: TODAY });

    await service.create(ctxFor(userId), input);

    const stored = await findStoredTransaction(input.id);
    expect(stored?.entries).toEqual([
      { accountId, amount: '-20.00', currencyCode: 'USD', date: TODAY },
    ]);
    expect(stored?.rateCurBob).toBe('10.40');
    expect(stored?.rateUsdBob).toBe('10.40');
  });
});

describe('EC-M3-02 Sin ninguna tasa disponible', () => {
  it('EC-M3-02 Sin ninguna tasa disponible: RATE_REQUIRED; al reenviar con manualUsdRate esa tasa queda en el gasto y el valor manual queda activo', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({
      currencyCode: 'USD',
      initialBalance: '100.00',
    });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, { amount: '10.00', date: TODAY });

    const error = await rejectionOf(service.create(ctxFor(userId), input));

    expect(error.code).toBe('RATE_REQUIRED');
    expect(error.status).toBe(409);
    await expectNothingStored(userId);

    const retried = await service.create(ctxFor(userId), { ...input, manualUsdRate: '7.00' });

    expect(retried.created).toBe(true);
    const stored = await findStoredTransaction(input.id);
    expect(stored?.rateUsdBob).toBe('7.00');
    expect(stored?.rateCurBob).toBe('7.00');
    expect(stored?.entries).toEqual([
      { accountId, amount: '-10.00', currencyCode: 'USD', date: TODAY },
    ]);
    const current = await rates.current(ctxFor(userId));
    expect(current.inUse).toMatchObject({ kind: 'manual', value: '7.00' });
    expect(await manualOnEventsOf(userId)).toEqual(['7.00']);
  });

  it('EC-M3-02 los movimientos en bolivianos se registran sin restriccion aunque no haya ninguna tasa', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({ initialBalance: '100.00' });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, { date: TODAY });

    const result = await service.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    const stored = await findStoredTransaction(input.id);
    expect(stored?.rateCurBob).toBe('1.00');
    expect(stored?.rateUsdBob).toBeNull();
    expect(await manualOnEventsOf(userId)).toEqual([]);
  });

  it('EC-M3-02 el valor manual se activa en la misma transaccion: si el gasto se rechaza, no queda activo', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({
      type: 'cash',
      currencyCode: 'USD',
      initialBalance: '5.00',
    });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, {
      amount: '10.00',
      date: TODAY,
      manualUsdRate: '7.00',
    });

    const error = await rejectionOf(service.create(ctxFor(userId), input));

    expect(error.code).toBe('NEGATIVE_BALANCE');
    await expectNothingStored(userId);
    const current = await rates.current(ctxFor(userId));
    expect(current.inUse.kind).not.toBe('manual');
    expect(await manualOnEventsOf(userId)).toEqual([]);
  });
});

describe('RF-M4-03 / RN-12 movimiento anterior al saldo inicial', () => {
  it('RF-M4-03 RN-12 Movimiento anterior al saldo inicial no altera el saldo: Bs 50 el 5/10 sobre Bs 500 del 10/10', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({
      type: 'cash',
      initialBalance: '500.00',
      initialBalanceDate: '2090-10-10',
    });
    const { service } = newService();
    const input = expenseInput(accountId, expenseCategoryId, {
      amount: '50.00',
      date: '2090-10-05',
    });

    const result = await service.create(ctxFor(userId, new Date('2090-10-15T16:00:00Z')), input);

    expect(result.created).toBe(true);
    expect(await balanceOf(userId, accountId)).toBe('500.00');
    const stored = await findStoredTransaction(input.id);
    expect(stored?.date).toBe('2090-10-05');
    expect(stored?.entries).toEqual([
      { accountId, amount: '-50.00', currencyCode: 'BOB', date: '2090-10-05' },
    ]);

    const filters = { from: '2090-10-01', to: '2090-10-31', limit: 50 };
    const { page, totals } = await uow.run(
      async (repos: Repositories) => ({
        page: await repos.ledger.list(filters, null),
        totals: await repos.ledger.summary(filters, 'BOB'),
      }),
      { userLock: userId, readOnly: true },
    );
    expect(page.items.map((item) => item.id)).toContain(input.id);
    expect(totals.expense.toFixed(2)).toBe('50.00');
  });
});

describe('RF-M4-04 Bloqueo de negativo en efectivo', () => {
  it('RF-M4-04 Bloqueo de negativo en efectivo: 35 sobre 30 da NEGATIVE_BALANCE (-5.00) y no se guarda nada', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({
      type: 'cash',
      initialBalance: '30.00',
    });
    const { service, ledgerHooks } = newService();
    const handler = vi.fn(() => Promise.resolve());
    ledgerHooks.register(handler);

    const error = await rejectionOf(
      service.create(
        ctxFor(userId),
        expenseInput(accountId, expenseCategoryId, { amount: '35.00', date: TODAY }),
      ),
    );

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.status).toBe(422);
    expect(error.data).toEqual({ accountId, resultingBalance: '-5.00' });
    await expectNothingStored(userId);
    expect(await balanceOf(userId, accountId)).toBe('30.00');
    expect(handler).not.toHaveBeenCalled();
  });

  it('RF-M4-04 un gasto que deja el efectivo exactamente en 0 se guarda', async () => {
    const { userId, accountId, expenseCategoryId } = await setup({
      type: 'cash',
      initialBalance: '30.00',
    });
    const { service } = newService();

    const result = await service.create(
      ctxFor(userId),
      expenseInput(accountId, expenseCategoryId, { amount: '30.00', date: TODAY }),
    );

    expect(result.created).toBe(true);
    expect(await balanceOf(userId, accountId)).toBe('0.00');
  });
});
