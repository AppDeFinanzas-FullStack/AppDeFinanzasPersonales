import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createDashboardService } from '../../src/application/services/dashboard.service.js';
import { createDashboardRepository } from '../../src/infrastructure/persistence/repositories/dashboard.repository.js';
import { createUserSettingsRepository } from '../../src/infrastructure/persistence/repositories/user-settings.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import {
  categoryIdOf,
  createLedgerTransaction,
  deleteLedgerOf,
} from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `GET /api/dashboard?month` and the `DashboardDto` (plan §4.8.2, TASK-143) but not
 * how the service is built. These tests assume, like those of `RatesService`:
 * - `createDashboardService({ uow })` builds it over the `UnitOfWork`, whose repositories expose
 *   `dashboard` (`createDashboardRepository(tx, userId)`).
 * - `cards(ctx, month)` with `ctx = { userId, timezone, now, traceId }` and `month = 'YYYY-MM'`
 *   returns `{ range, cards }` with the shapes of `DashboardDto.range` and `DashboardDto.cards`.
 * - A variation that cannot be computed (previous value 0) is `null` (the web shows a dash).
 * - The base currency is BOB (the default of a new user).
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';

const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx, userId) => ({
  dashboard: createDashboardRepository(tx, userId ?? NIL_USER),
  userSettings: createUserSettingsRepository(tx),
}));

interface Cards {
  income: string;
  expense: string;
  balance: string;
  savingsRatePct: number | null;
  variations: {
    income: string | null;
    expense: string | null;
    balance: string | null;
    savingsRatePp: number | null;
  };
}

interface CardsResult {
  range: { firstMonth: string; currentMonth: string };
  cards: Cards;
}

interface DashboardCards {
  cards(
    ctx: { userId: string; timezone: string; now: Date; traceId: string },
    month: string,
  ): Promise<CardsResult>;
}

const service = createDashboardService({ uow }) as unknown as DashboardCards;

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z'); // 2090-06-15, 12:00 in La Paz

const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

async function newUser(): Promise<TestUser> {
  const user = await createUser();
  usedUserIds.push(user.id);
  return user;
}

const cardsOf = (userId: string, month: string): Promise<CardsResult> =>
  service.cards({ userId, timezone: TZ, now: NOW, traceId: uuidv7() }, month);

type Kind = 'income' | 'expense';

async function move(
  userId: string,
  accountId: string,
  kind: Kind,
  date: string,
  amount: string,
  options: { categoryId?: string; rates?: { curBob: string; usdBob: string } } = {},
): Promise<string> {
  const signed = kind === 'income' ? amount : `-${amount}`;
  const tx = await createLedgerTransaction(userId, {
    kind,
    date,
    entries: [{ accountId, amount: signed }],
    ...(options.categoryId === undefined ? {} : { categoryId: options.categoryId }),
  });
  if (options.rates) {
    await testPrisma().$executeRaw`
      UPDATE ledger_transaction
         SET rate_cur_bob = ${options.rates.curBob}::numeric,
             rate_usd_bob = ${options.rates.usdBob}::numeric
       WHERE id = ${tx.id}::uuid`;
  }
  return tx.id;
}

async function systemCategory(
  userId: string,
  key: 'debts' | 'debts_interest',
): Promise<{ id: string; kind: Kind }> {
  const rows = await testPrisma().$queryRaw<{ id: string; kind: Kind }[]>`
    SELECT id::text AS id, kind::text AS kind FROM category
     WHERE user_id = ${userId}::uuid AND system_key = ${key}::system_category_key`;
  const row = rows[0];
  if (!row) {
    throw new Error(`No system category ${key}`);
  }
  return row;
}

describe('TASK-145 DashboardService: tarjetas', () => {
  it('RN-02 Préstamos no inflan los ingresos: el préstamo no suma en Ingresos pero sí en el saldo', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, { initialBalanceDate: '2090-01-01' });
    const debts = await systemCategory(user.id, 'debts');
    await move(user.id, account.id, 'income', '2090-05-10', '5000.00', { categoryId: debts.id });
    await move(user.id, account.id, 'income', '2090-05-11', '1000.00');

    const { cards } = await cardsOf(user.id, '2090-05');

    expect(cards.income).toBe('1000.00');
    const rows = await testPrisma().$queryRaw<{ balance: string }[]>`
      SELECT (SELECT initial_balance FROM account WHERE id = ${account.id}::uuid)
           + COALESCE(SUM(amount), 0) AS balance
        FROM ledger_entry WHERE account_id = ${account.id}::uuid`;
    expect(Number(rows[0]?.balance)).toBe(6000);
  });

  it('RN-02 la subcategoría Intereses sí cuenta; transferencias y ajustes no cuentan', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const other = await createAccount(user.id);
    const interest = await systemCategory(user.id, 'debts_interest');
    await move(user.id, account.id, interest.kind, '2090-05-10', '30.00', {
      categoryId: interest.id,
    });
    await createLedgerTransaction(user.id, {
      kind: 'transfer',
      date: '2090-05-11',
      entries: [
        { accountId: account.id, amount: '-400.00' },
        { accountId: other.id, amount: '400.00' },
      ],
    });
    await createLedgerTransaction(user.id, {
      kind: 'adjustment',
      date: '2090-05-12',
      entries: [{ accountId: account.id, amount: '-77.00' }],
    });

    const { cards } = await cardsOf(user.id, '2090-05');

    const counted = interest.kind === 'income' ? cards.income : cards.expense;
    const notCounted = interest.kind === 'income' ? cards.expense : cards.income;
    expect(counted).toBe('30.00');
    expect(notCounted).toBe('0.00');
  });

  it('RF-M8-02 convierte con la tasa guardada en cada movimiento (RN-05)', async () => {
    const user = await newUser();
    const usd = await createAccount(user.id, { currencyCode: 'USD' });
    await move(user.id, usd.id, 'expense', '2090-05-10', '10.00', {
      rates: { curBob: '6.96', usdBob: '6.96' },
    });
    await move(user.id, usd.id, 'expense', '2090-05-20', '10.00', {
      rates: { curBob: '9.00', usdBob: '9.00' },
    });

    const { cards } = await cardsOf(user.id, '2090-05');

    expect(cards.expense).toBe('159.60');
  });

  it('RF-M8-02 solo cuenta los movimientos del propio usuario', async () => {
    const user = await newUser();
    const stranger = await newUser();
    const mine = await createAccount(user.id);
    const theirs = await createAccount(stranger.id);
    await move(user.id, mine.id, 'income', '2090-05-10', '100.00');
    await move(stranger.id, theirs.id, 'income', '2090-05-10', '999.00');

    const { cards } = await cardsOf(user.id, '2090-05');

    expect(cards.income).toBe('100.00');
  });

  it('RF-M8-03 balance = ingresos - gastos y tasa de ahorro con la mitad hacia arriba', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    await move(user.id, account.id, 'income', '2090-05-10', '1000.00');
    await move(user.id, account.id, 'expense', '2090-05-11', '255.00');

    const { cards } = await cardsOf(user.id, '2090-05');

    expect(cards.balance).toBe('745.00');
    expect(cards.savingsRatePct).toBe(75); // 74,5 sube a 75
  });

  it('RF-M8-03 la tasa de ahorro se oculta con balance negativo y sin ingresos', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    await move(user.id, account.id, 'expense', '2090-05-11', '50.00');
    const withoutIncome = await cardsOf(user.id, '2090-05');
    expect(withoutIncome.cards.savingsRatePct).toBeNull();

    await move(user.id, account.id, 'income', '2090-05-12', '20.00');
    const negative = await cardsOf(user.id, '2090-05');
    expect(negative.cards.balance).toBe('-30.00');
    expect(negative.cards.savingsRatePct).toBeNull();
  });

  it('EC-M8-02 un mes sin movimientos da tarjetas en 0 y la tasa de ahorro en null', async () => {
    const user = await newUser();
    await createAccount(user.id, { initialBalanceDate: '2090-01-01' });

    const { cards } = await cardsOf(user.id, '2090-05');

    expect(cards.income).toBe('0.00');
    expect(cards.expense).toBe('0.00');
    expect(cards.balance).toBe('0.00');
    expect(cards.savingsRatePct).toBeNull();
  });

  it('RF-M8-01 el rango empieza en el mes del primer saldo inicial y no incluye meses futuros', async () => {
    const user = await newUser();
    await createAccount(user.id, { initialBalanceDate: '2090-03-10' });
    const later = await createAccount(user.id, { initialBalanceDate: '2090-04-01' });
    await move(user.id, later.id, 'income', '2090-04-05', '10.00');

    const { range } = await cardsOf(user.id, '2090-06');

    expect(range).toEqual({ firstMonth: '2090-03', currentMonth: '2090-06' });
  });

  it('RF-M8-01 el rango empieza en el primer movimiento si es anterior al saldo inicial', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, { initialBalanceDate: '2090-03-10' });
    await move(user.id, account.id, 'expense', '2090-02-10', '10.00');

    const { range } = await cardsOf(user.id, '2090-06');

    expect(range.firstMonth).toBe('2090-02');
    expect(range.currentMonth).toBe('2090-06');
  });

  it('RN-12 un gasto anterior al saldo inicial cuenta en los gastos del mes', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, { initialBalanceDate: '2090-03-01' });
    await move(user.id, account.id, 'expense', '2090-02-10', '40.00');

    const { cards } = await cardsOf(user.id, '2090-02');

    expect(cards.expense).toBe('40.00');
  });

  it('RF-M8-04 en un mes cerrado compara contra el mes anterior completo', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const expenseCat = await categoryIdOf(user.id, 'expense');
    await move(user.id, account.id, 'income', '2090-05-10', '200.00');
    await move(user.id, account.id, 'income', '2090-04-28', '100.00');
    await move(user.id, account.id, 'expense', '2090-05-12', '30.00', { categoryId: expenseCat });

    const { cards } = await cardsOf(user.id, '2090-05');

    expect(cards.variations.income).toMatch(/100/);
    expect(cards.variations.balance).toBe('70.00'); // 170 - 100
    expect(cards.variations.expense).toBeNull(); // el gasto anterior es 0
    expect(cards.variations.savingsRatePp).toBe(-15); // 85 - 100
  });

  it('RF-M8-04 en el mes en curso compara contra el mismo tramo de días del mes anterior', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    await move(user.id, account.id, 'income', '2090-06-10', '300.00');
    await move(user.id, account.id, 'income', '2090-05-10', '100.00');
    // Después del día 15 de mayo: no entra en el tramo comparado.
    await move(user.id, account.id, 'income', '2090-05-20', '900.00');

    const { cards } = await cardsOf(user.id, '2090-06');

    expect(cards.income).toBe('300.00');
    expect(cards.variations.income).toMatch(/200/);
    expect(cards.variations.balance).toBe('200.00');
  });
});
