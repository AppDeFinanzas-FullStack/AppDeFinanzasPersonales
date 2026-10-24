import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createDebtPaymentRepository } from '../../src/infrastructure/persistence/repositories/debt-payment.repository.js';
import { createDebtRepository } from '../../src/infrastructure/persistence/repositories/debt.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import {
  createDebt,
  createDebtPayment,
  findStoredDebt,
  storedPaymentIdsOf,
} from '../factories/debt.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes the operations of the repositories (tasks.md, TASK-210) but not the names of
 * their factories nor their row shapes. These tests assume, like those of TASK-099:
 * - `createDebtRepository(tx, userId)` and `createDebtPaymentRepository(tx, userId)` build a
 *   repository over the client of a transaction; `Repositories` exposes them as `debts` and
 *   `debtPayments`. The user comes from the `UnitOfWork` (`userLock`), never from an argument.
 * - Amounts and rates are `Decimal`, instants are `Date` and days are `YYYY-MM-DD` strings.
 * - A debt row has `id`, `direction`, `person`, `personKey`, `principal`, `currencyCode`,
 *   `startDate`, `dueDate`, `note`, `interestRate`, `interestPeriod`, `status`, `forgivenAmount`,
 *   `initialTransactionId`, `capitalOutstanding`, `interestUnpaid`, `accruedThrough`, `createdAt`
 *   and `updatedAt`. `debts.insert` takes the same fields without `personKey`, `status`,
 *   `forgivenAmount`, `interestUnpaid`, `createdAt` and `updatedAt`: the repository derives
 *   `person_key = lower(unaccent(person))`, and also when `update(id, patch)` changes the person.
 *   The patch takes some of `person`, `note`, `dueDate`, `principal`, `status`, `forgivenAmount`,
 *   `capitalOutstanding`, `interestUnpaid`, `accruedThrough` and `initialTransactionId`.
 * - `debts.get(id)` and `debts.lockForUpdate(id)` return `null` when the user has no such debt;
 *   `lockForUpdate` takes `SELECT … FOR UPDATE` on the row (plan §4.13.3). `debts.list()` returns
 *   every debt of the user, `debts.delete(id)` removes one and `debts.persons()` returns the
 *   `person` values the user already used, for the autocompletion (plan §4.13.4).
 * - A payment row has `id`, `debtId`, `amount`, `interestPart`, `capitalPart`, `date`,
 *   `accountId`, `declaredRate`, `accountAmount`, `capitalTransactionId`,
 *   `interestTransactionId`, `note` and `createdAt`. `debtPayments.insert` takes the same fields
 *   without `createdAt`. `debtPayments.list(debtId)` returns the payments of the debt,
 *   `debtPayments.last(debtId)` the one with the greatest `created_at` (or `null`), and
 *   `debtPayments.delete(id)` removes one.
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';

const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx, userId) => ({
  debts: createDebtRepository(tx, userId ?? NIL_USER),
  debtPayments: createDebtPaymentRepository(tx, userId ?? NIL_USER),
}));

afterAll(async () => {
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const newUser = (): Promise<TestUser> => createUser();

const fixed = (value: Decimal | string | number): string => new Decimal(value).toFixed(2);

const withUser = <T>(userId: string, fn: (repos: Repositories) => Promise<T>) =>
  uow.run(fn, { userLock: userId });

/** A debt to insert through the repository, with every field of plan §3.6. */
function newDebt(
  overrides: {
    person?: string;
    direction?: 'i_owe' | 'owed_to_me';
    principal?: string;
  } = {},
) {
  const principal = new Decimal(overrides.principal ?? '1200.00');
  return {
    id: uuidv7(),
    direction: overrides.direction ?? ('i_owe' as const),
    person: overrides.person ?? 'Juan',
    principal,
    currencyCode: 'BOB',
    startDate: '2090-01-01',
    dueDate: '2090-06-30' as string | null,
    note: 'Préstamo del auto' as string | null,
    interestRate: new Decimal('2.5000') as Decimal | null,
    interestPeriod: 'monthly' as 'monthly' | 'yearly' | null,
    initialTransactionId: null,
    capitalOutstanding: principal,
    accruedThrough: '2090-01-01',
  };
}

/** A payment without an account to insert through the repository (plan §3.6). */
function newPayment(debtId: string, capital = '100.00', interest = '0.00') {
  const capitalPart = new Decimal(capital);
  const interestPart = new Decimal(interest);
  return {
    id: uuidv7(),
    debtId,
    amount: capitalPart.plus(interestPart),
    interestPart,
    capitalPart,
    date: '2090-01-15',
    accountId: null,
    declaredRate: null,
    accountAmount: null,
    capitalTransactionId: null,
    interestTransactionId: null,
    note: null,
  };
}

/** Tries to lock the debt row from another connection, without waiting. */
async function tryLock(debtId: string): Promise<'free' | 'blocked'> {
  const query = `SELECT id FROM debt WHERE id = '${debtId}'::uuid FOR UPDATE NOWAIT`;
  try {
    await testPrisma().$queryRawUnsafe(query);
    return 'free';
  } catch {
    return 'blocked';
  }
}

// ---------- debts: CRUD ----------

describe('debts.insert y debts.get', () => {
  it('TASK-210 insert guarda la deuda y get la devuelve con todos sus campos', async () => {
    const user = await newUser();
    const input = newDebt({ person: 'Juan', principal: '1200.00' });

    await withUser(user.id, (repos) => repos.debts.insert(input));
    const debt = await withUser(user.id, (repos) => repos.debts.get(input.id));

    expect(debt).not.toBeNull();
    expect(debt).toMatchObject({
      id: input.id,
      direction: 'i_owe',
      person: 'Juan',
      personKey: 'juan',
      currencyCode: 'BOB',
      startDate: '2090-01-01',
      dueDate: '2090-06-30',
      note: 'Préstamo del auto',
      interestPeriod: 'monthly',
      status: 'active',
      forgivenAmount: null,
      initialTransactionId: null,
      accruedThrough: '2090-01-01',
    });
    expect(fixed(debt?.principal ?? 0)).toBe('1200.00');
    expect(fixed(debt?.capitalOutstanding ?? 0)).toBe('1200.00');
    expect(new Decimal(debt?.interestUnpaid ?? 1).isZero()).toBe(true);
    expect(new Decimal(debt?.interestRate ?? 0).toFixed(4)).toBe('2.5000');
  });

  it('TASK-210 get de una deuda inexistente devuelve null', async () => {
    const user = await newUser();

    expect(await withUser(user.id, (repos) => repos.debts.get(uuidv7()))).toBeNull();
  });
});

describe('debts.list', () => {
  it('TASK-210 list devuelve todas las deudas del usuario', async () => {
    const user = await newUser();
    const first = await createDebt(user.id, { person: 'Ana' });
    const second = await createDebt(user.id, { person: 'Carla', direction: 'owed_to_me' });
    const paid = await createDebt(user.id, { person: 'Luis', status: 'paid' });

    const debts = await withUser(user.id, (repos) => repos.debts.list());

    expect(debts.map((debt) => debt.id).sort()).toEqual([first.id, second.id, paid.id].sort());
  });
});

describe('debts.update y debts.delete', () => {
  it('TASK-210 update cambia la persona, la nota, la fecha límite y los saldos', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, { person: 'Juan', dueDate: '2090-03-01' });

    await withUser(user.id, (repos) =>
      repos.debts.update(debt.id, {
        person: 'Pedro',
        note: 'Nueva nota',
        dueDate: '2090-09-01',
        capitalOutstanding: new Decimal('900.00'),
        interestUnpaid: new Decimal('12.3456789012'),
        accruedThrough: '2090-02-01',
      }),
    );

    expect(await findStoredDebt(debt.id)).toMatchObject({
      person: 'Pedro',
      personKey: 'pedro',
      note: 'Nueva nota',
      dueDate: '2090-09-01',
      capitalOutstanding: '900.00',
      interestUnpaid: '12.3456789012',
      accruedThrough: '2090-02-01',
    });
  });

  it('TASK-210 update a condonada guarda el estado y el monto condonado', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id);

    await withUser(user.id, (repos) =>
      repos.debts.update(debt.id, { status: 'forgiven', forgivenAmount: new Decimal('1000.00') }),
    );

    expect(await findStoredDebt(debt.id)).toMatchObject({
      status: 'forgiven',
      forgivenAmount: '1000.00',
    });
  });

  it('TASK-210 delete borra la deuda junto con sus pagos', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id);
    await createDebtPayment(user.id, debt.id);

    await withUser(user.id, (repos) => repos.debts.delete(debt.id));

    expect(await findStoredDebt(debt.id)).toBeNull();
    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
  });
});

describe('debts.lockForUpdate', () => {
  it('TASK-210 lockForUpdate devuelve la deuda y bloquea su fila hasta el fin de la transacción', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, { person: 'Juan' });

    const outcome = await withUser(user.id, async (repos) => {
      const locked = await repos.debts.lockForUpdate(debt.id);
      const state = await tryLock(debt.id);
      return { locked, state };
    });

    expect(outcome.locked?.id).toBe(debt.id);
    expect(outcome.locked?.person).toBe('Juan');
    expect(outcome.state).toBe('blocked');
    expect(await tryLock(debt.id)).toBe('free');
  });

  it('TASK-210 lockForUpdate de una deuda inexistente devuelve null', async () => {
    const user = await newUser();

    expect(await withUser(user.id, (repos) => repos.debts.lockForUpdate(uuidv7()))).toBeNull();
  });
});

// ---------- person_key ----------

describe('debts person_key', () => {
  it('EC-M13-06 "José" y "jose" comparten person_key', async () => {
    const user = await newUser();
    const accented = newDebt({ person: 'José', direction: 'i_owe' });
    const plain = newDebt({ person: 'jose', direction: 'owed_to_me' });

    await withUser(user.id, async (repos) => {
      await repos.debts.insert(accented);
      await repos.debts.insert(plain);
    });
    const [first, second] = await withUser(
      user.id,
      async (repos) =>
        [await repos.debts.get(accented.id), await repos.debts.get(plain.id)] as const,
    );

    expect(first?.person).toBe('José');
    expect(second?.person).toBe('jose');
    expect(first?.personKey).toBe('jose');
    expect(second?.personKey).toBe('jose');
    expect((await findStoredDebt(accented.id))?.personKey).toBe('jose');
    expect((await findStoredDebt(plain.id))?.personKey).toBe('jose');
  });

  it('RF-M13-13 las deudas de una persona escrita con y sin mayúsculas ni tildes se agrupan por person_key', async () => {
    const user = await newUser();
    const variants = ['María Pérez', 'maria perez', 'MARÍA PÉREZ'].map((person, index) =>
      newDebt({ person, direction: index === 1 ? 'owed_to_me' : 'i_owe' }),
    );

    await withUser(user.id, async (repos) => {
      for (const debt of variants) {
        await repos.debts.insert(debt);
      }
    });
    const debts = await withUser(user.id, (repos) => repos.debts.list());

    expect(new Set(debts.map((debt) => debt.personKey))).toEqual(new Set(['maria perez']));
  });

  it('EC-M13-06 update de la persona recalcula person_key', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, { person: 'Juan' });

    await withUser(user.id, (repos) => repos.debts.update(debt.id, { person: 'JOSÉ' }));

    expect(await findStoredDebt(debt.id)).toMatchObject({ person: 'JOSÉ', personKey: 'jose' });
  });
});

describe('debts.persons', () => {
  it('TASK-210 persons devuelve las personas que el usuario ya usó, para el autocompletado', async () => {
    const user = await newUser();
    await createDebt(user.id, { person: 'Ana' });
    await createDebt(user.id, { person: 'Carlos', direction: 'owed_to_me' });

    const persons = await withUser(user.id, (repos) => repos.debts.persons());

    expect(persons).toEqual(expect.arrayContaining(['Ana', 'Carlos']));
    expect(persons).toHaveLength(2);
  });
});

// ---------- debtPayments ----------

describe('debtPayments.insert, list y delete', () => {
  it('TASK-210 insert guarda el pago y list lo devuelve con sus partes', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id);
    const payment = newPayment(debt.id, '150.00', '42.30');

    await withUser(user.id, (repos) => repos.debtPayments.insert(payment));
    const payments = await withUser(user.id, (repos) => repos.debtPayments.list(debt.id));

    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      id: payment.id,
      debtId: debt.id,
      date: '2090-01-15',
      accountId: null,
      capitalTransactionId: null,
      interestTransactionId: null,
      note: null,
    });
    expect(fixed(payments[0]?.amount ?? 0)).toBe('192.30');
    expect(fixed(payments[0]?.interestPart ?? 0)).toBe('42.30');
    expect(fixed(payments[0]?.capitalPart ?? 0)).toBe('150.00');
    expect(payments[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('TASK-210 list devuelve solo los pagos de esa deuda', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id);
    const other = await createDebt(user.id, { person: 'Otra' });
    const first = await createDebtPayment(user.id, debt.id);
    const second = await createDebtPayment(user.id, debt.id);
    await createDebtPayment(user.id, other.id);

    const payments = await withUser(user.id, (repos) => repos.debtPayments.list(debt.id));

    expect(payments.map((payment) => payment.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('TASK-210 delete borra el pago', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id);
    const kept = await createDebtPayment(user.id, debt.id);
    const removed = await createDebtPayment(user.id, debt.id);

    await withUser(user.id, (repos) => repos.debtPayments.delete(removed.id));

    expect(await storedPaymentIdsOf(debt.id)).toEqual([kept.id]);
  });
});

describe('debtPayments.last', () => {
  it('TASK-210 last devuelve el pago creado más recientemente', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id);
    // The newest one has the oldest date and the smallest id: only `created_at` decides.
    const newestId = uuidv7();
    await createDebtPayment(user.id, debt.id, {
      date: '2090-03-01',
      createdAt: new Date('2090-03-01T10:00:00Z'),
    });
    await createDebtPayment(user.id, debt.id, {
      date: '2090-02-01',
      createdAt: new Date('2090-03-03T10:00:00Z'),
    });
    await createDebtPayment(user.id, debt.id, {
      id: newestId,
      date: '2090-01-10',
      createdAt: new Date('2090-03-05T10:00:00Z'),
    });
    await createDebtPayment(user.id, debt.id, {
      date: '2090-02-20',
      createdAt: new Date('2090-03-04T10:00:00Z'),
    });

    const last = await withUser(user.id, (repos) => repos.debtPayments.last(debt.id));

    expect(last?.id).toBe(newestId);
  });

  it('TASK-210 last devuelve el último pago registrado por el repositorio', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id);
    const first = newPayment(debt.id, '100.00');
    const second = newPayment(debt.id, '200.00');

    await withUser(user.id, (repos) => repos.debtPayments.insert(first));
    await withUser(user.id, (repos) => repos.debtPayments.insert(second));
    const last = await withUser(user.id, (repos) => repos.debtPayments.last(debt.id));

    expect(last?.id).toBe(second.id);
    expect(fixed(last?.capitalPart ?? 0)).toBe('200.00');
  });

  it('TASK-210 last de una deuda sin pagos devuelve null', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id);

    expect(await withUser(user.id, (repos) => repos.debtPayments.last(debt.id))).toBeNull();
  });
});

// ---------- aislamiento ----------

describe('aislamiento entre usuarios', () => {
  it('RN-09 get, list y persons no ven las deudas de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoDebt = await createDebt(beto.id, { person: 'Zoe' });

    const [got, debts, persons] = await withUser(
      ana.id,
      async (repos) =>
        [
          await repos.debts.get(betoDebt.id),
          await repos.debts.list(),
          await repos.debts.persons(),
        ] as const,
    );

    expect(got).toBeNull();
    expect(debts).toEqual([]);
    expect(persons).not.toContain('Zoe');
  });

  it('RN-09 lockForUpdate no devuelve ni bloquea la deuda de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoDebt = await createDebt(beto.id);

    const outcome = await withUser(ana.id, async (repos) => {
      const locked = await repos.debts.lockForUpdate(betoDebt.id);
      const state = await tryLock(betoDebt.id);
      return { locked, state };
    });

    expect(outcome.locked).toBeNull();
    expect(outcome.state).toBe('free');
  });

  it('RN-09 update y delete no modifican la deuda de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoDebt = await createDebt(beto.id, { person: 'Juan', note: 'De Beto' });

    await withUser(ana.id, (repos) =>
      repos.debts.update(betoDebt.id, { person: 'Robada', note: 'x' }),
    ).catch(() => undefined);
    await withUser(ana.id, (repos) => repos.debts.delete(betoDebt.id)).catch(() => undefined);

    expect(await findStoredDebt(betoDebt.id)).toMatchObject({
      person: 'Juan',
      personKey: 'juan',
      note: 'De Beto',
    });
  });

  it('RN-09 list, last y delete no ven los pagos de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoDebt = await createDebt(beto.id);
    const betoPayment = await createDebtPayment(beto.id, betoDebt.id);

    const [payments, last] = await withUser(
      ana.id,
      async (repos) =>
        [
          await repos.debtPayments.list(betoDebt.id),
          await repos.debtPayments.last(betoDebt.id),
        ] as const,
    );
    await withUser(ana.id, (repos) => repos.debtPayments.delete(betoPayment.id)).catch(
      () => undefined,
    );

    expect(payments).toEqual([]);
    expect(last).toBeNull();
    expect(await storedPaymentIdsOf(betoDebt.id)).toEqual([betoPayment.id]);
  });

  it('RN-09 insert guarda la deuda a nombre del usuario de la transacción', async () => {
    const user = await newUser();
    const input = newDebt();

    await withUser(user.id, (repos) => repos.debts.insert(input));

    expect((await findStoredDebt(input.id))?.userId).toBe(user.id);
  });
});
