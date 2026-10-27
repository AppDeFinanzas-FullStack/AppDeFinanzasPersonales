import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createBudgetPeriodRepository } from '../../src/infrastructure/persistence/repositories/budget-period.repository.js';
import { createBudgetRepository } from '../../src/infrastructure/persistence/repositories/budget.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import {
  createBudget,
  createBudgetPeriod,
  createSpend,
  deleteBudgetsOf,
  systemCategoryId,
  thresholdHitsOf,
} from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes the operations (tasks.md, TASK-196) but not their factories nor their row shapes.
 * These tests assume, like those of TASK-182:
 * - `createBudgetRepository(tx, userId)` and `createBudgetPeriodRepository(tx, userId)` build a
 *   repository over the client of a transaction; `Repositories` exposes them as `budgets` and
 *   `budgetPeriods`. The user comes from the `UnitOfWork` (`userLock`), never from an argument.
 * - `budgets.insert({ id, scope, categoryId, amount, currencyCode, startDay, defaultAction,
 *   thresholds })` takes `amount` as a `Decimal` and `categoryId` as `null` for the general one;
 *   `get(id)` returns `{ id, scope, categoryId, amount: Decimal, currencyCode, startDay,
 *   nextStartDay, defaultAction, thresholds: number[], status, frozenCarryover }` or `null` when the
 *   user has no such budget; `update(id, patch)` takes some of `amount`, `defaultAction`,
 *   `thresholds`, `nextStartDay`, `status` and `frozenCarryover`; `delete(id)` removes it with its
 *   history; `count()` counts the budgets of the user.
 * - `budgetPeriods.insert({ id, budgetId, startDate, endDate, amount, carryoverIn })` takes the
 *   amounts as `Decimal`; `get(id)` returns `{ id, budgetId, startDate, endDate, amount: Decimal,
 *   carryoverIn: Decimal, status }` or `null`; `listByBudget(budgetId, limit)` returns the newest
 *   first.
 * - `budgetPeriods.insertLateAdjustment({ id, periodId, sourcePeriodId, amount })` and
 *   `lateAdjustments(periodId)` returning `{ id, sourcePeriodId, amount: Decimal, voidedAt }[]`;
 *   `voidLateAdjustments(periodId)` sets `voidedAt` ("Reiniciar arrastre").
 * - `budgetPeriods.recordThresholdHit(periodId, threshold)` returns `true` when it saved the notice
 *   and `false` when that threshold already had one in that period.
 * - `budgetPeriods.spent(budget, period)` takes rows returned by `get` and returns a `Decimal`: the
 *   expenses of the scope within the period, in the currency of the budget (RF-M11-03).
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';

const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx, userId) => ({
  budgets: createBudgetRepository(tx, userId ?? NIL_USER),
  budgetPeriods: createBudgetPeriodRepository(tx, userId ?? NIL_USER),
}));

const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteBudgetsOf(usedUserIds);
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

const FROM = '2090-05-01';
const TO = '2090-05-31';

/** The spent of the budget in the period, read through the repositories. */
async function spentOf(userId: string, budgetId: string, periodId: string): Promise<string> {
  const spent = await withUser(userId, async (r) => {
    const budget = await r.budgets.get(budgetId);
    const period = await r.budgetPeriods.get(periodId);
    if (!budget || !period) {
      throw new Error('Budget or period not found');
    }
    return r.budgetPeriods.spent(budget, period);
  });
  return spent.toFixed(2);
}

describe('budget repository', () => {
  it('RN-09 inserta y lee un presupuesto propio', async () => {
    const user = await newUser();
    const category = await createCategory(user.id);
    const id = uuidv7();
    await withUser(user.id, (r) =>
      r.budgets.insert({
        id,
        scope: 'category',
        categoryId: category.id,
        amount: new Decimal('250.50'),
        currencyCode: 'BOB',
        startDay: 5,
        defaultAction: 'carry',
        thresholds: [50, 90],
      }),
    );
    const row = await withUser(user.id, (r) => r.budgets.get(id));
    expect(row?.id).toBe(id);
    expect(row?.scope).toBe('category');
    expect(row?.categoryId).toBe(category.id);
    expect(new Decimal(row?.amount ?? 0).toFixed(2)).toBe('250.50');
    expect(row?.currencyCode).toBe('BOB');
    expect(row?.startDay).toBe(5);
    expect(row?.defaultAction).toBe('carry');
    expect(row?.thresholds).toEqual([50, 90]);
    expect(row?.status).toBe('active');
    expect(await withUser(user.id, (r) => r.budgets.count())).toBe(1);
  });

  it('RN-09 actualiza un presupuesto propio', async () => {
    const user = await newUser();
    const budget = await createBudget(user.id);
    await withUser(user.id, (r) =>
      r.budgets.update(budget.id, {
        amount: new Decimal('800.00'),
        thresholds: [70],
        nextStartDay: 10,
        status: 'paused',
      }),
    );
    const row = await withUser(user.id, (r) => r.budgets.get(budget.id));
    expect(new Decimal(row?.amount ?? 0).toFixed(2)).toBe('800.00');
    expect(row?.thresholds).toEqual([70]);
    expect(row?.nextStartDay).toBe(10);
    expect(row?.status).toBe('paused');
  });

  it('RN-09 borra un presupuesto con su historia', async () => {
    const user = await newUser();
    const budget = await createBudget(user.id);
    const period = await createBudgetPeriod(user.id, budget, { startDate: FROM, endDate: TO });
    await withUser(user.id, (r) => r.budgets.delete(budget.id));
    expect(await withUser(user.id, (r) => r.budgets.get(budget.id))).toBeNull();
    expect(await withUser(user.id, (r) => r.budgetPeriods.get(period.id))).toBeNull();
  });

  it('RN-09 no se ven los presupuestos de otro usuario', async () => {
    const owner = await newUser();
    const other = await newUser();
    const budget = await createBudget(owner.id);
    expect(await withUser(other.id, (r) => r.budgets.get(budget.id))).toBeNull();
    expect(await withUser(other.id, (r) => r.budgets.count())).toBe(0);
    expect(await withUser(owner.id, (r) => r.budgets.get(budget.id))).not.toBeNull();
  });

  it('RN-09 otro usuario no modifica ni borra el presupuesto ajeno', async () => {
    const owner = await newUser();
    const other = await newUser();
    const budget = await createBudget(owner.id, { amount: '500.00' });
    await withUser(other.id, (r) => r.budgets.update(budget.id, { amount: new Decimal('1.00') }));
    await withUser(other.id, (r) => r.budgets.delete(budget.id));
    const row = await withUser(owner.id, (r) => r.budgets.get(budget.id));
    expect(new Decimal(row?.amount ?? 0).toFixed(2)).toBe('500.00');
  });
});

describe('budget period repository', () => {
  it('RN-09 inserta, lee y lista los períodos de un presupuesto', async () => {
    const user = await newUser();
    const budget = await createBudget(user.id);
    const first = uuidv7();
    const second = uuidv7();
    await withUser(user.id, async (r) => {
      await r.budgetPeriods.insert({
        id: first,
        budgetId: budget.id,
        startDate: '2090-04-01',
        endDate: '2090-04-30',
        amount: new Decimal('500.00'),
        carryoverIn: new Decimal('0.00'),
      });
      await r.budgetPeriods.insert({
        id: second,
        budgetId: budget.id,
        startDate: FROM,
        endDate: TO,
        amount: new Decimal('500.00'),
        carryoverIn: new Decimal('12.50'),
      });
    });
    const row = await withUser(user.id, (r) => r.budgetPeriods.get(second));
    expect(row?.startDate).toBe(FROM);
    expect(row?.endDate).toBe(TO);
    expect(new Decimal(row?.carryoverIn ?? 0).toFixed(2)).toBe('12.50');
    expect(row?.status).toBe('open');

    const list = await withUser(user.id, (r) => r.budgetPeriods.listByBudget(budget.id, 12));
    expect(list.map((p) => p.id)).toEqual([second, first]);
    const limited = await withUser(user.id, (r) => r.budgetPeriods.listByBudget(budget.id, 1));
    expect(limited.map((p) => p.id)).toEqual([second]);
  });

  it('RN-09 no se ven los períodos de otro usuario', async () => {
    const owner = await newUser();
    const other = await newUser();
    const budget = await createBudget(owner.id);
    const period = await createBudgetPeriod(owner.id, budget, { startDate: FROM, endDate: TO });
    expect(await withUser(other.id, (r) => r.budgetPeriods.get(period.id))).toBeNull();
    expect(await withUser(other.id, (r) => r.budgetPeriods.listByBudget(budget.id, 12))).toEqual(
      [],
    );
  });

  it('TASK-196 guarda los ajustes tardíos y los anula al reiniciar el arrastre', async () => {
    const user = await newUser();
    const budget = await createBudget(user.id);
    const closed = await createBudgetPeriod(user.id, budget, {
      startDate: '2090-04-01',
      endDate: '2090-04-30',
      status: 'closed_pending',
    });
    const current = await createBudgetPeriod(user.id, budget, { startDate: FROM, endDate: TO });
    await withUser(user.id, (r) =>
      r.budgetPeriods.insertLateAdjustment({
        id: uuidv7(),
        periodId: current.id,
        sourcePeriodId: closed.id,
        amount: new Decimal('-15.25'),
      }),
    );
    const rows = await withUser(user.id, (r) => r.budgetPeriods.lateAdjustments(current.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourcePeriodId).toBe(closed.id);
    expect(new Decimal(rows[0]?.amount ?? 0).toFixed(2)).toBe('-15.25');
    expect(rows[0]?.voidedAt).toBeNull();

    await withUser(user.id, (r) => r.budgetPeriods.voidLateAdjustments(current.id));
    const voided = await withUser(user.id, (r) => r.budgetPeriods.lateAdjustments(current.id));
    expect(voided[0]?.voidedAt).not.toBeNull();
  });

  it('RN-09 no se ven los ajustes tardíos de otro usuario', async () => {
    const owner = await newUser();
    const other = await newUser();
    const budget = await createBudget(owner.id);
    const closed = await createBudgetPeriod(owner.id, budget, {
      startDate: '2090-04-01',
      endDate: '2090-04-30',
      status: 'closed_pending',
    });
    const current = await createBudgetPeriod(owner.id, budget, { startDate: FROM, endDate: TO });
    await withUser(owner.id, (r) =>
      r.budgetPeriods.insertLateAdjustment({
        id: uuidv7(),
        periodId: current.id,
        sourcePeriodId: closed.id,
        amount: new Decimal('5.00'),
      }),
    );
    expect(await withUser(other.id, (r) => r.budgetPeriods.lateAdjustments(current.id))).toEqual(
      [],
    );
  });

  it('TASK-196 un umbral avisa una sola vez por período', async () => {
    const user = await newUser();
    const budget = await createBudget(user.id);
    const period = await createBudgetPeriod(user.id, budget, { startDate: FROM, endDate: TO });
    const first = await withUser(user.id, (r) => r.budgetPeriods.recordThresholdHit(period.id, 80));
    const again = await withUser(user.id, (r) => r.budgetPeriods.recordThresholdHit(period.id, 80));
    const other = await withUser(user.id, (r) =>
      r.budgetPeriods.recordThresholdHit(period.id, 100),
    );
    expect([first, again, other]).toEqual([true, false, true]);
    expect(await thresholdHitsOf(period.id)).toEqual([80, 100]);
  });
});

describe('budget period spent', () => {
  it('RF-M11-03 un gasto en $ se convierte con su tasa guardada a un presupuesto en Bs', async () => {
    const user = await newUser();
    const usd = await createAccount(user.id, { currencyCode: 'USD' });
    const category = await createCategory(user.id);
    const budget = await createBudget(user.id, { categoryId: category.id, currencyCode: 'BOB' });
    const period = await createBudgetPeriod(user.id, budget, { startDate: FROM, endDate: TO });
    await createSpend(user.id, {
      accountId: usd.id,
      categoryId: category.id,
      date: '2090-05-10',
      amount: '10.00',
      rateCurBob: '7.00',
      rateUsdBob: '7.00',
    });
    await createSpend(user.id, {
      accountId: usd.id,
      categoryId: category.id,
      date: '2090-05-20',
      amount: '5.00',
      rateCurBob: '6.90',
      rateUsdBob: '6.90',
    });
    expect(await spentOf(user.id, budget.id, period.id)).toBe('104.50');
  });

  it('RF-M11-03 un gasto en Bs se convierte con su tasa guardada a un presupuesto en $', async () => {
    const user = await newUser();
    const bob = await createAccount(user.id, { currencyCode: 'BOB' });
    const category = await createCategory(user.id);
    const budget = await createBudget(user.id, { categoryId: category.id, currencyCode: 'USD' });
    const period = await createBudgetPeriod(user.id, budget, { startDate: FROM, endDate: TO });
    await createSpend(user.id, {
      accountId: bob.id,
      categoryId: category.id,
      date: '2090-05-10',
      amount: '70.00',
      rateCurBob: '1.00',
      rateUsdBob: '7.00',
    });
    expect(await spentOf(user.id, budget.id, period.id)).toBe('10.00');
  });

  it('RF-M11-03 solo suma los gastos del período, sin los borrados ni los ingresos', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const category = await createCategory(user.id);
    const income = await createCategory(user.id, { kind: 'income' });
    const budget = await createBudget(user.id, { categoryId: category.id });
    const period = await createBudgetPeriod(user.id, budget, { startDate: FROM, endDate: TO });
    const spend = (date: string, extra: { deletedAt?: Date } = {}) =>
      createSpend(user.id, {
        accountId: account.id,
        categoryId: category.id,
        date,
        amount: '10.00',
        ...extra,
      });
    await spend('2090-05-01');
    await spend('2090-05-31');
    await spend('2090-04-30');
    await spend('2090-06-01');
    await spend('2090-05-15', { deletedAt: new Date() });
    await createSpend(user.id, {
      accountId: account.id,
      categoryId: income.id,
      kind: 'income',
      date: '2090-05-15',
      amount: '99.00',
    });
    expect(await spentOf(user.id, budget.id, period.id)).toBe('20.00');
  });

  it('RF-M11-02 un gasto de una subcategoría cuenta en su presupuesto, en el del padre y en el general', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const parent = await createCategory(user.id);
    const child = await createCategory(user.id, { parentId: parent.id });
    const sibling = await createCategory(user.id);
    const childBudget = await createBudget(user.id, { categoryId: child.id });
    const parentBudget = await createBudget(user.id, { categoryId: parent.id });
    const general = await createBudget(user.id);
    const periods = {
      child: await createBudgetPeriod(user.id, childBudget, { startDate: FROM, endDate: TO }),
      parent: await createBudgetPeriod(user.id, parentBudget, { startDate: FROM, endDate: TO }),
      general: await createBudgetPeriod(user.id, general, { startDate: FROM, endDate: TO }),
    };
    const spend = (categoryId: string, amount: string) =>
      createSpend(user.id, { accountId: account.id, categoryId, date: '2090-05-10', amount });
    await spend(child.id, '10.00');
    await spend(parent.id, '3.00');
    await spend(sibling.id, '100.00');

    expect(await spentOf(user.id, childBudget.id, periods.child.id)).toBe('10.00');
    expect(await spentOf(user.id, parentBudget.id, periods.parent.id)).toBe('13.00');
    expect(await spentOf(user.id, general.id, periods.general.id)).toBe('113.00');
  });

  it('RN-02 el general no suma las transferencias, los ajustes ni "Deudas y préstamos"', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const other = await createAccount(user.id);
    const category = await createCategory(user.id);
    const general = await createBudget(user.id);
    const period = await createBudgetPeriod(user.id, general, { startDate: FROM, endDate: TO });
    const debts = await systemCategoryId(user.id, 'debts');
    await createSpend(user.id, {
      accountId: account.id,
      categoryId: category.id,
      date: '2090-05-10',
      amount: '25.00',
    });
    await createSpend(user.id, {
      accountId: account.id,
      categoryId: debts,
      date: '2090-05-11',
      amount: '300.00',
    });
    await createLedgerTransaction(user.id, {
      kind: 'transfer',
      date: '2090-05-12',
      entries: [
        { accountId: account.id, amount: '-400.00' },
        { accountId: other.id, amount: '400.00' },
      ],
    });
    await createLedgerTransaction(user.id, {
      kind: 'adjustment',
      date: '2090-05-13',
      entries: [{ accountId: account.id, amount: '-77.00' }],
    });
    expect(await spentOf(user.id, general.id, period.id)).toBe('25.00');
  });

  it('RN-02 la subcategoría "Intereses" sí cuenta en el general', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const general = await createBudget(user.id);
    const period = await createBudgetPeriod(user.id, general, { startDate: FROM, endDate: TO });
    const interest = await systemCategoryId(user.id, 'debts_interest');
    await createSpend(user.id, {
      accountId: account.id,
      categoryId: interest,
      date: '2090-05-10',
      amount: '30.00',
    });
    expect(await spentOf(user.id, general.id, period.id)).toBe('30.00');
  });

  it('RN-09 el gasto no suma los movimientos de otro usuario', async () => {
    const owner = await newUser();
    const other = await newUser();
    const general = await createBudget(owner.id);
    const period = await createBudgetPeriod(owner.id, general, { startDate: FROM, endDate: TO });
    const account = await createAccount(other.id);
    const category = await createCategory(other.id);
    await createSpend(other.id, {
      accountId: account.id,
      categoryId: category.id,
      date: '2090-05-10',
      amount: '60.00',
    });
    expect(await spentOf(owner.id, general.id, period.id)).toBe('0.00');
  });
});
