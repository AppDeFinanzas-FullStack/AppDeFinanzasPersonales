import type { DedicateInput, EarmarkInput, GoalDto, ReleaseInput } from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { GoalHistoryItem } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import {
  createRatesService,
  type RatesContext,
} from '../../src/application/services/rates.service.js';
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
import { createAllocationEvent, createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Assumptions (plan 4.12.2; the plan fixes the endpoints, not the service signatures):
 * - `earmark(ctx, goalId, input)`, `release(ctx, goalId, input)` and `dedicate(ctx, goalId, input)`
 *   take the contract inputs (`EarmarkInput`, `ReleaseInput`, `DedicateInput`) and return `GoalDto`.
 * - Errors are `AppError`s; `EARMARK_EXCEEDS_FREE` carries `data.free` as decimal text.
 * - A manual earmark writes a `manual` allocation event (negative for a release).
 */
interface GoalDetail extends GoalDto {
  history: GoalHistoryItem[];
}
interface GoalsServiceUnderTest {
  earmark(ctx: RatesContext, goalId: string, input: EarmarkInput): Promise<GoalDto>;
  release(ctx: RatesContext, goalId: string, input: ReleaseInput): Promise<GoalDto>;
  dedicate(ctx: RatesContext, goalId: string, input: DedicateInput): Promise<GoalDto>;
  get(ctx: RatesContext, id: string): Promise<GoalDetail>;
}
type CreateGoalsService = (deps: {
  uow: UnitOfWork;
  rates: ReturnType<typeof createRatesService>;
}) => GoalsServiceUnderTest;

const { createGoalsService } =
  (await import('../../src/application/services/goals.service.js')) as unknown as {
    createGoalsService: CreateGoalsService;
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
  goals: createGoalRepository(tx, userId ?? NIL_USER),
  goalAllocations: createGoalAllocationRepository(tx, userId ?? NIL_USER),
}));

const rates = createRatesService({ uow });
const goals = createGoalsService({ uow, rates });

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z');
const usedUserIds: string[] = [];

afterAll(async () => {
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

const bank = (userId: string, balance: string): ReturnType<typeof createAccount> =>
  createAccount(userId, { initialBalance: balance, initialBalanceDate: '2090-01-01' });

const earmarkOf = (accountId: string, amount: string): EarmarkInput => ({
  id: uuidv7(),
  accountId,
  amount,
});

async function earmarkedIn(userId: string, goalId: string, accountId: string): Promise<string> {
  const detail = await goals.get(ctxFor(userId), goalId);
  return detail.byAccount.find((row) => row.accountId === accountId)?.amount ?? '0.00';
}

const cardOf = (userId: string): ReturnType<typeof createAccount> =>
  createAccount(userId, {
    type: 'credit_card',
    cardCutDay: 1,
    cardPayDay: 10,
    cardLimit: '1000.00',
  });

describe('GoalsService: apartar, liberar y dedicar', () => {
  it('RF-M12-04 apartar dentro del saldo libre suma el apartado y deja un evento manual', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, {});

    await goals.earmark(ctxFor(userId), goal.id, earmarkOf(account.id, '200.00'));

    expect(await earmarkedIn(userId, goal.id, account.id)).toBe('200.00');
    const detail = await goals.get(ctxFor(userId), goal.id);
    expect(detail.history.map((h) => `${h.origin}:${h.amount.toFixed(2)}`)).toEqual([
      'manual:200.00',
    ]);
  });

  it('RF-M12-04 varias metas pueden apartar en la misma cuenta, siempre dentro del saldo libre', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const a = await createGoal(userId, {});
    const b = await createGoal(userId, {});

    await goals.earmark(ctxFor(userId), a.id, earmarkOf(account.id, '300.00'));
    await goals.earmark(ctxFor(userId), b.id, earmarkOf(account.id, '200.00'));
    const error = await rejectionOf(
      goals.earmark(ctxFor(userId), b.id, earmarkOf(account.id, '0.01')),
    );

    expect(error.code).toBe('EARMARK_EXCEEDS_FREE');
  });

  it('EC-M12-01 apartar más que el saldo libre da EARMARK_EXCEEDS_FREE con el saldo libre', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const other = await createGoal(userId, {});
    await createAllocationEvent(userId, other.id, account.id, { amount: '100.00' });
    const goal = await createGoal(userId, {});

    const error = await rejectionOf(
      goals.earmark(ctxFor(userId), goal.id, earmarkOf(account.id, '400.01')),
    );

    expect(error.code).toBe('EARMARK_EXCEEDS_FREE');
    expect(error.status).toBe(422);
    expect(error.data?.['free']).toBe('400.00');
    expect(await earmarkedIn(userId, goal.id, account.id)).toBe('0.00');
  });

  it('EC-M12-01 apartar exactamente el saldo libre se acepta', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, {});

    await goals.earmark(ctxFor(userId), goal.id, earmarkOf(account.id, '500.00'));

    expect(await earmarkedIn(userId, goal.id, account.id)).toBe('500.00');
  });

  it('EC-M12-08 apartar en una tarjeta da ACCOUNT_NOT_DEDICABLE', async () => {
    const userId = await newUser();
    const card = await cardOf(userId);
    const goal = await createGoal(userId, {});

    const error = await rejectionOf(
      goals.earmark(ctxFor(userId), goal.id, earmarkOf(card.id, '10.00')),
    );

    expect(error.code).toBe('ACCOUNT_NOT_DEDICABLE');
    expect(error.status).toBe(422);
  });

  it('EC-M12-01 dos apartados simultáneos no superan el saldo libre', async () => {
    const userId = await newUser();
    const account = await bank(userId, '100.00');
    const a = await createGoal(userId, {});
    const b = await createGoal(userId, {});

    const results = await Promise.allSettled([
      goals.earmark(ctxFor(userId), a.id, earmarkOf(account.id, '80.00')),
      goals.earmark(ctxFor(userId), b.id, earmarkOf(account.id, '80.00')),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect((failed?.reason as AppError).code).toBe('EARMARK_EXCEEDS_FREE');
    const inA = await earmarkedIn(userId, a.id, account.id);
    const inB = await earmarkedIn(userId, b.id, account.id);
    expect([inA, inB].sort()).toEqual(['0.00', '80.00']);
  });

  it('RF-M12-04 liberar reduce lo apartado y deja un evento manual negativo', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, account.id, { amount: '200.00' });

    await goals.release(ctxFor(userId), goal.id, { accountId: account.id, amount: '50.00' });

    expect(await earmarkedIn(userId, goal.id, account.id)).toBe('150.00');
    const detail = await goals.get(ctxFor(userId), goal.id);
    expect(detail.history.map((h) => `${h.origin}:${h.amount.toFixed(2)}`).sort()).toEqual([
      'manual:-50.00',
      'manual:200.00',
    ]);
  });

  it('RF-M12-04 liberar más de lo apartado en esa cuenta da RELEASE_EXCEEDS_EARMARK', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, {});
    const other = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, account.id, { amount: '100.00' });
    await createAllocationEvent(userId, other.id, account.id, { amount: '300.00' });

    const error = await rejectionOf(
      goals.release(ctxFor(userId), goal.id, { accountId: account.id, amount: '100.01' }),
    );

    expect(error.code).toBe('RELEASE_EXCEEDS_EARMARK');
    expect(error.status).toBe(422);
    expect(await earmarkedIn(userId, goal.id, account.id)).toBe('100.00');
  });

  it('RF-M12-03 dedicar una cuenta libre la deja como la dedicada de la meta', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, {});

    await goals.dedicate(ctxFor(userId), goal.id, { accountId: account.id });

    const detail = await goals.get(ctxFor(userId), goal.id);
    expect(detail.dedicatedAccount?.id).toBe(account.id);
    expect(detail.progress).toBe('500.00');
  });

  it('RF-M12-03 dedicar una cuenta ya dedicada da ACCOUNT_ALREADY_DEDICATED', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    await createGoal(userId, { dedicatedAccountId: account.id });
    const goal = await createGoal(userId, {});

    const error = await rejectionOf(
      goals.dedicate(ctxFor(userId), goal.id, { accountId: account.id }),
    );

    expect(error.code).toBe('ACCOUNT_ALREADY_DEDICATED');
    expect(error.status).toBe(409);
  });

  it('EC-M12-06 dedicar una cuenta con apartados de otra meta da ACCOUNT_HAS_OTHER_EARMARKS', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const other = await createGoal(userId, {});
    await createAllocationEvent(userId, other.id, account.id, { amount: '50.00' });
    const goal = await createGoal(userId, {});

    const error = await rejectionOf(
      goals.dedicate(ctxFor(userId), goal.id, { accountId: account.id }),
    );

    expect(error.code).toBe('ACCOUNT_HAS_OTHER_EARMARKS');
    expect(error.status).toBe(409);
    expect((await goals.get(ctxFor(userId), goal.id)).dedicatedAccount).toBeUndefined();
  });

  it('EC-M12-08 dedicar una tarjeta da ACCOUNT_NOT_DEDICABLE', async () => {
    const userId = await newUser();
    const card = await cardOf(userId);
    const goal = await createGoal(userId, {});

    const error = await rejectionOf(
      goals.dedicate(ctxFor(userId), goal.id, { accountId: card.id }),
    );

    expect(error.code).toBe('ACCOUNT_NOT_DEDICABLE');
    expect(error.status).toBe(422);
  });

  it('RN-09 un usuario no puede apartar, liberar ni dedicar en la meta de otro', async () => {
    const owner = await newUser();
    const intruder = await newUser();
    const account = await bank(intruder, '500.00');
    const goal = await createGoal(owner, {});

    const earmark = await rejectionOf(
      goals.earmark(ctxFor(intruder), goal.id, earmarkOf(account.id, '10.00')),
    );
    const release = await rejectionOf(
      goals.release(ctxFor(intruder), goal.id, { accountId: account.id, amount: '10.00' }),
    );
    const dedicate = await rejectionOf(
      goals.dedicate(ctxFor(intruder), goal.id, { accountId: account.id }),
    );

    expect([earmark.code, release.code, dedicate.code]).toEqual([
      'NOT_FOUND',
      'NOT_FOUND',
      'NOT_FOUND',
    ]);
  });
});
