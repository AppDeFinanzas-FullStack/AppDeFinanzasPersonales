import type { GoalDto } from '@finanzas/contracts';
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
 * `useAndClose`, `archive`, `restore`, `remove` (DELETE) and `celebrated` take `(ctx, goalId)`.
 * The first three return the `GoalDto`; `remove` and `celebrated` return nothing relevant.
 */
interface GoalDetail extends GoalDto {
  history: GoalHistoryItem[];
}
interface GoalsServiceUnderTest {
  useAndClose(ctx: RatesContext, goalId: string): Promise<GoalDto>;
  archive(ctx: RatesContext, goalId: string): Promise<GoalDto>;
  restore(ctx: RatesContext, goalId: string): Promise<GoalDto>;
  remove(ctx: RatesContext, goalId: string): Promise<unknown>;
  celebrated(ctx: RatesContext, goalId: string): Promise<unknown>;
  get(ctx: RatesContext, id: string): Promise<GoalDetail>;
  list(ctx: RatesContext): Promise<GoalDto[]>;
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

async function earmarkedIn(userId: string, goalId: string, accountId: string): Promise<string> {
  const detail = await goals.get(ctxFor(userId), goalId);
  return detail.byAccount.find((row) => row.accountId === accountId)?.amount ?? '0.00';
}

async function eventCount(goalId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM goal_allocation_event WHERE goal_id = ${goalId}::uuid`;
  return rows[0]?.n ?? 0;
}

async function archivedAt(goalId: string): Promise<Date | null> {
  const rows = await prisma.$queryRaw<{ archived_at: Date | null }[]>`
    SELECT archived_at FROM goal WHERE id = ${goalId}::uuid`;
  return rows[0]?.archived_at ?? null;
}

async function celebratedAt(goalId: string): Promise<Date | null> {
  const rows = await prisma.$queryRaw<{ celebrated_at: Date | null }[]>`
    SELECT celebrated_at FROM goal WHERE id = ${goalId}::uuid`;
  return rows[0]?.celebrated_at ?? null;
}

describe('GoalsService: usar y cerrar, archivar, restaurar, eliminar y celebrar', () => {
  it('RF-M12-09 Usar y cerrar: los apartados de dos cuentas quedan en 0 y la meta queda archivada con su historia', async () => {
    const userId = await newUser();
    const a = await bank(userId, '500.00');
    const b = await bank(userId, '300.00');
    const goal = await createGoal(userId, { name: 'Laptop', target: '400.00' });
    await createAllocationEvent(userId, goal.id, a.id, { amount: '250.00' });
    await createAllocationEvent(userId, goal.id, b.id, { amount: '150.00' });

    await goals.useAndClose(ctxFor(userId), goal.id);

    const detail = await goals.get(ctxFor(userId), goal.id);
    expect(detail.status).toBe('archived');
    expect(await earmarkedIn(userId, goal.id, a.id)).toBe('0.00');
    expect(await earmarkedIn(userId, goal.id, b.id)).toBe('0.00');
    expect(await archivedAt(goal.id)).not.toBeNull();
    const closing = detail.history.filter((h) => h.origin === 'use_and_close');
    expect(closing.map((h) => h.amount.toFixed(2)).sort()).toEqual(['-150.00', '-250.00']);
    expect(detail.history.filter((h) => h.origin === 'manual')).toHaveLength(2);
    expect(await goals.list(ctxFor(userId))).toEqual([]);
  });

  it('RF-M12-09 Usar y cerrar quita la cuenta dedicada y la deja como cuenta normal', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, { dedicatedAccountId: account.id });

    await goals.useAndClose(ctxFor(userId), goal.id);

    const detail = await goals.get(ctxFor(userId), goal.id);
    expect(detail.dedicatedAccount).toBeUndefined();
    expect(detail.status).toBe('archived');
    const rows = await prisma.$queryRaw<{ dedicated_account_id: string | null }[]>`
      SELECT dedicated_account_id FROM goal WHERE id = ${goal.id}::uuid`;
    expect(rows[0]?.dedicated_account_id).toBeNull();
  });

  it('RF-M12-09 un usuario no puede usar y cerrar la meta de otro', async () => {
    const owner = await newUser();
    const intruder = await newUser();
    const goal = await createGoal(owner, {});

    const error = await rejectionOf(goals.useAndClose(ctxFor(intruder), goal.id));

    expect(error.code).toBe('NOT_FOUND');
  });

  it('TASK-187 archivar una meta con apartados da GOAL_NOT_EMPTY', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, account.id, { amount: '100.00' });

    const error = await rejectionOf(goals.archive(ctxFor(userId), goal.id));

    expect(error.code).toBe('GOAL_NOT_EMPTY');
    expect(error.status).toBe(409);
    expect(await archivedAt(goal.id)).toBeNull();
  });

  it('TASK-187 archivar una meta con cuenta dedicada da GOAL_NOT_EMPTY', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, { dedicatedAccountId: account.id });

    const error = await rejectionOf(goals.archive(ctxFor(userId), goal.id));

    expect(error.code).toBe('GOAL_NOT_EMPTY');
  });

  it('TASK-187 archivar una meta vacía la archiva y restaurar no recupera los apartados', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, account.id, { amount: '100.00' });
    await goals.useAndClose(ctxFor(userId), goal.id);

    const restored = await goals.restore(ctxFor(userId), goal.id);

    expect(restored.status).not.toBe('archived');
    expect(await archivedAt(goal.id)).toBeNull();
    expect(await earmarkedIn(userId, goal.id, account.id)).toBe('0.00');
    expect(restored.progress).toBe('0.00');

    const empty = await createGoal(userId, {});
    const archived = await goals.archive(ctxFor(userId), empty.id);
    expect(archived.status).toBe('archived');
    expect(await archivedAt(empty.id)).not.toBeNull();
  });

  it('TASK-187 eliminar una meta con apartados da GOAL_NOT_EMPTY y no borra nada', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, account.id, { amount: '100.00' });

    const error = await rejectionOf(goals.remove(ctxFor(userId), goal.id));

    expect(error.code).toBe('GOAL_NOT_EMPTY');
    expect(await eventCount(goal.id)).toBe(1);
  });

  it('TASK-187 eliminar una meta vacía borra la meta y su historia', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, account.id, { amount: '100.00' });
    await createAllocationEvent(userId, goal.id, account.id, { amount: '-100.00' });

    await goals.remove(ctxFor(userId), goal.id);

    expect(await eventCount(goal.id)).toBe(0);
    const error = await rejectionOf(goals.get(ctxFor(userId), goal.id));
    expect(error.code).toBe('NOT_FOUND');
  });

  it('TASK-187 un usuario no puede archivar, restaurar, eliminar ni celebrar la meta de otro', async () => {
    const owner = await newUser();
    const intruder = await newUser();
    const goal = await createGoal(owner, {});

    const archive = await rejectionOf(goals.archive(ctxFor(intruder), goal.id));
    const restore = await rejectionOf(goals.restore(ctxFor(intruder), goal.id));
    const remove = await rejectionOf(goals.remove(ctxFor(intruder), goal.id));
    const celebrated = await rejectionOf(goals.celebrated(ctxFor(intruder), goal.id));

    expect([archive.code, restore.code, remove.code, celebrated.code]).toEqual([
      'NOT_FOUND',
      'NOT_FOUND',
      'NOT_FOUND',
      'NOT_FOUND',
    ]);
  });

  it('TASK-187 firstAchievement es verdadero solo hasta marcar celebrated', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, { target: '100.00' });
    await createAllocationEvent(userId, goal.id, account.id, { amount: '100.00' });

    const before = await goals.get(ctxFor(userId), goal.id);
    expect(before.status).toBe('achieved');
    expect(before.firstAchievement).toBe(true);

    await goals.celebrated(ctxFor(userId), goal.id);

    const after = await goals.get(ctxFor(userId), goal.id);
    expect(after.status).toBe('achieved');
    expect(after.firstAchievement).toBe(false);
  });

  it('TASK-187 celebrated marca celebrated_at una sola vez', async () => {
    const userId = await newUser();
    const goal = await createGoal(userId, {});

    await goals.celebrated(ctxFor(userId), goal.id);
    const first = await celebratedAt(goal.id);
    await goals.celebrated({ ...ctxFor(userId), now: new Date('2090-07-01T16:00:00Z') }, goal.id);
    const second = await celebratedAt(goal.id);

    expect(first).not.toBeNull();
    expect(second?.getTime()).toBe(first?.getTime());
  });
});
