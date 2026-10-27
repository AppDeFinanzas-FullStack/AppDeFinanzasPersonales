import type { CreateCategoryInput, Step3Input } from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import {
  createAccountsService,
  type AccountsService,
} from '../../src/application/services/accounts.service.js';
import {
  createCategoriesService,
  type CategoriesService,
} from '../../src/application/services/categories.service.js';
import {
  createRatesService,
  type RatesService,
} from '../../src/application/services/rates.service.js';
import { createLedgerHooks } from '../../src/application/shared/ledger-hooks.js';
import { createAccountRepository } from '../../src/infrastructure/persistence/repositories/account.repository.js';
import { createCategoryRepository } from '../../src/infrastructure/persistence/repositories/category.repository.js';
import { createCurrencyRepository } from '../../src/infrastructure/persistence/repositories/currency.repository.js';
import { createDashboardRepository } from '../../src/infrastructure/persistence/repositories/dashboard.repository.js';
import { createEmailLinkRepository } from '../../src/infrastructure/persistence/repositories/email-link.repository.js';
import { createEmailOutboxRepository } from '../../src/infrastructure/persistence/repositories/email-outbox.repository.js';
import { createEmailSendLogRepository } from '../../src/infrastructure/persistence/repositories/email-send-log.repository.js';
import { createExportRepository } from '../../src/infrastructure/persistence/repositories/export.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createLoginThrottleRepository } from '../../src/infrastructure/persistence/repositories/login-throttle.repository.js';
import { createMarketRateRepository } from '../../src/infrastructure/persistence/repositories/market-rate.repository.js';
import { createShortcutRepository } from '../../src/infrastructure/persistence/repositories/shortcut.repository.js';
import { createUndoActionRepository } from '../../src/infrastructure/persistence/repositories/undo-action.repository.js';
import { createUserFxEventRepository } from '../../src/infrastructure/persistence/repositories/user-fx-event.repository.js';
import { createUserSettingsRepository } from '../../src/infrastructure/persistence/repositories/user-settings.repository.js';
import { createUserRepository } from '../../src/infrastructure/persistence/repositories/user.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `POST /api/onboarding/step3` with its errors (plan §4.10.2), the lifecycle
 * (plan §4.10.3), the contract `Step3Input` (plan §4.10.1) and the seed (plan §4.5.3), but not how
 * the service is built. These tests assume, like those of TASK-156 and TASK-157:
 * - `createOnboardingService({ uow, rates, accounts, categories })` builds it over the `UnitOfWork`,
 *   the `RatesService`, the `AccountsService` and the `CategoriesService`. Those are the deps of
 *   TASK-157 plus `categories`; an implementation that does not need one ignores it. The
 *   `UnitOfWork` of this file builds every repository of the composition root.
 * - `step3(ctx, Step3Input)` takes the request context `{ userId, timezone, now, traceId }`
 *   (plan §1.4) and the input already parsed by the controller.
 * - The value `step3` resolves to is not checked: the tests read `category` and `user_settings`
 *   back.
 * - A rejection is an `AppError` (ADR-09): `SYSTEM_CATEGORY`, `STEP_MISMATCH` with
 *   `data = { currentStep }`, or `ONBOARDING_DONE` once `onboarding_completed_at` is set. A
 *   rejected step 3 removes and creates nothing and leaves the Onboarding in step 3, not finished.
 * - The categories of a new user are the preset and system ones of the seed (`createUser` runs
 *   `bootstrapUser`), so the tests find them by kind and name.
 */
interface OnboardingContext {
  userId: string;
  timezone: string;
  now: Date;
  traceId: string;
}

interface OnboardingServiceUnderTest {
  get(ctx: OnboardingContext): Promise<unknown>;
  step3(ctx: OnboardingContext, input: Step3Input): Promise<unknown>;
}

type CreateOnboardingService = (deps: {
  uow: UnitOfWork;
  rates: RatesService;
  accounts: AccountsService;
  categories: CategoriesService;
}) => OnboardingServiceUnderTest;

const { createOnboardingService } =
  (await import('../../src/application/services/onboarding.service.js')) as unknown as {
    createOnboardingService: CreateOnboardingService;
  };

const NIL_USER = '00000000-0000-0000-0000-000000000000';
const prisma = testPrisma();

const uow: UnitOfWork = createUnitOfWork(prisma, (tx, userId) => ({
  emailOutbox: createEmailOutboxRepository(tx),
  emailLinks: createEmailLinkRepository(tx),
  emailSendLog: createEmailSendLogRepository(tx),
  loginThrottle: createLoginThrottleRepository(tx),
  users: createUserRepository(tx),
  marketRates: createMarketRateRepository(tx),
  currencies: createCurrencyRepository(tx, userId ?? NIL_USER),
  userFxEvents: createUserFxEventRepository(tx, userId ?? NIL_USER),
  accounts: createAccountRepository(tx, userId ?? NIL_USER),
  ledger: createLedgerRepository(tx, userId ?? NIL_USER),
  undoActions: createUndoActionRepository(tx, userId ?? NIL_USER),
  categories: createCategoryRepository(tx, userId ?? NIL_USER),
  userSettings: createUserSettingsRepository(tx),
  shortcuts: createShortcutRepository(tx, userId ?? NIL_USER),
  dashboard: createDashboardRepository(tx, userId ?? NIL_USER),
  exports: createExportRepository(tx, userId ?? NIL_USER),
}));

const rates = createRatesService({ uow });
const accounts = createAccountsService({ uow, rates, ledgerHooks: createLedgerHooks() });
const categories = createCategoriesService({ uow });
const service = createOnboardingService({ uow, rates, accounts, categories });

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z'); // 12:00 in La Paz

afterAll(async () => {
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

type Kind = 'expense' | 'income';

function ctxFor(userId: string): OnboardingContext {
  return { userId, timezone: TZ, now: NOW, traceId: uuidv7() };
}

/** A confirmed user whose Onboarding waits in step 3, with the seed categories. */
async function userInStep3(): Promise<string> {
  const user = await createUser();
  await setOnboarding(user.id, 3);
  return user.id;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to be rejected');
}

function expectCodeError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  expectCodeError(await rejectionOf(promise), code);
}

function expectStepMismatchError(error: unknown, currentStep: number): void {
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  expect(appError.code).toBe('STEP_MISMATCH');
  expect(appError.data).toEqual({ currentStep });
}

/** The reasons of the rejected promises, in order. */
const reasonsOf = (results: PromiseSettledResult<unknown>[]): unknown[] =>
  results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));

interface Progress {
  step: number;
  completed: boolean;
}

async function progressOf(userId: string): Promise<Progress> {
  const rows = await prisma.$queryRaw<Progress[]>`
    SELECT onboarding_step::int AS step,
           (onboarding_completed_at IS NOT NULL) AS completed
      FROM user_settings
     WHERE user_id = ${userId}::uuid`;
  const row = rows[0];
  if (!row) {
    throw new Error(`No user_settings for ${userId}`);
  }
  return row;
}

/** Leaves the user's Onboarding in that step, finished or not. */
async function setOnboarding(userId: string, step: 1 | 2 | 3, completed = false): Promise<void> {
  await prisma.$executeRaw`
    UPDATE user_settings
       SET onboarding_step = ${step}::smallint,
           onboarding_completed_at = CASE WHEN ${completed}::boolean THEN now() ELSE NULL END
     WHERE user_id = ${userId}::uuid`;
}

interface StoredCategory {
  id: string;
  kind: Kind;
  parentId: string | null;
  name: string;
  color: string;
  icon: string;
  systemKey: string | null;
  status: string;
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

async function categoriesOf(userId: string): Promise<StoredCategory[]> {
  return prisma.$queryRaw<StoredCategory[]>`
    SELECT id::text AS id, kind::text AS kind, parent_id::text AS "parentId", name, color, icon,
           system_key::text AS "systemKey", status::text AS status
      FROM category
     WHERE user_id = ${userId}::uuid
     ORDER BY id`;
}

/** The only category of that kind with that name. */
function named(rows: readonly StoredCategory[], kind: Kind, name: string): StoredCategory {
  const found = rows.filter((row) => row.kind === kind && row.name === name);
  const [row] = found;
  if (found.length !== 1 || !row) {
    throw new Error(`Expected one ${kind} category named "${name}", found ${found.length}`);
  }
  return row;
}

/** The system category of that kind with that key (plan §4.5.3). */
function system(
  rows: readonly StoredCategory[],
  kind: Kind,
  key: 'debts' | 'debts_interest',
): StoredCategory {
  const row = rows.find((category) => category.kind === kind && category.systemKey === key);
  if (!row) {
    throw new Error(`No ${kind} system category ${key}`);
  }
  return row;
}

/** The rows minus the given categories. */
const without = (rows: readonly StoredCategory[], ids: readonly string[]): StoredCategory[] =>
  rows.filter((row) => !ids.includes(row.id));

/** The category plus its subcategories. */
const withChildren = (rows: readonly StoredCategory[], parentId: string): string[] =>
  rows.filter((row) => row.id === parentId || row.parentId === parentId).map((row) => row.id);

/** A new category of the step with a new client id (ADR-11). */
function newCategory(
  kind: Kind,
  name: string,
  icon: CreateCategoryInput['icon'],
  parentId: string | null = null,
  color?: CreateCategoryInput['color'],
): CreateCategoryInput {
  const input: CreateCategoryInput = { id: uuidv7(), kind, parentId, name, icon };
  if (color !== undefined) {
    input.color = color;
  }
  return input;
}

/** The row a new category of the step should leave, with the color it ends up with. */
function storedFrom(input: CreateCategoryInput, color: string): StoredCategory {
  return {
    id: input.id,
    kind: input.kind,
    parentId: input.parentId,
    name: input.name,
    color,
    icon: input.icon,
    systemKey: null,
    status: 'active',
  };
}

// ---------- Removing the unchecked ones ----------

describe('TASK-158 OnboardingService.step3: quitar las desmarcadas', () => {
  it('TASK-158 quita las precargadas desmarcadas, conserva las demás y termina el Onboarding', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const removed = [named(before, 'expense', 'Ocio').id, named(before, 'income', 'Mesada').id];

    await service.step3(ctxFor(userId), { removeCategoryIds: removed, newCategories: [] });

    expect(await categoriesOf(userId)).toEqual(without(before, removed));
    expect((await progressOf(userId)).completed).toBe(true);
  });

  it('TASK-158 desmarcar un padre quita también sus subcategorías', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const transport = named(before, 'expense', 'Transporte');
    const family = withChildren(before, transport.id);

    await service.step3(ctxFor(userId), { removeCategoryIds: [transport.id], newCategories: [] });

    // Transporte with Micro/Trufi, Taxi/Apps and Combustible.
    expect(family).toHaveLength(4);
    expect(await categoriesOf(userId)).toEqual(without(before, family));
  });

  it('TASK-158 desmarcar una subcategoría la quita y conserva su padre y sus hermanas', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const restaurants = named(before, 'expense', 'Restaurantes');

    await service.step3(ctxFor(userId), {
      removeCategoryIds: [restaurants.id],
      newCategories: [],
    });

    const after = await categoriesOf(userId);
    expect(after).toEqual(without(before, [restaurants.id]));
    expect(after.find((row) => row.id === restaurants.parentId)?.name).toBe('Comida');
  });

  it('TASK-158 desmarcar un padre junto con sus subcategorías las quita a todas', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const family = withChildren(before, named(before, 'expense', 'Servicios').id);

    await service.step3(ctxFor(userId), { removeCategoryIds: family, newCategories: [] });

    expect(family).toHaveLength(7);
    expect(await categoriesOf(userId)).toEqual(without(before, family));
    expect((await progressOf(userId)).completed).toBe(true);
  });
});

// ---------- Removing a whole kind ----------

describe('TASK-158 OnboardingService.step3: quitar todas las de un tipo', () => {
  it('EC-M10-03 se pueden quitar todas las de gasto: solo quedan las del sistema y el Onboarding termina', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    // Every expense category the step lets uncheck: the parents and their subcategories.
    const removed = before
      .filter((row) => row.kind === 'expense' && row.systemKey === null)
      .map((row) => row.id);

    await service.step3(ctxFor(userId), { removeCategoryIds: removed, newCategories: [] });

    const after = await categoriesOf(userId);
    expect(after).toEqual(without(before, removed));
    expect(
      after
        .filter((row) => row.kind === 'expense')
        .map((row) => row.systemKey)
        .sort(),
    ).toEqual(['debts', 'debts_interest']);
    expect(after.filter((row) => row.kind === 'income')).toEqual(
      before.filter((row) => row.kind === 'income'),
    );
    expect((await progressOf(userId)).completed).toBe(true);
  });

  it('EC-M10-03 se pueden quitar todas las de ingreso: solo quedan las del sistema y el Onboarding termina', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const removed = before
      .filter((row) => row.kind === 'income' && row.systemKey === null)
      .map((row) => row.id);

    await service.step3(ctxFor(userId), { removeCategoryIds: removed, newCategories: [] });

    const after = await categoriesOf(userId);
    expect(after).toEqual(without(before, removed));
    expect(
      after
        .filter((row) => row.kind === 'income')
        .map((row) => row.systemKey)
        .sort(),
    ).toEqual(['debts', 'debts_interest']);
    expect(after.filter((row) => row.kind === 'expense')).toEqual(
      before.filter((row) => row.kind === 'expense'),
    );
    expect((await progressOf(userId)).completed).toBe(true);
  });

  it('EC-M10-03 desmarcar todos los padres de gasto se lleva también sus subcategorías', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const parents = before
      .filter((row) => row.kind === 'expense' && row.parentId === null && row.systemKey === null)
      .map((row) => row.id);
    const removed = before
      .filter((row) => row.kind === 'expense' && row.systemKey === null)
      .map((row) => row.id);

    await service.step3(ctxFor(userId), { removeCategoryIds: parents, newCategories: [] });

    expect(removed.length).toBeGreaterThan(parents.length);
    expect(await categoriesOf(userId)).toEqual(without(before, removed));
    expect((await progressOf(userId)).completed).toBe(true);
  });
});

// ---------- System category ----------

describe('TASK-158 OnboardingService.step3: la categoría del sistema', () => {
  it('RF-M10-05 quitar "Deudas y préstamos" de gasto da SYSTEM_CATEGORY y no quita, no crea ni termina nada', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const debts = system(before, 'expense', 'debts');
    expect(debts.name).toBe('Deudas y préstamos');
    // The removable one goes first: a rejected step removes none of them.
    const input: Step3Input = {
      removeCategoryIds: [named(before, 'expense', 'Ocio').id, debts.id],
      newCategories: [newCategory('expense', 'Gimnasio', 'heart-pulse', null, 'purple')],
    };

    await expectCode(service.step3(ctxFor(userId), input), 'SYSTEM_CATEGORY');

    expect(await categoriesOf(userId)).toEqual(before);
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('RF-M10-05 quitar "Deudas y préstamos" de ingreso también da SYSTEM_CATEGORY y no cambia nada', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const debts = system(before, 'income', 'debts');
    expect(debts.name).toBe('Deudas y préstamos');

    await expectCode(
      service.step3(ctxFor(userId), {
        removeCategoryIds: [named(before, 'income', 'Mesada').id, debts.id],
        newCategories: [],
      }),
      'SYSTEM_CATEGORY',
    );

    expect(await categoriesOf(userId)).toEqual(before);
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('RF-M5-05 RF-M10-05 quitar su subcategoría del sistema "Intereses" da SYSTEM_CATEGORY y no cambia nada', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const interest = system(before, 'expense', 'debts_interest');
    expect(interest.name).toBe('Intereses');

    await expectCode(
      service.step3(ctxFor(userId), { removeCategoryIds: [interest.id], newCategories: [] }),
      'SYSTEM_CATEGORY',
    );

    expect(await categoriesOf(userId)).toEqual(before);
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('RF-M10-05 tras el rechazo, reenviar el paso sin la del sistema lo completa', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const leisure = named(before, 'expense', 'Ocio');
    const gym = newCategory('expense', 'Gimnasio', 'heart-pulse', null, 'purple');
    await expectCode(
      service.step3(ctxFor(userId), {
        removeCategoryIds: [leisure.id, system(before, 'expense', 'debts').id],
        newCategories: [gym],
      }),
      'SYSTEM_CATEGORY',
    );

    await service.step3(ctxFor(userId), { removeCategoryIds: [leisure.id], newCategories: [gym] });

    expect(await categoriesOf(userId)).toEqual(
      [...without(before, [leisure.id]), storedFrom(gym, 'purple')].sort(byId),
    );
    expect((await progressOf(userId)).completed).toBe(true);
  });
});

// ---------- Creating the new ones ----------

describe('TASK-158 OnboardingService.step3: crear las nuevas', () => {
  it('TASK-158 crea las categorías nuevas del paso, principales y subcategorías, de gasto y de ingreso', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const food = named(before, 'expense', 'Comida');
    const gym = newCategory('expense', 'Gimnasio', 'heart-pulse', null, 'purple');
    const delivery = newCategory('expense', 'Delivery', 'pizza', food.id, 'red');
    const rent = newCategory('income', 'Alquileres cobrados', 'house', null, 'amber');

    await service.step3(ctxFor(userId), {
      removeCategoryIds: [],
      newCategories: [gym, delivery, rent],
    });

    expect(await categoriesOf(userId)).toEqual(
      [
        ...before,
        storedFrom(gym, 'purple'),
        storedFrom(delivery, 'red'),
        storedFrom(rent, 'amber'),
      ].sort(byId),
    );
    expect((await progressOf(userId)).completed).toBe(true);
  });

  it('RF-M5-04 una subcategoría nueva sin color toma el color de su padre', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const food = named(before, 'expense', 'Comida');
    const bakery = newCategory('expense', 'Panadería', 'shopping-cart', food.id);

    await service.step3(ctxFor(userId), { removeCategoryIds: [], newCategories: [bakery] });

    expect(await categoriesOf(userId)).toEqual(
      [...before, storedFrom(bakery, food.color)].sort(byId),
    );
  });

  it('TASK-158 quita las desmarcadas y crea las nuevas en el mismo paso', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const removed = withChildren(before, named(before, 'expense', 'Vivienda').id);
    const gym = newCategory('expense', 'Gimnasio', 'heart-pulse', null, 'purple');
    const rent = newCategory('income', 'Alquileres cobrados', 'house', null, 'amber');

    await service.step3(ctxFor(userId), { removeCategoryIds: removed, newCategories: [gym, rent] });

    expect(await categoriesOf(userId)).toEqual(
      [...without(before, removed), storedFrom(gym, 'purple'), storedFrom(rent, 'amber')].sort(
        byId,
      ),
    );
    expect((await progressOf(userId)).completed).toBe(true);
  });
});

// ---------- End ----------

describe('TASK-158 OnboardingService.step3: fin del Onboarding', () => {
  it('TASK-158 al terminar el paso 3 el Onboarding queda completado y ya no vuelve: get responde ONBOARDING_DONE', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);

    await service.step3(ctxFor(userId), { removeCategoryIds: [], newCategories: [] });

    expect((await progressOf(userId)).completed).toBe(true);
    expect(await categoriesOf(userId)).toEqual(before);
    await expectCode(service.get(ctxFor(userId)), 'ONBOARDING_DONE');
  });

  it('TASK-158 repetir el paso 3 ya terminado responde ONBOARDING_DONE y no quita ni crea nada más', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const leisure = named(before, 'expense', 'Ocio');
    const gym = newCategory('expense', 'Gimnasio', 'heart-pulse', null, 'purple');
    await service.step3(ctxFor(userId), { removeCategoryIds: [leisure.id], newCategories: [gym] });
    const done = await categoriesOf(userId);

    await expectCode(
      service.step3(ctxFor(userId), {
        removeCategoryIds: [named(before, 'expense', 'Salud').id],
        newCategories: [newCategory('income', 'Alquileres cobrados', 'house', null, 'amber')],
      }),
      'ONBOARDING_DONE',
    );

    expect(done).toEqual([...without(before, [leisure.id]), storedFrom(gym, 'purple')].sort(byId));
    expect(await categoriesOf(userId)).toEqual(done);
    expect((await progressOf(userId)).completed).toBe(true);
  });

  it('TASK-158 dos step3 simultáneos con los mismos ids crean cada categoría una sola vez y terminan una sola vez', async () => {
    const userId = await userInStep3();
    const before = await categoriesOf(userId);
    const removed = withChildren(before, named(before, 'expense', 'Comida').id);
    const gym = newCategory('expense', 'Gimnasio', 'heart-pulse', null, 'purple');
    const input: Step3Input = { removeCategoryIds: removed, newCategories: [gym] };

    const results = await Promise.allSettled([
      service.step3(ctxFor(userId), input),
      service.step3(ctxFor(userId), input),
    ]);

    const rejected = reasonsOf(results);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectCodeError(rejected[0], 'ONBOARDING_DONE');
    expect(await categoriesOf(userId)).toEqual(
      [...without(before, removed), storedFrom(gym, 'purple')].sort(byId),
    );
    expect((await progressOf(userId)).completed).toBe(true);
  });
});

// ---------- Pending step ----------

describe('TASK-158 OnboardingService.step3: paso pendiente', () => {
  it('TASK-158 en el paso 1, step3 da STEP_MISMATCH con el paso actual y no quita ni crea categorías', async () => {
    const user = await createUser();
    const before = await categoriesOf(user.id);
    const input: Step3Input = {
      removeCategoryIds: [named(before, 'expense', 'Ocio').id],
      newCategories: [newCategory('expense', 'Gimnasio', 'heart-pulse', null, 'purple')],
    };

    expectStepMismatchError(await rejectionOf(service.step3(ctxFor(user.id), input)), 1);

    expect(await categoriesOf(user.id)).toEqual(before);
    expect(await progressOf(user.id)).toEqual({ step: 1, completed: false });
  });

  it('TASK-158 en el paso 2, step3 da STEP_MISMATCH con el paso actual y no quita ni crea categorías', async () => {
    const userId = await userInStep3();
    await setOnboarding(userId, 2);
    const before = await categoriesOf(userId);
    const input: Step3Input = {
      removeCategoryIds: [named(before, 'expense', 'Ocio').id],
      newCategories: [newCategory('expense', 'Gimnasio', 'heart-pulse', null, 'purple')],
    };

    expectStepMismatchError(await rejectionOf(service.step3(ctxFor(userId), input)), 2);

    expect(await categoriesOf(userId)).toEqual(before);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('TASK-158 con el Onboarding terminado, step3 responde ONBOARDING_DONE y no cambia nada', async () => {
    const userId = await userInStep3();
    // Finished while the stored step is still 3: the step matches, the end still wins.
    await setOnboarding(userId, 3, true);
    const before = await categoriesOf(userId);
    const input: Step3Input = {
      removeCategoryIds: [named(before, 'expense', 'Ocio').id],
      newCategories: [newCategory('expense', 'Gimnasio', 'heart-pulse', null, 'purple')],
    };

    await expectCode(service.step3(ctxFor(userId), input), 'ONBOARDING_DONE');

    expect(await categoriesOf(userId)).toEqual(before);
    expect(await progressOf(userId)).toEqual({ step: 3, completed: true });
  });
});

// ---------- Isolation ----------

describe('TASK-158 OnboardingService.step3: aislamiento', () => {
  it('TASK-158 el paso 3 de un usuario no quita las categorías de otro ni mueve su Onboarding', async () => {
    const [ana, beto] = await Promise.all([userInStep3(), userInStep3()]);
    const anaBefore = await categoriesOf(ana);
    const betoBefore = await categoriesOf(beto);
    const removed = withChildren(anaBefore, named(anaBefore, 'expense', 'Comida').id);

    await service.step3(ctxFor(ana), { removeCategoryIds: removed, newCategories: [] });

    expect(await categoriesOf(ana)).toEqual(without(anaBefore, removed));
    expect(await categoriesOf(beto)).toEqual(betoBefore);
    expect(await progressOf(beto)).toEqual({ step: 3, completed: false });
  });

  it('TASK-158 una categoría de otro usuario en la lista del paso 3 no se quita', async () => {
    const [ana, beto] = await Promise.all([userInStep3(), userInStep3()]);
    const betoBefore = await categoriesOf(beto);
    const betoFood = named(betoBefore, 'expense', 'Comida');

    // Whether the step rejects or ignores the foreign id, it never reaches Beto's rows.
    await Promise.allSettled([
      service.step3(ctxFor(ana), { removeCategoryIds: [betoFood.id], newCategories: [] }),
    ]);

    expect(await categoriesOf(beto)).toEqual(betoBefore);
    expect(await progressOf(beto)).toEqual({ step: 3, completed: false });
  });
});
