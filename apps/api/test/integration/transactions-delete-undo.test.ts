import type { CreateTransactionInput } from '@finanzas/contracts';
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
  type StoredTransaction,
  undoActionsOf,
} from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `DELETE /api/transactions/:id` and `POST /api/transactions/undo` (plan §4.6.2),
 * the life cycle of a deleted movement (plan §4.6.3, ADR-07) and `UndoInput = { undoToken }`
 * (plan §4.6.1). The task names the operations `delete` and `undo(token)`. These tests assume, as
 * the tests of TASK-121 to TASK-123:
 * - `createTransactionsService({ uow, rates, ledgerHooks })` builds the service and
 *   `create(ctx, input)` creates the movements the tests delete; on a new movement its
 *   `undoToken` is the id of its `undo_action(create)`.
 * - `delete(ctx, id)` deletes the movement `id` of `ctx.userId` and resolves to `{ undoToken }`:
 *   the id of the `undo_action(delete)` it creates (plan §3.5, `undo_action.id` is the undoToken),
 *   which the client needs to show "Deshacer", as `create` returns its own.
 * - `undo(ctx, undoToken)` reverts the action of the token for `ctx.userId`. Its result is not
 *   checked: the rows are read straight by SQL.
 * - A rejection is an `AppError` with the code and the status of the catalogue (ADR-09). A
 *   movement of another user does not exist (`NOT_FOUND`, RNF-14). `NEGATIVE_BALANCE` carries
 *   `{ accountId, resultingBalance }`, as `BalanceGuard` raises it.
 *
 * The expiry of an `undo_action` is checked by the database clock (`expires_at > now()`, plan
 * §4.6.2), so "N seconds later" is simulated by moving its `expires_at` N seconds back.
 *
 * `market_rate` is global (ADR-12): the file saves its rows, empties the table before each test
 * and puts the rows back at the end.
 */
interface CreateResult {
  created: boolean;
  transaction: { id: string };
  undoToken: string | null;
}

interface DeleteResult {
  /** The id of the `undo_action(delete)`. */
  undoToken: string;
}

interface TransactionsServiceUnderTest {
  create(ctx: RatesContext, input: CreateTransactionInput): Promise<CreateResult>;
  delete(ctx: RatesContext, id: string): Promise<DeleteResult>;
  undo(ctx: RatesContext, undoToken: string): Promise<unknown>;
}

type CreateTransactionsService = (deps: {
  uow: UnitOfWork;
  rates: RatesService;
  ledgerHooks: LedgerHooks;
}) => TransactionsServiceUnderTest;

const { createTransactionsService } =
  (await import('../../src/application/services/transactions.service.js')) as unknown as {
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

function ctxFor(userId: string, now: Date = NOW, timezone: string = TZ): RatesContext {
  return { userId, timezone, now, traceId: uuidv7() };
}

async function newUserId(): Promise<string> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  return user.id;
}

async function account(userId: string, options: CreateAccountOptions = {}): Promise<string> {
  const created = await createAccount(userId, { initialBalanceDate: '2090-01-01', ...options });
  return created.id;
}

async function expenseCategory(userId: string): Promise<string> {
  return (await createCategory(userId, { kind: 'expense' })).id;
}

async function incomeCategory(userId: string): Promise<string> {
  return (await createCategory(userId, { kind: 'income' })).id;
}

async function marketRate(kind: Kind, rateDate: string, value: string): Promise<void> {
  const source = kind === 'official' ? 'bcb' : 'paralelo_bo';
  await prisma.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${kind}::market_rate_kind, ${rateDate}::date, ${value}::numeric,
            ${new Date(`${rateDate}T12:00:00Z`)}, ${source}::rate_source)`;
}

/** Parallel bid (median - 0.10), ask (median + 0.10) and median and the official rate of that day. */
async function marketOn(rateDate: string, median: string): Promise<void> {
  const value = new Decimal(median);
  await marketRate('parallel_bid', rateDate, value.minus('0.10').toFixed(2));
  await marketRate('parallel_ask', rateDate, value.plus('0.10').toFixed(2));
  await marketRate('parallel_median', rateDate, median);
  await marketRate('official', rateDate, '6.96');
}

/** The dollar moves after the movement was saved: the market of today is replaced. */
async function marketMovesTo(median: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM market_rate`;
  await marketOn(TODAY, median);
}

/** The token of a new movement; a new movement always has one (`undo_action(create)`). */
function tokenOf(result: CreateResult): string {
  if (result.undoToken === null) {
    throw new Error('A new movement was expected to return its undoToken');
  }
  return result.undoToken;
}

interface Created {
  id: string;
  /** The token of its `undo_action(create)` (RF-M7-07). */
  undoToken: string;
}

async function createExpense(
  service: TransactionsServiceUnderTest,
  userId: string,
  accountId: string,
  categoryId: string,
  amount: string,
): Promise<Created> {
  const input = expenseInput(accountId, categoryId, { date: TODAY, amount });
  const result = await service.create(ctxFor(userId), input);
  return { id: input.id, undoToken: tokenOf(result) };
}

async function createIncome(
  service: TransactionsServiceUnderTest,
  userId: string,
  accountId: string,
  categoryId: string,
  amount: string,
): Promise<Created> {
  const input = incomeInput(accountId, categoryId, { date: TODAY, amount });
  const result = await service.create(ctxFor(userId), input);
  return { id: input.id, undoToken: tokenOf(result) };
}

/** Creates a transfer with its fee through the service. */
async function createTransfer(
  service: TransactionsServiceUnderTest,
  userId: string,
  from: string,
  to: string,
  options: { amountOut: string; fee: string },
): Promise<Created & { feeId: string }> {
  const id = uuidv7();
  const feeId = uuidv7();
  const result = await service.create(ctxFor(userId), {
    kind: 'transfer',
    id,
    fromAccountId: from,
    toAccountId: to,
    amountOut: options.amountOut,
    date: TODAY,
    fee: { id: feeId, amount: options.fee },
  });
  return { id, feeId, undoToken: tokenOf(result) };
}

type LinkedOrigin = 'debt_initial' | 'debt_payment' | 'recurring';

/**
 * A movement created by another module (glosario, RF-M6-09), written by SQL because its origin (a
 * debt, a debt payment, a recurring rule) is created by other modules.
 */
async function createLinkedMovement(
  userId: string,
  options: {
    kind: 'expense' | 'income';
    origin: LinkedOrigin;
    accountId: string;
    categoryId: string;
    amount: string;
  },
): Promise<string> {
  const id = uuidv7();
  const originId = options.origin === 'recurring' ? null : uuidv7();
  const label = options.origin === 'recurring' ? 'Alquiler' : null;
  const amount = new Decimal(options.amount);
  const signed = options.kind === 'expense' ? amount.negated() : amount;
  await prisma.$executeRaw`
    INSERT INTO ledger_transaction (id, user_id, kind, date, category_id, origin, origin_id,
                                    recurring_label, rate_cur_bob, rate_usd_bob)
    VALUES (${id}::uuid, ${userId}::uuid, ${options.kind}::transaction_kind, ${TODAY}::date,
            ${options.categoryId}::uuid, ${options.origin}::transaction_origin, ${originId}::uuid,
            ${label}, 1.00, 10.40)`;
  await prisma.$executeRaw`
    INSERT INTO ledger_entry (id, user_id, transaction_id, account_id, amount, date)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${id}::uuid, ${options.accountId}::uuid,
            ${signed.toFixed(2)}::numeric, ${TODAY}::date)`;
  return id;
}

/** A transfer of "Enviar a meta" (glosario), written by SQL because M12 creates it. */
async function createGoalTransfer(
  userId: string,
  from: string,
  to: string,
  amount: string,
): Promise<string> {
  const id = uuidv7();
  const value = new Decimal(amount);
  await prisma.$executeRaw`
    INSERT INTO ledger_transaction (id, user_id, kind, date, origin, origin_id, rate_cur_bob,
                                    rate_usd_bob)
    VALUES (${id}::uuid, ${userId}::uuid, 'transfer', ${TODAY}::date, 'goal_transfer',
            ${uuidv7()}::uuid, 1.00, 10.40)`;
  await prisma.$executeRaw`
    INSERT INTO ledger_entry (id, user_id, transaction_id, account_id, amount, date)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${id}::uuid, ${from}::uuid,
            ${value.negated().toFixed(2)}::numeric, ${TODAY}::date),
           (${uuidv7()}::uuid, ${userId}::uuid, ${id}::uuid, ${to}::uuid,
            ${value.toFixed(2)}::numeric, ${TODAY}::date)`;
  return id;
}

/** A deletion made in another device: the movement and its fee get `deleted_at`. */
async function deleteElsewhere(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE ledger_transaction SET deleted_at = now()
     WHERE id = ${id}::uuid OR parent_transaction_id = ${id}::uuid`;
}

/** `seconds` pass since the action was created: its expiry moves that much back (ADR-07). */
async function elapse(undoToken: string, seconds: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE undo_action SET expires_at = expires_at - (${seconds}::int * interval '1 second')
     WHERE id = ${undoToken}::uuid`;
}

async function stored(id: string): Promise<StoredTransaction> {
  const row = await findStoredTransaction(id);
  if (row === null) {
    throw new Error(`The transaction ${id} is not stored`);
  }
  return row;
}

/** `true` when the movement keeps its row and its `deleted_at` is set (plan §4.6.3). */
async function isDeleted(id: string): Promise<boolean> {
  return (await stored(id)).deletedAt !== null;
}

/** Everything stored of those movements, to show that a rejected action saved nothing. */
async function snapshotOf(ids: string[]): Promise<(StoredTransaction | null)[]> {
  return Promise.all(ids.map((id) => findStoredTransaction(id)));
}

/** The `undo_action(delete)` rows of the user, oldest first. */
async function deleteActionsOf(userId: string): Promise<{ id: string; kind: string }[]> {
  return (await undoActionsOf(userId)).filter((action) => action.kind === 'delete');
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

/** Waits for the promise and ignores how it ends: only what it left stored is checked. */
async function settle(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Whether it rejects or resolves is not what the test checks.
  }
}

type HookHandler = (tx: Repositories, userId: string, change: LedgerChange) => Promise<void>;

function hookSpy() {
  return vi.fn<HookHandler>(() => Promise.resolve());
}

// ---------- Tests ----------

describe('TASK-124 Eliminar y deshacer', () => {
  it('TASK-124 Eliminar y deshacer: el saldo de Efectivo sube Bs 35,00 al eliminar el gasto y el undo antes de 10 s lo restablece', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const { id } = await createExpense(service, userId, cash, category, '35.00');
    expect(await balanceOf(userId, cash)).toBe('65.00');
    const before = await stored(id);

    const { undoToken } = await service.delete(ctxFor(userId), id);

    expect(await balanceOf(userId, cash)).toBe('100.00');
    expect(await isDeleted(id)).toBe(true);

    await elapse(undoToken, 9);
    await service.undo(ctxFor(userId), undoToken);

    expect(await stored(id)).toEqual(before);
    expect(await balanceOf(userId, cash)).toBe('65.00');
  });

  it('TASK-124 eliminar pone deleted_at en la transaccion y conserva su fila y sus asientos', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const { id } = await createExpense(service, userId, bank, category, '35.00');
    const before = await stored(id);
    const transactions = await countTransactionsOf(userId);
    const entries = await countEntriesOf(userId);

    await service.delete(ctxFor(userId), id);

    const after = await stored(id);
    expect(after.deletedAt).toBeInstanceOf(Date);
    expect(after).toEqual({ ...before, deletedAt: after.deletedAt });
    expect(await countTransactionsOf(userId)).toBe(transactions);
    expect(await countEntriesOf(userId)).toBe(entries);
    expect(await balanceOf(userId, bank)).toBe('1000.00');
  });

  it('TASK-124 eliminar crea un undo_action(delete) y devuelve su token', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const { id } = await createExpense(service, userId, bank, category, '35.00');

    const result = await service.delete(ctxFor(userId), id);

    expect(await deleteActionsOf(userId)).toEqual([{ id: result.undoToken, kind: 'delete' }]);
  });

  it('TASK-124 eliminar llama una vez a LedgerHooks.afterChange con la fecha, la cuenta y la categoria del movimiento', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const { id } = await createExpense(service, userId, cash, category, '35.00');
    const handler = hookSpy();
    ledgerHooks.register(handler);

    await service.delete(ctxFor(userId), id);

    expect(handler).toHaveBeenCalledTimes(1);
    const [, hookUserId, change] = handler.mock.calls[0] ?? [];
    expect(hookUserId).toBe(userId);
    expect(change?.dates).toEqual(expect.arrayContaining([TODAY]));
    expect(change?.accountIds).toEqual(expect.arrayContaining([cash]));
    expect(change?.categoryIds).toEqual(expect.arrayContaining([category]));
  });

  it('TASK-124 si un hook falla, la eliminacion se revierte y no deja undo_action(delete)', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const { id } = await createExpense(service, userId, cash, category, '35.00');
    ledgerHooks.register(() => Promise.reject(new Error('hook boom')));
    const before = await snapshotOf([id]);

    await expect(service.delete(ctxFor(userId), id)).rejects.toThrow('hook boom');

    expect(await snapshotOf([id])).toEqual(before);
    expect(await deleteActionsOf(userId)).toEqual([]);
    expect(await balanceOf(userId, cash)).toBe('65.00');
  });

  it('TASK-124 deshacer una eliminacion pasa por LedgerHooks.afterChange con la cuenta del movimiento', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const { id } = await createExpense(service, userId, cash, category, '35.00');
    const { undoToken } = await service.delete(ctxFor(userId), id);
    const handler = hookSpy();
    ledgerHooks.register(handler);

    await service.undo(ctxFor(userId), undoToken);

    expect(handler).toHaveBeenCalledTimes(1);
    const [, hookUserId, change] = handler.mock.calls[0] ?? [];
    expect(hookUserId).toBe(userId);
    expect(change?.accountIds).toEqual(expect.arrayContaining([cash]));
    expect(change?.dates).toEqual(expect.arrayContaining([TODAY]));
  });

  it('TASK-124 un undo a los 13 s da UNDO_EXPIRED y el movimiento sigue eliminado', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const { id } = await createExpense(service, userId, cash, category, '35.00');
    const { undoToken } = await service.delete(ctxFor(userId), id);
    const deleted = await snapshotOf([id]);
    const handler = hookSpy();
    ledgerHooks.register(handler);

    await elapse(undoToken, 13);
    const error = await rejectionOf(service.undo(ctxFor(userId), undoToken));

    expect(error.code).toBe('UNDO_EXPIRED');
    expect(error.status).toBe(410);
    expect(await snapshotOf([id])).toEqual(deleted);
    expect(await isDeleted(id)).toBe(true);
    expect(await balanceOf(userId, cash)).toBe('100.00');
    expect(handler).not.toHaveBeenCalled();
  });

  it('RNF-11 un undo repetido no hace nada: el token ya usado no restaura el movimiento eliminado otra vez', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const { id } = await createExpense(service, userId, cash, category, '35.00');
    const first = await service.delete(ctxFor(userId), id);
    await service.undo(ctxFor(userId), first.undoToken);
    const second = await service.delete(ctxFor(userId), id);
    const deleted = await snapshotOf([id]);

    await settle(service.undo(ctxFor(userId), first.undoToken));

    expect(await snapshotOf([id])).toEqual(deleted);
    expect(await isDeleted(id)).toBe(true);
    expect(await balanceOf(userId, cash)).toBe('100.00');

    await service.undo(ctxFor(userId), second.undoToken);

    expect(await isDeleted(id)).toBe(false);
    expect(await balanceOf(userId, cash)).toBe('65.00');
  });

  it('RF-M6-10 un movimiento de una recurrente se elimina y se deshace como cualquier otro', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createLinkedMovement(userId, {
      kind: 'expense',
      origin: 'recurring',
      accountId: bank,
      categoryId: category,
      amount: '200.00',
    });
    const before = await stored(id);

    const { undoToken } = await service.delete(ctxFor(userId), id);

    expect(await isDeleted(id)).toBe(true);
    expect(await balanceOf(userId, bank)).toBe('1000.00');

    await service.undo(ctxFor(userId), undoToken);

    expect(await stored(id)).toEqual(before);
    expect(await balanceOf(userId, bank)).toBe('800.00');
  });
});

describe('EC-M6-05 eliminar una transferencia con comision', () => {
  it('EC-M6-05 eliminar una transferencia elimina tambien su comision, con un solo undo_action(delete)', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });
    expect(await balanceOf(userId, bank)).toBe('495.00');

    const { undoToken } = await service.delete(ctxFor(userId), id);

    expect(await isDeleted(id)).toBe(true);
    expect(await isDeleted(feeId)).toBe(true);
    expect(await deleteActionsOf(userId)).toEqual([{ id: undoToken, kind: 'delete' }]);
    expect(await balanceOf(userId, bank)).toBe('1000.00');
    expect(await balanceOf(userId, cash)).toBe('0.00');
  });

  it('EC-M6-05 un solo undo restaura la transferencia y su comision', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });
    const before = await snapshotOf([id, feeId]);
    const { undoToken } = await service.delete(ctxFor(userId), id);

    await service.undo(ctxFor(userId), undoToken);

    expect(await snapshotOf([id, feeId])).toEqual(before);
    expect(await balanceOf(userId, bank)).toBe('495.00');
    expect(await balanceOf(userId, cash)).toBe('500.00');
  });

  it('EC-M6-05 eliminar una transferencia avisa a los hooks de sus dos cuentas y de la categoria de la comision', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service, ledgerHooks } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });
    const feeCategory = (await stored(feeId)).categoryId;
    const handler = hookSpy();
    ledgerHooks.register(handler);

    await service.delete(ctxFor(userId), id);

    expect(handler).toHaveBeenCalled();
    const changes = handler.mock.calls.map(([, , change]) => change);
    const accountIds = changes.flatMap((change) => change.accountIds);
    const categoryIds = changes.flatMap((change) => change.categoryIds);
    expect(accountIds).toEqual(expect.arrayContaining([bank, cash]));
    expect(categoryIds).toEqual(expect.arrayContaining([feeCategory]));
  });
});

describe('EC-M4-01 / RF-M6-08 bloqueo de negativos al eliminar', () => {
  it('EC-M4-01 eliminar un ingreso del efectivo que lo dejaria en -50 da NEGATIVE_BALANCE y no cambia nada', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const income = await incomeCategory(userId);
    const expense = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const { id } = await createIncome(service, userId, cash, income, '100.00');
    await createExpense(service, userId, cash, expense, '50.00');
    const handler = hookSpy();
    ledgerHooks.register(handler);
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.delete(ctxFor(userId), id));

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.status).toBe(422);
    expect(error.data).toEqual({ accountId: cash, resultingBalance: '-50.00' });
    expect(await snapshotOf([id])).toEqual(before);
    expect(await deleteActionsOf(userId)).toEqual([]);
    expect(await balanceOf(userId, cash)).toBe('50.00');
    expect(handler).not.toHaveBeenCalled();
  });

  it('RF-M6-08 eliminar un ingreso que deja el efectivo exactamente en 0 se permite', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const income = await incomeCategory(userId);
    const { service } = newService();
    const { id } = await createIncome(service, userId, cash, income, '100.00');

    await service.delete(ctxFor(userId), id);

    expect(await isDeleted(id)).toBe(true);
    expect(await balanceOf(userId, cash)).toBe('0.00');
  });

  it('RF-M6-08 eliminar una transferencia hacia un efectivo que ya se gasto da NEGATIVE_BALANCE y no elimina ni la transferencia ni su comision', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const expense = await expenseCategory(userId);
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });
    await createExpense(service, userId, cash, expense, '300.00');
    const before = await snapshotOf([id, feeId]);

    const error = await rejectionOf(service.delete(ctxFor(userId), id));

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.data).toEqual({ accountId: cash, resultingBalance: '-300.00' });
    expect(await snapshotOf([id, feeId])).toEqual(before);
    expect(await deleteActionsOf(userId)).toEqual([]);
    expect(await balanceOf(userId, bank)).toBe('495.00');
    expect(await balanceOf(userId, cash)).toBe('200.00');
  });
});

describe('EC-M6-03 deshacer una eliminacion que violaria el bloqueo de negativos', () => {
  it('EC-M6-03 deshacer la eliminacion de un gasto que dejaria el efectivo en negativo da NEGATIVE_BALANCE y el gasto sigue eliminado', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const { id } = await createExpense(service, userId, cash, category, '35.00');
    const { undoToken } = await service.delete(ctxFor(userId), id);
    await createExpense(service, userId, cash, category, '80.00');
    const deleted = await snapshotOf([id]);
    const handler = hookSpy();
    ledgerHooks.register(handler);

    const error = await rejectionOf(service.undo(ctxFor(userId), undoToken));

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.status).toBe(422);
    expect(error.data).toEqual({ accountId: cash, resultingBalance: '-15.00' });
    expect(await snapshotOf([id])).toEqual(deleted);
    expect(await isDeleted(id)).toBe(true);
    expect(await balanceOf(userId, cash)).toBe('20.00');
    expect(handler).not.toHaveBeenCalled();
  });

  it('EC-M6-03 deshacer la eliminacion de una transferencia desde el efectivo valida el monto y la comision juntos', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '600.00' });
    const bank = await account(userId, { type: 'bank', initialBalance: '0.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, cash, bank, {
      amountOut: '500.00',
      fee: '5.00',
    });
    const { undoToken } = await service.delete(ctxFor(userId), id);
    await createExpense(service, userId, cash, category, '100.00');
    const deleted = await snapshotOf([id, feeId]);

    const error = await rejectionOf(service.undo(ctxFor(userId), undoToken));

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.data).toEqual({ accountId: cash, resultingBalance: '-5.00' });
    expect(await snapshotOf([id, feeId])).toEqual(deleted);
    expect(await isDeleted(id)).toBe(true);
    expect(await isDeleted(feeId)).toBe(true);
    expect(await balanceOf(userId, cash)).toBe('500.00');
    expect(await balanceOf(userId, bank)).toBe('0.00');
  });

  it('RF-M6-08 deshacer una eliminacion que deja el efectivo exactamente en 0 se permite', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const { id } = await createExpense(service, userId, cash, category, '35.00');
    const { undoToken } = await service.delete(ctxFor(userId), id);
    await createExpense(service, userId, cash, category, '65.00');

    await service.undo(ctxFor(userId), undoToken);

    expect(await isDeleted(id)).toBe(false);
    expect(await balanceOf(userId, cash)).toBe('0.00');
  });

  it('RF-M6-08 deshacer una eliminacion restaura el gasto en $ con su tasa guardada aunque el dolar se haya movido', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const usd = await account(userId, {
      type: 'savings',
      currencyCode: 'USD',
      initialBalance: '500.00',
    });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const { id } = await createExpense(service, userId, usd, category, '10.00');
    const before = await stored(id);
    expect(before).toMatchObject({ rateCurBob: '10.40', rateUsdBob: '10.40' });
    const { undoToken } = await service.delete(ctxFor(userId), id);
    await marketMovesTo('11.00');

    await service.undo(ctxFor(userId), undoToken);

    expect(await stored(id)).toEqual(before);
    expect(await balanceOf(userId, usd)).toBe('490.00');
  });
});

describe('RF-M7-07 deshacer una creacion', () => {
  it('RF-M7-07 el undo de una creacion antes de 10 s elimina el gasto recien creado y su saldo vuelve', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const { id, undoToken } = await createExpense(service, userId, cash, category, '35.00');
    expect(await balanceOf(userId, cash)).toBe('65.00');

    await elapse(undoToken, 9);
    await service.undo(ctxFor(userId), undoToken);

    expect(await isDeleted(id)).toBe(true);
    expect(await balanceOf(userId, cash)).toBe('100.00');
  });

  it('RF-M7-07 el undo de una transferencia recien creada elimina tambien su comision', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId, undoToken } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });

    await service.undo(ctxFor(userId), undoToken);

    expect(await isDeleted(id)).toBe(true);
    expect(await isDeleted(feeId)).toBe(true);
    expect(await balanceOf(userId, bank)).toBe('1000.00');
    expect(await balanceOf(userId, cash)).toBe('0.00');
  });

  it('RF-M7-07 el undo de una creacion tiene las mismas validaciones que una eliminacion: un ingreso cuyo retiro dejaria el efectivo en negativo da NEGATIVE_BALANCE', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const income = await incomeCategory(userId);
    const expense = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const { id, undoToken } = await createIncome(service, userId, cash, income, '100.00');
    await createExpense(service, userId, cash, expense, '70.00');
    const handler = hookSpy();
    ledgerHooks.register(handler);
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.undo(ctxFor(userId), undoToken));

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.status).toBe(422);
    expect(error.data).toEqual({ accountId: cash, resultingBalance: '-70.00' });
    expect(await snapshotOf([id])).toEqual(before);
    expect(await isDeleted(id)).toBe(false);
    expect(await balanceOf(userId, cash)).toBe('30.00');
    expect(handler).not.toHaveBeenCalled();
  });

  it('RF-M7-07 el undo de una creacion pasa por LedgerHooks.afterChange con la cuenta del movimiento', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const { undoToken } = await createExpense(service, userId, cash, category, '35.00');
    const handler = hookSpy();
    ledgerHooks.register(handler);

    await service.undo(ctxFor(userId), undoToken);

    expect(handler).toHaveBeenCalledTimes(1);
    const [, hookUserId, change] = handler.mock.calls[0] ?? [];
    expect(hookUserId).toBe(userId);
    expect(change?.accountIds).toEqual(expect.arrayContaining([cash]));
    expect(change?.categoryIds).toEqual(expect.arrayContaining([category]));
  });

  it('RF-M7-07 el undo de una creacion a los 13 s da UNDO_EXPIRED y el movimiento se queda', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const { id, undoToken } = await createExpense(service, userId, cash, category, '35.00');
    const before = await snapshotOf([id]);

    await elapse(undoToken, 13);
    const error = await rejectionOf(service.undo(ctxFor(userId), undoToken));

    expect(error.code).toBe('UNDO_EXPIRED');
    expect(error.status).toBe(410);
    expect(await snapshotOf([id])).toEqual(before);
    expect(await balanceOf(userId, cash)).toBe('65.00');
  });
});

describe('TASK-124 un vinculado de deuda o de meta solo se elimina desde su origen', () => {
  it('TASK-124 eliminar un pago de deuda da LINKED_DELETE_FORBIDDEN y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const id = await createLinkedMovement(userId, {
      kind: 'expense',
      origin: 'debt_payment',
      accountId: bank,
      categoryId: category,
      amount: '200.00',
    });
    const handler = hookSpy();
    ledgerHooks.register(handler);
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.delete(ctxFor(userId), id));

    expect(error.code).toBe('LINKED_DELETE_FORBIDDEN');
    expect(error.status).toBe(422);
    expect(await snapshotOf([id])).toEqual(before);
    expect(await undoActionsOf(userId)).toEqual([]);
    expect(await balanceOf(userId, bank)).toBe('800.00');
    expect(handler).not.toHaveBeenCalled();
  });

  it('TASK-124 eliminar el movimiento inicial de una deuda da LINKED_DELETE_FORBIDDEN y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '0.00' });
    const category = await incomeCategory(userId);
    const { service } = newService();
    const id = await createLinkedMovement(userId, {
      kind: 'income',
      origin: 'debt_initial',
      accountId: bank,
      categoryId: category,
      amount: '300.00',
    });
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.delete(ctxFor(userId), id));

    expect(error.code).toBe('LINKED_DELETE_FORBIDDEN');
    expect(await snapshotOf([id])).toEqual(before);
    expect(await undoActionsOf(userId)).toEqual([]);
    expect(await balanceOf(userId, bank)).toBe('300.00');
  });

  it('TASK-124 eliminar una transferencia de meta da LINKED_DELETE_FORBIDDEN y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const savings = await account(userId, { type: 'savings', initialBalance: '0.00' });
    const { service } = newService();
    const id = await createGoalTransfer(userId, bank, savings, '250.00');
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.delete(ctxFor(userId), id));

    expect(error.code).toBe('LINKED_DELETE_FORBIDDEN');
    expect(error.status).toBe(422);
    expect(await snapshotOf([id])).toEqual(before);
    expect(await undoActionsOf(userId)).toEqual([]);
    expect(await balanceOf(userId, bank)).toBe('750.00');
    expect(await balanceOf(userId, savings)).toBe('250.00');
  });
});

describe('TASK-124 un movimiento que no existe para el usuario', () => {
  it('RNF-09 eliminar un movimiento ya eliminado en otro dispositivo da NOT_FOUND y no crea otro undo_action', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const { id } = await createExpense(service, userId, bank, category, '35.00');
    await deleteElsewhere(id);
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.delete(ctxFor(userId), id));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
    expect(await snapshotOf([id])).toEqual(before);
    expect(await deleteActionsOf(userId)).toEqual([]);
  });

  it('TASK-124 eliminar un id que no existe da NOT_FOUND', async () => {
    const userId = await newUserId();
    const { service } = newService();

    const error = await rejectionOf(service.delete(ctxFor(userId), uuidv7()));

    expect(error.code).toBe('NOT_FOUND');
    expect(await undoActionsOf(userId)).toEqual([]);
  });

  it('TASK-124 aislamiento: eliminar el movimiento de otro usuario da NOT_FOUND y no lo cambia', async () => {
    const owner = await newUserId();
    const ownerBank = await account(owner, { type: 'bank', initialBalance: '1000.00' });
    const ownerCategory = await expenseCategory(owner);
    const other = await newUserId();
    const { service } = newService();
    const { id } = await createExpense(service, owner, ownerBank, ownerCategory, '35.00');
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.delete(ctxFor(other), id));

    expect(error.code).toBe('NOT_FOUND');
    expect(await snapshotOf([id])).toEqual(before);
    expect(await balanceOf(owner, ownerBank)).toBe('965.00');
    expect(await undoActionsOf(other)).toEqual([]);
    expect(await deleteActionsOf(owner)).toEqual([]);
  });

  it('TASK-124 aislamiento: el token de deshacer de otro usuario no restaura su movimiento y el dueno aun puede usarlo', async () => {
    const owner = await newUserId();
    const ownerCash = await account(owner, { type: 'cash', initialBalance: '100.00' });
    const ownerCategory = await expenseCategory(owner);
    const other = await newUserId();
    const { service } = newService();
    const { id } = await createExpense(service, owner, ownerCash, ownerCategory, '35.00');
    const { undoToken } = await service.delete(ctxFor(owner), id);
    const deleted = await snapshotOf([id]);

    await settle(service.undo(ctxFor(other), undoToken));

    expect(await snapshotOf([id])).toEqual(deleted);
    expect(await balanceOf(owner, ownerCash)).toBe('100.00');

    await service.undo(ctxFor(owner), undoToken);

    expect(await isDeleted(id)).toBe(false);
    expect(await balanceOf(owner, ownerCash)).toBe('65.00');
  });
});
