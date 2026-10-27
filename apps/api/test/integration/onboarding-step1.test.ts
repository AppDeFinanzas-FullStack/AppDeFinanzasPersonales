import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import {
  createRatesService,
  type RatesService,
} from '../../src/application/services/rates.service.js';
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
 * The plan fixes `GET /api/onboarding`, `POST /api/onboarding/step1`, `/skip` and `/skip-all`
 * with their errors (plan §4.10.2), the lifecycle (plan §4.10.3) and the contracts
 * `OnboardingDto`, `Step1Input` and `SkipInput` (plan §4.10.1), but not how the service is built.
 * These tests assume, like those of `RatesService` and `AccountsService`:
 * - `createOnboardingService({ uow, rates })` builds it over the `UnitOfWork` and the
 *   `RatesService`. The `UnitOfWork` of this file builds every repository of the composition root,
 *   so the service reaches the `user_settings` row through `repos.userSettings`.
 * - Every method takes the request context `{ userId, timezone, now, traceId }` (plan §1.4):
 *   `get(ctx)`, `step1(ctx, Step1Input)`, `skip(ctx, SkipInput)` and `skipAll(ctx)`.
 * - `get` resolves to the fields of `OnboardingDto`: `step`, `presets.accounts`,
 *   `presets.categories` (the tree of the user's categories, both kinds, as `CategoryNode`) and
 *   `rate`: the `inUse` of `RatesService.current`, or `null` when there is no rate. The rate value
 *   may come back as decimal text or `Decimal`: the tests compare it at 2 decimals.
 * - The values `step1`, `skip` and `skipAll` resolve to are not checked: the tests read the
 *   `user_settings` row back.
 * - A rejection is an `AppError` (ADR-09): `STEP_MISMATCH` with `data = { currentStep }`, or
 *   `ONBOARDING_DONE` once `onboarding_completed_at` is set, whatever the step.
 * - Skipping step 3, the last one, finishes the Onboarding: there is no step 4 (spec §2.10.2).
 *
 * `market_rate` is global (ADR-12): the file saves its rows, empties the table in the tests of the
 * rate and puts the rows back at the end. Integration files run one after another.
 */
interface OnboardingContext {
  userId: string;
  timezone: string;
  now: Date;
  traceId: string;
}

interface AccountPresetView {
  name: string;
  type: string;
  currencyCode: string;
  checked: boolean;
}

interface CategoryNodeView {
  id: string;
  kind: 'expense' | 'income';
  name: string;
  isSystem: boolean;
  children: CategoryNodeView[];
}

interface RateInUseView {
  kind: string;
  value: Decimal | string | null;
  since?: string;
}

interface OnboardingView {
  step: number;
  presets: { accounts: AccountPresetView[]; categories: CategoryNodeView[] };
  rate: RateInUseView | null;
}

interface OnboardingServiceUnderTest {
  get(ctx: OnboardingContext): Promise<OnboardingView>;
  step1(ctx: OnboardingContext, input: { baseCurrency: 'BOB' | 'USD' }): Promise<unknown>;
  skip(ctx: OnboardingContext, input: { step: 1 | 2 | 3 }): Promise<unknown>;
  skipAll(ctx: OnboardingContext): Promise<unknown>;
}

type CreateOnboardingService = (deps: {
  uow: UnitOfWork;
  rates: RatesService;
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
const service = createOnboardingService({ uow, rates });

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z'); // 12:00 in La Paz
const TODAY = '2090-06-15';

interface SavedRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

let savedRates: SavedRate[] = [];

beforeAll(async () => {
  savedRates = await prisma.$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate`;
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate`;
  for (const row of savedRates) {
    await prisma.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const fixed = (value: Decimal | string | number): string => new Decimal(value).toFixed(2);

function ctxFor(userId: string): OnboardingContext {
  return { userId, timezone: TZ, now: NOW, traceId: uuidv7() };
}

async function newUserId(): Promise<string> {
  const user = await createUser();
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

function expectStepMismatchError(error: unknown, currentStep: number): void {
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  expect(appError.code).toBe('STEP_MISMATCH');
  expect(appError.data).toEqual({ currentStep });
}

async function expectStepMismatch(promise: Promise<unknown>, currentStep: number): Promise<void> {
  expectStepMismatchError(await rejectionOf(promise), currentStep);
}

async function expectOnboardingDone(promise: Promise<unknown>): Promise<void> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe('ONBOARDING_DONE');
}

/** The reasons of the rejected promises, in order. */
const reasonsOf = (results: PromiseSettledResult<unknown>[]): unknown[] =>
  results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));

interface OnboardingRow {
  step: number;
  completed: boolean;
  baseCurrency: string;
}

async function onboardingOf(userId: string): Promise<OnboardingRow> {
  const rows = await prisma.$queryRaw<OnboardingRow[]>`
    SELECT onboarding_step::int AS step,
           (onboarding_completed_at IS NOT NULL) AS completed,
           btrim(base_currency::text) AS "baseCurrency"
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

async function accountCount(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM account WHERE user_id = ${userId}::uuid`;
  return rows[0]?.count ?? 0;
}

interface StoredCategory {
  id: string;
  kind: string;
  parentId: string | null;
  name: string;
  isSystem: boolean;
  status: string;
}

async function categoriesOf(userId: string): Promise<StoredCategory[]> {
  return prisma.$queryRaw<StoredCategory[]>`
    SELECT id::text AS id, kind::text AS kind, parent_id::text AS "parentId", name,
           is_system AS "isSystem", status::text AS status
      FROM category
     WHERE user_id = ${userId}::uuid
     ORDER BY id`;
}

interface FlatNode {
  id: string;
  parentId: string | null;
  isSystem: boolean;
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Every node of the tree with the id of the node it hangs from. */
function flatten(nodes: readonly CategoryNodeView[], parentId: string | null = null): FlatNode[] {
  return nodes.flatMap((node) => [
    { id: node.id, parentId, isSystem: node.isSystem },
    ...flatten(node.children, node.id),
  ]);
}

type Kind = 'parallel_bid' | 'parallel_ask' | 'parallel_median' | 'official';

async function marketRate(
  kind: Kind,
  value: string,
  observedAt: string,
  source: 'paralelo_bo' | 'bcb' = 'paralelo_bo',
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${kind}::market_rate_kind, ${TODAY}::date, ${value}::numeric,
            ${new Date(observedAt)}, ${source}::rate_source)`;
}

async function clearMarketRates(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM market_rate`;
}

// ---------- get ----------

describe('TASK-156 OnboardingService.get', () => {
  it('TASK-156 un usuario recién confirmado empieza el Onboarding en el paso 1', async () => {
    const userId = await newUserId();

    const onboarding = await service.get(ctxFor(userId));

    expect(onboarding.step).toBe(1);
  });

  it('TASK-156 sugiere "Efectivo (Bs)" y "Banco (Bs)" marcadas y "Dólares en efectivo ($)" sin marcar', async () => {
    const userId = await newUserId();

    const onboarding = await service.get(ctxFor(userId));

    const accounts = onboarding.presets.accounts.map(({ name, type, currencyCode, checked }) => ({
      name,
      type,
      currencyCode,
      checked,
    }));
    expect(accounts).toEqual([
      { name: 'Efectivo (Bs)', type: 'cash', currencyCode: 'BOB', checked: true },
      { name: 'Banco (Bs)', type: 'bank', currencyCode: 'BOB', checked: true },
      { name: 'Dólares en efectivo ($)', type: 'cash', currencyCode: 'USD', checked: false },
    ]);
  });

  it('TASK-156 trae el árbol de las categorías del usuario, de gasto y de ingreso, con las del sistema', async () => {
    const userId = await newUserId();
    const stored = await categoriesOf(userId);

    const onboarding = await service.get(ctxFor(userId));

    const tree = onboarding.presets.categories;
    expect(new Set(tree.map((node) => node.kind))).toEqual(new Set(['expense', 'income']));
    expect(flatten(tree).sort(byId)).toEqual(
      stored.map(({ id, parentId, isSystem }) => ({ id, parentId, isSystem })).sort(byId),
    );
    expect(stored.some((category) => category.isSystem)).toBe(true);
  });

  it('TASK-156 trae la tasa en uso del dólar', async () => {
    const userId = await newUserId();
    await clearMarketRates();
    await marketRate('parallel_bid', '10.30', '2090-06-15T15:30:00Z');
    await marketRate('parallel_ask', '10.50', '2090-06-15T15:30:00Z');
    await marketRate('parallel_median', '10.40', '2090-06-15T15:30:00Z');
    await marketRate('official', '6.96', '2090-06-15T12:00:00Z', 'bcb');

    const onboarding = await service.get(ctxFor(userId));
    const current = await rates.current(ctxFor(userId));

    expect(onboarding.rate).not.toBeNull();
    expect(onboarding.rate?.kind).toBe('parallel_median');
    expect(onboarding.rate?.kind).toBe(current.inUse.kind);
    expect(fixed(onboarding.rate?.value ?? '0')).toBe('10.40');
    expect(fixed(onboarding.rate?.value ?? '0')).toBe(fixed(current.inUse.value ?? '0'));
  });

  it('TASK-156 sin ninguna tasa, la tasa en uso es null', async () => {
    const userId = await newUserId();
    await clearMarketRates();

    const onboarding = await service.get(ctxFor(userId));

    expect(onboarding.rate).toBeNull();
  });

  it('RF-M10-01 Retomar en otro dispositivo: tras el paso 1 en uno, el Onboarding continúa en el paso 2 en otro', async () => {
    const userId = await newUserId();
    await service.step1(ctxFor(userId), { baseCurrency: 'USD' });

    // Another device: a new request of the same user, with nothing kept in memory.
    const onboarding = await service.get(ctxFor(userId));

    expect(onboarding.step).toBe(2);
    expect((await onboardingOf(userId)).baseCurrency).toBe('USD');
  });
});

// ---------- step1 ----------

describe('TASK-156 OnboardingService.step1', () => {
  it('RF-M10-01 el paso 1 guarda en la cuenta la moneda base elegida y avanza al paso 2', async () => {
    const userId = await newUserId();

    await service.step1(ctxFor(userId), { baseCurrency: 'USD' });

    expect(await onboardingOf(userId)).toEqual({ step: 2, completed: false, baseCurrency: 'USD' });
  });

  it('RF-M10-01 dos step1 simultáneos avanzan una sola vez, y el segundo da STEP_MISMATCH', async () => {
    const userId = await newUserId();

    // Different choices, so the stored base currency tells which one advanced.
    const results = await Promise.allSettled([
      service.step1(ctxFor(userId), { baseCurrency: 'USD' }),
      service.step1(ctxFor(userId), { baseCurrency: 'BOB' }),
    ]);

    const rejected = reasonsOf(results);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectStepMismatchError(rejected[0], 2);
    const winner = results[0]?.status === 'fulfilled' ? 'USD' : 'BOB';
    expect(await onboardingOf(userId)).toEqual({
      step: 2,
      completed: false,
      baseCurrency: winner,
    });
  });

  it('RF-M10-01 con el paso 1 ya confirmado, repetirlo da STEP_MISMATCH con el paso actual y no cambia la moneda base', async () => {
    const userId = await newUserId();
    await service.step1(ctxFor(userId), { baseCurrency: 'USD' });

    await expectStepMismatch(service.step1(ctxFor(userId), { baseCurrency: 'BOB' }), 2);

    expect(await onboardingOf(userId)).toEqual({ step: 2, completed: false, baseCurrency: 'USD' });
  });

  it('TASK-156 el paso 1 de un usuario no mueve el Onboarding de otro (aislamiento)', async () => {
    const [ana, beto] = await Promise.all([newUserId(), newUserId()]);

    await service.step1(ctxFor(ana), { baseCurrency: 'USD' });

    expect(await onboardingOf(beto)).toEqual({ step: 1, completed: false, baseCurrency: 'BOB' });
    expect((await service.get(ctxFor(beto))).step).toBe(1);
  });
});

// ---------- skip ----------

describe('TASK-156 OnboardingService.skip', () => {
  it('RF-M10-02 saltar el paso 1 deja BOB como moneda base y avanza al paso 2', async () => {
    const userId = await newUserId();

    await service.skip(ctxFor(userId), { step: 1 });

    expect(await onboardingOf(userId)).toEqual({ step: 2, completed: false, baseCurrency: 'BOB' });
  });

  it('RF-M10-03 saltar el paso 2 no crea ninguna cuenta y avanza al paso 3', async () => {
    const userId = await newUserId();
    await setOnboarding(userId, 2);

    await service.skip(ctxFor(userId), { step: 2 });

    expect(await accountCount(userId)).toBe(0);
    expect(await onboardingOf(userId)).toMatchObject({ step: 3, completed: false });
  });

  it('RF-M10-06 saltar el paso 3 conserva todas las categorías precargadas', async () => {
    const userId = await newUserId();
    await setOnboarding(userId, 3);
    const before = await categoriesOf(userId);

    await service.skip(ctxFor(userId), { step: 3 });

    expect(before.length).toBeGreaterThan(0);
    expect(await categoriesOf(userId)).toEqual(before);
  });

  it('TASK-156 saltar el paso 3, el último, termina el Onboarding', async () => {
    const userId = await newUserId();
    await setOnboarding(userId, 3);

    await service.skip(ctxFor(userId), { step: 3 });

    expect((await onboardingOf(userId)).completed).toBe(true);
    await expectOnboardingDone(service.get(ctxFor(userId)));
  });

  it('RF-M10-01 saltar un paso que no es el pendiente da STEP_MISMATCH con el paso actual', async () => {
    const userId = await newUserId();
    await setOnboarding(userId, 2);

    await expectStepMismatch(service.skip(ctxFor(userId), { step: 1 }), 2);
    await expectStepMismatch(service.skip(ctxFor(userId), { step: 3 }), 2);

    expect(await onboardingOf(userId)).toEqual({ step: 2, completed: false, baseCurrency: 'BOB' });
  });

  it('RF-M10-01 dos saltos simultáneos del paso 2 avanzan una sola vez, y el segundo da STEP_MISMATCH', async () => {
    const userId = await newUserId();
    await setOnboarding(userId, 2);

    const results = await Promise.allSettled([
      service.skip(ctxFor(userId), { step: 2 }),
      service.skip(ctxFor(userId), { step: 2 }),
    ]);

    const rejected = reasonsOf(results);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectStepMismatchError(rejected[0], 3);
    expect(await onboardingOf(userId)).toMatchObject({ step: 3, completed: false });
  });
});

// ---------- skipAll ----------

describe('TASK-156 OnboardingService.skipAll', () => {
  it('RF-M10-02 RF-M10-03 RF-M10-06 Saltar todo: la base es BOB, no hay cuentas, siguen todas las categorías y el Onboarding termina', async () => {
    const userId = await newUserId();
    const before = await categoriesOf(userId);

    await service.skipAll(ctxFor(userId));

    const after = await onboardingOf(userId);
    expect(after.baseCurrency).toBe('BOB');
    expect(after.completed).toBe(true);
    expect(await accountCount(userId)).toBe(0);
    expect(await categoriesOf(userId)).toEqual(before);
  });

  it('RF-M10-01 Saltar todo después del paso 1 conserva la moneda base ya confirmada', async () => {
    const userId = await newUserId();
    await service.step1(ctxFor(userId), { baseCurrency: 'USD' });

    await service.skipAll(ctxFor(userId));

    expect(await onboardingOf(userId)).toMatchObject({ completed: true, baseCurrency: 'USD' });
  });
});

// ---------- Terminado ----------

describe('TASK-156 Onboarding terminado', () => {
  it('TASK-156 una vez terminado, get, step1, skip y skipAll responden ONBOARDING_DONE y no cambian nada', async () => {
    const userId = await newUserId();
    // Finished while the stored step is still 1: the step matches, the end still wins.
    await setOnboarding(userId, 1, true);

    await expectOnboardingDone(service.get(ctxFor(userId)));
    await expectOnboardingDone(service.step1(ctxFor(userId), { baseCurrency: 'USD' }));
    await expectOnboardingDone(service.skip(ctxFor(userId), { step: 1 }));
    await expectOnboardingDone(service.skip(ctxFor(userId), { step: 2 }));
    await expectOnboardingDone(service.skipAll(ctxFor(userId)));

    expect(await onboardingOf(userId)).toEqual({ step: 1, completed: true, baseCurrency: 'BOB' });
  });

  it('TASK-156 después de Saltar todo, el Onboarding no vuelve: todo responde ONBOARDING_DONE', async () => {
    const userId = await newUserId();
    await service.skipAll(ctxFor(userId));

    await expectOnboardingDone(service.get(ctxFor(userId)));
    await expectOnboardingDone(service.step1(ctxFor(userId), { baseCurrency: 'USD' }));
    await expectOnboardingDone(service.skip(ctxFor(userId), { step: 1 }));
    await expectOnboardingDone(service.skipAll(ctxFor(userId)));

    expect(await onboardingOf(userId)).toMatchObject({ completed: true, baseCurrency: 'BOB' });
  });
});
