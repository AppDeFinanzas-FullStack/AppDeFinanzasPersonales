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
  type StoredEntry,
  type StoredTransaction,
} from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `PATCH /api/transactions/:id` (plan §4.6.2) over `UpdateTransactionInput`
 * (plan §4.6.1, with `fromAccountId` and `toAccountId` for transfers) and its errors. These tests
 * assume, as the tests of TASK-121 and TASK-122:
 * - `createTransactionsService({ uow, rates, ledgerHooks })` builds the service, `create(ctx, input)`
 *   creates the movements the tests edit and `update(ctx, id, input)` edits the movement `id` of
 *   `ctx.userId` with an `UpdateTransactionInput` already validated by the contract. Its result is
 *   not checked: the rows are read straight by SQL.
 * - A rejection is an `AppError` with the code and the status of the catalogue (ADR-09). A
 *   `VALIDATION_ERROR` carries `{ issues: [{ path, code }] }`, as in `create` (`SAME_ACCOUNT`,
 *   `CURRENCY_MISMATCH`). A movement or an account of another user does not exist (`NOT_FOUND`,
 *   RNF-14). `LINKED_FIELD_LOCKED` carries `{ originType, originId }`: the `origin` and the
 *   `origin_id` of the movement (plan §3.5).
 * - `amountInNewCurrency` is the amount in the currency of the new account, as the client confirms
 *   it (RF-M6-07); the service rejects one above 999.999.999,99 with `AMOUNT_OUT_OF_RANGE` (EC-M6-07).
 *
 * `market_rate` is global (ADR-12): the file saves its rows, empties the table before each test
 * and puts the rows back at the end.
 */
interface UpdateInput {
  amount?: string;
  accountId?: string;
  amountInNewCurrency?: string;
  fromAccountId?: string;
  toAccountId?: string;
  categoryId?: string;
  date?: string;
  note?: string | null;
  rateUsdBob?: string;
  rateCurBob?: string;
  declaredRate?: string;
}

interface CreateResult {
  created: boolean;
  transaction: { id: string };
  undoToken: string | null;
}

interface TransactionsServiceUnderTest {
  create(ctx: RatesContext, input: CreateTransactionInput): Promise<CreateResult>;
  update(ctx: RatesContext, id: string, input: UpdateInput): Promise<unknown>;
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
const EARLIER = '2090-06-10';

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
  await marketOn(EARLIER, median);
}

interface ExpenseOptions {
  amount: string;
  date?: string;
  note?: string;
}

async function createExpense(
  service: TransactionsServiceUnderTest,
  userId: string,
  accountId: string,
  categoryId: string,
  options: ExpenseOptions,
): Promise<string> {
  const input = expenseInput(accountId, categoryId, { date: TODAY, ...options });
  await service.create(ctxFor(userId), input);
  return input.id;
}

async function createIncome(
  service: TransactionsServiceUnderTest,
  userId: string,
  accountId: string,
  categoryId: string,
  options: ExpenseOptions,
): Promise<string> {
  const input = incomeInput(accountId, categoryId, { date: TODAY, ...options });
  await service.create(ctxFor(userId), input);
  return input.id;
}

interface TransferOptions {
  amountOut: string;
  declaredRate?: string;
  date?: string;
  fee?: string;
}

/** Creates a transfer through the service; returns its id and the id of its fee. */
async function createTransfer(
  service: TransactionsServiceUnderTest,
  userId: string,
  from: string,
  to: string,
  options: TransferOptions,
): Promise<{ id: string; feeId: string }> {
  const id = uuidv7();
  const feeId = uuidv7();
  await service.create(ctxFor(userId), {
    kind: 'transfer',
    id,
    fromAccountId: from,
    toAccountId: to,
    amountOut: options.amountOut,
    date: options.date ?? TODAY,
    ...(options.declaredRate === undefined ? {} : { declaredRate: options.declaredRate }),
    ...(options.fee === undefined ? {} : { fee: { id: feeId, amount: options.fee } }),
  });
  return { id, feeId };
}

/**
 * A movement linked to its origin (glosario, RF-M6-09), written by SQL because its origin (a debt
 * payment, a goal transfer) is created by other modules. `origin_id` is the target of "Ir a…".
 */
async function createLinkedExpense(
  userId: string,
  accountId: string,
  categoryId: string,
  options: { origin: 'debt_payment' | 'goal_transfer' | 'recurring'; amount: string; note?: string },
): Promise<{ id: string; originId: string | null }> {
  const id = uuidv7();
  const originId = options.origin === 'recurring' ? null : uuidv7();
  const label = options.origin === 'recurring' ? 'Alquiler' : null;
  await prisma.$executeRaw`
    INSERT INTO ledger_transaction (id, user_id, kind, date, note, category_id, origin, origin_id,
                                    recurring_label, rate_cur_bob, rate_usd_bob)
    VALUES (${id}::uuid, ${userId}::uuid, 'expense', ${TODAY}::date, ${options.note ?? null},
            ${categoryId}::uuid, ${options.origin}::transaction_origin, ${originId}::uuid,
            ${label}, 1.00, 10.40)`;
  await prisma.$executeRaw`
    INSERT INTO ledger_entry (id, user_id, transaction_id, account_id, amount, date)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${id}::uuid, ${accountId}::uuid,
            ${new Decimal(options.amount).negated().toFixed(2)}::numeric, ${TODAY}::date)`;
  return { id, originId };
}

/** A deletion made in another device (EC-M6-02): the movement and its fee get `deleted_at`. */
async function deleteElsewhere(id: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE ledger_transaction SET deleted_at = now()
     WHERE id = ${id}::uuid OR parent_transaction_id = ${id}::uuid`;
}

interface StoredHeader {
  date: string;
  note: string | null;
  categoryId: string | null;
  kind: string;
  origin: string;
  declaredRate: string | null;
  rateCurBob: string;
  rateUsdBob: string | null;
}

async function headerOf(id: string): Promise<StoredHeader | null> {
  const rows = await prisma.$queryRaw<StoredHeader[]>`
    SELECT date::text AS date, note, category_id::text AS "categoryId", kind::text AS kind,
           origin::text AS origin, declared_rate::text AS "declaredRate",
           rate_cur_bob::text AS "rateCurBob", rate_usd_bob::text AS "rateUsdBob"
      FROM ledger_transaction
     WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
}

async function stored(id: string): Promise<StoredTransaction> {
  const row = await findStoredTransaction(id);
  if (row === null) {
    throw new Error(`The transaction ${id} is not stored`);
  }
  return row;
}

/** The entries of a stored transaction, ordered by account so the comparison does not depend on ids. */
async function entriesOf(id: string): Promise<StoredEntry[]> {
  return sortedEntries((await stored(id)).entries);
}

function sortedEntries(entries: StoredEntry[]): StoredEntry[] {
  return [...entries].sort((a, b) => a.accountId.localeCompare(b.accountId));
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

/** The codes of the issues of a `VALIDATION_ERROR` (`{ issues: [{ path, code }] }`). */
function issueCodes(error: AppError): string[] {
  const issues = (error.data?.['issues'] ?? []) as { code?: unknown }[];
  return issues.map((issue) => String(issue.code));
}

/** Everything the user has stored, to show that a rejected edit saved nothing. */
async function snapshotOf(ids: string[]): Promise<(StoredTransaction | null)[]> {
  return Promise.all(ids.map((id) => findStoredTransaction(id)));
}

// ---------- Tests ----------

describe('TASK-123 editar un gasto o un ingreso', () => {
  it('TASK-123 editar el monto, la nota y la categoria de un gasto reescribe la cabecera y su asiento', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const other = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, {
      amount: '35.00',
      note: 'Almuerzo',
    });

    await service.update(ctxFor(userId), id, { amount: '50.00', note: 'Cena', categoryId: other });

    expect(await stored(id)).toMatchObject({
      kind: 'expense',
      date: TODAY,
      note: 'Cena',
      categoryId: other,
      deletedAt: null,
      entries: [{ accountId: bank, amount: '-50.00', currencyCode: 'BOB', date: TODAY }],
    });
    expect(await balanceOf(userId, bank)).toBe('950.00');
  });

  it('TASK-123 la nota se puede borrar con null', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '100.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, {
      amount: '10.00',
      note: 'Taxi',
    });

    await service.update(ctxFor(userId), id, { note: null });

    expect((await stored(id)).note).toBeNull();
    expect((await stored(id)).entries).toEqual([
      { accountId: bank, amount: '-10.00', currencyCode: 'BOB', date: TODAY },
    ]);
  });

  it('TASK-123 cambiar la cuenta y la fecha de un ingreso mueve su asiento', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '0.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const category = await incomeCategory(userId);
    const { service } = newService();
    const id = await createIncome(service, userId, bank, category, { amount: '200.00' });

    await service.update(ctxFor(userId), id, { accountId: cash, date: EARLIER });

    expect(await stored(id)).toMatchObject({
      kind: 'income',
      date: EARLIER,
      entries: [{ accountId: cash, amount: '200.00', currencyCode: 'BOB', date: EARLIER }],
    });
    expect(await balanceOf(userId, bank)).toBe('0.00');
    expect(await balanceOf(userId, cash)).toBe('200.00');
  });

  it('TASK-123 llama una vez a LedgerHooks.afterChange con las fechas, las cuentas y las categorias de antes y de despues', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const other = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const newCategory = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const id = await createExpense(service, userId, bank, category, { amount: '35.00' });
    const handler = vi.fn<
      (tx: Repositories, userId: string, change: LedgerChange) => Promise<void>
    >(() => Promise.resolve());
    ledgerHooks.register(handler);

    await service.update(ctxFor(userId), id, {
      accountId: other,
      date: EARLIER,
      categoryId: newCategory,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const [, hookUserId, change] = handler.mock.calls[0] ?? [];
    expect(hookUserId).toBe(userId);
    expect(change?.dates).toEqual(expect.arrayContaining([TODAY, EARLIER]));
    expect(change?.accountIds).toEqual(expect.arrayContaining([bank, other]));
    expect(change?.categoryIds).toEqual(expect.arrayContaining([category, newCategory]));
  });

  it('RF-M6-06 el tipo no cambia: un gasto editado sigue siendo un gasto y un ingreso sigue siendo un ingreso', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const expense = await expenseCategory(userId);
    const income = await incomeCategory(userId);
    const { service } = newService();
    const expenseId = await createExpense(service, userId, bank, expense, { amount: '35.00' });
    const incomeId = await createIncome(service, userId, bank, income, { amount: '80.00' });

    await service.update(ctxFor(userId), expenseId, { amount: '40.00' });
    await service.update(ctxFor(userId), incomeId, { amount: '90.00' });

    expect(await stored(expenseId)).toMatchObject({
      kind: 'expense',
      entries: [{ accountId: bank, amount: '-40.00' }],
    });
    expect(await stored(incomeId)).toMatchObject({
      kind: 'income',
      entries: [{ accountId: bank, amount: '90.00' }],
    });
  });
});

describe('EC-M6-04 / RF-M3-10 la tasa guardada se conserva', () => {
  it('EC-M6-04 cambiar la fecha de un gasto en $ conserva su tasa guardada', async () => {
    await marketOn(TODAY, '10.40');
    await marketOn(EARLIER, '9.00');
    const userId = await newUserId();
    const usd = await account(userId, {
      type: 'savings',
      currencyCode: 'USD',
      initialBalance: '500.00',
    });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, usd, category, { amount: '10.00' });
    expect(await headerOf(id)).toMatchObject({ rateCurBob: '10.40', rateUsdBob: '10.40' });

    await service.update(ctxFor(userId), id, { date: EARLIER });

    expect(await headerOf(id)).toMatchObject({
      date: EARLIER,
      rateCurBob: '10.40',
      rateUsdBob: '10.40',
    });
    expect((await stored(id)).entries).toEqual([
      { accountId: usd, amount: '-10.00', currencyCode: 'USD', date: EARLIER },
    ]);
  });

  it('RF-M3-10 cambiar la fecha de un gasto en Bs conserva su rate_usd_bob aunque el dolar se haya movido', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, { amount: '104.00' });
    await marketMovesTo('11.00');

    await service.update(ctxFor(userId), id, { date: EARLIER, amount: '110.00' });

    expect(await headerOf(id)).toMatchObject({
      date: EARLIER,
      rateCurBob: '1.00',
      rateUsdBob: '10.40',
    });
  });

  it('RF-M3-10 cambiar la cuenta de un gasto a otra de la misma moneda conserva su tasa', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const usd = await account(userId, {
      type: 'savings',
      currencyCode: 'USD',
      initialBalance: '500.00',
    });
    const otherUsd = await account(userId, {
      type: 'bank',
      currencyCode: 'USD',
      initialBalance: '500.00',
    });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, usd, category, { amount: '10.00' });
    await marketMovesTo('11.00');

    await service.update(ctxFor(userId), id, { accountId: otherUsd });

    expect(await headerOf(id)).toMatchObject({ rateCurBob: '10.40', rateUsdBob: '10.40' });
    expect((await stored(id)).entries).toEqual([
      { accountId: otherUsd, amount: '-10.00', currencyCode: 'USD', date: TODAY },
    ]);
    expect(await balanceOf(userId, usd)).toBe('500.00');
    expect(await balanceOf(userId, otherUsd)).toBe('490.00');
  });

  it('RF-M3-10 la tasa solo cambia si llega a mano: rateUsdBob en un gasto en Bs', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, { amount: '104.00' });

    await service.update(ctxFor(userId), id, { rateUsdBob: '10.00' });

    expect(await headerOf(id)).toMatchObject({ rateCurBob: '1.00', rateUsdBob: '10.00' });
    expect((await stored(id)).entries).toEqual([
      { accountId: bank, amount: '-104.00', currencyCode: 'BOB', date: TODAY },
    ]);
  });

  it('EC-M6-04 el usuario puede editar a mano la tasa de un gasto en $ (rateUsdBob y rateCurBob)', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const usd = await account(userId, {
      type: 'savings',
      currencyCode: 'USD',
      initialBalance: '500.00',
    });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, usd, category, { amount: '10.00' });

    await service.update(ctxFor(userId), id, {
      date: EARLIER,
      rateUsdBob: '9.50',
      rateCurBob: '9.50',
    });

    expect(await headerOf(id)).toMatchObject({
      date: EARLIER,
      rateCurBob: '9.50',
      rateUsdBob: '9.50',
    });
  });

  it('RF-M3-10 en una transferencia entre monedas, cambiar la fecha conserva la tasa declarada y los montos', async () => {
    await marketOn(TODAY, '10.40');
    await marketOn(EARLIER, '9.00');
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '5000.00' });
    const usd = await account(userId, { type: 'savings', currencyCode: 'USD' });
    const { service } = newService();
    const { id } = await createTransfer(service, userId, bank, usd, {
      amountOut: '1040.00',
      declaredRate: '10.40',
    });

    await service.update(ctxFor(userId), id, { date: EARLIER });

    expect(await headerOf(id)).toMatchObject({
      date: EARLIER,
      declaredRate: '10.40',
      rateUsdBob: '10.40',
    });
    expect(await entriesOf(id)).toEqual(
      sortedEntries([
        { accountId: bank, amount: '-1040.00', currencyCode: 'BOB', date: EARLIER },
        { accountId: usd, amount: '100.00', currencyCode: 'USD', date: EARLIER },
      ]),
    );
  });
});

describe('RF-M6-07 / EC-M6-07 pasar un movimiento a una cuenta de otra moneda', () => {
  it('RF-M6-07 pasar un gasto en Bs a una cuenta en $ guarda amountInNewCurrency en dolares y conserva la tasa', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const usd = await account(userId, {
      type: 'savings',
      currencyCode: 'USD',
      initialBalance: '50.00',
    });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, { amount: '104.00' });

    await service.update(ctxFor(userId), id, { accountId: usd, amountInNewCurrency: '10.00' });

    expect((await stored(id)).entries).toEqual([
      { accountId: usd, amount: '-10.00', currencyCode: 'USD', date: TODAY },
    ]);
    expect((await headerOf(id))?.rateUsdBob).toBe('10.40');
    expect(await balanceOf(userId, bank)).toBe('1000.00');
    expect(await balanceOf(userId, usd)).toBe('40.00');
  });

  it('RF-M6-07 pasar a una cuenta de otra moneda sin amountInNewCurrency se rechaza y no cambia nada', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const usd = await account(userId, { type: 'savings', currencyCode: 'USD' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, { amount: '104.00' });
    const before = await snapshotOf([id]);

    await rejectionOf(service.update(ctxFor(userId), id, { accountId: usd }));

    expect(await snapshotOf([id])).toEqual(before);
    expect(await balanceOf(userId, bank)).toBe('896.00');
  });

  it('EC-M6-07 una conversion mayor que 999.999.999,99 da AMOUNT_OUT_OF_RANGE y no cambia nada', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const usd = await account(userId, { type: 'bank', currencyCode: 'USD' });
    const bank = await account(userId, { type: 'bank', initialBalance: '0.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, usd, category, { amount: '100000000.00' });
    const before = await snapshotOf([id]);

    const error = await rejectionOf(
      service.update(ctxFor(userId), id, {
        accountId: bank,
        amountInNewCurrency: '1040000000.00',
      }),
    );

    expect(error.code).toBe('AMOUNT_OUT_OF_RANGE');
    expect(error.status).toBe(422);
    expect(await snapshotOf([id])).toEqual(before);
    expect(await balanceOf(userId, bank)).toBe('0.00');
  });

  it('EC-M6-07 una conversion de exactamente 999.999.999,99 se acepta', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const usd = await account(userId, { type: 'bank', currencyCode: 'USD' });
    const bank = await account(userId, { type: 'bank', initialBalance: '0.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, usd, category, { amount: '96153846.15' });

    await service.update(ctxFor(userId), id, {
      accountId: bank,
      amountInNewCurrency: '999999999.99',
    });

    expect((await stored(id)).entries).toEqual([
      { accountId: bank, amount: '-999999999.99', currencyCode: 'BOB', date: TODAY },
    ]);
    expect(await balanceOf(userId, usd)).toBe('0.00');
  });
});

describe('RF-M6-09 movimientos vinculados', () => {
  it('RF-M6-09 editar el monto de un vinculado da LINKED_FIELD_LOCKED con su origen y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const linked = await createLinkedExpense(userId, bank, category, {
      origin: 'debt_payment',
      amount: '200.00',
    });
    const before = await snapshotOf([linked.id]);

    const error = await rejectionOf(
      service.update(ctxFor(userId), linked.id, { amount: '150.00' }),
    );

    expect(error.code).toBe('LINKED_FIELD_LOCKED');
    expect(error.status).toBe(422);
    expect(error.data).toMatchObject({ originType: 'debt_payment', originId: linked.originId });
    expect(await snapshotOf([linked.id])).toEqual(before);
    expect(await balanceOf(userId, bank)).toBe('800.00');
  });

  it('RF-M6-09 editar la cuenta o la fecha de un vinculado da LINKED_FIELD_LOCKED', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const other = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const linked = await createLinkedExpense(userId, bank, category, {
      origin: 'goal_transfer',
      amount: '200.00',
    });
    const before = await snapshotOf([linked.id]);

    const byAccount = await rejectionOf(
      service.update(ctxFor(userId), linked.id, { accountId: other }),
    );
    const byDate = await rejectionOf(
      service.update(ctxFor(userId), linked.id, { date: EARLIER }),
    );

    expect(byAccount.code).toBe('LINKED_FIELD_LOCKED');
    expect(byAccount.data).toMatchObject({
      originType: 'goal_transfer',
      originId: linked.originId,
    });
    expect(byDate.code).toBe('LINKED_FIELD_LOCKED');
    expect(await snapshotOf([linked.id])).toEqual(before);
  });

  it('RF-M6-09 la nota de un vinculado si se puede editar', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const linked = await createLinkedExpense(userId, bank, category, {
      origin: 'debt_payment',
      amount: '200.00',
      note: 'Cuota',
    });

    await service.update(ctxFor(userId), linked.id, { note: 'Cuota de junio' });

    expect(await stored(linked.id)).toMatchObject({
      note: 'Cuota de junio',
      origin: 'debt_payment',
      date: TODAY,
      entries: [{ accountId: bank, amount: '-200.00', currencyCode: 'BOB', date: TODAY }],
    });
  });

  it('RF-M6-09 la categoria de un vinculado si se puede editar', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const other = await expenseCategory(userId);
    const { service } = newService();
    const linked = await createLinkedExpense(userId, bank, category, {
      origin: 'goal_transfer',
      amount: '200.00',
    });

    await service.update(ctxFor(userId), linked.id, { categoryId: other });

    expect(await stored(linked.id)).toMatchObject({
      categoryId: other,
      entries: [{ accountId: bank, amount: '-200.00' }],
    });
  });

  it('RF-M6-09 un movimiento de una recurrente no es vinculado: su monto si se edita', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const recurring = await createLinkedExpense(userId, bank, category, {
      origin: 'recurring',
      amount: '200.00',
    });

    await service.update(ctxFor(userId), recurring.id, { amount: '250.00' });

    expect(await stored(recurring.id)).toMatchObject({
      origin: 'recurring',
      entries: [{ accountId: bank, amount: '-250.00' }],
    });
    expect(await balanceOf(userId, bank)).toBe('750.00');
  });

  it('RF-M6-05 el monto de la comision no se edita: editarla directamente da LINKED_FIELD_LOCKED', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });
    const before = await snapshotOf([id, feeId]);

    const error = await rejectionOf(service.update(ctxFor(userId), feeId, { amount: '7.00' }));

    expect(error.code).toBe('LINKED_FIELD_LOCKED');
    expect(await snapshotOf([id, feeId])).toEqual(before);
    expect(await balanceOf(userId, bank)).toBe('495.00');
  });
});

describe('RF-M6-08 bloqueo de negativos al editar', () => {
  it('RF-M6-08 bajar un ingreso que deja el efectivo en negativo da NEGATIVE_BALANCE y no cambia nada', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const income = await incomeCategory(userId);
    const expense = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const incomeId = await createIncome(service, userId, cash, income, { amount: '100.00' });
    await createExpense(service, userId, cash, expense, { amount: '70.00' });
    const handler = vi.fn(() => Promise.resolve());
    ledgerHooks.register(handler);
    const before = await snapshotOf([incomeId]);

    const error = await rejectionOf(
      service.update(ctxFor(userId), incomeId, { amount: '50.00' }),
    );

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.status).toBe(422);
    expect(error.data).toEqual({ accountId: cash, resultingBalance: '-20.00' });
    expect(await snapshotOf([incomeId])).toEqual(before);
    expect(await balanceOf(userId, cash)).toBe('30.00');
    expect(handler).not.toHaveBeenCalled();
  });

  it('RF-M6-08 bajar un ingreso que deja el efectivo exactamente en 0 se guarda', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const income = await incomeCategory(userId);
    const expense = await expenseCategory(userId);
    const { service } = newService();
    const incomeId = await createIncome(service, userId, cash, income, { amount: '100.00' });
    await createExpense(service, userId, cash, expense, { amount: '70.00' });

    await service.update(ctxFor(userId), incomeId, { amount: '70.00' });

    expect(await balanceOf(userId, cash)).toBe('0.00');
  });

  it('RF-M6-08 subir un gasto que deja el efectivo en negativo da NEGATIVE_BALANCE', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const expense = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, cash, expense, { amount: '30.00' });

    const error = await rejectionOf(service.update(ctxFor(userId), id, { amount: '120.00' }));

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.data).toEqual({ accountId: cash, resultingBalance: '-20.00' });
    expect(await balanceOf(userId, cash)).toBe('70.00');
  });

  it('RF-M6-08 pasar un gasto a un efectivo sin saldo suficiente da NEGATIVE_BALANCE', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '10.00' });
    const expense = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, expense, { amount: '30.00' });
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.update(ctxFor(userId), id, { accountId: cash }));

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.data).toEqual({ accountId: cash, resultingBalance: '-20.00' });
    expect(await snapshotOf([id])).toEqual(before);
    expect(await balanceOf(userId, bank)).toBe('970.00');
    expect(await balanceOf(userId, cash)).toBe('10.00');
  });

  it('RF-M6-08 cambiar el origen de una transferencia a un efectivo valida el monto y la comision juntos', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '502.00' });
    const target = await account(userId, { type: 'bank', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, target, {
      amountOut: '500.00',
      fee: '5.00',
    });
    const before = await snapshotOf([id, feeId]);

    const error = await rejectionOf(
      service.update(ctxFor(userId), id, { fromAccountId: cash }),
    );

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.data).toEqual({ accountId: cash, resultingBalance: '-3.00' });
    expect(await snapshotOf([id, feeId])).toEqual(before);
    expect(await balanceOf(userId, cash)).toBe('502.00');
  });
});

describe('EC-M6-02 / RNF-09 editar un movimiento que ya no existe', () => {
  it('EC-M6-02 editar un movimiento eliminado en otro dispositivo da NOT_FOUND y no guarda nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service, ledgerHooks } = newService();
    const id = await createExpense(service, userId, bank, category, {
      amount: '35.00',
      note: 'Almuerzo',
    });
    await deleteElsewhere(id);
    const handler = vi.fn(() => Promise.resolve());
    ledgerHooks.register(handler);
    const before = await snapshotOf([id]);

    const error = await rejectionOf(
      service.update(ctxFor(userId), id, { amount: '50.00', note: 'Cena' }),
    );

    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
    expect(await snapshotOf([id])).toEqual(before);
    expect(handler).not.toHaveBeenCalled();
  });

  it('RNF-09 una transferencia eliminada en otro dispositivo tampoco se edita, ni su comision', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });
    await deleteElsewhere(id);
    const before = await snapshotOf([id, feeId]);

    const error = await rejectionOf(service.update(ctxFor(userId), id, { date: EARLIER }));

    expect(error.code).toBe('NOT_FOUND');
    expect(await snapshotOf([id, feeId])).toEqual(before);
  });

  it('RNF-09 un id que no existe da NOT_FOUND', async () => {
    const userId = await newUserId();
    const { service } = newService();

    const error = await rejectionOf(service.update(ctxFor(userId), uuidv7(), { note: 'x' }));

    expect(error.code).toBe('NOT_FOUND');
    expect(await countTransactionsOf(userId)).toBe(0);
  });

  it('TASK-123 aislamiento: el movimiento de otro usuario no existe (NOT_FOUND) y no cambia', async () => {
    const owner = await newUserId();
    const ownerBank = await account(owner, { type: 'bank', initialBalance: '1000.00' });
    const ownerCategory = await expenseCategory(owner);
    const other = await newUserId();
    const { service } = newService();
    const id = await createExpense(service, owner, ownerBank, ownerCategory, {
      amount: '35.00',
      note: 'Mio',
    });
    const before = await snapshotOf([id]);

    const error = await rejectionOf(
      service.update(ctxFor(other), id, { amount: '1.00', note: 'Ajeno' }),
    );

    expect(error.code).toBe('NOT_FOUND');
    expect(await snapshotOf([id])).toEqual(before);
  });

  it('TASK-123 aislamiento: la cuenta o la categoria de otro usuario no existen como destino de la edicion (NOT_FOUND)', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const other = await newUserId();
    const foreignBank = await account(other, { type: 'bank', initialBalance: '1000.00' });
    const foreignCategory = await expenseCategory(other);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, { amount: '35.00' });
    const before = await snapshotOf([id]);

    const byAccount = await rejectionOf(
      service.update(ctxFor(userId), id, { accountId: foreignBank }),
    );
    const byCategory = await rejectionOf(
      service.update(ctxFor(userId), id, { categoryId: foreignCategory }),
    );

    expect(byAccount.code).toBe('NOT_FOUND');
    expect(byCategory.code).toBe('NOT_FOUND');
    expect(await snapshotOf([id])).toEqual(before);
    expect(await balanceOf(other, foreignBank)).toBe('1000.00');
  });
});

describe('EC-M6-01 / RNF-08 gana la ultima edicion', () => {
  it('EC-M6-01 con dos PATCH seguidos gana el ultimo', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, { amount: '35.00' });

    await service.update(ctxFor(userId), id, { amount: '20.00', note: 'Primero' });
    await service.update(ctxFor(userId), id, { amount: '30.00', note: 'Segundo' });

    expect(await stored(id)).toMatchObject({
      note: 'Segundo',
      entries: [{ accountId: bank, amount: '-30.00', currencyCode: 'BOB', date: TODAY }],
    });
    expect(await balanceOf(userId, bank)).toBe('970.00');
  });

  it('RNF-08 dos PATCH simultaneos desde dos dispositivos se guardan los dos y queda uno de ellos completo', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, { amount: '35.00' });

    await Promise.all([
      service.update(ctxFor(userId), id, { amount: '20.00', note: 'Celular' }),
      service.update(ctxFor(userId), id, { amount: '30.00', note: 'Escritorio' }),
    ]);

    const row = await stored(id);
    expect(row.entries).toHaveLength(1);
    const expected = row.note === 'Celular' ? '-20.00' : '-30.00';
    expect(['Celular', 'Escritorio']).toContain(row.note);
    expect(row.entries[0]?.amount).toBe(expected);
    expect(await balanceOf(userId, bank)).toBe(new Decimal('1000.00').plus(expected).toFixed(2));
  });
});

describe('RNF-24 sin historial de ediciones', () => {
  it('RNF-24 no existe ninguna tabla ni columna de historial de ediciones', async () => {
    const rows = await prisma.$queryRaw<{ name: string }[]>`
      SELECT table_name::text AS name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name ~* '(^|_)(history|histories|revision|revisions|version|versions|audit|audits|edit|edits|edited|snapshot|snapshots|previous)(_|$)'
      UNION ALL
      SELECT (table_name || '.' || column_name)::text AS name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name NOT LIKE '\\_prisma%'
         AND column_name ~* '(^|_)(history|histories|revision|revisions|version|versions|audit|audits|edit|edits|edited|snapshot|snapshots|previous|prev|original)(_|$)'`;

    expect(rows).toEqual([]);
  });

  it('RNF-24 una edicion reescribe el movimiento en su lugar: no deja copias ni filas nuevas', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, { amount: '35.00' });
    const transfer = await createTransfer(service, userId, bank, cash, {
      amountOut: '100.00',
      fee: '2.00',
    });
    const transactions = await countTransactionsOf(userId);
    const entries = await countEntriesOf(userId);

    await service.update(ctxFor(userId), id, { amount: '40.00', note: 'Editado' });
    await service.update(ctxFor(userId), transfer.id, { date: EARLIER, note: 'Editada' });

    expect(await countTransactionsOf(userId)).toBe(transactions);
    expect(await countEntriesOf(userId)).toBe(entries);
    expect((await stored(id)).note).toBe('Editado');
  });
});

describe('RF-M6-07 / RF-M6-04 cambiar las cuentas de una transferencia', () => {
  it('RF-M6-07 cambiar el origen a otra cuenta de la misma moneda mueve el asiento y la comision', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const bank2 = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });

    await service.update(ctxFor(userId), id, { fromAccountId: bank2 });

    expect(await entriesOf(id)).toEqual(
      sortedEntries([
        { accountId: bank2, amount: '-500.00', currencyCode: 'BOB', date: TODAY },
        { accountId: cash, amount: '500.00', currencyCode: 'BOB', date: TODAY },
      ]),
    );
    expect(await entriesOf(feeId)).toEqual([
      { accountId: bank2, amount: '-5.00', currencyCode: 'BOB', date: TODAY },
    ]);
    expect(await balanceOf(userId, bank)).toBe('1000.00');
    expect(await balanceOf(userId, bank2)).toBe('495.00');
    expect(await balanceOf(userId, cash)).toBe('500.00');
  });

  it('RF-M6-07 cambiar el destino a otra cuenta de la misma moneda mueve el asiento y la comision se queda en el origen', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const cash2 = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });

    await service.update(ctxFor(userId), id, { toAccountId: cash2 });

    expect(await entriesOf(id)).toEqual(
      sortedEntries([
        { accountId: bank, amount: '-500.00', currencyCode: 'BOB', date: TODAY },
        { accountId: cash2, amount: '500.00', currencyCode: 'BOB', date: TODAY },
      ]),
    );
    expect(await entriesOf(feeId)).toEqual([
      { accountId: bank, amount: '-5.00', currencyCode: 'BOB', date: TODAY },
    ]);
    expect(await balanceOf(userId, cash)).toBe('0.00');
    expect(await balanceOf(userId, cash2)).toBe('500.00');
    expect(await balanceOf(userId, bank)).toBe('495.00');
  });

  it('RF-M6-07 en una transferencia entre monedas, cambiar el origen a otra cuenta de la misma moneda conserva los montos y la tasa declarada', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '5000.00' });
    const bank2 = await account(userId, { type: 'bank', initialBalance: '5000.00' });
    const usd = await account(userId, { type: 'savings', currencyCode: 'USD' });
    const { service } = newService();
    const { id } = await createTransfer(service, userId, bank, usd, {
      amountOut: '1040.00',
      declaredRate: '10.40',
    });
    await marketMovesTo('11.00');

    await service.update(ctxFor(userId), id, { fromAccountId: bank2 });

    expect(await entriesOf(id)).toEqual(
      sortedEntries([
        { accountId: bank2, amount: '-1040.00', currencyCode: 'BOB', date: TODAY },
        { accountId: usd, amount: '100.00', currencyCode: 'USD', date: TODAY },
      ]),
    );
    expect(await headerOf(id)).toMatchObject({ declaredRate: '10.40', rateUsdBob: '10.40' });
  });

  it('RF-M6-07 cambiar el origen a una cuenta de otra moneda da VALIDATION_ERROR con CURRENCY_MISMATCH y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const usd = await account(userId, {
      type: 'savings',
      currencyCode: 'USD',
      initialBalance: '1000.00',
    });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });
    const before = await snapshotOf([id, feeId]);

    const error = await rejectionOf(service.update(ctxFor(userId), id, { fromAccountId: usd }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.status).toBe(400);
    expect(issueCodes(error)).toContain('CURRENCY_MISMATCH');
    expect(await snapshotOf([id, feeId])).toEqual(before);
    expect(await balanceOf(userId, usd)).toBe('1000.00');
  });

  it('RF-M6-07 cambiar el destino a una cuenta de otra moneda da VALIDATION_ERROR con CURRENCY_MISMATCH y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const usd = await account(userId, { type: 'savings', currencyCode: 'USD' });
    const { service } = newService();
    const { id } = await createTransfer(service, userId, bank, cash, { amountOut: '500.00' });
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.update(ctxFor(userId), id, { toAccountId: usd }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(issueCodes(error)).toContain('CURRENCY_MISMATCH');
    expect(await snapshotOf([id])).toEqual(before);
  });

  it('RF-M6-04 cambiar el origen a la cuenta de destino da VALIDATION_ERROR con SAME_ACCOUNT y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });
    const before = await snapshotOf([id, feeId]);

    const error = await rejectionOf(service.update(ctxFor(userId), id, { fromAccountId: cash }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(issueCodes(error)).toContain('SAME_ACCOUNT');
    expect(await snapshotOf([id, feeId])).toEqual(before);
  });

  it('RF-M6-04 cambiar el destino a la cuenta de origen da VALIDATION_ERROR con SAME_ACCOUNT y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id } = await createTransfer(service, userId, bank, cash, { amountOut: '500.00' });
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.update(ctxFor(userId), id, { toAccountId: bank }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(issueCodes(error)).toContain('SAME_ACCOUNT');
    expect(await snapshotOf([id])).toEqual(before);
  });

  it('RF-M6-04 cambiar el origen o el destino a una cuenta archivada da ACCOUNT_ARCHIVED y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const archivedBank = await account(userId, {
      type: 'bank',
      initialBalance: '1000.00',
      status: 'archived',
    });
    const archivedCash = await account(userId, { type: 'cash', status: 'archived' });
    const { service } = newService();
    const { id } = await createTransfer(service, userId, bank, cash, { amountOut: '500.00' });
    const before = await snapshotOf([id]);

    const byFrom = await rejectionOf(
      service.update(ctxFor(userId), id, { fromAccountId: archivedBank }),
    );
    const byTo = await rejectionOf(
      service.update(ctxFor(userId), id, { toAccountId: archivedCash }),
    );

    expect(byFrom.code).toBe('ACCOUNT_ARCHIVED');
    expect(byFrom.status).toBe(409);
    expect(byTo.code).toBe('ACCOUNT_ARCHIVED');
    expect(await snapshotOf([id])).toEqual(before);
  });

  it('RF-M6-04 aislamiento: cambiar el origen o el destino a una cuenta de otro usuario da NOT_FOUND', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const other = await newUserId();
    const foreign = await account(other, { type: 'bank', initialBalance: '1000.00' });
    const { service } = newService();
    const { id } = await createTransfer(service, userId, bank, cash, { amountOut: '500.00' });
    const before = await snapshotOf([id]);

    const byFrom = await rejectionOf(
      service.update(ctxFor(userId), id, { fromAccountId: foreign }),
    );
    const byTo = await rejectionOf(service.update(ctxFor(userId), id, { toAccountId: foreign }));

    expect(byFrom.code).toBe('NOT_FOUND');
    expect(byTo.code).toBe('NOT_FOUND');
    expect(await snapshotOf([id])).toEqual(before);
    expect(await balanceOf(other, foreign)).toBe('1000.00');
  });

  it('RF-M6-07 accountId en una transferencia da VALIDATION_ERROR y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const bank2 = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const { service } = newService();
    const { id } = await createTransfer(service, userId, bank, cash, { amountOut: '500.00' });
    const before = await snapshotOf([id]);

    const error = await rejectionOf(service.update(ctxFor(userId), id, { accountId: bank2 }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(await snapshotOf([id])).toEqual(before);
  });

  it('RF-M6-07 fromAccountId o toAccountId en un gasto da VALIDATION_ERROR y no cambia nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const bank2 = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const category = await expenseCategory(userId);
    const { service } = newService();
    const id = await createExpense(service, userId, bank, category, { amount: '35.00' });
    const before = await snapshotOf([id]);

    const byFrom = await rejectionOf(
      service.update(ctxFor(userId), id, { fromAccountId: bank2 }),
    );
    const byTo = await rejectionOf(service.update(ctxFor(userId), id, { toAccountId: bank2 }));

    expect(byFrom.code).toBe('VALIDATION_ERROR');
    expect(byTo.code).toBe('VALIDATION_ERROR');
    expect(await snapshotOf([id])).toEqual(before);
  });
});

describe('RF-M6-05 la comision acompana a la transferencia', () => {
  it('RF-M6-05 cambiar la fecha de una transferencia cambia la de su comision, y su monto se conserva', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });

    await service.update(ctxFor(userId), id, { date: EARLIER });

    expect((await headerOf(id))?.date).toBe(EARLIER);
    expect(await entriesOf(id)).toEqual(
      sortedEntries([
        { accountId: bank, amount: '-500.00', currencyCode: 'BOB', date: EARLIER },
        { accountId: cash, amount: '500.00', currencyCode: 'BOB', date: EARLIER },
      ]),
    );
    expect(await headerOf(feeId)).toMatchObject({ date: EARLIER, origin: 'fee', kind: 'expense' });
    expect(await entriesOf(feeId)).toEqual([
      { accountId: bank, amount: '-5.00', currencyCode: 'BOB', date: EARLIER },
    ]);
    expect(await balanceOf(userId, bank)).toBe('495.00');
  });

  it('RF-M6-05 cambiar la fecha y el origen a la vez mueve la comision con los dos y conserva su monto', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const bank2 = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const { id, feeId } = await createTransfer(service, userId, bank, cash, {
      amountOut: '500.00',
      fee: '5.00',
    });

    await service.update(ctxFor(userId), id, { date: EARLIER, fromAccountId: bank2 });

    expect(await entriesOf(feeId)).toEqual([
      { accountId: bank2, amount: '-5.00', currencyCode: 'BOB', date: EARLIER },
    ]);
    expect((await headerOf(feeId))?.date).toBe(EARLIER);
    expect(await balanceOf(userId, bank)).toBe('1000.00');
    expect(await balanceOf(userId, bank2)).toBe('495.00');
  });
});
