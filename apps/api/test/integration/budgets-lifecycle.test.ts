import { type BudgetDto, CreateBudgetInput, UpdateBudgetInput } from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import {
  createRatesService,
  type RatesContext,
} from '../../src/application/services/rates.service.js';
import { createNotificationEmitter } from '../../src/application/shared/notification-emitter.js';
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
import { createBudgetPeriod, createSpend, deleteBudgetsOf } from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Assumptions (plan §4.11.2 fixes the endpoints, not the service signatures; same shape as the
 * goals service and the create/list/detail of TASK-197):
 * - `createBudgetsService({ uow, rates, notifications, ids })` also gives
 *   `update(ctx, id, input)` -> `BudgetDto` (PATCH), `pause(ctx, id)`, `resume(ctx, id)`,
 *   `resetCarryover(ctx, id)` and `remove(ctx, id)` (DELETE).
 * - `input` of `update` is the output of `UpdateBudgetInput.parse`.
 * - The end of the stretched period (RF-M11-07) is `current.end` of the returned `BudgetDto`.
 * - Errors are `AppError`s; a budget of another user is `NOT_FOUND`.
 * - The decision notice of a closed period is a notification with `decision_kind = 'budget_period'`
 *   and `decision_ref` = the period id.
 */
interface BudgetDetail extends BudgetDto {
  periods: { id: string; start: string; end: string; amount: string; carryoverIn: string }[];
}
interface BudgetsServiceUnderTest {
  create(
    ctx: RatesContext,
    input: CreateBudgetInput,
  ): Promise<{ created: boolean; budget: BudgetDto }>;
  list(ctx: RatesContext): Promise<BudgetDto[]>;
  get(ctx: RatesContext, id: string): Promise<BudgetDetail>;
  update(ctx: RatesContext, id: string, input: UpdateBudgetInput): Promise<BudgetDto>;
  pause(ctx: RatesContext, id: string): Promise<unknown>;
  resume(ctx: RatesContext, id: string): Promise<unknown>;
  resetCarryover(ctx: RatesContext, id: string): Promise<unknown>;
  remove(ctx: RatesContext, id: string): Promise<unknown>;
}
type CreateBudgetsService = (deps: {
  uow: UnitOfWork;
  rates: ReturnType<typeof createRatesService>;
  notifications: ReturnType<typeof createNotificationEmitter>;
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

const budgets = createBudgetsService({
  uow,
  rates: createRatesService({ uow }),
  notifications: createNotificationEmitter({ release: '1.1' }),
  ids: { next: () => uuidv7() },
});

const TZ = 'America/La_Paz';
/** Today is 2090-06-15 in La Paz: the period in course of a budget from day 1 is June. */
const NOW = new Date('2090-06-15T16:00:00Z');
const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteBudgetsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

const ctxFor = (userId: string, now: Date = NOW): RatesContext => ({
  userId,
  timezone: TZ,
  now,
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

/** A category budget of 500.00 BOB from day 1, created by the service with its June period. */
async function newBudget(
  userId: string,
  now: Date = NOW,
): Promise<{ id: string; categoryId: string }> {
  const category = await createCategory(userId);
  const input = CreateBudgetInput.parse({
    id: uuidv7(),
    scope: 'category',
    categoryId: category.id,
    amount: '500.00',
    currencyCode: 'BOB',
  });
  await budgets.create(ctxFor(userId, now), input);
  return { id: input.id, categoryId: category.id };
}

interface PeriodRow {
  id: string;
  start: string;
  end: string;
  amount: string;
  carryoverIn: string;
  status: string;
}

async function periodsOf(budgetId: string): Promise<PeriodRow[]> {
  return prisma.$queryRaw<PeriodRow[]>`
    SELECT id::text AS id, to_char(start_date, 'YYYY-MM-DD') AS start,
           to_char(end_date, 'YYYY-MM-DD') AS "end", amount::text AS amount,
           carryover_in::text AS "carryoverIn", status::text AS status
      FROM budget_period WHERE budget_id = ${budgetId}::uuid ORDER BY start_date`;
}

async function openPeriodOf(budgetId: string): Promise<PeriodRow> {
  const open = (await periodsOf(budgetId)).find((p) => p.status === 'open');
  if (open === undefined) {
    throw new Error('The budget has no open period');
  }
  return open;
}

interface BudgetRowView {
  status: string;
  nextStartDay: number | null;
  frozenCarryover: string | null;
}

async function budgetRow(budgetId: string): Promise<BudgetRowView | null> {
  const rows = await prisma.$queryRaw<BudgetRowView[]>`
    SELECT status::text AS status, next_start_day::int AS "nextStartDay",
           frozen_carryover::text AS "frozenCarryover"
      FROM budget WHERE id = ${budgetId}::uuid`;
  return rows[0] ?? null;
}

async function setCarryover(periodId: string, value: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE budget_period SET carryover_in = ${value}::numeric WHERE id = ${periodId}::uuid`;
}

async function insertLateAdjustment(
  userId: string,
  periodId: string,
  sourcePeriodId: string,
  amount: string,
): Promise<string> {
  const id = uuidv7();
  await prisma.$executeRaw`
    INSERT INTO budget_late_adjustment (id, user_id, period_id, source_period_id, amount)
    VALUES (${id}::uuid, ${userId}::uuid, ${periodId}::uuid, ${sourcePeriodId}::uuid,
            ${amount}::numeric)`;
  return id;
}

async function insertDecisionNotice(userId: string, periodId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO notification (id, user_id, type, event_key, params, target_route, decision_kind,
                              decision_ref, decision_status)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, 'period_close'::notification_type,
            ${'period_close:' + periodId}, '{}'::jsonb, '/presupuestos', 'budget_period',
            ${periodId}::uuid, 'waiting'::decision_status)`;
}

async function decisionStatusOf(userId: string, periodId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ status: string | null }[]>`
    SELECT decision_status::text AS status FROM notification
     WHERE user_id = ${userId}::uuid AND decision_ref = ${periodId}::uuid`;
  return rows[0]?.status ?? null;
}

describe('BudgetsService: editar, pausar, reanudar, reiniciar el arrastre y eliminar', () => {
  it('RF-M11-06 cambiar el monto afecta el período en curso y no los pasados', async () => {
    const userId = await newUser();
    const { id } = await newBudget(userId);
    const past = await createBudgetPeriod(
      userId,
      { id, amount: '500.00' },
      { startDate: '2090-05-01', endDate: '2090-05-31', status: 'decided' },
    );

    const updated = await budgets.update(
      ctxFor(userId),
      id,
      UpdateBudgetInput.parse({ amount: '800.00' }),
    );

    expect(updated.amount).toBe('800.00');
    expect(updated.current?.available).toBe('800.00');
    const periods = await periodsOf(id);
    expect(periods.find((p) => p.id === past.id)?.amount).toBe('500.00');
    expect((await openPeriodOf(id)).amount).toBe('800.00');
  });

  it('RF-M11-06 la acción por defecto y los umbrales se aplican al editarlos', async () => {
    const userId = await newUser();
    const { id } = await newBudget(userId);

    const updated = await budgets.update(
      ctxFor(userId),
      id,
      UpdateBudgetInput.parse({ defaultAction: 'carry', thresholds: [100, 50] }),
    );

    expect(updated.defaultAction).toBe('carry');
    expect(updated.thresholds).toEqual([50, 100]);
    const detail = await budgets.get(ctxFor(userId), id);
    expect(detail.defaultAction).toBe('carry');
    expect(detail.thresholds).toEqual([50, 100]);
  });

  it('RF-M11-07 cambiar el día de inicio devuelve la fecha de fin del período alargado', async () => {
    const userId = await newUser();
    const { id } = await newBudget(userId);

    const updated = await budgets.update(
      ctxFor(userId),
      id,
      UpdateBudgetInput.parse({ startDay: 15 }),
    );

    expect(updated.startDay).toBe(1);
    expect(updated.nextStartDay).toBe(15);
    expect(updated.current?.start).toBe('2090-06-01');
    expect(updated.current?.end).toBe('2090-07-14');
    expect((await budgetRow(id))?.nextStartDay).toBe(15);
  });

  it('RF-M11-07 con hoy antes del nuevo día de inicio, el período en curso se alarga y no se acorta', async () => {
    /** 2090-06-10 in La Paz: before day 15 inside the June period of a budget from day 1. */
    const before = new Date('2090-06-10T16:00:00Z');
    const userId = await newUser();
    const { id } = await newBudget(userId, before);

    const updated = await budgets.update(
      ctxFor(userId, before),
      id,
      UpdateBudgetInput.parse({ startDay: 15 }),
    );

    expect(updated.startDay).toBe(1);
    expect(updated.nextStartDay).toBe(15);
    expect(updated.current?.start).toBe('2090-06-01');
    expect(updated.current?.end).toBe('2090-07-14');
    const open = await openPeriodOf(id);
    expect([open.start, open.end]).toEqual(['2090-06-01', '2090-07-14']);
    expect((await periodsOf(id)).filter((p) => p.status === 'open')).toHaveLength(1);
  });

  it('RF-M11-07 el período alargado conserva el monto de un mes', async () => {
    const userId = await newUser();
    const { id } = await newBudget(userId);

    const updated = await budgets.update(
      ctxFor(userId),
      id,
      UpdateBudgetInput.parse({ startDay: 15 }),
    );

    expect(updated.amount).toBe('500.00');
    expect(updated.current?.available).toBe('500.00');
  });

  it('TASK-198 pausar congela el arrastre vigente y elimina el período en curso sin decisión', async () => {
    const userId = await newUser();
    const { id } = await newBudget(userId);
    const open = await openPeriodOf(id);
    await setCarryover(open.id, '40.00');

    await budgets.pause(ctxFor(userId), id);

    const row = await budgetRow(id);
    expect(row?.status).toBe('paused');
    expect(row?.frozenCarryover).toBe('40.00');
    expect((await periodsOf(id)).some((p) => p.status === 'open')).toBe(false);
  });

  it('TASK-198 pausar conserva un período cerrado que espera su decisión', async () => {
    const userId = await newUser();
    const { id } = await newBudget(userId);
    const pending = await createBudgetPeriod(
      userId,
      { id, amount: '500.00' },
      { startDate: '2090-05-01', endDate: '2090-05-31', status: 'closed_pending' },
    );

    await budgets.pause(ctxFor(userId), id);

    const periods = await periodsOf(id);
    expect(periods.map((p) => p.id)).toEqual([pending.id]);
    expect(periods[0]?.status).toBe('closed_pending');
  });

  it('EC-M11-08 al reanudar a mitad de período el gasto cuenta desde el inicio, con el arrastre congelado', async () => {
    const userId = await newUser();
    const { id, categoryId } = await newBudget(userId);
    const open = await openPeriodOf(id);
    await setCarryover(open.id, '40.00');
    await budgets.pause(ctxFor(userId), id);
    const account = await createAccount(userId, {});
    await createSpend(userId, {
      accountId: account.id,
      categoryId,
      date: '2090-06-03',
      amount: '30.00',
    });

    await budgets.resume(ctxFor(userId), id);

    expect((await budgetRow(id))?.status).toBe('active');
    const resumed = await openPeriodOf(id);
    expect([resumed.start, resumed.end]).toEqual(['2090-06-01', '2090-06-30']);
    expect(resumed.carryoverIn).toBe('40.00');
    const detail = await budgets.get(ctxFor(userId), id);
    expect(detail.status).toBe('active');
    expect(detail.current?.periodId).toBe(resumed.id);
    expect(detail.current?.spent).toBe('30.00');
    expect(detail.current?.carryover).toBe('40.00');
    expect(detail.current?.available).toBe('540.00');
  });

  it('RF-M11-12 reiniciar deja el arrastre en 0 y anula los ajustes tardíos', async () => {
    const userId = await newUser();
    const { id } = await newBudget(userId);
    const past = await createBudgetPeriod(
      userId,
      { id, amount: '500.00' },
      { startDate: '2090-05-01', endDate: '2090-05-31', status: 'decided' },
    );
    const open = await openPeriodOf(id);
    await setCarryover(open.id, '75.00');
    const adjustment = await insertLateAdjustment(userId, open.id, past.id, '20.00');

    await budgets.resetCarryover(ctxFor(userId), id);

    expect((await openPeriodOf(id)).carryoverIn).toBe('0.00');
    const rows = await prisma.$queryRaw<{ voided: boolean }[]>`
      SELECT voided_at IS NOT NULL AS voided FROM budget_late_adjustment
       WHERE id = ${adjustment}::uuid`;
    expect(rows[0]?.voided).toBe(true);
    const detail = await budgets.get(ctxFor(userId), id);
    expect(detail.current?.carryover).toBe('0.00');
    expect(detail.current?.lateAdjustments).toEqual([]);
    expect(detail.current?.available).toBe('500.00');
  });

  it('TASK-198 pausar un presupuesto ya pausado da INVALID_STATE', async () => {
    const userId = await newUser();
    const { id } = await newBudget(userId);
    await budgets.pause(ctxFor(userId), id);

    const error = await rejectionOf(budgets.pause(ctxFor(userId), id));

    expect(error.code).toBe('INVALID_STATE');
    expect(error.status).toBe(409);
  });

  it('TASK-198 reanudar un presupuesto activo da INVALID_STATE', async () => {
    const userId = await newUser();
    const { id } = await newBudget(userId);

    const error = await rejectionOf(budgets.resume(ctxFor(userId), id));

    expect(error.code).toBe('INVALID_STATE');
    expect(error.status).toBe(409);
    expect((await periodsOf(id)).filter((p) => p.status === 'open')).toHaveLength(1);
  });

  it('TASK-198 eliminar borra el presupuesto con su historia y resuelve sus avisos de decisión', async () => {
    const userId = await newUser();
    const { id } = await newBudget(userId);
    const pending = await createBudgetPeriod(
      userId,
      { id, amount: '500.00' },
      { startDate: '2090-05-01', endDate: '2090-05-31', status: 'closed_pending' },
    );
    await insertDecisionNotice(userId, pending.id);

    await budgets.remove(ctxFor(userId), id);

    expect(await budgetRow(id)).toBeNull();
    expect(await periodsOf(id)).toEqual([]);
    expect(await decisionStatusOf(userId, pending.id)).toBe('resolved');
    expect((await budgets.list(ctxFor(userId))).map((b) => b.id)).not.toContain(id);
  });

  it('RN-09 un usuario no edita, pausa ni elimina el presupuesto de otro', async () => {
    const owner = await newUser();
    const other = await newUser();
    const { id } = await newBudget(owner);

    const updateError = await rejectionOf(
      budgets.update(ctxFor(other), id, UpdateBudgetInput.parse({ amount: '1.00' })),
    );
    const pauseError = await rejectionOf(budgets.pause(ctxFor(other), id));
    const removeError = await rejectionOf(budgets.remove(ctxFor(other), id));

    expect(updateError.code).toBe('NOT_FOUND');
    expect(pauseError.code).toBe('NOT_FOUND');
    expect(removeError.code).toBe('NOT_FOUND');
    expect((await budgetRow(id))?.status).toBe('active');
    expect((await openPeriodOf(id)).amount).toBe('500.00');
  });
});
