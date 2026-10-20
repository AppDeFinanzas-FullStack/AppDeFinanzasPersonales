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
  findStoredTransaction,
  type StoredEntry,
  undoActionsOf,
} from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `TransactionsService.create(ctx, input)` (plan §1.4) with the transfer branch of
 * `CreateTransactionInput` (plan §4.6.1), the errors of `POST /api/transactions` (plan §4.6.2), the
 * convention of the declared rate (plan §4.6.1) and that the fee is another
 * `ledger_transaction(kind = expense, origin = fee, parent_transaction_id)` in
 * "Servicios › Comisiones bancarias" (plan §4.6.3). These tests assume, as the tests of TASK-121:
 * - `createTransactionsService({ uow, rates, ledgerHooks })` builds the service and
 *   `create(ctx, input)` resolves to `{ created, transaction, undoToken }`; `transaction` is the
 *   movement read back with its fee (`LedgerTransactionDetail`).
 * - A rejection is an `AppError` with the code and the status of the catalogue (ADR-09); an account
 *   of another user does not exist for the user (`NOT_FOUND`, RNF-14).
 * - The amount that arrives is `amountOut / rate` from BOB and `amountOut * rate` otherwise, rounded
 *   to two decimals; the recalculated rate is the inverse (`amountInFrom`, `rateFromAmounts` of
 *   `@finanzas/domain`).
 *
 * The rows are read straight by SQL. `market_rate` is global (ADR-12): the file saves its rows,
 * empties the table before each test and puts the rows back at the end.
 */
type TransferInput = Extract<CreateTransactionInput, { kind: 'transfer' }>;

interface CreateResult {
  created: boolean;
  transaction: { id: string; fee: { id: string } | null };
  undoToken: string | null;
}

interface TransactionsServiceUnderTest {
  create(ctx: RatesContext, input: TransferInput): Promise<CreateResult>;
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
const JUNE = { from: '2090-06-01', to: '2090-06-30', limit: 50 };

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

interface TransferOptions {
  id?: string;
  amountOut: string;
  amountIn?: string;
  declaredRate?: string;
  date?: string;
  note?: string;
  fee?: { id?: string; amount: string; categoryId?: string };
}

/** The transfer branch of `CreateTransactionInput`, as the client sends it (plan §4.6.1). */
function transferInput(from: string, to: string, options: TransferOptions): TransferInput {
  return {
    kind: 'transfer',
    id: options.id ?? uuidv7(),
    fromAccountId: from,
    toAccountId: to,
    amountOut: options.amountOut,
    date: options.date ?? TODAY,
    ...(options.amountIn === undefined ? {} : { amountIn: options.amountIn }),
    ...(options.declaredRate === undefined ? {} : { declaredRate: options.declaredRate }),
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.fee === undefined
      ? {}
      : {
          fee: {
            id: options.fee.id ?? uuidv7(),
            amount: options.fee.amount,
            ...(options.fee.categoryId === undefined ? {} : { categoryId: options.fee.categoryId }),
          },
        }),
  };
}

/** The id of the user's preset "Servicios › Comisiones bancarias" (plan §4.6.3). */
async function bankFeesCategoryId(userId: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c.id::text AS id
      FROM category c
      JOIN category p ON p.id = c.parent_id
     WHERE c.user_id = ${userId}::uuid AND c.kind = 'expense'
       AND p.name = 'Servicios' AND c.name = 'Comisiones bancarias'`;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error('The user has no "Servicios › Comisiones bancarias" category');
  }
  return id;
}

/** "Comisiones bancarias" deleted in the Onboarding (EC-M6-08). */
async function deleteBankFees(userId: string): Promise<void> {
  const id = await bankFeesCategoryId(userId);
  await prisma.$executeRaw`DELETE FROM category WHERE id = ${id}::uuid`;
}

async function archiveBankFees(userId: string): Promise<void> {
  const id = await bankFeesCategoryId(userId);
  await prisma.$executeRaw`
    UPDATE category SET status = 'archived', archived_at = now() WHERE id = ${id}::uuid`;
}

interface StoredHeader {
  id: string;
  kind: string;
  categoryId: string | null;
  origin: string;
  parentTransactionId: string | null;
  declaredRate: string | null;
  rateUsdBob: string | null;
  deletedAt: Date | null;
}

async function headerOf(id: string): Promise<StoredHeader | null> {
  const rows = await prisma.$queryRaw<StoredHeader[]>`
    SELECT id::text AS id, kind::text AS kind, category_id::text AS "categoryId",
           origin::text AS origin, parent_transaction_id::text AS "parentTransactionId",
           declared_rate::text AS "declaredRate", rate_usd_bob::text AS "rateUsdBob",
           deleted_at AS "deletedAt"
      FROM ledger_transaction
     WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
}

/** The fees of the transfer: the transactions whose parent it is (RF-M6-05). */
async function feesOf(transferId: string): Promise<StoredHeader[]> {
  return prisma.$queryRaw<StoredHeader[]>`
    SELECT id::text AS id, kind::text AS kind, category_id::text AS "categoryId",
           origin::text AS origin, parent_transaction_id::text AS "parentTransactionId",
           declared_rate::text AS "declaredRate", rate_usd_bob::text AS "rateUsdBob",
           deleted_at AS "deletedAt"
      FROM ledger_transaction
     WHERE parent_transaction_id = ${transferId}::uuid`;
}

/** The entries of a stored transaction, ordered by account so the comparison does not depend on ids. */
async function entriesOf(id: string): Promise<StoredEntry[]> {
  const stored = await findStoredTransaction(id);
  return [...(stored?.entries ?? [])].sort((a, b) => a.accountId.localeCompare(b.accountId));
}

function sortedEntries(entries: StoredEntry[]): StoredEntry[] {
  return [...entries].sort((a, b) => a.accountId.localeCompare(b.accountId));
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

async function fxEvent(
  userId: string,
  kind: 'manual_usd_on' | 'custom_rate',
  currencyCode: string,
  value: string,
  effectiveAt: Date,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO user_fx_event (id, user_id, kind, currency_code, reference, value, effective_at)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${kind}::fx_event_kind, ${currencyCode}, NULL,
            ${value}::numeric, ${effectiveAt})`;
}

/** Activates the manual USD value, as `PUT /api/fx/manual` leaves it (plan §4.3.2). */
async function setManual(userId: string, value: string, since: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE user_settings SET manual_usd_value = ${value}::numeric, manual_usd_since = ${since}
     WHERE user_id = ${userId}::uuid`;
  await fxEvent(userId, 'manual_usd_on', 'USD', value, since);
}

/** Adds a currency with its rate, as `POST /api/currencies` leaves it (plan §4.3.2). */
async function addCurrency(userId: string, code: string, rate: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO currency (user_id, code, symbol) VALUES (${userId}::uuid, ${code}, ${code})`;
  await fxEvent(userId, 'custom_rate', code, rate, new Date('2090-06-01T12:00:00Z'));
}

/** Current balance of the account through the ledger (RN-01). */
async function balanceOf(userId: string, accountId: string): Promise<string> {
  const balances = await uow.run((repos: Repositories) => repos.ledger.balances([accountId]), {
    userLock: userId,
    readOnly: true,
  });
  return (balances.get(accountId) ?? new Decimal(NaN)).toFixed(2);
}

/** Income and expense of June in BOB, without what RN-02 leaves out (RF-M6-12). */
async function juneTotals(userId: string): Promise<{ income: string; expense: string }> {
  const totals = await uow.run((repos: Repositories) => repos.ledger.summary(JUNE, 'BOB'), {
    userLock: userId,
    readOnly: true,
  });
  return { income: totals.income.toFixed(2), expense: totals.expense.toFixed(2) };
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

describe('RF-M6-05 Transferencia con comision', () => {
  it('RF-M6-05 Transferencia con comision: el Banco baja 505, el Efectivo sube 500, se crea un gasto de 5 en "Comisiones bancarias" y la transferencia no cuenta como ingreso ni gasto', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const feeCategoryId = await bankFeesCategoryId(userId);
    const { service } = newService();
    const input = transferInput(bank, cash, { amountOut: '500.00', fee: { amount: '5.00' } });
    const feeId = input.fee?.id ?? '';

    const result = await service.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    expect(result.transaction.id).toBe(input.id);
    expect(result.transaction.fee?.id).toBe(feeId);
    expect(await balanceOf(userId, bank)).toBe('495.00');
    expect(await balanceOf(userId, cash)).toBe('500.00');

    expect(await headerOf(input.id)).toMatchObject({
      kind: 'transfer',
      categoryId: null,
      origin: 'manual',
      parentTransactionId: null,
      deletedAt: null,
    });
    expect(await entriesOf(input.id)).toEqual(
      sortedEntries([
        { accountId: bank, amount: '-500.00', currencyCode: 'BOB', date: TODAY },
        { accountId: cash, amount: '500.00', currencyCode: 'BOB', date: TODAY },
      ]),
    );

    const fees = await feesOf(input.id);
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({
      id: feeId,
      kind: 'expense',
      categoryId: feeCategoryId,
      origin: 'fee',
      parentTransactionId: input.id,
      deletedAt: null,
    });
    expect(await entriesOf(feeId)).toEqual([
      { accountId: bank, amount: '-5.00', currencyCode: 'BOB', date: TODAY },
    ]);

    expect(await juneTotals(userId)).toEqual({ income: '0.00', expense: '5.00' });
  });

  it('RN-02 una transferencia sin comision no cuenta como ingreso ni como gasto', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const input = transferInput(bank, cash, { amountOut: '300.00' });

    await service.create(ctxFor(userId), input);

    expect(await feesOf(input.id)).toEqual([]);
    expect(await countTransactionsOf(userId)).toBe(1);
    expect(await balanceOf(userId, bank)).toBe('700.00');
    expect(await balanceOf(userId, cash)).toBe('300.00');
    expect(await juneTotals(userId)).toEqual({ income: '0.00', expense: '0.00' });
  });

  it('RF-M6-05 la comision puede ser mayor que el monto', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '100.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const input = transferInput(bank, cash, { amountOut: '10.00', fee: { amount: '15.00' } });

    const result = await service.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    expect(await balanceOf(userId, bank)).toBe('75.00');
    expect(await balanceOf(userId, cash)).toBe('10.00');
    expect(await entriesOf(input.fee?.id ?? '')).toEqual([
      { accountId: bank, amount: '-15.00', currencyCode: 'BOB', date: TODAY },
    ]);
  });

  it('RF-M6-05 el monto y la comision se validan juntos contra el bloqueo de negativos: 98 + 5 sobre 100 da NEGATIVE_BALANCE (-3.00)', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const bank = await account(userId, { type: 'bank', initialBalance: '0.00' });
    const { service, ledgerHooks } = newService();
    const handler = vi.fn(() => Promise.resolve());
    ledgerHooks.register(handler);

    const error = await rejectionOf(
      service.create(
        ctxFor(userId),
        transferInput(cash, bank, { amountOut: '98.00', fee: { amount: '5.00' } }),
      ),
    );

    expect(error.code).toBe('NEGATIVE_BALANCE');
    expect(error.status).toBe(422);
    expect(error.data).toEqual({ accountId: cash, resultingBalance: '-3.00' });
    await expectNothingStored(userId);
    expect(await balanceOf(userId, cash)).toBe('100.00');
    expect(handler).not.toHaveBeenCalled();
  });

  it('RF-M6-05 un monto y una comision que dejan el efectivo exactamente en 0 se guardan', async () => {
    const userId = await newUserId();
    const cash = await account(userId, { type: 'cash', initialBalance: '100.00' });
    const bank = await account(userId, { type: 'bank', initialBalance: '0.00' });
    const { service } = newService();

    const result = await service.create(
      ctxFor(userId),
      transferInput(cash, bank, { amountOut: '95.00', fee: { amount: '5.00' } }),
    );

    expect(result.created).toBe(true);
    expect(await balanceOf(userId, cash)).toBe('0.00');
    expect(await balanceOf(userId, bank)).toBe('95.00');
  });
});

describe('EC-M6-08 categoria de la comision', () => {
  it('EC-M6-08 sin "Comisiones bancarias" (eliminada en el Onboarding) da FEE_CATEGORY_REQUIRED y no se guarda nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    await deleteBankFees(userId);
    const { service } = newService();

    const error = await rejectionOf(
      service.create(
        ctxFor(userId),
        transferInput(bank, cash, { amountOut: '500.00', fee: { amount: '5.00' } }),
      ),
    );

    expect(error.code).toBe('FEE_CATEGORY_REQUIRED');
    expect(error.status).toBe(422);
    await expectNothingStored(userId);
    expect(await balanceOf(userId, bank)).toBe('1000.00');
  });

  it('RF-M6-05 con "Comisiones bancarias" archivada y sin fee.categoryId da FEE_CATEGORY_REQUIRED', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    await archiveBankFees(userId);
    const { service } = newService();

    const error = await rejectionOf(
      service.create(
        ctxFor(userId),
        transferInput(bank, cash, { amountOut: '500.00', fee: { amount: '5.00' } }),
      ),
    );

    expect(error.code).toBe('FEE_CATEGORY_REQUIRED');
    await expectNothingStored(userId);
  });

  it('EC-M6-08 al reenviar con otra categoria de gasto en fee.categoryId, la comision queda en esa categoria', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    await deleteBankFees(userId);
    const other = await createCategory(userId, { kind: 'expense' });
    const { service } = newService();
    const input = transferInput(bank, cash, {
      amountOut: '500.00',
      fee: { amount: '5.00', categoryId: other.id },
    });

    const result = await service.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    const fees = await feesOf(input.id);
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({
      id: input.fee?.id,
      kind: 'expense',
      categoryId: other.id,
      origin: 'fee',
      parentTransactionId: input.id,
    });
    expect(await balanceOf(userId, bank)).toBe('495.00');
  });

  it('EC-M6-08 una transferencia sin comision no necesita "Comisiones bancarias"', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    await deleteBankFees(userId);
    const { service } = newService();

    const result = await service.create(
      ctxFor(userId),
      transferInput(bank, cash, { amountOut: '500.00' }),
    );

    expect(result.created).toBe(true);
    expect(await balanceOf(userId, cash)).toBe('500.00');
  });
});

describe('RN-02 Pago de tarjeta no es gasto', () => {
  it('RN-02 Pago de tarjeta no es gasto: la tarjeta queda en "Debes Bs 0,00" y los gastos del mes no cambian', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '3000.00' });
    // A card stores its debt as a negative balance.
    const card = await account(userId, { type: 'credit_card', initialBalance: '-1000.00' });
    const { service } = newService();
    const before = await juneTotals(userId);

    const result = await service.create(
      ctxFor(userId),
      transferInput(bank, card, { amountOut: '1000.00' }),
    );

    expect(result.created).toBe(true);
    expect(await balanceOf(userId, card)).toBe('0.00');
    expect(await balanceOf(userId, bank)).toBe('2000.00');
    expect(await juneTotals(userId)).toEqual(before);
    expect(before).toEqual({ income: '0.00', expense: '0.00' });
  });
});

describe('RF-M6-04 origen y destino', () => {
  it('RF-M6-04 el origen y el destino iguales se rechazan y no se guarda nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const { service } = newService();

    await rejectionOf(
      service.create(ctxFor(userId), transferInput(bank, bank, { amountOut: '10.00' })),
    );

    await expectNothingStored(userId);
    expect(await balanceOf(userId, bank)).toBe('1000.00');
  });

  it('RF-M6-04 un origen archivado da ACCOUNT_ARCHIVED y no se guarda nada', async () => {
    const userId = await newUserId();
    const archived = await account(userId, {
      type: 'bank',
      initialBalance: '1000.00',
      status: 'archived',
    });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();

    const error = await rejectionOf(
      service.create(ctxFor(userId), transferInput(archived, cash, { amountOut: '10.00' })),
    );

    expect(error.code).toBe('ACCOUNT_ARCHIVED');
    expect(error.status).toBe(409);
    await expectNothingStored(userId);
  });

  it('RF-M6-04 un destino archivado da ACCOUNT_ARCHIVED y no se guarda nada', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const archived = await account(userId, { type: 'cash', status: 'archived' });
    const { service } = newService();

    const error = await rejectionOf(
      service.create(ctxFor(userId), transferInput(bank, archived, { amountOut: '10.00' })),
    );

    expect(error.code).toBe('ACCOUNT_ARCHIVED');
    expect(error.status).toBe(409);
    await expectNothingStored(userId);
    expect(await balanceOf(userId, bank)).toBe('1000.00');
  });

  it('RF-M6-04 aislamiento: el origen o el destino de otro usuario no existen (NOT_FOUND)', async () => {
    const owner = await newUserId();
    const ownerBank = await account(owner, { type: 'bank', initialBalance: '1000.00' });
    const other = await newUserId();
    const otherBank = await account(other, { type: 'bank', initialBalance: '1000.00' });
    const { service } = newService();

    const foreignFrom = await rejectionOf(
      service.create(ctxFor(other), transferInput(ownerBank, otherBank, { amountOut: '10.00' })),
    );
    const foreignTo = await rejectionOf(
      service.create(ctxFor(other), transferInput(otherBank, ownerBank, { amountOut: '10.00' })),
    );

    expect(foreignFrom.code).toBe('NOT_FOUND');
    expect(foreignTo.code).toBe('NOT_FOUND');
    await expectNothingStored(other);
    await expectNothingStored(owner);
    expect(await balanceOf(owner, ownerBank)).toBe('1000.00');
    expect(await balanceOf(other, otherBank)).toBe('1000.00');
  });
});

describe('RF-M3-08 / RF-M3-09 transferencia entre monedas con tasa declarada', () => {
  it('RF-M3-09 BOB a USD: la tasa declarada queda como declared_rate y como rate_usd_bob; el monto que llega se calcula', async () => {
    await marketOn(TODAY, '10.00');
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '5000.00' });
    const usd = await account(userId, { type: 'savings', currencyCode: 'USD' });
    const { service } = newService();
    const input = transferInput(bank, usd, { amountOut: '1040.00', declaredRate: '10.40' });

    await service.create(ctxFor(userId), input);

    expect(await headerOf(input.id)).toMatchObject({
      kind: 'transfer',
      declaredRate: '10.40',
      rateUsdBob: '10.40',
    });
    expect(await entriesOf(input.id)).toEqual(
      sortedEntries([
        { accountId: bank, amount: '-1040.00', currencyCode: 'BOB', date: TODAY },
        { accountId: usd, amount: '100.00', currencyCode: 'USD', date: TODAY },
      ]),
    );
    expect(await balanceOf(userId, usd)).toBe('100.00');
  });

  it('RF-M3-09 USD a BOB: la tasa declarada queda como rate_usd_bob y el monto que llega es monto x tasa', async () => {
    await marketOn(TODAY, '10.00');
    const userId = await newUserId();
    const usd = await account(userId, {
      type: 'savings',
      currencyCode: 'USD',
      initialBalance: '500.00',
    });
    const bank = await account(userId, { type: 'bank', initialBalance: '0.00' });
    const { service } = newService();
    const input = transferInput(usd, bank, { amountOut: '100.00', declaredRate: '10.30' });

    await service.create(ctxFor(userId), input);

    expect(await headerOf(input.id)).toMatchObject({ declaredRate: '10.30', rateUsdBob: '10.30' });
    expect(await entriesOf(input.id)).toEqual(
      sortedEntries([
        { accountId: usd, amount: '-100.00', currencyCode: 'USD', date: TODAY },
        { accountId: bank, amount: '1030.00', currencyCode: 'BOB', date: TODAY },
      ]),
    );
  });

  it('RF-M3-08 si llega amountIn, ese monto manda y se guarda tal cual; la tasa se recalcula', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '5000.00' });
    const usd = await account(userId, { type: 'savings', currencyCode: 'USD' });
    const { service } = newService();
    const input = transferInput(bank, usd, { amountOut: '1000.00', amountIn: '96.15' });

    await service.create(ctxFor(userId), input);

    // 1000.00 / 96.15 = 10.4004… → 10.40; 1000.00 / 10.40 = 96.15 (diferencia ≤ 0,01).
    expect(await headerOf(input.id)).toMatchObject({ declaredRate: '10.40', rateUsdBob: '10.40' });
    expect(await entriesOf(input.id)).toEqual(
      sortedEntries([
        { accountId: bank, amount: '-1000.00', currencyCode: 'BOB', date: TODAY },
        { accountId: usd, amount: '96.15', currencyCode: 'USD', date: TODAY },
      ]),
    );
  });

  it('RF-M3-08 amountIn manda sobre la tasa declarada que llega: la tasa se recalcula desde los dos montos', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '5000.00' });
    const usd = await account(userId, { type: 'savings', currencyCode: 'USD' });
    const { service } = newService();
    const input = transferInput(bank, usd, {
      amountOut: '1000.00',
      declaredRate: '10.50',
      amountIn: '96.15',
    });

    await service.create(ctxFor(userId), input);

    expect(await headerOf(input.id)).toMatchObject({ declaredRate: '10.40', rateUsdBob: '10.40' });
    expect(await balanceOf(userId, usd)).toBe('96.15');
    expect(await balanceOf(userId, bank)).toBe('4000.00');
  });

  it('RF-M3-08 entre dos monedas que no son BOB, el monto que llega es monto x tasa (1 de origen = X de destino)', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    await addCurrency(userId, 'EUR', '11.50');
    await addCurrency(userId, 'PEN', '2.00');
    const eur = await account(userId, {
      type: 'bank',
      currencyCode: 'EUR',
      initialBalance: '100.00',
    });
    const pen = await account(userId, { type: 'bank', currencyCode: 'PEN' });
    const { service } = newService();
    const input = transferInput(eur, pen, { amountOut: '10.00', declaredRate: '5.70' });

    await service.create(ctxFor(userId), input);

    expect((await headerOf(input.id))?.declaredRate).toBe('5.70');
    expect(await entriesOf(input.id)).toEqual(
      sortedEntries([
        { accountId: eur, amount: '-10.00', currencyCode: 'EUR', date: TODAY },
        { accountId: pen, amount: '57.00', currencyCode: 'PEN', date: TODAY },
      ]),
    );
  });

  it('RF-M3-09 una transferencia entre cuentas de la misma moneda no lleva tasa declarada', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const input = transferInput(bank, cash, { amountOut: '100.00' });

    await service.create(ctxFor(userId), input);

    expect((await headerOf(input.id))?.declaredRate).toBeNull();
    expect(await balanceOf(userId, cash)).toBe('100.00');
  });
});

describe('RF-M3-07 precarga de la tasa cuando no llega declaredRate', () => {
  it('RF-M3-07 con el valor manual del dolar activo, se usa el valor manual', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    await setManual(userId, '9.80', new Date('2090-06-01T12:00:00Z'));
    const bank = await account(userId, { type: 'bank', initialBalance: '5000.00' });
    const usd = await account(userId, { type: 'savings', currencyCode: 'USD' });
    const { service } = newService();
    const input = transferInput(bank, usd, { amountOut: '980.00' });

    await service.create(ctxFor(userId), input);

    expect(await headerOf(input.id)).toMatchObject({ declaredRate: '9.80', rateUsdBob: '9.80' });
    expect(await balanceOf(userId, usd)).toBe('100.00');
  });

  it('RF-M3-07 sin valor manual, si el usuario compra dolares (BOB a USD) se usa el paralelo de venta', async () => {
    await marketOn(TODAY, '10.40'); // compra 10.30, venta 10.50
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '5000.00' });
    const usd = await account(userId, { type: 'savings', currencyCode: 'USD' });
    const { service } = newService();
    const input = transferInput(bank, usd, { amountOut: '1050.00' });

    await service.create(ctxFor(userId), input);

    expect(await headerOf(input.id)).toMatchObject({ declaredRate: '10.50', rateUsdBob: '10.50' });
    expect(await balanceOf(userId, usd)).toBe('100.00');
  });

  it('RF-M3-07 sin valor manual, si el usuario vende dolares (USD a BOB) se usa el paralelo de compra', async () => {
    await marketOn(TODAY, '10.40'); // compra 10.30, venta 10.50
    const userId = await newUserId();
    const usd = await account(userId, {
      type: 'savings',
      currencyCode: 'USD',
      initialBalance: '500.00',
    });
    const bank = await account(userId, { type: 'bank', initialBalance: '0.00' });
    const { service } = newService();
    const input = transferInput(usd, bank, { amountOut: '100.00' });

    await service.create(ctxFor(userId), input);

    expect(await headerOf(input.id)).toMatchObject({ declaredRate: '10.30', rateUsdBob: '10.30' });
    expect(await balanceOf(userId, bank)).toBe('1030.00');
  });

  it('RF-M3-07 para una fecha pasada se precarga el paralelo de ese dia', async () => {
    await marketOn('2090-06-10', '10.00'); // venta 10.10
    await marketOn(TODAY, '10.40'); // venta 10.50
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '5000.00' });
    const usd = await account(userId, { type: 'savings', currencyCode: 'USD' });
    const { service } = newService();
    const input = transferInput(bank, usd, { amountOut: '1010.00', date: '2090-06-10' });

    await service.create(ctxFor(userId), input);

    expect(await headerOf(input.id)).toMatchObject({ declaredRate: '10.10', rateUsdBob: '10.10' });
    expect(await entriesOf(input.id)).toEqual(
      sortedEntries([
        { accountId: bank, amount: '-1010.00', currencyCode: 'BOB', date: '2090-06-10' },
        { accountId: usd, amount: '100.00', currencyCode: 'USD', date: '2090-06-10' },
      ]),
    );
  });

  it('RF-M3-07 si no interviene el dolar, se usa la tasa manual de la moneda agregada', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    await addCurrency(userId, 'EUR', '11.50');
    const bank = await account(userId, { type: 'bank', initialBalance: '5000.00' });
    const eur = await account(userId, { type: 'bank', currencyCode: 'EUR' });
    const { service } = newService();
    const input = transferInput(bank, eur, { amountOut: '1150.00' });

    await service.create(ctxFor(userId), input);

    expect((await headerOf(input.id))?.declaredRate).toBe('11.50');
    expect(await balanceOf(userId, eur)).toBe('100.00');
  });

  it('RF-M3-07 entre dos monedas agregadas se usa la tasa cruzada a traves de BOB', async () => {
    await marketOn(TODAY, '10.40');
    const userId = await newUserId();
    await addCurrency(userId, 'EUR', '11.50');
    await addCurrency(userId, 'PEN', '2.00');
    const eur = await account(userId, {
      type: 'bank',
      currencyCode: 'EUR',
      initialBalance: '100.00',
    });
    const pen = await account(userId, { type: 'bank', currencyCode: 'PEN' });
    const { service } = newService();
    const input = transferInput(eur, pen, { amountOut: '10.00' });

    await service.create(ctxFor(userId), input);

    // 11.50 Bs / 2.00 Bs = 5.75 PEN por EUR.
    expect((await headerOf(input.id))?.declaredRate).toBe('5.75');
    expect(await balanceOf(userId, pen)).toBe('57.50');
    expect(await balanceOf(userId, eur)).toBe('90.00');
  });
});

describe('TASK-122 efectos de la creacion', () => {
  it('TASK-122 crea un solo undo_action(create) y devuelve su token', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();

    const result = await service.create(
      ctxFor(userId),
      transferInput(bank, cash, { amountOut: '500.00', fee: { amount: '5.00' } }),
    );

    const undo = await undoActionsOf(userId);
    expect(undo).toHaveLength(1);
    expect(undo[0]).toEqual({ id: result.undoToken, kind: 'create' });
  });

  it('TASK-122 llama una vez a LedgerHooks.afterChange con la fecha, las dos cuentas y la categoria de la comision', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const feeCategoryId = await bankFeesCategoryId(userId);
    const { service, ledgerHooks } = newService();
    const handler = vi.fn<
      (tx: Repositories, userId: string, change: LedgerChange) => Promise<void>
    >(() => Promise.resolve());
    ledgerHooks.register(handler);

    await service.create(
      ctxFor(userId),
      transferInput(bank, cash, {
        amountOut: '500.00',
        date: '2090-06-10',
        fee: { amount: '5.00' },
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const [, hookUserId, change] = handler.mock.calls[0] ?? [];
    expect(hookUserId).toBe(userId);
    expect(change?.dates).toEqual(['2090-06-10']);
    expect([...(change?.accountIds ?? [])].sort()).toEqual([bank, cash].sort());
    expect(change?.categoryIds).toEqual(expect.arrayContaining([feeCategoryId]));
  });

  it('TASK-122 idempotencia: dos create con el mismo id dejan una transferencia y una comision; el segundo devuelve el existente', async () => {
    const userId = await newUserId();
    const bank = await account(userId, { type: 'bank', initialBalance: '1000.00' });
    const cash = await account(userId, { type: 'cash', initialBalance: '0.00' });
    const { service } = newService();
    const input = transferInput(bank, cash, { amountOut: '500.00', fee: { amount: '5.00' } });

    const first = await service.create(ctxFor(userId), input);
    const second = await service.create(ctxFor(userId), { ...input });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.transaction.id).toBe(input.id);
    expect(await countTransactionsOf(userId)).toBe(2);
    expect(await countEntriesOf(userId)).toBe(3);
    expect(await balanceOf(userId, bank)).toBe('495.00');
    expect(await balanceOf(userId, cash)).toBe('500.00');
  });
});
