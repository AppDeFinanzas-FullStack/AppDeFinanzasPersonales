import type { Step2Input } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import {
  createAccountsService,
  type AccountsService,
} from '../../src/application/services/accounts.service.js';
import {
  createRatesService,
  type RatesService,
} from '../../src/application/services/rates.service.js';
import { createLedgerHooks } from '../../src/application/shared/ledger-hooks.js';
import { createAccountRepository } from '../../src/infrastructure/persistence/repositories/account.repository.js';
import { createCategoryRepository } from '../../src/infrastructure/persistence/repositories/category.repository.js';
import { createCurrencyRepository } from '../../src/infrastructure/persistence/repositories/currency.repository.js';
import { createGoalAllocationRepository } from '../../src/infrastructure/persistence/repositories/goal-allocation.repository.js';
import { createGoalRepository } from '../../src/infrastructure/persistence/repositories/goal.repository.js';
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
import { createAccount } from '../factories/account.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `POST /api/onboarding/step2` with its errors (plan §4.10.2), the lifecycle
 * (plan §4.10.3) and the contract `Step2Input` (plan §4.10.1), but not how the service is built.
 * These tests assume, like those of TASK-156:
 * - `createOnboardingService({ uow, rates, accounts })` builds it over the `UnitOfWork`, the
 *   `RatesService` and the `AccountsService` the task creates the accounts with. Those are the
 *   deps of TASK-156 plus `accounts`; an implementation that does not need it ignores it. The
 *   `UnitOfWork` of this file builds every repository of the composition root.
 * - `step2(ctx, Step2Input)` takes the request context `{ userId, timezone, now, traceId }`
 *   (plan §1.4) and the input already parsed by the controller.
 * - The value `step2` resolves to is not checked: the tests read `account` and `user_settings`
 *   back.
 * - A rejection is an `AppError` (ADR-09): `VALIDATION_ERROR`, `NAME_TAKEN`, `STEP_MISMATCH`
 *   with `data = { currentStep }`, or `ONBOARDING_DONE` once `onboarding_completed_at` is set.
 *   A rejected step 2 creates no account and stays in step 2: the accounts and the move to step 3
 *   go in one transaction.
 * - "Today" is the user's local day (RN-07): the clock of the context, in its timezone.
 */
interface OnboardingContext {
  userId: string;
  timezone: string;
  now: Date;
  traceId: string;
}

interface OnboardingServiceUnderTest {
  step2(ctx: OnboardingContext, input: Step2Input): Promise<unknown>;
}

type CreateOnboardingService = (deps: {
  uow: UnitOfWork;
  rates: RatesService;
  accounts: AccountsService;
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
  goals: createGoalRepository(tx, userId ?? NIL_USER),
  goalAllocations: createGoalAllocationRepository(tx, userId ?? NIL_USER),
}));

const rates = createRatesService({ uow });
const accounts = createAccountsService({ uow, rates, ledgerHooks: createLedgerHooks() });
const service = createOnboardingService({ uow, rates, accounts });

const TZ = 'America/La_Paz';
// 22:30 of June 15 in La Paz, already June 16 in UTC: "today" is the user's day.
const NOW = new Date('2090-06-16T02:30:00Z');
const TODAY = '2090-06-15';

afterAll(async () => {
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

type Step2Account = Step2Input['accounts'][number];

const fixed = (value: string): string => new Decimal(value).toFixed(2);

function ctxFor(userId: string, timezone = TZ): OnboardingContext {
  return { userId, timezone, now: NOW, traceId: uuidv7() };
}

/** A confirmed user whose Onboarding waits in step 2. */
async function userInStep2(timezone = TZ): Promise<string> {
  const user = await createUser({ timezone });
  await setOnboarding(user.id, 2);
  return user.id;
}

/** An account of step 2 with a new client id (ADR-11). */
function entry(
  name: string,
  type: Step2Account['type'],
  currencyCode: string,
  balance: string,
): Step2Account {
  return { id: uuidv7(), name, type, currencyCode, balance };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to be rejected');
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  expect(appError.code).toBe(code);
  return appError;
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

interface StoredAccount {
  id: string;
  type: string;
  name: string;
  currencyCode: string;
  initialBalance: string;
  initialBalanceDate: string;
  status: string;
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

async function accountsOf(userId: string): Promise<StoredAccount[]> {
  return prisma.$queryRaw<StoredAccount[]>`
    SELECT id::text AS id, type::text AS type, name, btrim(currency_code::text) AS "currencyCode",
           initial_balance::text AS "initialBalance",
           initial_balance_date::text AS "initialBalanceDate", status::text AS status
      FROM account
     WHERE user_id = ${userId}::uuid
     ORDER BY id`;
}

/** The active account each entry of the step should leave, with its balance dated `date`. */
function expectedAccounts(entries: readonly Step2Account[], date = TODAY): StoredAccount[] {
  return entries
    .map((account) => ({
      id: account.id,
      type: account.type,
      name: account.name,
      currencyCode: account.currencyCode,
      initialBalance: fixed(account.balance),
      initialBalanceDate: date,
      status: 'active',
    }))
    .sort(byId);
}

// ---------- Creating the accounts ----------

describe('TASK-157 OnboardingService.step2', () => {
  it('RF-M10-04 crea las cuentas del paso con su saldo y la fecha de hoy, y avanza al paso 3', async () => {
    const userId = await userInStep2();
    const input: Step2Input = {
      accounts: [
        entry('Efectivo (Bs)', 'cash', 'BOB', '150.50'),
        entry('Banco (Bs)', 'bank', 'BOB', '2300'),
        entry('Dólares en efectivo ($)', 'cash', 'USD', '40.00'),
      ],
    };

    await service.step2(ctxFor(userId), input);

    expect(await accountsOf(userId)).toEqual(expectedAccounts(input.accounts));
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('RF-M10-04 la fecha de hoy es el día del usuario en su zona horaria', async () => {
    // The same instant is already June 16 in Tokyo.
    const userId = await userInStep2('Asia/Tokyo');
    const input: Step2Input = { accounts: [entry('Efectivo (Bs)', 'cash', 'BOB', '10.00')] };

    await service.step2(ctxFor(userId, 'Asia/Tokyo'), input);

    expect(await accountsOf(userId)).toEqual(expectedAccounts(input.accounts, '2090-06-16'));
  });

  it('RF-M4-02 RF-M10-04 efectivo y billetera aceptan 0, y banco, ahorro y otro aceptan saldos negativos', async () => {
    const userId = await userInStep2();
    const input: Step2Input = {
      accounts: [
        entry('Efectivo (Bs)', 'cash', 'BOB', '0.00'),
        entry('Billetera', 'ewallet', 'BOB', '0'),
        entry('Banco (Bs)', 'bank', 'BOB', '-150.50'),
        entry('Ahorro ($)', 'savings', 'USD', '-20.00'),
        entry('Otra', 'other', 'BOB', '-5.25'),
      ],
    };

    await service.step2(ctxFor(userId), input);

    expect(await accountsOf(userId)).toEqual(expectedAccounts(input.accounts));
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('RF-M4-02 un saldo de hasta 999.999.999,99 en valor absoluto se acepta', async () => {
    const userId = await userInStep2();
    const input: Step2Input = {
      accounts: [
        entry('Ahorro (Bs)', 'savings', 'BOB', '999999999.99'),
        entry('Banco (Bs)', 'bank', 'BOB', '-999999999.99'),
      ],
    };

    await service.step2(ctxFor(userId), input);

    expect(await accountsOf(userId)).toEqual(expectedAccounts(input.accounts));
  });
});

// ---------- Balance rules ----------

describe('TASK-157 OnboardingService.step2: reglas del saldo inicial', () => {
  it('EC-M10-01 un saldo negativo en el efectivo da VALIDATION_ERROR y no se crea ninguna cuenta', async () => {
    const userId = await userInStep2();
    // The valid account goes first: a rejected step leaves none of them.
    const input: Step2Input = {
      accounts: [
        entry('Banco (Bs)', 'bank', 'BOB', '500.00'),
        entry('Efectivo (Bs)', 'cash', 'BOB', '-10.00'),
      ],
    };

    await expectCode(service.step2(ctxFor(userId), input), 'VALIDATION_ERROR');

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('EC-M10-01 un saldo negativo en el efectivo en dólares también se rechaza con VALIDATION_ERROR', async () => {
    const userId = await userInStep2();
    const input: Step2Input = {
      accounts: [entry('Dólares en efectivo ($)', 'cash', 'USD', '-0.01')],
    };

    await expectCode(service.step2(ctxFor(userId), input), 'VALIDATION_ERROR');

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('RF-M4-02 un saldo negativo en una billetera da VALIDATION_ERROR y no se crea ninguna cuenta', async () => {
    const userId = await userInStep2();
    const input: Step2Input = {
      accounts: [
        entry('Efectivo (Bs)', 'cash', 'BOB', '20.00'),
        entry('Billetera', 'ewallet', 'BOB', '-0.01'),
      ],
    };

    await expectCode(service.step2(ctxFor(userId), input), 'VALIDATION_ERROR');

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('RF-M4-02 un saldo de más de 999.999.999,99 en valor absoluto da VALIDATION_ERROR y no se crea ninguna cuenta', async () => {
    const userId = await userInStep2();
    const input: Step2Input = {
      accounts: [
        entry('Efectivo (Bs)', 'cash', 'BOB', '20.00'),
        entry('Banco (Bs)', 'bank', 'BOB', '-1000000000.00'),
      ],
    };

    await expectCode(service.step2(ctxFor(userId), input), 'VALIDATION_ERROR');

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });
});

// ---------- Names ----------

describe('TASK-157 OnboardingService.step2: nombres', () => {
  it('EC-M10-02 dos cuentas con el mismo nombre dan NAME_TAKEN y no se crea ninguna', async () => {
    const userId = await userInStep2();
    // "Banco (Bs)" renamed to the name of the cash account.
    const input: Step2Input = {
      accounts: [
        entry('Efectivo (Bs)', 'cash', 'BOB', '100.00'),
        entry('Efectivo (Bs)', 'bank', 'BOB', '200.00'),
      ],
    };

    await expectCode(service.step2(ctxFor(userId), input), 'NAME_TAKEN');

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('RF-M4-01 EC-M10-02 los nombres se comparan sin distinguir mayúsculas', async () => {
    const userId = await userInStep2();
    const input: Step2Input = {
      accounts: [
        entry('Mi Banco', 'bank', 'BOB', '100.00'),
        entry('MI BANCO', 'savings', 'BOB', '200.00'),
      ],
    };

    await expectCode(service.step2(ctxFor(userId), input), 'NAME_TAKEN');

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('RF-M4-01 un nombre que ya usa una cuenta activa del usuario da NAME_TAKEN', async () => {
    const userId = await userInStep2();
    const existing = await createAccount(userId, { name: 'Ahorros', type: 'savings' });
    const input: Step2Input = {
      accounts: [
        entry('Efectivo (Bs)', 'cash', 'BOB', '20.00'),
        entry('ahorros', 'savings', 'BOB', '300.00'),
      ],
    };

    await expectCode(service.step2(ctxFor(userId), input), 'NAME_TAKEN');

    expect((await accountsOf(userId)).map((account) => account.id)).toEqual([existing.id]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('RF-M4-01 el nombre de una cuenta archivada queda libre', async () => {
    const userId = await userInStep2();
    const archived = await createAccount(userId, { name: 'Banco (Bs)', status: 'archived' });
    const created = entry('Banco (Bs)', 'bank', 'BOB', '700.00');

    await service.step2(ctxFor(userId), { accounts: [created] });

    const stored = await accountsOf(userId);
    expect(stored.find((account) => account.id === archived.id)?.status).toBe('archived');
    expect(stored.filter((account) => account.id !== archived.id)).toEqual(
      expectedAccounts([created]),
    );
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });
});

// ---------- Idempotency ----------

describe('TASK-157 OnboardingService.step2: reenvíos', () => {
  it('TASK-157 reenviar el paso con los mismos ids no duplica las cuentas', async () => {
    const userId = await userInStep2();
    const input: Step2Input = {
      accounts: [
        entry('Efectivo (Bs)', 'cash', 'BOB', '150.00'),
        entry('Banco (Bs)', 'bank', 'BOB', '900.00'),
      ],
    };
    await service.step2(ctxFor(userId), input);
    const before = await accountsOf(userId);

    // The step already moved on: the repeated step 2 does not advance twice (plan §4.10.3).
    expectStepMismatchError(await rejectionOf(service.step2(ctxFor(userId), input)), 3);

    expect(before).toEqual(expectedAccounts(input.accounts));
    expect(await accountsOf(userId)).toEqual(before);
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('TASK-157 dos step2 simultáneos con los mismos ids crean cada cuenta una sola vez y avanzan una sola vez', async () => {
    const userId = await userInStep2();
    const input: Step2Input = {
      accounts: [
        entry('Efectivo (Bs)', 'cash', 'BOB', '150.00'),
        entry('Banco (Bs)', 'bank', 'BOB', '900.00'),
      ],
    };

    const results = await Promise.allSettled([
      service.step2(ctxFor(userId), input),
      service.step2(ctxFor(userId), input),
    ]);

    const rejected = reasonsOf(results);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectStepMismatchError(rejected[0], 3);
    expect(await accountsOf(userId)).toEqual(expectedAccounts(input.accounts));
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('TASK-157 tras un rechazo, reenviar el paso corregido con los mismos ids crea cada cuenta una vez', async () => {
    const userId = await userInStep2();
    const cash = entry('Efectivo (Bs)', 'cash', 'BOB', '-50.00');
    const bank = entry('Banco (Bs)', 'bank', 'BOB', '900.00');
    await expectCode(service.step2(ctxFor(userId), { accounts: [bank, cash] }), 'VALIDATION_ERROR');

    const corrected: Step2Account = { ...cash, balance: '50.00' };
    await service.step2(ctxFor(userId), { accounts: [bank, corrected] });

    expect(await accountsOf(userId)).toEqual(expectedAccounts([bank, corrected]));
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });
});

// ---------- Step and end ----------

describe('TASK-157 OnboardingService.step2: paso pendiente', () => {
  it('TASK-157 en el paso 1, step2 da STEP_MISMATCH con el paso actual y no crea cuentas', async () => {
    const user = await createUser();
    const input: Step2Input = { accounts: [entry('Efectivo (Bs)', 'cash', 'BOB', '10.00')] };

    expectStepMismatchError(await rejectionOf(service.step2(ctxFor(user.id), input)), 1);

    expect(await accountsOf(user.id)).toEqual([]);
    expect(await progressOf(user.id)).toEqual({ step: 1, completed: false });
  });

  it('TASK-157 en el paso 3, step2 da STEP_MISMATCH con el paso actual y no crea cuentas', async () => {
    const userId = await userInStep2();
    await setOnboarding(userId, 3);
    const input: Step2Input = { accounts: [entry('Efectivo (Bs)', 'cash', 'BOB', '10.00')] };

    expectStepMismatchError(await rejectionOf(service.step2(ctxFor(userId), input)), 3);

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('TASK-157 con el Onboarding terminado, step2 responde ONBOARDING_DONE y no crea cuentas', async () => {
    const userId = await userInStep2();
    // Finished while the stored step is still 2: the step matches, the end still wins.
    await setOnboarding(userId, 2, true);
    const input: Step2Input = { accounts: [entry('Efectivo (Bs)', 'cash', 'BOB', '10.00')] };

    await expectCode(service.step2(ctxFor(userId), input), 'ONBOARDING_DONE');

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: true });
  });
});

// ---------- Isolation ----------

describe('TASK-157 OnboardingService.step2: aislamiento', () => {
  it('RF-M4-01 TASK-157 el paso 2 de un usuario no choca con los nombres de otro ni toca sus cuentas ni su Onboarding', async () => {
    const [ana, beto] = await Promise.all([userInStep2(), userInStep2()]);
    const betoCash = await createAccount(beto, { name: 'Efectivo (Bs)', type: 'cash' });
    const before = await accountsOf(beto);
    const input: Step2Input = { accounts: [entry('Efectivo (Bs)', 'cash', 'BOB', '80.00')] };

    await service.step2(ctxFor(ana), input);

    expect(await accountsOf(ana)).toEqual(expectedAccounts(input.accounts));
    expect(await progressOf(ana)).toEqual({ step: 3, completed: false });
    expect(before.map((account) => account.id)).toEqual([betoCash.id]);
    expect(await accountsOf(beto)).toEqual(before);
    expect(await progressOf(beto)).toEqual({ step: 2, completed: false });
  });
});
