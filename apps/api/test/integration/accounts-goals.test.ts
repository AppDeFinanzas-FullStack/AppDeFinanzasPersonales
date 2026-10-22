import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createAccountsService } from '../../src/application/services/accounts.service.js';
import {
  createRatesService,
  type RatesContext,
} from '../../src/application/services/rates.service.js';
import {
  createRegisterService,
  type RegisterUsageReader,
} from '../../src/application/services/register.service.js';
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
const ledgerHooks = createLedgerHooks();
const accounts = createAccountsService({ uow, rates, ledgerHooks });

const usage: RegisterUsageReader = {
  read: () =>
    Promise.resolve({
      categoryUses: [],
      seeded: [],
      lastAccount: { expense: null, income: null },
      lastTransfer: null,
    }),
  createdSince: () => Promise.resolve([]),
};
const register = createRegisterService({
  uow,
  usage,
  accounts,
  shortcuts: { listVisible: () => Promise.resolve([]) } as never,
  transactions: {} as never,
});

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z');
const TODAY = '2090-06-15';

interface SavedRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

let savedRates: SavedRate[] = [];
const usedUserIds: string[] = [];

async function marketRate(kind: string, value: string): Promise<void> {
  const source = kind === 'official' ? 'bcb' : 'paralelo_bo';
  await prisma.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${kind}::market_rate_kind, ${TODAY}::date, ${value}::numeric,
            ${new Date(`${TODAY}T12:00:00Z`)}, ${source}::rate_source)`;
}

beforeAll(async () => {
  savedRates = await prisma.$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate`;
});

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate`;
  await marketRate('parallel_bid', '10.30');
  await marketRate('parallel_ask', '10.50');
  await marketRate('parallel_median', '10.40');
  await marketRate('official', '6.96');
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate`;
  for (const row of savedRates) {
    await prisma.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
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

const bank = (userId: string, balance: string): ReturnType<typeof createAccount> =>
  createAccount(userId, { initialBalance: balance, initialBalanceDate: '2090-01-01' });

describe('AccountsService: cuentas con apartados y dedicadas', () => {
  it('EC-M12-02 archivar una cuenta con apartados da ACCOUNT_HAS_EARMARKS con las metas', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, { name: 'Viaje a Uyuni' });
    await createAllocationEvent(userId, goal.id, account.id, { amount: '200.00' });

    const error = await rejectionOf(
      accounts.archive(ctxFor(userId), account.id, { confirmNonZero: true }),
    );

    expect(error.code).toBe('ACCOUNT_HAS_EARMARKS');
    expect(error.status).toBe(409);
    expect(JSON.stringify(error.data)).toContain(goal.id);
    const [stored] = await accounts.list(ctxFor(userId), 'active');
    expect(stored?.id).toBe(account.id);
  });

  it('EC-M12-02 archivar una cuenta sin apartados sigue funcionando', async () => {
    const userId = await newUser();
    const account = await bank(userId, '0.00');
    const goal = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, account.id, { amount: '200.00' });
    await createAllocationEvent(userId, goal.id, account.id, { amount: '-200.00' });

    const archived = await accounts.archive(ctxFor(userId), account.id, { confirmNonZero: false });

    expect(archived.status).toBe('archived');
  });

  it('RF-M12-08 archivar una cuenta dedicada da ACCOUNT_DEDICATED', async () => {
    const userId = await newUser();
    const account = await bank(userId, '300.00');
    await createGoal(userId, { dedicatedAccountId: account.id });

    const error = await rejectionOf(
      accounts.archive(ctxFor(userId), account.id, { confirmNonZero: true }),
    );

    expect(error.code).toBe('ACCOUNT_DEDICATED');
    expect(error.status).toBe(409);
  });

  it('RF-M12-08 eliminar una cuenta dedicada da ACCOUNT_DEDICATED', async () => {
    const userId = await newUser();
    const account = await bank(userId, '0.00');
    await createGoal(userId, { dedicatedAccountId: account.id });

    const error = await rejectionOf(accounts.remove(ctxFor(userId), account.id));

    expect(error.code).toBe('ACCOUNT_DEDICATED');
    expect(error.status).toBe(409);
  });

  it('RF-M4-07 pasar a tarjeta una cuenta dedicada da TYPE_CHANGE_INVALID', async () => {
    const userId = await newUser();
    const account = await bank(userId, '0.00');
    await createGoal(userId, { dedicatedAccountId: account.id });

    const error = await rejectionOf(
      accounts.update(ctxFor(userId), account.id, {
        type: 'credit_card',
        card: { cutDay: 1, payDay: 10, limit: '1000.00' },
      }),
    );

    expect(error.code).toBe('TYPE_CHANGE_INVALID');
    expect(error.status).toBe(422);
  });

  it('RF-M4-07 pasar a tarjeta una cuenta con apartados da TYPE_CHANGE_INVALID', async () => {
    const userId = await newUser();
    const account = await bank(userId, '0.00');
    const goal = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, account.id, { amount: '50.00' });

    const error = await rejectionOf(
      accounts.update(ctxFor(userId), account.id, {
        type: 'credit_card',
        card: { cutDay: 1, payDay: 10, limit: '1000.00' },
      }),
    );

    expect(error.code).toBe('TYPE_CHANGE_INVALID');
    expect(error.status).toBe(422);
  });

  it('RF-M4-07 pasar a tarjeta una cuenta libre de metas sigue permitido', async () => {
    const userId = await newUser();
    const account = await bank(userId, '0.00');

    const updated = await accounts.update(ctxFor(userId), account.id, {
      type: 'credit_card',
      card: { cutDay: 1, payDay: 10, limit: '1000.00' },
    });

    expect(updated.type).toBe('credit_card');
  });

  it('RF-M12-08 el AccountDto trae earmarked, free y dedicatedGoal', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const plain = await bank(userId, '100.00');
    const dedicatedAccount = await bank(userId, '300.00');
    const goal = await createGoal(userId, {});
    const dedicated = await createGoal(userId, {
      name: 'Casa',
      dedicatedAccountId: dedicatedAccount.id,
    });
    await createAllocationEvent(userId, goal.id, account.id, { amount: '200.00' });

    const list = await accounts.list(ctxFor(userId), 'active');
    const byId = new Map(list.map((a) => [a.id, a]));

    expect(byId.get(account.id)).toMatchObject({
      balance: '500.00',
      earmarked: '200.00',
      free: '300.00',
    });
    expect(byId.get(account.id)?.dedicatedGoal).toBeUndefined();
    expect(byId.get(plain.id)).toMatchObject({ earmarked: '0.00', free: '100.00' });
    expect(byId.get(dedicatedAccount.id)?.dedicatedGoal).toEqual({
      id: dedicated.id,
      name: 'Casa',
    });
  });

  it('RF-M4-10 el total neto no cambia al apartar y el desglose suma Apartado para metas', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const before = await accounts.summary(ctxFor(userId));
    expect(before.breakdown.earmarked).toBe('0.00');

    const goal = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, account.id, { amount: '200.00' });
    const after = await accounts.summary(ctxFor(userId));

    expect(after.netWorth).toEqual(before.netWorth);
    expect(after.breakdown.liquid).toBe(before.breakdown.liquid);
    expect(after.breakdown.earmarked).toBe('200.00');
  });

  it('RF-M12-08 el desglose suma los apartados más el saldo positivo de las dedicadas', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const dedicatedAccount = await bank(userId, '300.00');
    const before = await accounts.summary(ctxFor(userId));

    const goal = await createGoal(userId, {});
    await createGoal(userId, { dedicatedAccountId: dedicatedAccount.id });
    await createAllocationEvent(userId, goal.id, account.id, { amount: '200.00' });
    const after = await accounts.summary(ctxFor(userId));

    expect(after.netWorth).toEqual(before.netWorth);
    expect(after.breakdown.earmarked).toBe('500.00');
  });

  it('RF-M7-11 la ficha de Registrar recibe el saldo libre', async () => {
    const userId = await newUser();
    const account = await bank(userId, '500.00');
    const goal = await createGoal(userId, {});
    await createAllocationEvent(userId, goal.id, account.id, { amount: '200.00' });

    const context = await register.context(ctxFor(userId));

    const found = context.accounts.find((a) => a.id === account.id);
    expect(found).toMatchObject({ balance: '500.00', earmarked: '200.00', free: '300.00' });
  });
});
