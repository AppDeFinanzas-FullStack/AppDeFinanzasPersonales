import type { CreateGoalInput, GoalDto, UpdateGoalInput } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { GoalHistoryItem } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createAccountsService } from '../../src/application/services/accounts.service.js';
import { createCurrenciesService } from '../../src/application/services/currencies.service.js';
import {
  createRatesService,
  type RatesContext,
} from '../../src/application/services/rates.service.js';
import { createLedgerHooks } from '../../src/application/shared/ledger-hooks.js';
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
 * - `createGoalsService({ uow, rates })` gives `create(ctx, input)` -> `{ created, goal }`,
 *   `update(ctx, id, input)` -> `GoalDto`, `list(ctx)` -> `GoalDto[]` (active goals) and
 *   `get(ctx, id)` -> `GoalDto & { history }`, with `history` the items of
 *   `goalAllocations.history` (`accountId`, `amount` as `Decimal`, `origin`).
 * - Errors are `AppError`s; a goal of another user is `NOT_FOUND`.
 * - `suggested.amount` and `progress` are decimal text with two decimals; `pct` is a number.
 * - The history labels the ledger entries of an adjustment on the dedicated account `adjustment`.
 */
interface GoalDetail extends GoalDto {
  history: GoalHistoryItem[];
}
interface GoalsServiceUnderTest {
  create(ctx: RatesContext, input: CreateGoalInput): Promise<{ created: boolean; goal: GoalDto }>;
  update(ctx: RatesContext, id: string, input: UpdateGoalInput): Promise<GoalDto>;
  list(ctx: RatesContext): Promise<GoalDto[]>;
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
const accounts = createAccountsService({ uow, rates, ledgerHooks: createLedgerHooks() });
const currencies = createCurrenciesService({ uow, ids: { next: () => uuidv7() } });

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

function goalInput(overrides: Partial<CreateGoalInput> = {}): CreateGoalInput {
  return {
    id: uuidv7(),
    name: `Meta ${uuidv7().slice(-8)}`,
    target: '1000.00',
    currencyCode: 'BOB',
    icon: 'target',
    color: 'blue',
    ...overrides,
  } as CreateGoalInput;
}

async function countGoals(userId: string, id: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM goal WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
  return rows[0]?.n ?? 0;
}

async function setTargetDate(goalId: string, date: string): Promise<void> {
  await prisma.$executeRaw`UPDATE goal SET target_date = ${date}::date WHERE id = ${goalId}::uuid`;
}

/** A goal of 1.000 with a dedicated bank of `dedicated` and `earmarked` apart in another bank. */
async function goalWithProgress(
  userId: string,
  dedicated: string,
  earmarked: string,
): Promise<{ goalId: string; dedicatedId: string; otherId: string }> {
  const dedicatedAccount = await createAccount(userId, {
    initialBalance: dedicated,
    initialBalanceDate: '2090-01-01',
  });
  const other = await createAccount(userId, {
    initialBalance: '500.00',
    initialBalanceDate: '2090-01-01',
  });
  const goal = await createGoal(userId, { dedicatedAccountId: dedicatedAccount.id });
  if (new Decimal(earmarked).gt(0)) {
    await createAllocationEvent(userId, goal.id, other.id, { amount: earmarked });
  }
  return { goalId: goal.id, dedicatedId: dedicatedAccount.id, otherId: other.id };
}

describe('GoalsService: crear, editar, listar y detalle', () => {
  it('RF-M12-01 crear una meta es idempotente: dos POST con el mismo id dejan una fila', async () => {
    const userId = await newUser();
    const input = goalInput();

    const first = await goals.create(ctxFor(userId), input);
    const second = await goals.create(ctxFor(userId), input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await countGoals(userId, input.id)).toBe(1);
  });

  it('RNF-28 la meta 51 da LIMIT_REACHED y no se crea', async () => {
    const userId = await newUser();
    for (let i = 0; i < 50; i += 1) {
      await createGoal(userId, {});
    }
    const input = goalInput();

    const error = await rejectionOf(goals.create(ctxFor(userId), input));

    expect(error.code).toBe('LIMIT_REACHED');
    expect(await countGoals(userId, input.id)).toBe(0);
  });

  it('RF-M12-01 una fecha objetivo pasada al editar da TARGET_DATE_IN_PAST', async () => {
    const userId = await newUser();
    const goal = await createGoal(userId, {});

    const error = await rejectionOf(
      goals.update(ctxFor(userId), goal.id, { targetDate: '2090-06-14' }),
    );

    expect(error.code).toBe('TARGET_DATE_IN_PAST');
    expect(error.status).toBe(422);
  });

  it('RF-M12-01 una fecha objetivo de hoy se acepta y el nombre se edita', async () => {
    const userId = await newUser();
    const goal = await createGoal(userId, {});

    const updated = await goals.update(ctxFor(userId), goal.id, {
      targetDate: '2090-06-15',
      name: 'Viaje',
    });

    expect(updated.name).toBe('Viaje');
    expect(updated.targetDate).toBe('2090-06-15');
  });

  it('RF-M12-01 al crear una meta que dedica una tarjeta da ACCOUNT_NOT_DEDICABLE', async () => {
    const userId = await newUser();
    const card = await createAccount(userId, {
      type: 'credit_card',
      cardCutDay: 1,
      cardPayDay: 10,
      cardLimit: '1000.00',
    });
    const input = goalInput({ dedicatedAccountId: card.id });

    const error = await rejectionOf(goals.create(ctxFor(userId), input));

    expect(error.code).toBe('ACCOUNT_NOT_DEDICABLE');
    expect(await countGoals(userId, input.id)).toBe(0);
  });

  it('RF-M12-01 al crear una meta que dedica una cuenta ya dedicada da ACCOUNT_ALREADY_DEDICATED', async () => {
    const userId = await newUser();
    const account = await createAccount(userId, {});
    await createGoal(userId, { dedicatedAccountId: account.id });

    const error = await rejectionOf(
      goals.create(ctxFor(userId), goalInput({ dedicatedAccountId: account.id })),
    );

    expect(error.code).toBe('ACCOUNT_ALREADY_DEDICATED');
    expect(error.status).toBe(409);
  });

  it('RF-M12-01 al crear una meta que dedica una cuenta con apartados de otra meta da ACCOUNT_HAS_OTHER_EARMARKS', async () => {
    const userId = await newUser();
    const account = await createAccount(userId, {
      initialBalance: '300.00',
      initialBalanceDate: '2090-01-01',
    });
    const other = await createGoal(userId, {});
    await createAllocationEvent(userId, other.id, account.id, { amount: '50.00' });

    const error = await rejectionOf(
      goals.create(ctxFor(userId), goalInput({ dedicatedAccountId: account.id })),
    );

    expect(error.code).toBe('ACCOUNT_HAS_OTHER_EARMARKS');
    expect(error.status).toBe(409);
  });

  it('RF-M12-01 crear una meta con una cuenta dedicada válida la deja dedicada', async () => {
    const userId = await newUser();
    const account = await createAccount(userId, {});
    const input = goalInput({ dedicatedAccountId: account.id });

    await goals.create(ctxFor(userId), input);
    const detail = await goals.get(ctxFor(userId), input.id);

    expect(detail.dedicatedAccount?.id).toBe(account.id);
  });

  it('RF-M12-02 el progreso suma el saldo de la dedicada y los apartados en otras cuentas', async () => {
    const userId = await newUser();
    const s = await goalWithProgress(userId, '500.00', '100.00');

    const detail = await goals.get(ctxFor(userId), s.goalId);
    const listed = (await goals.list(ctxFor(userId))).find((g) => g.id === s.goalId);

    expect(detail.progress).toBe('600.00');
    expect(detail.pct).toBe(60);
    expect(detail.status).toBe('in_progress');
    expect(listed?.progress).toBe('600.00');
    const byAccount = Object.fromEntries(
      detail.byAccount.map((row) => [row.accountId, row.amount]),
    );
    expect(byAccount[s.dedicatedId]).toBe('500.00');
    expect(byAccount[s.otherId]).toBe('100.00');
    expect(detail.byAccount.find((row) => row.accountId === s.dedicatedId)?.dedicated).toBe(true);
  });

  it('RF-M12-02 una meta sin cuenta ni apartados tiene progreso 0.00', async () => {
    const userId = await newUser();
    const goal = await createGoal(userId, {});

    const detail = await goals.get(ctxFor(userId), goal.id);

    expect(detail.progress).toBe('0.00');
    expect(detail.byAccount).toEqual([]);
  });

  it('RF-M12-02 con el progreso en el objetivo la meta está lograda', async () => {
    const userId = await newUser();
    const s = await goalWithProgress(userId, '900.00', '100.00');

    const detail = await goals.get(ctxFor(userId), s.goalId);

    expect(detail.status).toBe('achieved');
    expect(detail.suggested.kind).toBe('none');
  });

  it('RF-M12-06 el sugerido es lo que falta entre los meses restantes, incluido el actual', async () => {
    const userId = await newUser();
    const s = await goalWithProgress(userId, '500.00', '100.00');
    await setTargetDate(s.goalId, '2090-08-31');

    const detail = await goals.get(ctxFor(userId), s.goalId);

    expect(detail.suggested.kind).toBe('monthly');
    expect(detail.suggested.amount).toBe('133.33');
  });

  it('RF-M12-06 si la fecha es este mes muestra lo que falta este mes', async () => {
    const userId = await newUser();
    const s = await goalWithProgress(userId, '500.00', '100.00');
    await setTargetDate(s.goalId, '2090-06-30');

    const detail = await goals.get(ctxFor(userId), s.goalId);

    expect(detail.suggested.kind).toBe('this_month');
    expect(detail.suggested.amount).toBe('400.00');
  });

  it('RF-M12-06 sin fecha ofrece la calculadora', async () => {
    const userId = await newUser();
    const goal = await createGoal(userId, {});

    const detail = await goals.get(ctxFor(userId), goal.id);

    expect(detail.suggested.kind).toBe('calculator');
  });

  it('RF-M12-06 una meta vencida pide elegir una nueva fecha', async () => {
    const userId = await newUser();
    const s = await goalWithProgress(userId, '500.00', '0.00');
    await setTargetDate(s.goalId, '2090-05-31');

    const detail = await goals.get(ctxFor(userId), s.goalId);

    expect(detail.status).toBe('overdue');
    expect(detail.suggested.kind).toBe('pick_new_date');
  });

  it('RF-M12-07 el detalle trae el historial con el origen de cada apartado', async () => {
    const userId = await newUser();
    const s = await goalWithProgress(userId, '0.00', '0.00');
    await createAllocationEvent(userId, s.goalId, s.otherId, { amount: '100.00', origin: 'manual' });
    await createAllocationEvent(userId, s.goalId, s.otherId, {
      amount: '-30.00',
      origin: 'confirmed_spend',
    });

    const detail = await goals.get(ctxFor(userId), s.goalId);

    const view = detail.history.map((item) => `${item.origin}:${item.amount.toFixed(2)}`).sort();
    expect(view).toEqual(['confirmed_spend:-30.00', 'manual:100.00']);
  });

  it('RF-M4-05 un ajuste en la dedicada aparece en el historial con el origen ajuste y cambia el progreso', async () => {
    const userId = await newUser();
    const s = await goalWithProgress(userId, '500.00', '0.00');
    expect((await goals.get(ctxFor(userId), s.goalId)).progress).toBe('500.00');

    await accounts.adjust(ctxFor(userId), s.dedicatedId, {
      transactionId: uuidv7(),
      realBalance: '300.00',
    });

    const detail = await goals.get(ctxFor(userId), s.goalId);
    expect(detail.progress).toBe('300.00');
    const adjustment = detail.history.filter((item) => item.origin === 'adjustment');
    expect(adjustment.map((item) => item.amount.toFixed(2))).toEqual(['-200.00']);
    expect(adjustment[0]?.accountId).toBe(s.dedicatedId);
  });

  it('RN-09 un usuario no ve ni lee las metas de otro', async () => {
    const owner = await newUser();
    const other = await newUser();
    const goal = await createGoal(owner, {});

    const error = await rejectionOf(goals.get(ctxFor(other), goal.id));
    const updateError = await rejectionOf(
      goals.update(ctxFor(other), goal.id, { name: 'Ajena' }),
    );

    expect(error.code).toBe('NOT_FOUND');
    expect(updateError.code).toBe('NOT_FOUND');
    expect((await goals.list(ctxFor(other))).map((g) => g.id)).not.toContain(goal.id);
    expect((await goals.list(ctxFor(owner))).map((g) => g.id)).toContain(goal.id);
  });

  it('EC-M3-05 desactivar la moneda de una meta da CURRENCY_IN_USE con goals', async () => {
    const userId = await newUser();
    await currencies.create(
      { userId, timezone: TZ, now: NOW },
      { code: 'EUR', symbol: 'EUR', rate: new Decimal('7.50') },
    );
    await createGoal(userId, { currencyCode: 'EUR' });

    const error = await rejectionOf(
      currencies.deactivate({ userId, timezone: TZ, now: NOW }, 'EUR'),
    );

    expect(error.code).toBe('CURRENCY_IN_USE');
    expect(error.data?.['usedBy']).toContain('goals');
  });

  it('EC-M3-05 una meta archivada no impide desactivar su moneda', async () => {
    const userId = await newUser();
    await currencies.create(
      { userId, timezone: TZ, now: NOW },
      { code: 'EUR', symbol: 'EUR', rate: new Decimal('7.50') },
    );
    const goal = await createGoal(userId, { currencyCode: 'EUR' });
    await prisma.$executeRaw`UPDATE goal SET archived_at = now() WHERE id = ${goal.id}::uuid`;

    await currencies.deactivate({ userId, timezone: TZ, now: NOW }, 'EUR');

    const rows = await prisma.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM currency
       WHERE user_id = ${userId}::uuid AND code = 'EUR'`;
    expect(rows[0]?.status).toBe('inactive');
  });
});
