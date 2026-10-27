import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createGoalAllocationRepository } from '../../src/infrastructure/persistence/repositories/goal-allocation.repository.js';
import { createGoalRepository } from '../../src/infrastructure/persistence/repositories/goal.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import { createAllocationEvent, createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes the operations of the repositories (tasks.md, TASK-182) but not their factories
 * nor their row shapes. These tests assume, like those of TASK-099:
 * - `createGoalRepository(tx, userId)` and `createGoalAllocationRepository(tx, userId)` build a
 *   repository over the client of a transaction; `Repositories` exposes them as `goals` and
 *   `goalAllocations`. The user comes from the `UnitOfWork` (`userLock`), never from an argument.
 * - `goals.insert({ id, name, target, currencyCode, targetDate, icon, color, dedicatedAccountId })`
 *   takes `target` as a `Decimal`, `targetDate` as `YYYY-MM-DD` or `null`; `goals.get(id)` returns
 *   a row with those fields or `null` when the user has no such goal; `goals.update(id, patch)`
 *   takes some of `name`, `target`, `currencyCode`, `targetDate`, `icon` and `color`.
 * - `goalAllocations.insert({ id, goalId, accountId, amount, origin, relatedTransactionId })` takes
 *   `amount` as a signed `Decimal`.
 * - `earmarkedByAccount(accountId)` returns `{ goalId, amount }[]`, one per goal, the sum of its
 *   events on that account; `earmarkedByGoal(goalId)` returns `{ accountId, amount }[]`, one per
 *   account. Amounts are `Decimal`.
 * - `history(goalId)` returns `{ accountId, amount, origin }[]`: the events of the goal with their
 *   own origin plus one item per entry of the ledger on the dedicated account (deleted
 *   transactions excluded), whose `origin` is `'dedicated_account'` (RF-M12-07).
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';

const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx, userId) => ({
  goals: createGoalRepository(tx, userId ?? NIL_USER),
  goalAllocations: createGoalAllocationRepository(tx, userId ?? NIL_USER),
}));

const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteGoalsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

async function newUser(): Promise<TestUser> {
  const user = await createUser();
  usedUserIds.push(user.id);
  return user;
}

const withUser = <T>(userId: string, fn: (repos: Repositories) => Promise<T>) =>
  uow.run(fn, { userLock: userId });

function totalsBy<K extends string>(
  rows: ({ amount: Decimal } & Record<K, string>)[],
  key: K,
): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row[key], row.amount.toFixed(2)]));
}

describe('goal repository', () => {
  it('RN-09 inserta y lee una meta propia', async () => {
    const user = await newUser();
    const id = uuidv7();
    await withUser(user.id, (r) =>
      r.goals.insert({
        id,
        name: 'Viaje',
        target: new Decimal('1500.50'),
        currencyCode: 'BOB',
        targetDate: null,
        icon: 'target',
        color: 'blue',
        dedicatedAccountId: null,
      }),
    );
    const row = await withUser(user.id, (r) => r.goals.get(id));
    expect(row?.id).toBe(id);
    expect(row?.name).toBe('Viaje');
    expect(new Decimal(row?.target ?? 0).toFixed(2)).toBe('1500.50');
  });

  it('RN-09 actualiza una meta propia', async () => {
    const user = await newUser();
    const goal = await createGoal(user.id);
    await withUser(user.id, (r) => r.goals.update(goal.id, { name: 'Casa' }));
    const row = await withUser(user.id, (r) => r.goals.get(goal.id));
    expect(row?.name).toBe('Casa');
  });

  it('RN-09 no se ven las metas de otro usuario', async () => {
    const owner = await newUser();
    const other = await newUser();
    const goal = await createGoal(owner.id);
    expect(await withUser(other.id, (r) => r.goals.get(goal.id))).toBeNull();
    expect(await withUser(owner.id, (r) => r.goals.get(goal.id))).not.toBeNull();
  });

  it('RN-09 otro usuario no modifica la meta ajena', async () => {
    const owner = await newUser();
    const other = await newUser();
    const goal = await createGoal(owner.id, { name: 'Original' });
    await withUser(other.id, (r) => r.goals.update(goal.id, { name: 'Robada' }));
    const row = await withUser(owner.id, (r) => r.goals.get(goal.id));
    expect(row?.name).toBe('Original');
  });
});

describe('goal allocation repository', () => {
  it('RF-M12-04 insert guarda el evento y earmarkedByGoal lo suma', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const goal = await createGoal(user.id);
    await withUser(user.id, (r) =>
      r.goalAllocations.insert({
        id: uuidv7(),
        goalId: goal.id,
        accountId: account.id,
        amount: new Decimal('40.00'),
        origin: 'manual',
        relatedTransactionId: null,
      }),
    );
    const rows = await withUser(user.id, (r) => r.goalAllocations.earmarkedByGoal(goal.id));
    expect(totalsBy(rows, 'accountId')).toEqual({ [account.id]: '40.00' });
  });

  it('RF-M12-04 earmarkedByAccount suma por meta los apartados y los retiros', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const goalA = await createGoal(user.id);
    const goalB = await createGoal(user.id);
    await createAllocationEvent(user.id, goalA.id, account.id, { amount: '100.00' });
    await createAllocationEvent(user.id, goalA.id, account.id, { amount: '-30.50' });
    await createAllocationEvent(user.id, goalA.id, account.id, { amount: '5.00', origin: 'budget' });
    await createAllocationEvent(user.id, goalB.id, account.id, { amount: '20.00' });

    const rows = await withUser(user.id, (r) => r.goalAllocations.earmarkedByAccount(account.id));
    expect(totalsBy(rows, 'goalId')).toEqual({ [goalA.id]: '74.50', [goalB.id]: '20.00' });
  });

  it('RF-M12-04 earmarkedByGoal suma por cuenta los apartados y los retiros', async () => {
    const user = await newUser();
    const accountA = await createAccount(user.id);
    const accountB = await createAccount(user.id);
    const goal = await createGoal(user.id);
    await createAllocationEvent(user.id, goal.id, accountA.id, { amount: '50.00' });
    await createAllocationEvent(user.id, goal.id, accountA.id, { amount: '-10.00' });
    await createAllocationEvent(user.id, goal.id, accountB.id, { amount: '7.25' });

    const rows = await withUser(user.id, (r) => r.goalAllocations.earmarkedByGoal(goal.id));
    expect(totalsBy(rows, 'accountId')).toEqual({ [accountA.id]: '40.00', [accountB.id]: '7.25' });
  });

  it('RF-M12-07 el historial incluye los eventos con su origen y los asientos de la dedicada con el origen "cuenta dedicada"', async () => {
    const user = await newUser();
    const dedicated = await createAccount(user.id);
    const other = await createAccount(user.id);
    const goal = await createGoal(user.id, { dedicatedAccountId: dedicated.id });
    await createAllocationEvent(user.id, goal.id, other.id, { amount: '25.00', origin: 'manual' });
    await createAllocationEvent(user.id, goal.id, other.id, {
      amount: '-5.00',
      origin: 'adjustment',
    });
    await createLedgerTransaction(user.id, {
      date: '2090-02-01',
      entries: [{ accountId: dedicated.id, amount: '300.00' }],
    });

    const rows = await withUser(user.id, (r) => r.goalAllocations.history(goal.id));
    const view = rows
      .map((row) => `${row.origin}:${row.accountId}:${row.amount.toFixed(2)}`)
      .sort();
    expect(view).toEqual(
      [
        `manual:${other.id}:25.00`,
        `adjustment:${other.id}:-5.00`,
        `dedicated_account:${dedicated.id}:300.00`,
      ].sort(),
    );
  });

  it('RF-M12-07 el historial ignora los asientos de transacciones borradas', async () => {
    const user = await newUser();
    const dedicated = await createAccount(user.id);
    const goal = await createGoal(user.id, { dedicatedAccountId: dedicated.id });
    await createLedgerTransaction(user.id, {
      date: '2090-02-01',
      deletedAt: new Date(),
      entries: [{ accountId: dedicated.id, amount: '80.00' }],
    });
    const rows = await withUser(user.id, (r) => r.goalAllocations.history(goal.id));
    expect(rows).toEqual([]);
  });

  it('RN-09 no se ven los apartados ni el historial de las metas de otro usuario', async () => {
    const owner = await newUser();
    const other = await newUser();
    const account = await createAccount(owner.id);
    const goal = await createGoal(owner.id, { dedicatedAccountId: account.id });
    await createAllocationEvent(owner.id, goal.id, account.id, { amount: '10.00' });
    await createLedgerTransaction(owner.id, {
      date: '2090-02-01',
      entries: [{ accountId: account.id, amount: '60.00' }],
    });

    expect(await withUser(other.id, (r) => r.goalAllocations.earmarkedByGoal(goal.id))).toEqual([]);
    expect(
      await withUser(other.id, (r) => r.goalAllocations.earmarkedByAccount(account.id)),
    ).toEqual([]);
    expect(await withUser(other.id, (r) => r.goalAllocations.history(goal.id))).toEqual([]);
  });
});
