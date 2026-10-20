import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type {
  Repositories,
  TransactionKind,
  TransactionOrigin,
} from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount, type TestAccount } from '../factories/account.factory.js';
import {
  createCategory,
  createCategoryRule,
  deleteCategoryUsageOf,
} from '../factories/category.factory.js';
import { categoryIdOf, deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes the operations of the ledger repository (tasks.md, TASK-119: `list(filters,
 * cursor)`, `summary(filters, base)` and `get(id)`) but not their shapes. These tests assume, like
 * those of TASK-099:
 * - `createLedgerRepository(tx, userId)` builds the repository; `Repositories` exposes it as
 *   `ledger`. The user comes from the `UnitOfWork` (`userLock`), never from an argument (ADR-05).
 * - The filters are those of `ListQuery` (plan §4.6.1) once the month is resolved: `from` and `to`
 *   (`YYYY-MM-DD`, both ends included), and optionally `accountId`, `categoryId`, `kind` and `q`,
 *   plus the page size `limit`. They never carry the base currency. `cursor` is `null` for the
 *   first page, and otherwise the `nextCursor` of the previous page.
 * - `list` returns `{ items, nextCursor, dayNets }`. `items` are the movements of the page, from
 *   the most recent to the oldest by `(date, created_at, id)`; each one has at least `id`, `kind`,
 *   `date`, `origin` and `originId`. `nextCursor` is `null` on the last page. `dayNets` has one
 *   `{ date, net }` per day of the page, with `net` a `Decimal` (income minus expense, RF-M6-12).
 *   The `dayNets` tests only use BOB movements of a user whose base is BOB, so the net in the base
 *   is the net in BOB.
 * - `summary(filters, base)` takes the code of the base currency and returns
 *   `{ income, expense, net }` as `Decimal`, with `expense` as a positive amount and
 *   `net = income - expense`, each movement converted with the rates stored in it (RN-05):
 *   `amount × rate_cur_bob ÷ (1 in BOB, or rate_usd_bob in USD)`.
 * - `get(id)` returns `null` when the user has no such movement; otherwise the movement with its
 *   `origin`, `originId`, `entries` (`{ accountId, amount }`, the amount a signed `Decimal`) and
 *   `fee`, the fee transaction (`origin = fee`) whose parent is this one, or `null` without one.
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';

const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx, userId) => ({
  ledger: createLedgerRepository(tx, userId ?? NIL_USER),
}));

const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteCategoryUsageOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

async function newUser(): Promise<TestUser> {
  const user = await createUser();
  usedUserIds.push(user.id);
  return user;
}

// The read side of the ledger as these tests use it (see the assumptions above).

interface LedgerListFilters {
  from: string;
  to: string;
  limit: number;
  accountId?: string;
  categoryId?: string;
  kind?: TransactionKind;
  q?: string;
}

interface LedgerListItem {
  id: string;
  kind: TransactionKind;
  date: string;
  origin: TransactionOrigin;
  originId: string | null;
}

interface LedgerDetail extends LedgerListItem {
  entries: { accountId: string; amount: Decimal }[];
  fee?: LedgerListItem | null;
}

interface LedgerPage {
  items: LedgerListItem[];
  nextCursor: string | null;
  dayNets: { date: string; net: Decimal }[];
}

interface LedgerTotals {
  income: Decimal;
  expense: Decimal;
  net: Decimal;
}

interface LedgerReads {
  list(filters: LedgerListFilters, cursor: string | null): Promise<LedgerPage>;
  summary(filters: LedgerListFilters, base: string): Promise<LedgerTotals>;
  get(id: string): Promise<LedgerDetail | null>;
}

/** Runs `fn` with the ledger repository of the user, inside one UnitOfWork. */
const withLedger = <T>(userId: string, fn: (ledger: LedgerReads) => Promise<T>) =>
  uow.run((repos: Repositories) => fn(repos.ledger as unknown as LedgerReads), {
    userLock: userId,
  });

const fixed = (value: Decimal | string | number): string => new Decimal(value).toFixed(2);

const FROM = '2026-01-01';
const TO = '2026-12-31';

interface FilterOverrides {
  from?: string;
  to?: string;
  accountId?: string;
  categoryId?: string;
  kind?: TransactionKind;
  q?: string;
  limit?: number;
}

/** The filters of the year 2026 with a page of 50, plus the overrides. */
function filters(overrides: FilterOverrides = {}) {
  return { from: FROM, to: TO, limit: 50, ...overrides };
}

/** A BOB account whose initial balance date comes before every movement of the tests. */
function bobAccount(userId: string, type: 'bank' | 'cash' = 'bank'): Promise<TestAccount> {
  return createAccount(userId, { type, initialBalanceDate: '2025-01-01' });
}

function usdAccount(userId: string): Promise<TestAccount> {
  return createAccount(userId, { currencyCode: 'USD', initialBalanceDate: '2025-01-01' });
}

/** The id of a system category of the user ("Deudas y préstamos" or its "Intereses"). */
async function systemCategoryId(
  userId: string,
  kind: 'expense' | 'income',
  key: 'debts' | 'debts_interest',
): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM category
     WHERE user_id = ${userId}::uuid AND kind = ${kind}::category_kind
       AND system_key = ${key}::system_category_key`;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(`The user has no ${kind} ${key} category`);
  }
  return id;
}

interface MovementOptions {
  kind?: TransactionKind;
  /** `YYYY-MM-DD`; every entry copies it. */
  date: string;
  /** Required by `expense` and `income`; one of the user's categories when omitted. */
  categoryId?: string;
  note?: string | null;
  /** The moment of registration; `now()` when omitted. */
  createdAt?: Date;
  origin?: TransactionOrigin;
  originId?: string | null;
  parentTransactionId?: string | null;
  rateCurBob?: string;
  rateUsdBob?: string | null;
  deletedAt?: Date | null;
  /** Signed decimal text: positive comes into the account, negative goes out (ADR-04). */
  entries: { accountId: string; amount: string }[];
}

/**
 * Writes a `ledger_transaction` and its entries straight by SQL, with every column the list reads,
 * so these tests never depend on the code that writes the ledger. By default it is a manual expense
 * in BOB (`rate_cur_bob` 1.00, `rate_usd_bob` 6.96). Returns its id.
 */
async function insertMovement(userId: string, options: MovementOptions): Promise<string> {
  const id = uuidv7();
  const kind = options.kind ?? 'expense';
  const needsCategory = kind === 'expense' || kind === 'income';
  const categoryId = needsCategory
    ? (options.categoryId ?? (await categoryIdOf(userId, kind)))
    : null;
  const rateUsdBob = options.rateUsdBob === undefined ? '6.96' : options.rateUsdBob;
  const db = testPrisma();

  await db.$executeRaw`
    INSERT INTO ledger_transaction (id, user_id, kind, date, note, category_id, origin, origin_id,
                                    parent_transaction_id, rate_cur_bob, rate_usd_bob, created_at,
                                    deleted_at)
    VALUES (${id}::uuid, ${userId}::uuid, ${kind}::transaction_kind, ${options.date}::date,
            ${options.note ?? null}, ${categoryId}::uuid,
            ${options.origin ?? 'manual'}::transaction_origin, ${options.originId ?? null}::uuid,
            ${options.parentTransactionId ?? null}::uuid, ${options.rateCurBob ?? '1.00'}::numeric,
            ${rateUsdBob}::numeric, COALESCE(${options.createdAt ?? null}::timestamptz, now()),
            ${options.deletedAt ?? null}::timestamptz)`;

  for (const entry of options.entries) {
    await db.$executeRaw`
      INSERT INTO ledger_entry (id, user_id, transaction_id, account_id, amount, date)
      VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${id}::uuid, ${entry.accountId}::uuid,
              ${entry.amount}::numeric, ${options.date}::date)`;
  }
  return id;
}

/** A BOB expense of `amount` (positive text) on the account. */
function expense(
  userId: string,
  accountId: string,
  date: string,
  amount: string,
  extra: Partial<MovementOptions> = {},
): Promise<string> {
  return insertMovement(userId, {
    kind: 'expense',
    date,
    entries: [{ accountId, amount: `-${amount}` }],
    ...extra,
  });
}

/** A BOB income of `amount` (positive text) on the account. */
function income(
  userId: string,
  accountId: string,
  date: string,
  amount: string,
  extra: Partial<MovementOptions> = {},
): Promise<string> {
  return insertMovement(userId, {
    kind: 'income',
    date,
    entries: [{ accountId, amount }],
    ...extra,
  });
}

/** A moment of 2026-06-10 at that hour, UTC. */
const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 5, 10, hour, minute, 0));

const idsOf = (items: readonly { id: string }[]): string[] => items.map((item) => item.id);

const sortedIds = (items: readonly { id: string }[]): string[] => idsOf(items).sort();

/** The net of each day of `dayNets`, as text, keyed by date. */
function netsByDate(dayNets: readonly { date: string; net: Decimal }[]): Record<string, string> {
  return Object.fromEntries(dayNets.map((day) => [day.date, fixed(day.net)]));
}

interface SummaryText {
  income: string;
  expense: string;
  net: string;
}

function summaryText(summary: { income: Decimal; expense: Decimal; net: Decimal }): SummaryText {
  return {
    income: fixed(summary.income),
    expense: fixed(summary.expense),
    net: fixed(summary.net),
  };
}

/**
 * A day with one movement of each kind that RN-02 leaves out, plus three that count: an income of
 * 100, an expense of 35 and an expense of 5 in "Intereses", so its net is 60.
 */
async function rn02Day(userId: string, date: string): Promise<void> {
  const bank = await bobAccount(userId);
  const cash = await bobAccount(userId, 'cash');
  const debtsExpense = await systemCategoryId(userId, 'expense', 'debts');
  const interestExpense = await systemCategoryId(userId, 'expense', 'debts_interest');
  const debtsIncome = await systemCategoryId(userId, 'income', 'debts');

  // Count: +100 − 35 − 5 = 60.
  await income(userId, bank.id, date, '100.00');
  await expense(userId, bank.id, date, '35.00');
  await expense(userId, bank.id, date, '5.00', { categoryId: interestExpense });
  // Left out by RN-02.
  await insertMovement(userId, {
    kind: 'transfer',
    date,
    entries: [
      { accountId: bank.id, amount: '-50.00' },
      { accountId: cash.id, amount: '50.00' },
    ],
  });
  await insertMovement(userId, {
    kind: 'adjustment',
    date,
    entries: [{ accountId: bank.id, amount: '20.00' }],
  });
  await expense(userId, bank.id, date, '40.00', { categoryId: debtsExpense });
  await income(userId, bank.id, date, '300.00', { categoryId: debtsIncome });
}

// ---------- list: orden y paginación ----------

describe('ledger.list orden', () => {
  it('RF-M6-02 dentro de un día ordena por momento de registro, del más reciente al más antiguo', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    const morning = await expense(user.id, account.id, '2026-06-10', '1.00', {
      createdAt: at(8),
    });
    const night = await expense(user.id, account.id, '2026-06-10', '2.00', {
      createdAt: at(21),
    });
    const noon = await expense(user.id, account.id, '2026-06-10', '3.00', {
      createdAt: at(12),
    });

    const page = await withLedger(user.id, (ledger) => ledger.list(filters(), null));

    expect(idsOf(page.items)).toEqual([night, noon, morning]);
  });

  it('RF-M6-02 ordena por fecha descendente y, en cada día, por registro descendente', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    // A movement of an older day registered after the ones of a newer day still goes after them.
    const oldDayLate = await expense(user.id, account.id, '2026-06-09', '1.00', {
      createdAt: at(23),
    });
    const newDayEarly = await expense(user.id, account.id, '2026-06-10', '2.00', {
      createdAt: at(7),
    });
    const newDayLate = await expense(user.id, account.id, '2026-06-10', '3.00', {
      createdAt: at(9),
    });
    const oldDayEarly = await expense(user.id, account.id, '2026-06-09', '4.00', {
      createdAt: at(6),
    });

    const page = await withLedger(user.id, (ledger) => ledger.list(filters(), null));

    expect(idsOf(page.items)).toEqual([newDayLate, newDayEarly, oldDayLate, oldDayEarly]);
    expect(page.items.map((item) => item.date)).toEqual([
      '2026-06-10',
      '2026-06-10',
      '2026-06-09',
      '2026-06-09',
    ]);
  });
});

describe('ledger.list paginación', () => {
  it('TASK-119 el cursor recorre todas las páginas en orden, sin repetir ni saltar movimientos', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    const sameMoment = at(10);
    const expected: string[] = [];
    // Two movements share their moment of registration, so the cursor needs the id to break ties.
    const days = ['2026-06-08', '2026-06-09', '2026-06-09', '2026-06-09', '2026-06-10'];
    const moments = [at(5), at(10), sameMoment, sameMoment, at(1)];
    for (const [index, date] of days.entries()) {
      expected.push(
        await expense(user.id, account.id, date, `${index + 1}.00`, {
          createdAt: moments[index] ?? at(0),
        }),
      );
    }

    const full = await withLedger(user.id, (ledger) => ledger.list(filters(), null));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const current: string | null = cursor;
      const page: LedgerPage = await withLedger(user.id, (ledger) =>
        ledger.list(filters({ limit: 2 }), current),
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...idsOf(page.items));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(full.nextCursor).toBeNull();
    expect(full.items).toHaveLength(5);
    expect(seen).toEqual(idsOf(full.items));
    expect([...seen].sort()).toEqual([...expected].sort());
    expect(pages).toBe(3);
  });

  it('TASK-119 la lista no incluye los movimientos eliminados', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    const kept = await expense(user.id, account.id, '2026-06-10', '10.00');
    await expense(user.id, account.id, '2026-06-10', '20.00', { deletedAt: new Date() });

    const page = await withLedger(user.id, (ledger) => ledger.list(filters(), null));

    expect(idsOf(page.items)).toEqual([kept]);
  });
});

// ---------- list: filtros ----------

describe('ledger.list filtros', () => {
  it('TASK-119 from y to incluyen los dos extremos y dejan fuera lo demás', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    await expense(user.id, account.id, '2026-05-31', '1.00');
    const first = await expense(user.id, account.id, '2026-06-01', '2.00');
    const last = await expense(user.id, account.id, '2026-06-30', '3.00');
    await expense(user.id, account.id, '2026-07-01', '4.00');

    const page = await withLedger(user.id, (ledger) =>
      ledger.list(filters({ from: '2026-06-01', to: '2026-06-30' }), null),
    );

    expect(sortedIds(page.items)).toEqual([first, last].sort());
  });

  it('TASK-119 accountId deja solo los movimientos con un asiento en esa cuenta, transferencias incluidas', async () => {
    const user = await newUser();
    const bank = await bobAccount(user.id);
    const cash = await bobAccount(user.id, 'cash');
    const onBank = await expense(user.id, bank.id, '2026-06-10', '10.00');
    await expense(user.id, cash.id, '2026-06-10', '20.00');
    const transfer = await insertMovement(user.id, {
      kind: 'transfer',
      date: '2026-06-10',
      entries: [
        { accountId: cash.id, amount: '-5.00' },
        { accountId: bank.id, amount: '5.00' },
      ],
    });

    const page = await withLedger(user.id, (ledger) =>
      ledger.list(filters({ accountId: bank.id }), null),
    );

    expect(sortedIds(page.items)).toEqual([onBank, transfer].sort());
  });

  it('TASK-119 kind deja solo los movimientos de ese tipo', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    await expense(user.id, account.id, '2026-06-10', '10.00');
    const earned = await income(user.id, account.id, '2026-06-10', '20.00');

    const page = await withLedger(user.id, (ledger) =>
      ledger.list(filters({ kind: 'income' }), null),
    );

    expect(idsOf(page.items)).toEqual([earned]);
  });

  it('RF-M5-03 filtrar por una categoría padre incluye los movimientos de sus subcategorías', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    const parent = await createCategory(user.id, { kind: 'expense' });
    const child = await createCategory(user.id, { parentId: parent.id });
    const other = await createCategory(user.id, { kind: 'expense' });
    const inParent = await expense(user.id, account.id, '2026-06-10', '10.00', {
      categoryId: parent.id,
    });
    const inChild = await expense(user.id, account.id, '2026-06-11', '20.00', {
      categoryId: child.id,
    });
    await expense(user.id, account.id, '2026-06-12', '30.00', { categoryId: other.id });

    const byParent = await withLedger(user.id, (ledger) =>
      ledger.list(filters({ categoryId: parent.id }), null),
    );
    const byChild = await withLedger(user.id, (ledger) =>
      ledger.list(filters({ categoryId: child.id }), null),
    );

    expect(sortedIds(byParent.items)).toEqual([inParent, inChild].sort());
    expect(idsOf(byChild.items)).toEqual([inChild]);
  });

  it('RF-M5-03 el total de un padre en summary incluye el de sus subcategorías', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    const parent = await createCategory(user.id, { kind: 'expense' });
    const child = await createCategory(user.id, { parentId: parent.id });
    const other = await createCategory(user.id, { kind: 'expense' });
    await expense(user.id, account.id, '2026-06-10', '10.00', { categoryId: parent.id });
    await expense(user.id, account.id, '2026-06-11', '20.00', { categoryId: child.id });
    await expense(user.id, account.id, '2026-06-12', '30.00', { categoryId: other.id });

    const summary = await withLedger(user.id, (ledger) =>
      ledger.summary(filters({ categoryId: parent.id }), 'BOB'),
    );

    expect(summaryText(summary)).toEqual({ income: '0.00', expense: '30.00', net: '-30.00' });
  });
});

// ---------- list: búsqueda q ----------

describe('ledger.list búsqueda', () => {
  it('TASK-119 q "35" encuentra los movimientos de 35,00 pero no los de 135, 350 ni 35,50', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    const spent = await expense(user.id, account.id, '2026-06-10', '35.00');
    const earned = await income(user.id, account.id, '2026-06-11', '35.00');
    await expense(user.id, account.id, '2026-06-10', '135.00');
    await income(user.id, account.id, '2026-06-10', '350.00');
    await expense(user.id, account.id, '2026-06-10', '35.50');

    const page = await withLedger(user.id, (ledger) => ledger.list(filters({ q: '35' }), null));

    expect(sortedIds(page.items)).toEqual([spent, earned].sort());
  });

  it('TASK-119 q con un monto busca el monto exacto en la moneda original, no en la base', async () => {
    const user = await newUser();
    const dollars = await usdAccount(user.id);
    const bolivianos = await bobAccount(user.id);
    // $ 10 at 7,00 is worth Bs 70,00, but its original amount is 10.
    const inDollars = await insertMovement(user.id, {
      kind: 'expense',
      date: '2026-06-10',
      rateCurBob: '7.00',
      rateUsdBob: '7.00',
      entries: [{ accountId: dollars.id, amount: '-10.00' }],
    });
    const inBolivianos = await expense(user.id, bolivianos.id, '2026-06-10', '70.00');

    const [byTen, bySeventy] = await withLedger(
      user.id,
      async (ledger) =>
        [
          await ledger.list(filters({ q: '10' }), null),
          await ledger.list(filters({ q: '70' }), null),
        ] as const,
    );

    expect(idsOf(byTen.items)).toEqual([inDollars]);
    expect(idsOf(bySeventy.items)).toEqual([inBolivianos]);
  });

  it('TASK-119 q "cafe" encuentra "Café" sin importar mayúsculas ni tildes', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    const coffee = await expense(user.id, account.id, '2026-06-10', '12.00', {
      note: 'Café con leche',
    });
    const upper = await expense(user.id, account.id, '2026-06-11', '8.00', {
      note: 'Un CAFÉ de la tarde',
    });
    await expense(user.id, account.id, '2026-06-10', '6.00', { note: 'Té verde' });
    await expense(user.id, account.id, '2026-06-10', '4.00', { note: null });

    const page = await withLedger(user.id, (ledger) => ledger.list(filters({ q: 'cafe' }), null));

    expect(sortedIds(page.items)).toEqual([coffee, upper].sort());
  });
});

// ---------- dayNets ----------

describe('ledger.list dayNets', () => {
  it('RF-M6-12 el neto del día excluye transferencias, ajustes y "Deudas y préstamos" salvo "Intereses"', async () => {
    const user = await newUser();
    await rn02Day(user.id, '2026-06-10');

    const page = await withLedger(user.id, (ledger) => ledger.list(filters(), null));

    expect(page.items).toHaveLength(7);
    expect(netsByDate(page.dayNets)).toEqual({ '2026-06-10': '60.00' });
  });

  it('RN-02 dayNets tiene el neto de cada día de la página y ninguno de las demás', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    await income(user.id, account.id, '2026-06-12', '100.00', { createdAt: at(10) });
    await expense(user.id, account.id, '2026-06-12', '30.00', { createdAt: at(9) });
    await expense(user.id, account.id, '2026-06-11', '15.50', { createdAt: at(10) });
    await income(user.id, account.id, '2026-06-10', '7.00', { createdAt: at(10) });

    const first = await withLedger(user.id, (ledger) => ledger.list(filters({ limit: 3 }), null));
    const cursor = first.nextCursor;
    const second = await withLedger(user.id, (ledger) =>
      ledger.list(filters({ limit: 3 }), cursor),
    );

    expect(netsByDate(first.dayNets)).toEqual({ '2026-06-12': '70.00', '2026-06-11': '-15.50' });
    expect(netsByDate(second.dayNets)).toEqual({ '2026-06-10': '7.00' });
  });
});

// ---------- summary ----------

describe('ledger.summary', () => {
  it('RN-02 summary excluye transferencias, ajustes y "Deudas y préstamos" salvo "Intereses"', async () => {
    const user = await newUser();
    await rn02Day(user.id, '2026-06-10');
    const interestIncome = await systemCategoryId(user.id, 'income', 'debts_interest');
    const account = await bobAccount(user.id);
    // Interest earned also counts.
    await income(user.id, account.id, '2026-06-11', '2.50', { categoryId: interestIncome });

    const summary = await withLedger(user.id, (ledger) => ledger.summary(filters(), 'BOB'));

    expect(summaryText(summary)).toEqual({ income: '102.50', expense: '40.00', net: '62.50' });
  });

  it('RF-M6-12 los totales siguen los mismos filtros que la lista', async () => {
    const user = await newUser();
    const bank = await bobAccount(user.id);
    const cash = await bobAccount(user.id, 'cash');
    await expense(user.id, bank.id, '2026-06-10', '10.00');
    await income(user.id, bank.id, '2026-06-11', '50.00');
    await expense(user.id, cash.id, '2026-06-10', '99.00');
    await expense(user.id, bank.id, '2026-07-01', '77.00');
    await expense(user.id, bank.id, '2026-06-12', '1000.00', { deletedAt: new Date() });

    const summary = await withLedger(user.id, (ledger) =>
      ledger.summary(filters({ from: '2026-06-01', to: '2026-06-30', accountId: bank.id }), 'BOB'),
    );

    expect(summaryText(summary)).toEqual({ income: '50.00', expense: '10.00', net: '40.00' });
  });

  it('RN-05 summary convierte cada movimiento a la base con las tasas guardadas en él', async () => {
    const user = await newUser();
    const dollars = await usdAccount(user.id);
    const bolivianos = await bobAccount(user.id);
    // $ 10 at 6,96 and $ 10 at 10,00: the stored rates, not today's.
    await insertMovement(user.id, {
      kind: 'expense',
      date: '2026-06-10',
      rateCurBob: '6.96',
      rateUsdBob: '6.96',
      entries: [{ accountId: dollars.id, amount: '-10.00' }],
    });
    await insertMovement(user.id, {
      kind: 'expense',
      date: '2026-06-11',
      rateCurBob: '10.00',
      rateUsdBob: '10.00',
      entries: [{ accountId: dollars.id, amount: '-10.00' }],
    });
    // Bs 69,60 when the dollar was 6,96 and Bs 100,00 when it was 10,00: $ 10 each.
    await expense(user.id, bolivianos.id, '2026-06-10', '69.60', { rateUsdBob: '6.96' });
    await expense(user.id, bolivianos.id, '2026-06-11', '100.00', { rateUsdBob: '10.00' });
    await income(user.id, bolivianos.id, '2026-06-12', '139.20', { rateUsdBob: '6.96' });

    const [inBob, inUsd] = await withLedger(
      user.id,
      async (ledger) =>
        [await ledger.summary(filters(), 'BOB'), await ledger.summary(filters(), 'USD')] as const,
    );

    expect(summaryText(inBob)).toEqual({ income: '139.20', expense: '339.20', net: '-200.00' });
    expect(summaryText(inUsd)).toEqual({ income: '20.00', expense: '40.00', net: '-20.00' });
  });

  it('RF-M6-11 los pendientes de un recurrente no aparecen en la lista ni cuentan en los totales', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    const categoryId = await categoryIdOf(user.id, 'expense');
    const rule = await createCategoryRule(user.id, categoryId, account.id);
    await testPrisma().$executeRaw`
      INSERT INTO recurring_occurrence (id, user_id, rule_id, scheduled_date, status, pending_since)
      VALUES (${uuidv7()}::uuid, ${user.id}::uuid, ${rule.id}::uuid, '2026-06-10'::date,
              'pending'::occurrence_status, now())`;

    const [page, summary] = await withLedger(
      user.id,
      async (ledger) =>
        [await ledger.list(filters(), null), await ledger.summary(filters(), 'BOB')] as const,
    );

    expect(page.items).toEqual([]);
    expect(page.dayNets).toEqual([]);
    expect(summaryText(summary)).toEqual({ income: '0.00', expense: '0.00', net: '0.00' });
  });
});

// ---------- get ----------

describe('ledger.get', () => {
  it('TASK-119 get trae la transferencia con sus asientos y su comisión', async () => {
    const user = await newUser();
    const bank = await bobAccount(user.id);
    const cash = await bobAccount(user.id, 'cash');
    const transfer = await insertMovement(user.id, {
      kind: 'transfer',
      date: '2026-06-10',
      entries: [
        { accountId: bank.id, amount: '-100.00' },
        { accountId: cash.id, amount: '100.00' },
      ],
    });
    const fee = await expense(user.id, bank.id, '2026-06-10', '5.00', {
      origin: 'fee',
      parentTransactionId: transfer,
    });

    const detail = await withLedger(user.id, (ledger) => ledger.get(transfer));

    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({ id: transfer, kind: 'transfer', date: '2026-06-10' });
    const entries = (detail?.entries ?? []).map((entry) => [entry.accountId, fixed(entry.amount)]);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        [bank.id, '-100.00'],
        [cash.id, '100.00'],
      ]),
    );
    expect(detail?.fee?.id).toBe(fee);
    expect(detail?.fee?.origin).toBe('fee');
  });

  it('TASK-119 get trae el origen de un movimiento vinculado para "Ir a…"', async () => {
    const user = await newUser();
    const account = await bobAccount(user.id);
    const debtId = uuidv7();
    const payment = await expense(user.id, account.id, '2026-06-10', '250.00', {
      categoryId: await systemCategoryId(user.id, 'expense', 'debts'),
      origin: 'debt_payment',
      originId: debtId,
    });
    const manual = await expense(user.id, account.id, '2026-06-10', '1.00');

    const [linked, plain] = await withLedger(
      user.id,
      async (ledger) => [await ledger.get(payment), await ledger.get(manual)] as const,
    );

    expect(linked).toMatchObject({ id: payment, origin: 'debt_payment', originId: debtId });
    expect(linked?.fee ?? null).toBeNull();
    expect(plain).toMatchObject({ id: manual, origin: 'manual', originId: null });
  });

  it('TASK-119 get de un movimiento inexistente devuelve null', async () => {
    const user = await newUser();

    expect(await withLedger(user.id, (ledger) => ledger.get(uuidv7()))).toBeNull();
  });
});

// ---------- aislamiento ----------

describe('ledger lectura aislamiento', () => {
  it('RN-09 list, summary y get no ven los movimientos de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const anaAccount = await bobAccount(ana.id);
    const betoAccount = await bobAccount(beto.id);
    const anaExpense = await expense(ana.id, anaAccount.id, '2026-06-10', '35.00', {
      note: 'Café',
    });
    const betoExpense = await expense(beto.id, betoAccount.id, '2026-06-10', '35.00', {
      note: 'Café',
    });
    await income(beto.id, betoAccount.id, '2026-06-10', '500.00');

    const [page, searched, byAccount, summary, got] = await withLedger(
      ana.id,
      async (ledger) =>
        [
          await ledger.list(filters(), null),
          await ledger.list(filters({ q: '35' }), null),
          await ledger.list(filters({ accountId: betoAccount.id }), null),
          await ledger.summary(filters(), 'BOB'),
          await ledger.get(betoExpense),
        ] as const,
    );

    expect(idsOf(page.items)).toEqual([anaExpense]);
    expect(idsOf(searched.items)).toEqual([anaExpense]);
    expect(byAccount.items).toEqual([]);
    expect(netsByDate(page.dayNets)).toEqual({ '2026-06-10': '-35.00' });
    expect(summaryText(summary)).toEqual({ income: '0.00', expense: '35.00', net: '-35.00' });
    expect(got).toBeNull();
  });
});
