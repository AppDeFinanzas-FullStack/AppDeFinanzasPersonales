import type { BudgetDto } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import {
  createRatesService,
  type RatesContext,
} from '../../src/application/services/rates.service.js';
import {
  createLedgerHooks,
  type LedgerChange,
  type LedgerChangeHandler,
  type LedgerHooks,
} from '../../src/application/shared/ledger-hooks.js';
import {
  createNotificationEmitter,
  type NotificationEmitter,
} from '../../src/application/shared/notification-emitter.js';
import { createAccountRepository } from '../../src/infrastructure/persistence/repositories/account.repository.js';
import { createBudgetPeriodRepository } from '../../src/infrastructure/persistence/repositories/budget-period.repository.js';
import { createBudgetRepository } from '../../src/infrastructure/persistence/repositories/budget.repository.js';
import { createCategoryRepository } from '../../src/infrastructure/persistence/repositories/category.repository.js';
import { createCurrencyRepository } from '../../src/infrastructure/persistence/repositories/currency.repository.js';
import { createGoalAllocationRepository } from '../../src/infrastructure/persistence/repositories/goal-allocation.repository.js';
import { createGoalRepository } from '../../src/infrastructure/persistence/repositories/goal.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createMarketRateRepository } from '../../src/infrastructure/persistence/repositories/market-rate.repository.js';
import { createNotificationPreferenceRepository } from '../../src/infrastructure/persistence/repositories/notification-preference.repository.js';
import { createNotificationRepository } from '../../src/infrastructure/persistence/repositories/notification.repository.js';
import { createUndoActionRepository } from '../../src/infrastructure/persistence/repositories/undo-action.repository.js';
import { createUserFxEventRepository } from '../../src/infrastructure/persistence/repositories/user-fx-event.repository.js';
import { createUserSettingsRepository } from '../../src/infrastructure/persistence/repositories/user-settings.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import {
  createBudget,
  createBudgetPeriod,
  createSpend,
  deleteBudgetsOf,
  type TestBudget,
  type TestBudgetStatus,
  thresholdHitsOf,
} from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Assumptions (tasks.md TASK-199 fixes the behaviour and the file, plan §4.11.3 fixes that it is a
 * handler of `LedgerHooks`; the factory name and its deps are not fixed):
 * - `budget-ledger-hook.ts` exports `createBudgetLedgerHook({ notifications, ids })`, which returns
 *   a `LedgerChangeHandler` `(tx, userId, change) => Promise<void>` to register in `LedgerHooks`.
 * - The period in course of a budget is its `open` period.
 * - The `decision` jsonb of a decided period stores the `DecisionInput` that was applied: "included
 *   carrying" is a surplus with `carry` > 0 or a deficit with `mode = 'carry'`.
 * - The "difference" of a late movement is the change of the spent of the closed period against
 *   `spent_at_decision` (less what earlier adjustments of that period already moved), with the
 *   sign of the result: deleting an expense of 40 adds +40.00 to the carryover in course.
 * - The ledger is written by SQL with the factories and then the hook is run with the change, as
 *   the services do after writing (plan §4.0).
 */
type CreateBudgetLedgerHook = (deps: {
  notifications: NotificationEmitter;
  ids: { next: () => string };
}) => LedgerChangeHandler;

const { createBudgetLedgerHook } =
  (await import('../../src/application/shared/budget-ledger-hook.js')) as unknown as {
    createBudgetLedgerHook: CreateBudgetLedgerHook;
  };

interface BudgetsServiceUnderTest {
  get(ctx: RatesContext, id: string): Promise<BudgetDto>;
}
type CreateBudgetsService = (deps: {
  uow: UnitOfWork;
  rates: ReturnType<typeof createRatesService>;
  notifications: NotificationEmitter;
  ids: { next: () => string };
}) => BudgetsServiceUnderTest;

const { createBudgetsService } =
  (await import('../../src/application/services/budgets.service.js')) as unknown as {
    createBudgetsService: CreateBudgetsService;
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
  notifications: createNotificationRepository(tx),
  notificationPreferences: createNotificationPreferenceRepository(tx),
  goals: createGoalRepository(tx, userId ?? NIL_USER),
  goalAllocations: createGoalAllocationRepository(tx, userId ?? NIL_USER),
  budgets: createBudgetRepository(tx, userId ?? NIL_USER),
  budgetPeriods: createBudgetPeriodRepository(tx, userId ?? NIL_USER),
}));

const notifications = createNotificationEmitter({ release: '1.1' });
const ids = { next: () => uuidv7() };

const hooks: LedgerHooks = createLedgerHooks();
hooks.register(createBudgetLedgerHook({ notifications, ids }));

const budgets = createBudgetsService({
  uow,
  rates: createRatesService({ uow }),
  notifications,
  ids,
});

const TZ = 'America/La_Paz';
/** Today is 2090-06-15 in La Paz: June is the period in course, May is closed. */
const NOW = new Date('2090-06-15T16:00:00Z');
const JUNE = { startDate: '2090-06-01', endDate: '2090-06-30' };
const MAY = { startDate: '2090-05-01', endDate: '2090-05-31' };
const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteBudgetsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

interface Setup {
  userId: string;
  accountId: string;
  categoryId: string;
  budget: TestBudget;
}

async function setup(
  options: { thresholds?: number[]; status?: TestBudgetStatus } = {},
): Promise<Setup> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  const account = await createAccount(user.id, { initialBalance: '10000.00' });
  const category = await createCategory(user.id);
  const budget = await createBudget(user.id, {
    categoryId: category.id,
    amount: '500.00',
    thresholds: options.thresholds ?? [80],
    status: options.status ?? 'active',
  });
  return { userId: user.id, accountId: account.id, categoryId: category.id, budget };
}

const spend = (s: Setup, date: string, amount: string) =>
  createSpend(s.userId, { accountId: s.accountId, categoryId: s.categoryId, date, amount });

async function deleteSpend(id: string): Promise<void> {
  await prisma.$executeRaw`UPDATE ledger_transaction SET deleted_at = now() WHERE id = ${id}::uuid`;
}

function runHook(s: Setup, dates: string[]): Promise<void> {
  const change: LedgerChange = {
    dates,
    categoryIds: [s.categoryId],
    accountIds: [s.accountId],
  };
  return uow.run((repos) => hooks.afterChange(repos, s.userId, change), { userLock: s.userId });
}

async function alertKeysOf(userId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ event_key: string }[]>`
    SELECT event_key FROM notification
     WHERE user_id = ${userId}::uuid AND type = 'budget_alert' ORDER BY event_key`;
  return rows.map((row) => row.event_key);
}

/** Marks the period as decided with the `DecisionInput` and the spent/result frozen at decision. */
async function decide(
  periodId: string,
  decision: Record<string, unknown>,
  spentAtDecision: string,
  resultAtDecision: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE budget_period
       SET status = 'decided', decided_at = now(), decision = ${JSON.stringify(decision)}::jsonb,
           spent_at_decision = ${spentAtDecision}::numeric,
           result_at_decision = ${resultAtDecision}::numeric
     WHERE id = ${periodId}::uuid`;
}

interface AdjustmentRow {
  period_id: string;
  source_period_id: string;
  amount: string;
  voided_at: Date | null;
}

async function adjustmentsOf(userId: string): Promise<AdjustmentRow[]> {
  return prisma.$queryRaw<AdjustmentRow[]>`
    SELECT period_id::text, source_period_id::text, amount::text, voided_at
      FROM budget_late_adjustment WHERE user_id = ${userId}::uuid ORDER BY created_at`;
}

async function periodState(
  periodId: string,
): Promise<{ status: string; carryover_in: string } | undefined> {
  const rows = await prisma.$queryRaw<{ status: string; carryover_in: string }[]>`
    SELECT status::text, carryover_in::text FROM budget_period WHERE id = ${periodId}::uuid`;
  return rows[0];
}

describe('umbrales del período en curso', () => {
  it('RF-M11-13 Umbral avisa una sola vez: bajar del 80 % y volver a cruzarlo no genera un segundo aviso', async () => {
    const s = await setup({ thresholds: [80] });
    const june = await createBudgetPeriod(s.userId, s.budget, JUNE);
    await spend(s, '2090-06-05', '320.00');
    const removable = await spend(s, '2090-06-06', '100.00');
    await runHook(s, ['2090-06-06']);
    expect(await alertKeysOf(s.userId)).toEqual([`budget_alert:${june.id}:80`]);

    await deleteSpend(removable);
    await runHook(s, ['2090-06-06']);
    await spend(s, '2090-06-07', '100.00');
    await runHook(s, ['2090-06-07']);

    expect(await alertKeysOf(s.userId)).toEqual([`budget_alert:${june.id}:80`]);
    expect(await thresholdHitsOf(june.id)).toEqual([80]);
  });

  it('RNF-12 Umbral avisa una sola vez: repetir el hook sobre el mismo cruce deja un solo aviso', async () => {
    const s = await setup({ thresholds: [80] });
    const june = await createBudgetPeriod(s.userId, s.budget, JUNE);
    await spend(s, '2090-06-05', '450.00');

    await runHook(s, ['2090-06-05']);
    await runHook(s, ['2090-06-05']);

    expect(await alertKeysOf(s.userId)).toEqual([`budget_alert:${june.id}:80`]);
    expect(await thresholdHitsOf(june.id)).toEqual([80]);
  });

  it('RF-M11-13 por debajo del umbral no avisa', async () => {
    const s = await setup({ thresholds: [80] });
    const june = await createBudgetPeriod(s.userId, s.budget, JUNE);
    await spend(s, '2090-06-05', '390.00');

    await runHook(s, ['2090-06-05']);

    expect(await alertKeysOf(s.userId)).toEqual([]);
    expect(await thresholdHitsOf(june.id)).toEqual([]);
  });

  it('RF-M11-13 el umbral se mide sobre el monto del período, no sobre el disponible', async () => {
    const s = await setup({ thresholds: [80] });
    // Available 300 (500 - 200 carried): 300 spent is 100 % of the available but 60 % of the amount.
    const june = await createBudgetPeriod(s.userId, s.budget, { ...JUNE, carryoverIn: '-200.00' });
    await spend(s, '2090-06-05', '300.00');

    await runHook(s, ['2090-06-05']);

    expect(await alertKeysOf(s.userId)).toEqual([]);
    expect(await thresholdHitsOf(june.id)).toEqual([]);
  });

  it('RF-M11-13 cruzar un segundo umbral avisa ese umbral una vez', async () => {
    const s = await setup({ thresholds: [80, 100] });
    const june = await createBudgetPeriod(s.userId, s.budget, JUNE);
    await spend(s, '2090-06-05', '420.00');
    await runHook(s, ['2090-06-05']);
    await spend(s, '2090-06-08', '100.00');
    await runHook(s, ['2090-06-08']);

    expect(await alertKeysOf(s.userId)).toEqual([
      `budget_alert:${june.id}:100`,
      `budget_alert:${june.id}:80`,
    ]);
    expect(await thresholdHitsOf(june.id)).toEqual([80, 100]);
  });

  it('RF-M11-13 un presupuesto pausado no alerta', async () => {
    const s = await setup({ thresholds: [80], status: 'paused' });
    const june = await createBudgetPeriod(s.userId, s.budget, JUNE);
    await spend(s, '2090-06-05', '450.00');

    await runHook(s, ['2090-06-05']);

    expect(await alertKeysOf(s.userId)).toEqual([]);
    expect(await thresholdHitsOf(june.id)).toEqual([]);
  });

  it('TASK-199 aislamiento: el gasto de otro usuario no cruza el umbral', async () => {
    const s = await setup({ thresholds: [80] });
    const june = await createBudgetPeriod(s.userId, s.budget, JUNE);
    const other = await setup({ thresholds: [80] });
    await createBudgetPeriod(other.userId, other.budget, JUNE);
    await spend(other, '2090-06-05', '450.00');

    await runHook(s, ['2090-06-05']);

    expect(await alertKeysOf(s.userId)).toEqual([]);
    expect(await thresholdHitsOf(june.id)).toEqual([]);
  });
});

describe('movimientos tardíos', () => {
  it('EC-M11-05 eliminar un gasto de un período decidido con arrastre sube el arrastre en curso por ese monto', async () => {
    const s = await setup({ thresholds: [] });
    const may = await createBudgetPeriod(s.userId, s.budget, { ...MAY, status: 'closed_pending' });
    const june = await createBudgetPeriod(s.userId, s.budget, { ...JUNE, carryoverIn: '200.00' });
    await spend(s, '2090-05-10', '260.00');
    const late = await spend(s, '2090-05-20', '40.00');
    await decide(may.id, { result: 'surplus', carry: '200.00', discard: '0.00' }, '300.00', '200.00');

    await deleteSpend(late);
    await runHook(s, ['2090-05-20']);

    const adjustments = await adjustmentsOf(s.userId);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.period_id).toBe(june.id);
    expect(adjustments[0]?.source_period_id).toBe(may.id);
    expect(new Decimal(adjustments[0]?.amount ?? '0').toFixed(2)).toBe('40.00');
    expect(adjustments[0]?.voided_at).toBeNull();
    expect((await periodState(may.id))?.status).toBe('decided');
  });

  it('EC-M11-05 con la decisión "descartar", eliminar el gasto no cambia nada', async () => {
    const s = await setup({ thresholds: [] });
    const may = await createBudgetPeriod(s.userId, s.budget, { ...MAY, status: 'closed_pending' });
    const june = await createBudgetPeriod(s.userId, s.budget, JUNE);
    await spend(s, '2090-05-10', '260.00');
    const late = await spend(s, '2090-05-20', '40.00');
    await decide(may.id, { result: 'surplus', carry: '0.00', discard: '200.00' }, '300.00', '200.00');

    await deleteSpend(late);
    await runHook(s, ['2090-05-20']);

    expect(await adjustmentsOf(s.userId)).toEqual([]);
    const state = await periodState(june.id);
    expect(new Decimal(state?.carryover_in ?? '-1').toFixed(2)).toBe('0.00');
    expect((await periodState(may.id))?.status).toBe('decided');
  });

  it('RF-M11-11 un tardío cargado en un período decidido con arrastre resta la diferencia del arrastre en curso', async () => {
    const s = await setup({ thresholds: [] });
    const may = await createBudgetPeriod(s.userId, s.budget, { ...MAY, status: 'closed_pending' });
    const june = await createBudgetPeriod(s.userId, s.budget, { ...JUNE, carryoverIn: '200.00' });
    await spend(s, '2090-05-10', '300.00');
    await decide(may.id, { result: 'surplus', carry: '200.00', discard: '0.00' }, '300.00', '200.00');

    await spend(s, '2090-05-25', '30.00');
    await runHook(s, ['2090-05-25']);

    const adjustments = await adjustmentsOf(s.userId);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.period_id).toBe(june.id);
    expect(adjustments[0]?.source_period_id).toBe(may.id);
    expect(new Decimal(adjustments[0]?.amount ?? '0').toFixed(2)).toBe('-30.00');
  });

  it('RF-M11-11 un exceso decidido con arrastre también recibe el ajuste por tardíos', async () => {
    const s = await setup({ thresholds: [] });
    const may = await createBudgetPeriod(s.userId, s.budget, { ...MAY, status: 'closed_pending' });
    const june = await createBudgetPeriod(s.userId, s.budget, { ...JUNE, carryoverIn: '-100.00' });
    await spend(s, '2090-05-10', '550.00');
    const late = await spend(s, '2090-05-11', '50.00');
    await decide(may.id, { result: 'deficit', mode: 'carry' }, '600.00', '-100.00');

    await deleteSpend(late);
    await runHook(s, ['2090-05-11']);

    const adjustments = await adjustmentsOf(s.userId);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.period_id).toBe(june.id);
    expect(new Decimal(adjustments[0]?.amount ?? '0').toFixed(2)).toBe('50.00');
  });

  it('RF-M11-11 un exceso absorbido no tiene efecto', async () => {
    const s = await setup({ thresholds: [] });
    const may = await createBudgetPeriod(s.userId, s.budget, { ...MAY, status: 'closed_pending' });
    await createBudgetPeriod(s.userId, s.budget, JUNE);
    await spend(s, '2090-05-10', '550.00');
    const late = await spend(s, '2090-05-11', '50.00');
    await decide(may.id, { result: 'deficit', mode: 'absorb' }, '600.00', '-100.00');

    await deleteSpend(late);
    await runHook(s, ['2090-05-11']);

    expect(await adjustmentsOf(s.userId)).toEqual([]);
  });

  it('RF-M11-11 un tardío con la decisión pendiente cambia el resultado mostrado sin crear ajustes', async () => {
    const s = await setup({ thresholds: [] });
    const may = await createBudgetPeriod(s.userId, s.budget, { ...MAY, status: 'closed_pending' });
    await prisma.$executeRaw`
      UPDATE budget_period SET decision_deadline = ${new Date('2090-06-20T12:00:00Z')}::timestamptz
       WHERE id = ${may.id}::uuid`;
    await createBudgetPeriod(s.userId, s.budget, JUNE);
    await spend(s, '2090-05-10', '260.00');
    const late = await spend(s, '2090-05-20', '40.00');
    const ctx: RatesContext = { userId: s.userId, timezone: TZ, now: NOW, traceId: uuidv7() };
    const before = (await budgets.get(ctx, s.budget.id)).pendingClose?.result;

    await deleteSpend(late);
    await runHook(s, ['2090-05-20']);

    const after = (await budgets.get(ctx, s.budget.id)).pendingClose?.result;
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(new Decimal(after ?? '0').minus(before ?? '0').toFixed(2)).toBe('40.00');
    expect(await adjustmentsOf(s.userId)).toEqual([]);
    expect((await periodState(may.id))?.status).toBe('closed_pending');
  });

  it('RF-M11-11 un presupuesto pausado con un cierre decidido con arrastre no recibe ajustes', async () => {
    const s = await setup({ thresholds: [], status: 'paused' });
    const may = await createBudgetPeriod(s.userId, s.budget, { ...MAY, status: 'closed_pending' });
    await spend(s, '2090-05-10', '260.00');
    const late = await spend(s, '2090-05-20', '40.00');
    await decide(may.id, { result: 'surplus', carry: '200.00', discard: '0.00' }, '300.00', '200.00');

    await deleteSpend(late);
    await runHook(s, ['2090-05-20']);

    expect(await adjustmentsOf(s.userId)).toEqual([]);
  });
});
