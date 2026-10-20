import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createAccountRepository } from '../../src/infrastructure/persistence/repositories/account.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount, uniqueAccountName } from '../factories/account.factory.js';
import {
  categoryIdOf,
  createBulkLedger,
  createLedgerTransaction,
  deleteLedgerOf,
} from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes the operations of each repository (tasks.md, TASK-099) but not the names of their
 * factories nor their row shapes. These tests assume, like those of TASK-083:
 * - `createAccountRepository(tx, userId)` and `createLedgerRepository(tx, userId)` build a repository
 *   over the client of a transaction; `Repositories` exposes them as `accounts` (plan §4.0) and
 *   `ledger`. The user comes from the `UnitOfWork` (`userLock`), never from an argument (ADR-05).
 *   The repositories are already bound to the transaction (plan §1.4), so the `tx` of
 *   `insertTransaction(tx, header, entries)` is the bound one: `insertTransaction(header, entries)`.
 * - Amounts are `Decimal`, instants are `Date` and days are `YYYY-MM-DD` strings.
 * - An account row has `id`, `type`, `name`, `currencyCode`, `initialBalance`, `initialBalanceDate`,
 *   `color`, `icon`, `cardCutDay`, `cardPayDay`, `cardLimit`, `status`, `archivedAt` and `sortOrder`.
 *   `insert` takes the same fields without `status` and `archivedAt`; `update(id, patch)` takes some.
 * - `get` returns `null` when the user has no such account; `lockForUpdate(ids)` and `list(status)`
 *   return arrays; `count()` and `hasEntries(id)` answer for the user's accounts only.
 * - `setOrder(ids)` gives each account a `sortOrder` that follows the position of its id.
 * - `balances(accountIds)` returns a `Map` from account id to balance, with one key per account of
 *   the user among the ids. `balanceSeries(accountId, from, to)` returns `{ date, balance }` per day
 *   of the range, both ends included, in ascending order, and `[]` for an account the user lacks.
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';

const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx, userId) => ({
  accounts: createAccountRepository(tx, userId ?? NIL_USER),
  ledger: createLedgerRepository(tx, userId ?? NIL_USER),
}));

const usedUserIds: string[] = [];

afterAll(async () => {
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

const fixed = (value: Decimal | string | number): string => new Decimal(value).toFixed(2);

const withUser = <T>(userId: string, fn: (repos: Repositories) => Promise<T>) =>
  uow.run(fn, { userLock: userId });

/** Balance of one account as text, or `undefined` when the map has no key for it. */
function balanceOf(balances: Map<string, Decimal>, accountId: string): string | undefined {
  const balance = balances.get(accountId);
  return balance === undefined ? undefined : fixed(balance);
}

/** A bank account in BOB to insert through the repository. */
function newBankAccount(overrides: { name?: string; sortOrder?: number } = {}) {
  return {
    id: uuidv7(),
    type: 'bank' as const,
    name: overrides.name ?? uniqueAccountName('Banco'),
    currencyCode: 'BOB',
    initialBalance: new Decimal('1500.50'),
    initialBalanceDate: '2090-02-01',
    color: 'green',
    icon: 'bank',
    cardCutDay: null,
    cardPayDay: null,
    cardLimit: null,
    sortOrder: overrides.sortOrder ?? 1,
  };
}

/** A transaction header to insert through the ledger repository, with every column of plan §3.5. */
function header(
  kind: 'expense' | 'income' | 'transfer' | 'adjustment',
  date: string,
  categoryId: string | null = null,
) {
  return {
    id: uuidv7(),
    kind,
    date,
    note: null,
    categoryId,
    origin: 'manual' as const,
    originId: null,
    parentTransactionId: null,
    recurringRuleId: null,
    recurringLabel: null,
    rateCurBob: new Decimal('1.00'),
    rateUsdBob: new Decimal('6.96'),
    declaredRate: null,
  };
}

/** Tries to lock the account row from another connection, without waiting. */
async function tryLock(accountId: string): Promise<'free' | 'blocked'> {
  const query = `SELECT id FROM account WHERE id = '${accountId}'::uuid FOR UPDATE NOWAIT`;
  try {
    await testPrisma().$queryRawUnsafe(query);
    return 'free';
  } catch {
    return 'blocked';
  }
}

interface StoredTransaction {
  kind: string;
  date: string;
  categoryId: string | null;
  rateCurBob: string;
}

/** The header of a transaction, read outside of any UnitOfWork. */
async function storedTransactions(id: string): Promise<StoredTransaction[]> {
  return testPrisma().$queryRaw<StoredTransaction[]>`
    SELECT kind::text AS kind, to_char(date, 'YYYY-MM-DD') AS date,
           category_id::text AS "categoryId", rate_cur_bob::text AS "rateCurBob"
      FROM ledger_transaction WHERE id = ${id}::uuid`;
}

interface StoredEntry {
  id: string;
  userId: string;
  accountId: string;
  amount: string;
  date: string;
}

/** The entries of a transaction, read outside of any UnitOfWork. */
async function storedEntries(transactionId: string): Promise<StoredEntry[]> {
  return testPrisma().$queryRaw<StoredEntry[]>`
    SELECT id::text AS id, user_id::text AS "userId", account_id::text AS "accountId",
           amount::text AS amount, to_char(date, 'YYYY-MM-DD') AS date
      FROM ledger_entry WHERE transaction_id = ${transactionId}::uuid
     ORDER BY amount`;
}

// ---------- accounts: escritura y lectura ----------

describe('accounts.insert y accounts.get', () => {
  it('TASK-099 insert guarda la cuenta y get la devuelve con todos sus campos', async () => {
    const user = await newUser();
    const input = newBankAccount({ sortOrder: 7 });

    await withUser(user.id, (repos) => repos.accounts.insert(input));
    const account = await withUser(user.id, (repos) => repos.accounts.get(input.id));

    expect(account).not.toBeNull();
    expect(account).toMatchObject({
      id: input.id,
      type: 'bank',
      name: input.name,
      currencyCode: 'BOB',
      initialBalanceDate: '2090-02-01',
      color: 'green',
      icon: 'bank',
      cardCutDay: null,
      cardPayDay: null,
      cardLimit: null,
      status: 'active',
      archivedAt: null,
      sortOrder: 7,
    });
    expect(fixed(account?.initialBalance ?? 0)).toBe('1500.50');
  });

  it('TASK-099 insert de una tarjeta guarda la deuda inicial negativa, el corte, el pago y el límite', async () => {
    const user = await newUser();
    const id = uuidv7();

    await withUser(user.id, (repos) =>
      repos.accounts.insert({
        id,
        type: 'credit_card',
        name: uniqueAccountName('Tarjeta'),
        currencyCode: 'USD',
        initialBalance: new Decimal('-250.00'),
        initialBalanceDate: '2090-02-01',
        color: 'red',
        icon: 'card',
        cardCutDay: 5,
        cardPayDay: 25,
        cardLimit: new Decimal('3000.00'),
        sortOrder: 1,
      }),
    );
    const card = await withUser(user.id, (repos) => repos.accounts.get(id));

    expect(card).toMatchObject({
      type: 'credit_card',
      currencyCode: 'USD',
      cardCutDay: 5,
      cardPayDay: 25,
    });
    expect(fixed(card?.initialBalance ?? 0)).toBe('-250.00');
    expect(fixed(card?.cardLimit ?? 0)).toBe('3000.00');
  });

  it('TASK-099 get de una cuenta inexistente devuelve null', async () => {
    const user = await newUser();

    expect(await withUser(user.id, (repos) => repos.accounts.get(uuidv7()))).toBeNull();
  });
});

describe('accounts.list', () => {
  it('TASK-099 list(status) devuelve solo las cuentas de ese estado, ordenadas por sort_order', async () => {
    const user = await newUser();
    const second = await createAccount(user.id, { sortOrder: 2 });
    const first = await createAccount(user.id, { sortOrder: 1 });
    const third = await createAccount(user.id, { sortOrder: 3 });
    const archived = await createAccount(user.id, { status: 'archived', sortOrder: 4 });

    const [active, archivedList] = await withUser(
      user.id,
      async (repos) =>
        [await repos.accounts.list('active'), await repos.accounts.list('archived')] as const,
    );

    expect(active.map((account) => account.id)).toEqual([first.id, second.id, third.id]);
    expect(archivedList.map((account) => account.id)).toEqual([archived.id]);
    expect(archivedList[0]?.status).toBe('archived');
    expect(archivedList[0]?.archivedAt).toBeInstanceOf(Date);
  });
});

describe('accounts.update', () => {
  it('TASK-099 update cambia el nombre, el color y el ícono de la cuenta', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const name = uniqueAccountName('Ahorros');

    await withUser(user.id, (repos) =>
      repos.accounts.update(account.id, { name, color: 'purple', icon: 'piggy' }),
    );
    const updated = await withUser(user.id, (repos) => repos.accounts.get(account.id));

    expect(updated).toMatchObject({ id: account.id, name, color: 'purple', icon: 'piggy' });
    expect(fixed(updated?.initialBalance ?? 1)).toBe('0.00');
    expect(updated?.initialBalanceDate).toBe(account.initialBalanceDate);
  });
});

describe('accounts.setOrder', () => {
  it('TASK-099 setOrder(ids) reasigna sort_order en el orden dado y list lo respeta', async () => {
    const user = await newUser();
    const a = await createAccount(user.id, { sortOrder: 1 });
    const b = await createAccount(user.id, { sortOrder: 2 });
    const c = await createAccount(user.id, { sortOrder: 3 });

    await withUser(user.id, (repos) => repos.accounts.setOrder([c.id, a.id, b.id]));
    const active = await withUser(user.id, (repos) => repos.accounts.list('active'));

    expect(active.map((account) => account.id)).toEqual([c.id, a.id, b.id]);
    const orders = active.map((account) => account.sortOrder);
    expect([...orders].sort((x, y) => x - y)).toEqual(orders);
    expect(new Set(orders).size).toBe(3);
  });
});

describe('accounts.count', () => {
  it('TASK-099 count devuelve cuántas cuentas tiene el usuario', async () => {
    const user = await newUser();

    expect(await withUser(user.id, (repos) => repos.accounts.count())).toBe(0);

    await createAccount(user.id);
    await createAccount(user.id);
    await createAccount(user.id);

    expect(await withUser(user.id, (repos) => repos.accounts.count())).toBe(3);
  });
});

describe('accounts.hasEntries', () => {
  it('TASK-099 hasEntries es false para una cuenta sin asientos y true cuando tiene uno', async () => {
    const user = await newUser();
    const empty = await createAccount(user.id);
    const used = await createAccount(user.id);
    await createLedgerTransaction(user.id, {
      date: '2090-01-10',
      entries: [{ accountId: used.id, amount: '10.00' }],
    });

    const [emptyHas, usedHas] = await withUser(
      user.id,
      async (repos) =>
        [
          await repos.accounts.hasEntries(empty.id),
          await repos.accounts.hasEntries(used.id),
        ] as const,
    );

    expect(emptyHas).toBe(false);
    expect(usedHas).toBe(true);
  });

  it('TASK-099 hasEntries cuenta los asientos de una transacción eliminada, dentro de la ventana de deshacer', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    await createLedgerTransaction(user.id, {
      date: '2090-01-10',
      deletedAt: new Date(),
      entries: [{ accountId: account.id, amount: '-10.00' }],
    });

    expect(await withUser(user.id, (repos) => repos.accounts.hasEntries(account.id))).toBe(true);
  });
});

describe('accounts.lockForUpdate', () => {
  it('TASK-099 lockForUpdate(ids) devuelve las cuentas ordenadas por id y bloquea sus filas', async () => {
    const user = await newUser();
    const accounts = await Promise.all([
      createAccount(user.id),
      createAccount(user.id),
      createAccount(user.id),
    ]);
    const ids = accounts.map((account) => account.id);
    const byId = [...ids].sort();

    const outcome = await withUser(user.id, async (repos) => {
      const locked = await repos.accounts.lockForUpdate([ids[2] ?? '', ids[0] ?? '', ids[1] ?? '']);
      const states = await Promise.all(ids.map((id) => tryLock(id)));
      return { locked, states };
    });

    expect(outcome.locked.map((account) => account.id)).toEqual(byId);
    expect(outcome.states).toEqual(['blocked', 'blocked', 'blocked']);
    expect(await tryLock(ids[0] ?? '')).toBe('free');
  });

  it('TASK-099 lockForUpdate omite los ids que no son cuentas', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);

    const locked = await withUser(user.id, (repos) =>
      repos.accounts.lockForUpdate([account.id, uuidv7()]),
    );

    expect(locked.map((row) => row.id)).toEqual([account.id]);
  });
});

// ---------- accounts: aislamiento ----------

describe('accounts aislamiento', () => {
  it('RN-09 get de la cuenta de otro usuario devuelve null y list y count no la incluyen', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoAccount = await createAccount(beto.id);
    const betoArchived = await createAccount(beto.id, { status: 'archived' });

    const [got, active, archived, count] = await withUser(
      ana.id,
      async (repos) =>
        [
          await repos.accounts.get(betoAccount.id),
          await repos.accounts.list('active'),
          await repos.accounts.list('archived'),
          await repos.accounts.count(),
        ] as const,
    );

    expect(got).toBeNull();
    expect(active.map((account) => account.id)).not.toContain(betoAccount.id);
    expect(archived.map((account) => account.id)).not.toContain(betoArchived.id);
    expect(active).toEqual([]);
    expect(count).toBe(0);
  });

  it('RN-09 lockForUpdate no devuelve ni bloquea las cuentas de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const anaAccount = await createAccount(ana.id);
    const betoAccount = await createAccount(beto.id);

    const outcome = await withUser(ana.id, async (repos) => {
      const locked = await repos.accounts.lockForUpdate([anaAccount.id, betoAccount.id]);
      const betoState = await tryLock(betoAccount.id);
      return { locked, betoState };
    });

    expect(outcome.locked.map((account) => account.id)).toEqual([anaAccount.id]);
    expect(outcome.betoState).toBe('free');
  });

  it('RN-09 update y setOrder no modifican la cuenta de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const anaAccount = await createAccount(ana.id, { sortOrder: 1 });
    const betoAccount = await createAccount(beto.id, { name: 'Banco de Beto', sortOrder: 9 });

    await withUser(ana.id, (repos) =>
      repos.accounts.update(betoAccount.id, { name: 'Robada', color: 'black', icon: 'x' }),
    ).catch(() => undefined);
    await withUser(ana.id, (repos) =>
      repos.accounts.setOrder([betoAccount.id, anaAccount.id]),
    ).catch(() => undefined);

    const stored = await withUser(beto.id, (repos) => repos.accounts.get(betoAccount.id));
    expect(stored).toMatchObject({
      name: 'Banco de Beto',
      color: 'blue',
      icon: 'bank',
      sortOrder: 9,
    });
  });

  it('RN-09 hasEntries de la cuenta de otro usuario con asientos es false', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoAccount = await createAccount(beto.id);
    await createLedgerTransaction(beto.id, {
      date: '2090-01-10',
      entries: [{ accountId: betoAccount.id, amount: '10.00' }],
    });

    expect(await withUser(ana.id, (repos) => repos.accounts.hasEntries(betoAccount.id))).toBe(
      false,
    );
  });
});

// ---------- ledger.insertTransaction ----------

describe('ledger.insertTransaction', () => {
  it('TASK-099 insertTransaction guarda la cabecera y sus asientos con signo, con la fecha de la cabecera', async () => {
    const user = await newUser();
    const from = await createAccount(user.id);
    const to = await createAccount(user.id);
    const transfer = header('transfer', '2090-03-15');
    const entries = [
      { id: uuidv7(), accountId: from.id, amount: new Decimal('-200.00') },
      { id: uuidv7(), accountId: to.id, amount: new Decimal('200.00') },
    ];

    await withUser(user.id, (repos) => repos.ledger.insertTransaction(transfer, entries));

    expect(await storedTransactions(transfer.id)).toEqual([
      { kind: 'transfer', date: '2090-03-15', categoryId: null, rateCurBob: '1.00' },
    ]);
    expect(await storedEntries(transfer.id)).toEqual([
      {
        id: entries[0]?.id,
        userId: user.id,
        accountId: from.id,
        amount: '-200.00',
        date: '2090-03-15',
      },
      {
        id: entries[1]?.id,
        userId: user.id,
        accountId: to.id,
        amount: '200.00',
        date: '2090-03-15',
      },
    ]);
  });

  it('TASK-099 insertTransaction con un id existente no duplica la cabecera ni los asientos (ON CONFLICT DO NOTHING)', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '100.00',
      initialBalanceDate: '2090-01-01',
    });
    const categoryId = await categoryIdOf(user.id, 'expense');
    const expense = header('expense', '2090-03-15', categoryId);
    const entries = [{ id: uuidv7(), accountId: account.id, amount: new Decimal('-35.00') }];

    await withUser(user.id, (repos) => repos.ledger.insertTransaction(expense, entries));
    await withUser(user.id, (repos) => repos.ledger.insertTransaction(expense, entries));

    expect(await storedTransactions(expense.id)).toHaveLength(1);
    expect(await storedEntries(expense.id)).toHaveLength(1);
    const balances = await withUser(user.id, (repos) => repos.ledger.balances([account.id]));
    expect(balanceOf(balances, account.id)).toBe('65.00');
  });

  it('RN-09 insertTransaction no puede escribir asientos en la cuenta de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoAccount = await createAccount(beto.id);
    const adjustment = header('adjustment', '2090-03-15');

    await expect(
      withUser(ana.id, (repos) =>
        repos.ledger.insertTransaction(adjustment, [
          { id: uuidv7(), accountId: betoAccount.id, amount: new Decimal('500.00') },
        ]),
      ),
    ).rejects.toThrow();

    expect(await storedTransactions(adjustment.id)).toEqual([]);
    expect(await storedEntries(adjustment.id)).toEqual([]);
  });
});

// ---------- ledger.balances ----------

describe('ledger.balances', () => {
  it('RN-01 el saldo es el saldo inicial más las entradas menos las salidas', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '100.00',
      initialBalanceDate: '2090-01-01',
    });
    await createLedgerTransaction(user.id, {
      kind: 'income',
      date: '2090-01-05',
      entries: [{ accountId: account.id, amount: '50.25' }],
    });
    await createLedgerTransaction(user.id, {
      kind: 'expense',
      date: '2090-01-06',
      entries: [{ accountId: account.id, amount: '-30.10' }],
    });

    const balances = await withUser(user.id, (repos) => repos.ledger.balances([account.id]));

    expect(balanceOf(balances, account.id)).toBe('120.15');
  });

  it('RN-01 balances ignora los asientos anteriores a la fecha del saldo inicial y cuenta los de ese mismo día', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '1000.00',
      initialBalanceDate: '2090-02-10',
    });
    await createLedgerTransaction(user.id, {
      date: '2090-02-09',
      entries: [{ accountId: account.id, amount: '-400.00' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-01-01',
      entries: [{ accountId: account.id, amount: '77.00' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-02-10',
      entries: [{ accountId: account.id, amount: '-100.00' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-02-11',
      entries: [{ accountId: account.id, amount: '25.00' }],
    });

    const balances = await withUser(user.id, (repos) => repos.ledger.balances([account.id]));

    expect(balanceOf(balances, account.id)).toBe('925.00');
  });

  it('RN-01 balances ignora los asientos de las transacciones con deleted_at', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '200.00',
      initialBalanceDate: '2090-01-01',
    });
    await createLedgerTransaction(user.id, {
      date: '2090-01-02',
      entries: [{ accountId: account.id, amount: '-50.00' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-01-03',
      deletedAt: new Date(),
      entries: [{ accountId: account.id, amount: '-120.00' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-01-04',
      deletedAt: new Date('2090-01-04T12:00:00Z'),
      entries: [{ accountId: account.id, amount: '999.00' }],
    });

    const balances = await withUser(user.id, (repos) => repos.ledger.balances([account.id]));

    expect(balanceOf(balances, account.id)).toBe('150.00');
  });

  it('TASK-099 balances da el saldo de varias cuentas en una llamada, y el saldo inicial a la que no tiene asientos', async () => {
    const user = await newUser();
    const bank = await createAccount(user.id, { initialBalance: '10.00' });
    const cash = await createAccount(user.id, { type: 'cash', initialBalance: '30.00' });
    const card = await createAccount(user.id, { type: 'credit_card', initialBalance: '-80.00' });
    await createLedgerTransaction(user.id, {
      kind: 'transfer',
      date: '2090-01-15',
      entries: [
        { accountId: bank.id, amount: '-5.00' },
        { accountId: card.id, amount: '5.00' },
      ],
    });

    const balances = await withUser(user.id, (repos) =>
      repos.ledger.balances([bank.id, cash.id, card.id]),
    );

    expect(balances.size).toBe(3);
    expect(balanceOf(balances, bank.id)).toBe('5.00');
    expect(balanceOf(balances, cash.id)).toBe('30.00');
    expect(balanceOf(balances, card.id)).toBe('-75.00');
  });

  it('RN-09 balances no devuelve el saldo de las cuentas de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const anaAccount = await createAccount(ana.id, { initialBalance: '1.00' });
    const betoAccount = await createAccount(beto.id, { initialBalance: '500.00' });
    await createLedgerTransaction(beto.id, {
      date: '2090-01-15',
      entries: [{ accountId: betoAccount.id, amount: '20.00' }],
    });

    const balances = await withUser(ana.id, (repos) =>
      repos.ledger.balances([anaAccount.id, betoAccount.id]),
    );

    expect(balanceOf(balances, anaAccount.id)).toBe('1.00');
    expect(balances.has(betoAccount.id)).toBe(false);
  });
});

// ---------- ledger.balanceSeries ----------

describe('ledger.balanceSeries', () => {
  it('TASK-099 balanceSeries devuelve el saldo de cada día del rango, con los movimientos previos al rango', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '100.00',
      initialBalanceDate: '2090-05-01',
    });
    await createLedgerTransaction(user.id, {
      date: '2090-05-02',
      entries: [{ accountId: account.id, amount: '50.00' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-05-11',
      entries: [{ accountId: account.id, amount: '-20.00' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-05-11',
      entries: [{ accountId: account.id, amount: '-5.50' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-05-13',
      entries: [{ accountId: account.id, amount: '10.00' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-05-20',
      entries: [{ accountId: account.id, amount: '1000.00' }],
    });

    const series = await withUser(user.id, (repos) =>
      repos.ledger.balanceSeries(account.id, '2090-05-10', '2090-05-14'),
    );

    expect(series.map((point) => [point.date, fixed(point.balance)])).toEqual([
      ['2090-05-10', '150.00'],
      ['2090-05-11', '124.50'],
      ['2090-05-12', '124.50'],
      ['2090-05-13', '134.50'],
      ['2090-05-14', '134.50'],
    ]);
  });

  it('RN-01 balanceSeries ignora los asientos anteriores al saldo inicial y los de transacciones eliminadas', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '300.00',
      initialBalanceDate: '2090-06-05',
    });
    await createLedgerTransaction(user.id, {
      date: '2090-06-04',
      entries: [{ accountId: account.id, amount: '-100.00' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-06-06',
      deletedAt: new Date(),
      entries: [{ accountId: account.id, amount: '-200.00' }],
    });
    await createLedgerTransaction(user.id, {
      date: '2090-06-07',
      entries: [{ accountId: account.id, amount: '-10.00' }],
    });

    const series = await withUser(user.id, (repos) =>
      repos.ledger.balanceSeries(account.id, '2090-06-05', '2090-06-07'),
    );

    expect(series.map((point) => [point.date, fixed(point.balance)])).toEqual([
      ['2090-06-05', '300.00'],
      ['2090-06-06', '300.00'],
      ['2090-06-07', '290.00'],
    ]);
  });

  it('RN-09 balanceSeries de la cuenta de otro usuario se comporta como inexistente', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoAccount = await createAccount(beto.id, {
      initialBalance: '500.00',
      initialBalanceDate: '2090-01-01',
    });
    await createLedgerTransaction(beto.id, {
      date: '2090-01-02',
      entries: [{ accountId: betoAccount.id, amount: '20.00' }],
    });

    const series = await withUser(ana.id, (repos) =>
      repos.ledger.balanceSeries(betoAccount.id, '2090-01-01', '2090-01-03'),
    );

    expect(series).toEqual([]);
  });
});

// ---------- rendimiento ----------

describe('ledger con 5.000 movimientos', () => {
  it('RNF-03 balances y balanceSeries resuelven 5.000 movimientos con un resultado exacto y dentro de 2 s', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '1000.00',
      initialBalanceDate: '2090-01-01',
    });
    await createBulkLedger(user.id, account.id, {
      count: 5000,
      amount: '1.10',
      firstDate: '2090-01-01',
      days: 100,
    });

    const started = performance.now();
    const [balances, series] = await withUser(
      user.id,
      async (repos) =>
        [
          await repos.ledger.balances([account.id]),
          await repos.ledger.balanceSeries(account.id, '2090-01-01', '2090-04-10'),
        ] as const,
    );
    const elapsed = performance.now() - started;

    // 5.000 × 1,10 = 5.500,00 sobre el saldo inicial de 1.000,00; 50 movimientos por día.
    expect(balanceOf(balances, account.id)).toBe('6500.00');
    expect(series).toHaveLength(100);
    expect(series[0]?.date).toBe('2090-01-01');
    expect(fixed(series[0]?.balance ?? 0)).toBe('1055.00');
    expect(series[99]?.date).toBe('2090-04-10');
    expect(fixed(series[99]?.balance ?? 0)).toBe('6500.00');
    expect(elapsed).toBeLessThan(2000);
  });
});
