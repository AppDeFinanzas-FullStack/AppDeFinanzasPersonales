import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { BalanceGuard } from '../../src/application/shared/balance-guard.js';
import { createAccountRepository } from '../../src/infrastructure/persistence/repositories/account.repository.js';
import { createGoalAllocationRepository } from '../../src/infrastructure/persistence/repositories/goal-allocation.repository.js';
import { createGoalRepository } from '../../src/infrastructure/persistence/repositories/goal.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import { createAllocationEvent, createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Assumptions on top of the ones in balance-guard.test.ts (plan 4.0, 4.12.3):
 * - `BalanceGuard.apply(repos, userId, deltas, { mode, earmarkWithdrawals })`, with
 *   `earmarkWithdrawals: { goalId, accountId, amount: Decimal }[]` of positive amounts.
 * - `interactive` rejects with `AppError` `EARMARK_CONFIRMATION_REQUIRED` (409) whose `data` is
 *   `{ shortfall: '100.00', proposal: [{ goalId, amount: '100.00' }] }` (decimal text, ADR-03;
 *   the proposal is the `earmarkProposal` of the domain).
 * - If the withdrawals cover the shortfall, the guard inserts one `confirmed_spend` event per
 *   withdrawal, with a negative amount, in the same transaction.
 * - `automatic` resolves to an "AutoBlocked" outcome and `batch` to `'skip'`; neither writes.
 */
const uowCache = new Map<string, UnitOfWork>();

function uowFor(userId: string): UnitOfWork {
  let uow = uowCache.get(userId);
  if (!uow) {
    uow = createUnitOfWork(testPrisma(), (tx) => ({
      accounts: createAccountRepository(tx, userId),
      ledger: createLedgerRepository(tx, userId),
      goals: createGoalRepository(tx, userId),
      goalAllocations: createGoalAllocationRepository(tx, userId),
    }));
    uowCache.set(userId, uow);
  }
  return uow;
}

const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteGoalsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

const delta = (accountId: string, amount: string) => ({ accountId, amount: new Decimal(amount) });

interface Withdrawal {
  goalId: string;
  accountId: string;
  amount: Decimal;
}

/** A user with a bank of 4.800 and a goal that has 300 earmarked on it. */
async function bankWithEarmarks() {
  const user = await createUser();
  usedUserIds.push(user.id);
  const bank = await createAccount(user.id, {
    type: 'bank',
    initialBalance: '4800.00',
    initialBalanceDate: '2090-01-01',
  });
  const goal = await createGoal(user.id, {});
  await createAllocationEvent(user.id, goal.id, bank.id, { amount: '300.00' });
  return { userId: user.id, accountId: bank.id, goalId: goal.id };
}

function apply(
  userId: string,
  deltas: { accountId: string; amount: Decimal }[],
  mode: 'interactive' | 'automatic' | 'batch',
  earmarkWithdrawals?: Withdrawal[],
): Promise<unknown> {
  return uowFor(userId).run(
    async (repos: Repositories) => {
      const outcome: unknown = await BalanceGuard.apply(repos, userId, deltas, {
        mode,
        ...(earmarkWithdrawals ? { earmarkWithdrawals } : {}),
      });
      return outcome;
    },
    { userLock: userId },
  );
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
  const rows = await uowFor(userId).run(
    (repos) => repos.goalAllocations.earmarkedByAccount(accountId),
    { userLock: userId },
  );
  return rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2);
}

async function spendEventsOf(userId: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM goal_allocation_event
     WHERE user_id = ${userId}::uuid AND origin = 'confirmed_spend'`;
  return rows[0]?.n ?? 0;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('BalanceGuard: protección de apartados', () => {
  it('RF-M12-05 un banco con 4.800 y 300 apartados, ante un gasto de 4.600, da un faltante de 100 con la propuesta', async () => {
    const { userId, accountId, goalId } = await bankWithEarmarks();

    const error = await rejectionOf(apply(userId, [delta(accountId, '-4600.00')], 'interactive'));

    expect(error.code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(error.status).toBe(409);
    expect(error.data).toEqual({
      shortfall: '100.00',
      proposal: [{ goalId, amount: '100.00' }],
    });
    expect(await earmarkedOf(userId, accountId)).toBe('300.00');
    expect(await spendEventsOf(userId)).toBe(0);
  });

  it('RF-M12-05 un gasto que deja el saldo igual a lo apartado no pide confirmación', async () => {
    const { userId, accountId } = await bankWithEarmarks();

    await expect(
      apply(userId, [delta(accountId, '-4500.00')], 'interactive'),
    ).resolves.toBeUndefined();
  });

  it('RF-M12-05 con los retiros que cubren 100, se guarda y los apartados quedan en 200', async () => {
    const { userId, accountId, goalId } = await bankWithEarmarks();

    await apply(userId, [delta(accountId, '-4600.00')], 'interactive', [
      { goalId, accountId, amount: new Decimal('100.00') },
    ]);

    expect(await earmarkedOf(userId, accountId)).toBe('200.00');
    expect(await spendEventsOf(userId)).toBe(1);
  });

  it('RF-M12-05 con retiros que no cubren el faltante sigue pidiendo confirmación y no escribe', async () => {
    const { userId, accountId, goalId } = await bankWithEarmarks();

    const error = await rejectionOf(
      apply(userId, [delta(accountId, '-4600.00')], 'interactive', [
        { goalId, accountId, amount: new Decimal('40.00') },
      ]),
    );

    expect(error.code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(await earmarkedOf(userId, accountId)).toBe('300.00');
    expect(await spendEventsOf(userId)).toBe(0);
  });

  it('RF-M12-05 si la operación falla después de la guarda, los retiros se deshacen con la transacción', async () => {
    const { userId, accountId, goalId } = await bankWithEarmarks();

    await expect(
      uowFor(userId).run(
        async (repos: Repositories) => {
          await BalanceGuard.apply(repos, userId, [delta(accountId, '-4600.00')], {
            mode: 'interactive',
            earmarkWithdrawals: [{ goalId, accountId, amount: new Decimal('100.00') }],
          });
          throw new Error('the spend failed after the guard');
        },
        { userLock: userId },
      ),
    ).rejects.toThrow('the spend failed');

    expect(await earmarkedOf(userId, accountId)).toBe('300.00');
  });

  it('RF-M12-05 en modo automatic devuelve AutoBlocked y no escribe nada', async () => {
    const { userId, accountId } = await bankWithEarmarks();

    const outcome = await apply(userId, [delta(accountId, '-4600.00')], 'automatic');

    expect(JSON.stringify(outcome)).toMatch(/auto.?blocked/i);
    expect(await earmarkedOf(userId, accountId)).toBe('300.00');
    expect(await spendEventsOf(userId)).toBe(0);
  });

  it('RF-M12-05 en modo batch devuelve skip y no escribe nada', async () => {
    const { userId, accountId } = await bankWithEarmarks();

    const outcome = await apply(userId, [delta(accountId, '-4600.00')], 'batch');

    expect(outcome).toBe('skip');
    expect(await earmarkedOf(userId, accountId)).toBe('300.00');
  });

  it('RF-M12-05 una cuenta dedicada no pide confirmación', async () => {
    const user = await createUser();
    usedUserIds.push(user.id);
    const bank = await createAccount(user.id, {
      type: 'bank',
      initialBalance: '1000.00',
      initialBalanceDate: '2090-01-01',
    });
    const goal = await createGoal(user.id, { dedicatedAccountId: bank.id });
    await createAllocationEvent(user.id, goal.id, bank.id, { amount: '800.00' });

    await expect(
      apply(user.id, [delta(bank.id, '-900.00')], 'interactive'),
    ).resolves.toBeUndefined();
  });

  it('EC-M12-07 un ajuste negativo que baja del apartado pide confirmación', async () => {
    const { userId, accountId, goalId } = await bankWithEarmarks();

    const error = await rejectionOf(apply(userId, [delta(accountId, '-4650.00')], 'interactive'));

    expect(error.code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(error.data).toEqual({
      shortfall: '150.00',
      proposal: [{ goalId, amount: '150.00' }],
    });
  });

  it('RNF-10 dos gastos concurrentes evalúan los apartados con el saldo vigente', async () => {
    const { userId, accountId } = await bankWithEarmarks();
    const uow = uowFor(userId);

    let firstChecked: () => void = () => undefined;
    const firstHasChecked = new Promise<void>((resolve) => {
      firstChecked = resolve;
    });
    const spend = (amount: string, afterCheck: () => Promise<void>) =>
      uow.run(async (repos: Repositories) => {
        await BalanceGuard.apply(repos, userId, [delta(accountId, amount)], {
          mode: 'interactive',
        });
        await afterCheck();
        await repos.ledger.insertTransaction(
          {
            id: uuidv7(),
            kind: 'adjustment',
            date: '2090-01-15',
            note: null,
            categoryId: null,
            origin: 'manual',
            originId: null,
            parentTransactionId: null,
            recurringRuleId: null,
            recurringLabel: null,
            rateCurBob: new Decimal('1.00'),
            rateUsdBob: new Decimal('6.96'),
            declaredRate: null,
          },
          [{ id: uuidv7(), accountId, amount: new Decimal(amount) }],
        );
      });

    // The first spend leaves exactly the 300 earmarked; the second, seen against 4.800, would pass.
    const first = spend('-4500.00', async () => {
      firstChecked();
      await wait(400);
    });
    const second = firstHasChecked.then(() => spend('-100.00', () => Promise.resolve()));

    const results = await Promise.allSettled([first, second]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    const reason: unknown = results[1].status === 'rejected' ? results[1].reason : undefined;
    expect(reason).toBeInstanceOf(AppError);
    expect((reason as AppError).code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect((reason as AppError).data).toMatchObject({ shortfall: '100.00' });
  });
});
