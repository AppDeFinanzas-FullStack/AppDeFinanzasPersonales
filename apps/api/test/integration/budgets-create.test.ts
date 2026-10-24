import { type BudgetDto, CreateBudgetInput } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createCurrenciesService } from '../../src/application/services/currencies.service.js';
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
import {
  createBudget,
  createBudgetPeriod,
  createSpend,
  deleteBudgetsOf,
  systemCategoryId,
  thresholdHitsOf,
} from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Assumptions (plan §4.11.2 fixes the endpoints, not the service signatures; same shape as the
 * goals service of TASK-185):
 * - `createBudgetsService({ uow, rates, notifications, ids })` gives `create(ctx, input)` ->
 *   `{ created, budget }`, `list(ctx)` -> `BudgetDto[]` and `get(ctx, id)` ->
 *   `BudgetDto & { periods }`, with `periods` the 12 last periods of the budget (`{ id }` at least).
 *   `notifications` is the `NotificationEmitter` (TASK-176); `ids` gives UUID v7 ids.
 * - `input` is the output of `CreateBudgetInput.parse` (defaults applied).
 * - Errors are `AppError`s; a budget of another user is `NOT_FOUND`.
 * - The threshold notice is a `budget_alert` notification (plan §4.11.3) and its
 *   `budget_threshold_hit` row.
 */
interface BudgetDetail extends BudgetDto {
  periods: { id: string }[];
}
interface BudgetsServiceUnderTest {
  create(
    ctx: RatesContext,
    input: CreateBudgetInput,
  ): Promise<{ created: boolean; budget: BudgetDto }>;
  list(ctx: RatesContext): Promise<BudgetDto[]>;
  get(ctx: RatesContext, id: string): Promise<BudgetDetail>;
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

const ids = { next: () => uuidv7() };
const rates = createRatesService({ uow });
const budgets = createBudgetsService({
  uow,
  rates,
  notifications: createNotificationEmitter({ release: '1.1' }),
  ids,
});
const currencies = createCurrenciesService({ uow, ids });

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z');
const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteBudgetsOf(usedUserIds);
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

function budgetInput(overrides: Record<string, unknown> = {}): CreateBudgetInput {
  return CreateBudgetInput.parse({
    id: uuidv7(),
    scope: 'category',
    amount: '100.00',
    currencyCode: 'BOB',
    ...overrides,
  });
}

async function countBudgets(userId: string, id: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM budget WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
  return rows[0]?.n ?? 0;
}

async function periodsOf(budgetId: string): Promise<{ id: string; start: string; end: string }[]> {
  return prisma.$queryRaw<{ id: string; start: string; end: string }[]>`
    SELECT id::text AS id, to_char(start_date, 'YYYY-MM-DD') AS start,
           to_char(end_date, 'YYYY-MM-DD') AS "end"
      FROM budget_period WHERE budget_id = ${budgetId}::uuid ORDER BY start_date`;
}

async function budgetAlertsOf(userId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ eventKey: string }[]>`
    SELECT event_key AS "eventKey" FROM notification
     WHERE user_id = ${userId}::uuid AND type = 'budget_alert'::notification_type
     ORDER BY event_key`;
  return rows.map((row) => row.eventKey);
}

describe('BudgetsService: crear, listar y detalle', () => {
  it('TASK-197 crear es idempotente: dos llamadas con el mismo id dejan una fila', async () => {
    const userId = await newUser();
    const category = await createCategory(userId);
    const input = budgetInput({ categoryId: category.id });

    const first = await budgets.create(ctxFor(userId), input);
    const second = await budgets.create(ctxFor(userId), input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.budget.id).toBe(input.id);
    expect(await countBudgets(userId, input.id)).toBe(1);
    expect(await periodsOf(input.id)).toHaveLength(1);
  });

  it('TASK-197 al crear se abre el período en curso con el gasto del alcance', async () => {
    const userId = await newUser();
    const category = await createCategory(userId);
    const account = await createAccount(userId, {});
    await createSpend(userId, {
      accountId: account.id,
      categoryId: category.id,
      date: '2090-06-10',
      amount: '30.00',
    });
    const input = budgetInput({ categoryId: category.id });

    const { budget } = await budgets.create(ctxFor(userId), input);

    const periods = await periodsOf(input.id);
    expect(periods.map((p) => [p.start, p.end])).toEqual([['2090-06-01', '2090-06-30']]);
    expect(budget.current?.periodId).toBe(periods[0]?.id);
    expect(budget.current?.start).toBe('2090-06-01');
    expect(budget.current?.end).toBe('2090-06-30');
    expect(budget.current?.spent).toBe('30.00');
    const listed = (await budgets.list(ctxFor(userId))).find((b) => b.id === input.id);
    expect(listed?.current?.spent).toBe('30.00');
    expect(listed?.category?.id).toBe(category.id);
  });

  it('RNF-28 el presupuesto 101 da LIMIT_REACHED y no se crea', async () => {
    const userId = await newUser();
    for (let i = 0; i < 100; i += 1) {
      const category = await createCategory(userId);
      await createBudget(userId, { categoryId: category.id });
    }
    const category = await createCategory(userId);
    const input = budgetInput({ categoryId: category.id });

    const error = await rejectionOf(budgets.create(ctxFor(userId), input));

    expect(error.code).toBe('LIMIT_REACHED');
    expect(await countBudgets(userId, input.id)).toBe(0);
  });

  it('EC-M11-06 un segundo presupuesto de la misma categoría da BUDGET_EXISTS con el budgetId del existente', async () => {
    const userId = await newUser();
    const category = await createCategory(userId);
    const existing = await createBudget(userId, { categoryId: category.id });
    const input = budgetInput({ categoryId: category.id });

    const error = await rejectionOf(budgets.create(ctxFor(userId), input));

    expect(error.code).toBe('BUDGET_EXISTS');
    expect(error.status).toBe(409);
    expect(error.data?.['budgetId']).toBe(existing.id);
    expect(await countBudgets(userId, input.id)).toBe(0);
  });

  it('EC-M11-06 un presupuesto pausado de la categoría también impide crear otro', async () => {
    const userId = await newUser();
    const category = await createCategory(userId);
    const existing = await createBudget(userId, { categoryId: category.id, status: 'paused' });

    const error = await rejectionOf(
      budgets.create(ctxFor(userId), budgetInput({ categoryId: category.id })),
    );

    expect(error.code).toBe('BUDGET_EXISTS');
    expect(error.data?.['budgetId']).toBe(existing.id);
  });

  it('RF-M11-01 un segundo presupuesto general da BUDGET_EXISTS', async () => {
    const userId = await newUser();
    const existing = await createBudget(userId, {});

    const error = await rejectionOf(
      budgets.create(ctxFor(userId), budgetInput({ scope: 'general' })),
    );

    expect(error.code).toBe('BUDGET_EXISTS');
    expect(error.data?.['budgetId']).toBe(existing.id);
  });

  it('RF-M11-01 "Deudas y préstamos" da CATEGORY_NOT_BUDGETABLE', async () => {
    const userId = await newUser();
    const debts = await systemCategoryId(userId, 'debts');
    const input = budgetInput({ categoryId: debts });

    const error = await rejectionOf(budgets.create(ctxFor(userId), input));

    expect(error.code).toBe('CATEGORY_NOT_BUDGETABLE');
    expect(error.status).toBe(422);
    expect(await countBudgets(userId, input.id)).toBe(0);
  });

  it('RF-M11-01 "Intereses" se acepta', async () => {
    const userId = await newUser();
    const interest = await systemCategoryId(userId, 'debts_interest');
    const input = budgetInput({ categoryId: interest });

    const result = await budgets.create(ctxFor(userId), input);

    expect(result.created).toBe(true);
    expect(await countBudgets(userId, input.id)).toBe(1);
  });

  it('RF-M11-01 una categoría de ingreso da CATEGORY_NOT_BUDGETABLE', async () => {
    const userId = await newUser();
    const income = await createCategory(userId, { kind: 'income' });

    const error = await rejectionOf(
      budgets.create(ctxFor(userId), budgetInput({ categoryId: income.id })),
    );

    expect(error.code).toBe('CATEGORY_NOT_BUDGETABLE');
  });

  it('RF-M11-01 una categoría archivada da CATEGORY_NOT_BUDGETABLE', async () => {
    const userId = await newUser();
    const archived = await createCategory(userId, { status: 'archived' });

    const error = await rejectionOf(
      budgets.create(ctxFor(userId), budgetInput({ categoryId: archived.id })),
    );

    expect(error.code).toBe('CATEGORY_NOT_BUDGETABLE');
  });

  it('RF-M11-13 si al crearlo ya está en el 120 % se crea un solo aviso, el del 100', async () => {
    const userId = await newUser();
    const category = await createCategory(userId);
    const account = await createAccount(userId, {});
    await createSpend(userId, {
      accountId: account.id,
      categoryId: category.id,
      date: '2090-06-05',
      amount: '120.00',
    });
    const input = budgetInput({ categoryId: category.id, thresholds: [80, 100] });

    await budgets.create(ctxFor(userId), input);

    const [period] = await periodsOf(input.id);
    expect(await thresholdHitsOf(period?.id ?? '')).toEqual([100]);
    const alerts = await budgetAlertsOf(userId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(':100');
  });

  it('RF-M11-13 si al crearlo no llega a ningún umbral no hay aviso', async () => {
    const userId = await newUser();
    const category = await createCategory(userId);
    const account = await createAccount(userId, {});
    await createSpend(userId, {
      accountId: account.id,
      categoryId: category.id,
      date: '2090-06-05',
      amount: '50.00',
    });
    const input = budgetInput({ categoryId: category.id, thresholds: [80, 100] });

    await budgets.create(ctxFor(userId), input);

    const [period] = await periodsOf(input.id);
    expect(await thresholdHitsOf(period?.id ?? '')).toEqual([]);
    expect(await budgetAlertsOf(userId)).toEqual([]);
  });

  it('RF-M11-02 si los hijos suman más que el padre childrenExceedParent es verdadero', async () => {
    const userId = await newUser();
    const parent = await createCategory(userId);
    const childA = await createCategory(userId, { parentId: parent.id });
    const childB = await createCategory(userId, { parentId: parent.id });
    const parentInput = budgetInput({ categoryId: parent.id, amount: '100.00' });
    await budgets.create(ctxFor(userId), parentInput);
    await budgets.create(ctxFor(userId), budgetInput({ categoryId: childA.id, amount: '60.00' }));
    await budgets.create(ctxFor(userId), budgetInput({ categoryId: childB.id, amount: '50.00' }));

    const listed = (await budgets.list(ctxFor(userId))).find((b) => b.id === parentInput.id);
    const detail = await budgets.get(ctxFor(userId), parentInput.id);

    expect(listed?.childrenExceedParent).toBe(true);
    expect(detail.childrenExceedParent).toBe(true);
  });

  it('RF-M11-02 si los hijos no suman más que el padre childrenExceedParent es falso', async () => {
    const userId = await newUser();
    const parent = await createCategory(userId);
    const childA = await createCategory(userId, { parentId: parent.id });
    const childB = await createCategory(userId, { parentId: parent.id });
    const parentInput = budgetInput({ categoryId: parent.id, amount: '100.00' });
    await budgets.create(ctxFor(userId), parentInput);
    await budgets.create(ctxFor(userId), budgetInput({ categoryId: childA.id, amount: '60.00' }));
    await budgets.create(ctxFor(userId), budgetInput({ categoryId: childB.id, amount: '40.00' }));

    const detail = await budgets.get(ctxFor(userId), parentInput.id);

    expect(detail.childrenExceedParent).toBe(false);
  });

  it('RF-M9-06 cada presupuesto guarda sus propios umbrales y acción', async () => {
    const userId = await newUser();
    const first = await createCategory(userId);
    const second = await createCategory(userId);
    const third = await createCategory(userId);
    const a = budgetInput({
      categoryId: first.id,
      thresholds: [50, 90, 120],
      defaultAction: 'carry',
    });
    const b = budgetInput({ categoryId: second.id, thresholds: [], defaultAction: 'discard' });
    const c = budgetInput({ categoryId: third.id });
    await budgets.create(ctxFor(userId), a);
    await budgets.create(ctxFor(userId), b);
    await budgets.create(ctxFor(userId), c);

    const da = await budgets.get(ctxFor(userId), a.id);
    const db = await budgets.get(ctxFor(userId), b.id);
    const dc = await budgets.get(ctxFor(userId), c.id);

    expect(da.thresholds).toEqual([50, 90, 120]);
    expect(da.defaultAction).toBe('carry');
    expect(db.thresholds).toEqual([]);
    expect(db.defaultAction).toBe('discard');
    expect(dc.thresholds).toEqual([80, 100]);
    expect(dc.defaultAction).toBe('discard');
  });

  it('TASK-197 el detalle trae los 12 últimos períodos', async () => {
    const userId = await newUser();
    const category = await createCategory(userId);
    const budget = await createBudget(userId, { categoryId: category.id });
    const created: string[] = [];
    for (let m = 0; m < 14; m += 1) {
      const year = 2089 + Math.floor((4 + m) / 12);
      const month = ((4 + m) % 12) + 1;
      const mm = String(month).padStart(2, '0');
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const period = await createBudgetPeriod(userId, budget, {
        startDate: `${year}-${mm}-01`,
        endDate: `${year}-${mm}-${String(last).padStart(2, '0')}`,
        status: m === 13 ? 'open' : 'decided',
      });
      created.push(period.id);
    }

    const detail = await budgets.get(ctxFor(userId), budget.id);

    expect(detail.periods).toHaveLength(12);
    expect(new Set(detail.periods.map((p) => p.id))).toEqual(new Set(created.slice(2)));
    expect(detail.current?.periodId).toBe(created[13]);
  });

  it('RN-09 un usuario no ve ni lee los presupuestos de otro', async () => {
    const owner = await newUser();
    const other = await newUser();
    const category = await createCategory(owner);
    const budget = await createBudget(owner, { categoryId: category.id });

    const error = await rejectionOf(budgets.get(ctxFor(other), budget.id));

    expect(error.code).toBe('NOT_FOUND');
    expect((await budgets.list(ctxFor(other))).map((b) => b.id)).not.toContain(budget.id);
    expect((await budgets.list(ctxFor(owner))).map((b) => b.id)).toContain(budget.id);
  });

  it('EC-M3-05 desactivar la moneda de un presupuesto activo o pausado da CURRENCY_IN_USE con budgets', async () => {
    for (const status of ['active', 'paused'] as const) {
      const userId = await newUser();
      await currencies.create(
        { userId, timezone: TZ, now: NOW },
        { code: 'EUR', symbol: 'EUR', rate: new Decimal('7.50') },
      );
      const category = await createCategory(userId);
      await createBudget(userId, { categoryId: category.id, currencyCode: 'EUR', status });

      const error = await rejectionOf(
        currencies.deactivate({ userId, timezone: TZ, now: NOW }, 'EUR'),
      );

      expect(error.code).toBe('CURRENCY_IN_USE');
      expect(error.data?.['usedBy']).toContain('budgets');
    }
  });

  it('EC-M3-05 un presupuesto finalizado no impide desactivar su moneda', async () => {
    const userId = await newUser();
    await currencies.create(
      { userId, timezone: TZ, now: NOW },
      { code: 'EUR', symbol: 'EUR', rate: new Decimal('7.50') },
    );
    const category = await createCategory(userId);
    await createBudget(userId, {
      categoryId: category.id,
      currencyCode: 'EUR',
      status: 'finalized',
    });

    await currencies.deactivate({ userId, timezone: TZ, now: NOW }, 'EUR');

    const rows = await prisma.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM currency
       WHERE user_id = ${userId}::uuid AND code = 'EUR'`;
    expect(rows[0]?.status).toBe('inactive');
  });
});
