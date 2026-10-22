import type {
  AdjustInput,
  CreateTransactionInput,
  UpdateTransactionInput,
} from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createAccountsService } from '../../src/application/services/accounts.service.js';
import {
  createRatesService,
  type RatesContext,
  type RatesService,
} from '../../src/application/services/rates.service.js';
import { createLedgerHooks, type LedgerHooks } from '../../src/application/shared/ledger-hooks.js';
import { createAccountRepository } from '../../src/infrastructure/persistence/repositories/account.repository.js';
import { createCategoryRepository } from '../../src/infrastructure/persistence/repositories/category.repository.js';
import { createCurrencyRepository } from '../../src/infrastructure/persistence/repositories/currency.repository.js';
import { createGoalAllocationRepository } from '../../src/infrastructure/persistence/repositories/goal-allocation.repository.js';
import { createGoalRepository } from '../../src/infrastructure/persistence/repositories/goal.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createMarketRateRepository } from '../../src/infrastructure/persistence/repositories/market-rate.repository.js';
import { createUndoActionRepository } from '../../src/infrastructure/persistence/repositories/undo-action.repository.js';
import { createUserFxEventRepository } from '../../src/infrastructure/persistence/repositories/user-fx-event.repository.js';
import { createUserSettingsRepository } from '../../src/infrastructure/persistence/repositories/user-settings.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createAllocationEvent, createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import {
  expenseInput,
  findStoredTransaction,
  incomeInput,
} from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Assumptions (plan 4.6.2, 4.12.3; TASK-183 fixes `BalanceGuard`):
 * - `earmarkWithdrawals` is `{ goalId, accountId, amount }[]` with `amount` as decimal text
 *   (ADR-03). `create` and `update` read it from their input; `adjust` from `AdjustInput`.
 * - `delete(ctx, id, { earmarkWithdrawals })` and `undo(ctx, undoToken, { earmarkWithdrawals })`
 *   take it as an optional third argument (the body of the DELETE and of the undo).
 * - Without covering withdrawals the operation rejects with `AppError`
 *   `EARMARK_CONFIRMATION_REQUIRED` (409) with `data = { shortfall, proposal }` and saves nothing.
 * - With them, the operation is saved and one `confirmed_spend` event per withdrawal is inserted.
 * - `batchDelete` skips (counts in `skipped`) the movement that would touch an earmark.
 */
interface Withdrawal {
  goalId: string;
  accountId: string;
  amount: string;
}
interface WithdrawalOptions {
  earmarkWithdrawals?: Withdrawal[];
}
interface TransactionsServiceUnderTest {
  create(ctx: RatesContext, input: CreateTransactionInput): Promise<{ undoToken: string | null }>;
  update(ctx: RatesContext, id: string, input: UpdateTransactionInput): Promise<unknown>;
  delete(
    ctx: RatesContext,
    id: string,
    options?: WithdrawalOptions,
  ): Promise<{ undoToken: string }>;
  undo(ctx: RatesContext, undoToken: string, options?: WithdrawalOptions): Promise<unknown>;
  batchDelete(
    ctx: RatesContext,
    input: { ids: string[] },
  ): Promise<{ processed: number; skipped: number }>;
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

interface AdjustWithWithdrawals extends AdjustInput {
  earmarkWithdrawals?: Withdrawal[];
}
interface AccountsServiceUnderTest {
  adjust(
    ctx: RatesContext,
    id: string,
    input: AdjustWithWithdrawals,
  ): Promise<{ created: boolean }>;
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
  goals: createGoalRepository(tx, userId ?? NIL_USER),
  goalAllocations: createGoalAllocationRepository(tx, userId ?? NIL_USER),
}));

const rates = createRatesService({ uow });
const ledgerHooks = createLedgerHooks();
const transactions = createTransactionsService({ uow, rates, ledgerHooks });
const accounts = createAccountsService({
  uow,
  rates,
  ledgerHooks,
}) as unknown as AccountsServiceUnderTest;

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z');
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

async function marketRate(kind: string, value: string): Promise<void> {
  const source = kind === 'official' ? 'bcb' : 'paralelo_bo';
  await prisma.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${kind}::market_rate_kind, ${TODAY}::date, ${value}::numeric,
            ${new Date(`${TODAY}T12:00:00Z`)}, ${source}::rate_source)`;
}

beforeAll(async () => {
  savedRates = await prisma.$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate`;
});

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate`;
  await marketRate('parallel_bid', '10.30');
  await marketRate('parallel_ask', '10.50');
  await marketRate('parallel_median', '10.40');
  await marketRate('official', '6.96');
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate`;
  for (const row of savedRates) {
    await prisma.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
  await deleteGoalsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

const ctxFor = (userId: string): RatesContext => ({
  userId,
  timezone: TZ,
  now: NOW,
  traceId: uuidv7(),
});

interface Setup {
  userId: string;
  accountId: string;
  goalId: string;
  expense: string;
  income: string;
}

/** A bank with 4.800, a goal with 300 earmarked on it and the categories. */
async function setup(): Promise<Setup> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  const bank = await createAccount(user.id, {
    type: 'bank',
    initialBalance: '4800.00',
    initialBalanceDate: '2090-01-01',
  });
  const goal = await createGoal(user.id, {});
  await createAllocationEvent(user.id, goal.id, bank.id, { amount: '300.00' });
  const expense = (await createCategory(user.id, { kind: 'expense' })).id;
  const income = (await createCategory(user.id, { kind: 'income' })).id;
  return { userId: user.id, accountId: bank.id, goalId: goal.id, expense, income };
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

async function earmarkedOf(userId: string, accountId: string): Promise<string> {
  const rows = await uow.run(
    (repos: Repositories) => repos.goalAllocations.earmarkedByAccount(accountId),
    { userLock: userId },
  );
  return rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2);
}

async function balanceOf(userId: string, accountId: string): Promise<string> {
  const balances = await uow.run((repos: Repositories) => repos.ledger.balances([accountId]), {
    userLock: userId,
    readOnly: true,
  });
  return (balances.get(accountId) ?? new Decimal(NaN)).toFixed(2);
}

async function isDeleted(id: string): Promise<boolean> {
  const row = await findStoredTransaction(id);
  if (row === null) {
    throw new Error(`The transaction ${id} is not stored`);
  }
  return row.deletedAt !== null;
}

async function exists(id: string): Promise<boolean> {
  return (await findStoredTransaction(id)) !== null;
}

async function expenseOf(s: Setup, amount: string): Promise<string> {
  const input = expenseInput(s.accountId, s.expense, { date: TODAY, amount });
  await transactions.create(ctxFor(s.userId), input);
  return input.id;
}

async function incomeOf(s: Setup, amount: string): Promise<string> {
  const input = incomeInput(s.accountId, s.income, { date: TODAY, amount });
  await transactions.create(ctxFor(s.userId), input);
  return input.id;
}

const withdrawalOf = (s: Setup, amount: string): Withdrawal => ({
  goalId: s.goalId,
  accountId: s.accountId,
  amount,
});

describe('Protección de apartados en movimientos', () => {
  it('RF-M12-05 Gasto que toca dinero apartado: primero pide confirmación con faltante 100 y no guarda', async () => {
    const s = await setup();
    const input = expenseInput(s.accountId, s.expense, { date: TODAY, amount: '4600.00' });

    const error = await rejectionOf(transactions.create(ctxFor(s.userId), input));

    expect(error.code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(error.status).toBe(409);
    expect(error.data).toEqual({
      shortfall: '100.00',
      proposal: [{ goalId: s.goalId, amount: '100.00' }],
    });
    expect(await exists(input.id)).toBe(false);
    expect(await earmarkedOf(s.userId, s.accountId)).toBe('300.00');
  });

  it('RF-M12-05 Gasto que toca dinero apartado: al reenviar con los retiros se guarda y los apartados quedan en 200', async () => {
    const s = await setup();
    const input = expenseInput(s.accountId, s.expense, { date: TODAY, amount: '4600.00' });

    await transactions.create(ctxFor(s.userId), {
      ...input,
      earmarkWithdrawals: [withdrawalOf(s, '100.00')],
    });

    expect(await exists(input.id)).toBe(true);
    expect(await balanceOf(s.userId, s.accountId)).toBe('200.00');
    expect(await earmarkedOf(s.userId, s.accountId)).toBe('200.00');
  });

  it('RF-M12-05 editar un gasto a un monto que baja del apartado pide confirmación y al confirmar retira', async () => {
    const s = await setup();
    const id = await expenseOf(s, '100.00');

    const error = await rejectionOf(
      transactions.update(ctxFor(s.userId), id, { amount: '4600.00' }),
    );

    expect(error.code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(await balanceOf(s.userId, s.accountId)).toBe('4700.00');
    expect(await earmarkedOf(s.userId, s.accountId)).toBe('300.00');

    await transactions.update(ctxFor(s.userId), id, {
      amount: '4600.00',
      earmarkWithdrawals: [withdrawalOf(s, '100.00')],
    });

    expect(await balanceOf(s.userId, s.accountId)).toBe('200.00');
    expect(await earmarkedOf(s.userId, s.accountId)).toBe('200.00');
  });

  it('RF-M12-05 eliminar un ingreso que baja del apartado pide confirmación y al confirmar retira', async () => {
    const s = await setup();
    const incomeId = await incomeOf(s, '100.00');
    await expenseOf(s, '4600.00');
    expect(await balanceOf(s.userId, s.accountId)).toBe('300.00');

    const error = await rejectionOf(transactions.delete(ctxFor(s.userId), incomeId));

    expect(error.code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(error.data).toMatchObject({ shortfall: '100.00' });
    expect(await isDeleted(incomeId)).toBe(false);

    await transactions.delete(ctxFor(s.userId), incomeId, {
      earmarkWithdrawals: [withdrawalOf(s, '100.00')],
    });

    expect(await isDeleted(incomeId)).toBe(true);
    expect(await earmarkedOf(s.userId, s.accountId)).toBe('200.00');
  });

  it('RF-M6-08 deshacer la eliminación de un gasto que baja del apartado pide confirmación', async () => {
    const s = await setup();
    const id = await expenseOf(s, '100.00');
    const { undoToken } = await transactions.delete(ctxFor(s.userId), id);
    await expenseOf(s, '4500.00');
    expect(await balanceOf(s.userId, s.accountId)).toBe('300.00');

    const error = await rejectionOf(transactions.undo(ctxFor(s.userId), undoToken));

    expect(error.code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(error.data).toMatchObject({ shortfall: '100.00' });
    expect(await isDeleted(id)).toBe(true);
    expect(await earmarkedOf(s.userId, s.accountId)).toBe('300.00');
  });

  it('RF-M6-08 deshacer la eliminación con los retiros restaura el gasto y reduce los apartados', async () => {
    const s = await setup();
    const id = await expenseOf(s, '100.00');
    const { undoToken } = await transactions.delete(ctxFor(s.userId), id);
    await expenseOf(s, '4500.00');

    await transactions.undo(ctxFor(s.userId), undoToken, {
      earmarkWithdrawals: [withdrawalOf(s, '100.00')],
    });

    expect(await isDeleted(id)).toBe(false);
    expect(await balanceOf(s.userId, s.accountId)).toBe('200.00');
    expect(await earmarkedOf(s.userId, s.accountId)).toBe('200.00');
  });

  it('RF-M6-13 el lote omite el movimiento que tocaría un apartado y elimina el resto', async () => {
    const s = await setup();
    const small = await expenseOf(s, '50.00');
    const incomeId = await incomeOf(s, '100.00');
    await expenseOf(s, '4550.00');
    expect(await balanceOf(s.userId, s.accountId)).toBe('300.00');

    const result = await transactions.batchDelete(ctxFor(s.userId), { ids: [incomeId, small] });

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(await isDeleted(incomeId)).toBe(false);
    expect(await isDeleted(small)).toBe(true);
    expect(await earmarkedOf(s.userId, s.accountId)).toBe('300.00');
  });

  it('EC-M12-07 un ajuste negativo que deja el saldo bajo lo apartado pide confirmación y no registra nada', async () => {
    const s = await setup();
    const input: AdjustWithWithdrawals = { transactionId: uuidv7(), realBalance: '200.00' };

    const error = await rejectionOf(accounts.adjust(ctxFor(s.userId), s.accountId, input));

    expect(error.code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(error.data).toEqual({
      shortfall: '100.00',
      proposal: [{ goalId: s.goalId, amount: '100.00' }],
    });
    expect(await exists(input.transactionId)).toBe(false);
    expect(await balanceOf(s.userId, s.accountId)).toBe('4800.00');
    expect(await earmarkedOf(s.userId, s.accountId)).toBe('300.00');
  });

  it('EC-M12-07 al confirmar el ajuste se registra el retiro y los apartados quedan en 200', async () => {
    const s = await setup();
    const input: AdjustWithWithdrawals = {
      transactionId: uuidv7(),
      realBalance: '200.00',
      earmarkWithdrawals: [withdrawalOf(s, '100.00')],
    };

    const result = await accounts.adjust(ctxFor(s.userId), s.accountId, input);

    expect(result.created).toBe(true);
    expect(await balanceOf(s.userId, s.accountId)).toBe('200.00');
    expect(await earmarkedOf(s.userId, s.accountId)).toBe('200.00');
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM goal_allocation_event
       WHERE user_id = ${s.userId}::uuid AND origin = 'confirmed_spend'`;
    expect(rows[0]?.n).toBe(1);
  });
});
