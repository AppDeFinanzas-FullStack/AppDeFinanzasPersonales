import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { BalanceGuard } from '../../src/application/shared/balance-guard.js';
import { createAccountRepository } from '../../src/infrastructure/persistence/repositories/account.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount, type TestAccountType } from '../factories/account.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `BalanceGuard.apply(tx, userId, deltas, { mode })` (plan §4.0). These tests assume:
 * - `balance-guard.ts` exports `BalanceGuard` with that `apply`. The guard lives in the application
 *   layer, so its `tx` is the `Repositories` of the running `UnitOfWork`, already bound to the
 *   transaction (plan §1.4); it reads the accounts and the ledger through `accounts` and `ledger`.
 * - A delta is `{ accountId, amount }` with a signed `Decimal` amount (plan §4.0).
 * - A blocked delta rejects with an `AppError` `NEGATIVE_BALANCE` (422) whose `data` is
 *   `{ accountId, resultingBalance }`, the balance as decimal text with two decimals (ADR-03, ADR-09).
 * - Several deltas on the same account add up (an outgoing transfer: amount and fee together).
 */
const uowCache = new Map<string, UnitOfWork>();

/** A UnitOfWork whose repositories are bound to that user. */
function uowFor(userId: string): UnitOfWork {
  let uow = uowCache.get(userId);
  if (!uow) {
    uow = createUnitOfWork(testPrisma(), (tx) => ({
      accounts: createAccountRepository(tx, userId),
      ledger: createLedgerRepository(tx, userId),
    }));
    uowCache.set(userId, uow);
  }
  return uow;
}

const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

async function newUserId(): Promise<string> {
  const user = await createUser();
  usedUserIds.push(user.id);
  return user.id;
}

/** An account of a new user, with its initial balance on 2090-01-01. */
async function accountWith(
  type: TestAccountType,
  initialBalance: string,
): Promise<{ userId: string; accountId: string }> {
  const userId = await newUserId();
  const account = await createAccount(userId, {
    type,
    initialBalance,
    initialBalanceDate: '2090-01-01',
  });
  return { userId, accountId: account.id };
}

const delta = (accountId: string, amount: string) => ({ accountId, amount: new Decimal(amount) });

/** Applies the guard in interactive mode inside a transaction that locks the user. */
function applyInteractive(
  userId: string,
  deltas: { accountId: string; amount: Decimal }[],
): Promise<void> {
  return uowFor(userId).run(
    async (repos: Repositories) => {
      await BalanceGuard.apply(repos, userId, deltas, { mode: 'interactive' });
    },
    { userLock: userId },
  );
}

/** The rejection of the promise, which must be an `AppError`. */
async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('The promise was expected to reject');
}

function expectNegativeBalance(error: AppError, accountId: string, resultingBalance: string): void {
  expect(error.code).toBe('NEGATIVE_BALANCE');
  expect(error.status).toBe(422);
  expect(error.data).toEqual({ accountId, resultingBalance });
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

/** Balance of the account read outside of any UnitOfWork: initial balance plus its entries. */
async function storedBalance(accountId: string): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ balance: string }[]>`
    SELECT (a.initial_balance + COALESCE((
              SELECT SUM(e.amount) FROM ledger_entry e
                JOIN ledger_transaction t ON t.id = e.transaction_id
               WHERE e.account_id = a.id AND t.deleted_at IS NULL), 0))::numeric(14,2)::text AS balance
      FROM account a WHERE a.id = ${accountId}::uuid`;
  return rows[0]?.balance ?? '';
}

/** An adjustment header to write the entry of a movement through the ledger repository. */
function adjustmentHeader(date: string) {
  return {
    id: uuidv7(),
    kind: 'adjustment' as const,
    date,
    note: null,
    categoryId: null,
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

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------- RF-M4-04: negativos en efectivo y billetera ----------

describe('BalanceGuard: negativos en efectivo y billetera', () => {
  it('RF-M4-04 efectivo con 30 y un delta de −35 da NEGATIVE_BALANCE con resultingBalance "-5.00"', async () => {
    const { userId, accountId } = await accountWith('cash', '30.00');

    const error = await rejectionOf(applyInteractive(userId, [delta(accountId, '-35.00')]));

    expectNegativeBalance(error, accountId, '-5.00');
  });

  it('RF-M4-04 una billetera con 30 y un delta de −35 da NEGATIVE_BALANCE con resultingBalance "-5.00"', async () => {
    const { userId, accountId } = await accountWith('ewallet', '30.00');

    const error = await rejectionOf(applyInteractive(userId, [delta(accountId, '-35.00')]));

    expectNegativeBalance(error, accountId, '-5.00');
  });

  it('RF-M4-04 efectivo con 30 y un delta de −30 queda en 0 y se permite', async () => {
    const { userId, accountId } = await accountWith('cash', '30.00');

    await expect(applyInteractive(userId, [delta(accountId, '-30.00')])).resolves.toBeUndefined();
  });

  it('RF-M4-04 el monto y la comisión de una transferencia saliente se validan juntos', async () => {
    const { userId, accountId } = await accountWith('cash', '30.00');

    const error = await rejectionOf(
      applyInteractive(userId, [delta(accountId, '-25.00'), delta(accountId, '-10.00')]),
    );

    expectNegativeBalance(error, accountId, '-5.00');
  });

  it('RF-M4-04 la guarda usa el saldo vigente con los movimientos, no solo el saldo inicial', async () => {
    const { userId, accountId } = await accountWith('cash', '30.00');
    await createLedgerTransaction(userId, {
      date: '2090-01-10',
      entries: [{ accountId, amount: '-20.00' }],
    });

    const error = await rejectionOf(applyInteractive(userId, [delta(accountId, '-15.00')]));

    expectNegativeBalance(error, accountId, '-5.00');
  });

  it('RF-M4-04 los saldos de días pasados no se validan: se compara el saldo actual total', async () => {
    // Initial 0 on 2090-01-01, an expense of 80 on 2090-01-05 and an income of 100 on 2090-01-10:
    // the balance of 2090-01-05 was −80, but the current balance is 20.
    const { userId, accountId } = await accountWith('cash', '0.00');
    await createLedgerTransaction(userId, {
      date: '2090-01-05',
      entries: [{ accountId, amount: '-80.00' }],
    });
    await createLedgerTransaction(userId, {
      date: '2090-01-10',
      entries: [{ accountId, amount: '100.00' }],
    });

    await expect(applyInteractive(userId, [delta(accountId, '-20.00')])).resolves.toBeUndefined();
  });

  it('RF-M4-04 con varias cuentas, rechaza la que quedaría en negativo', async () => {
    const userId = await newUserId();
    const bank = await createAccount(userId, { type: 'bank', initialBalance: '100.00' });
    const cash = await createAccount(userId, { type: 'cash', initialBalance: '30.00' });

    // A transfer from the cash to the bank: 40 out of the cash and 40 into the bank.
    const error = await rejectionOf(
      applyInteractive(userId, [delta(cash.id, '-40.00'), delta(bank.id, '40.00')]),
    );

    expectNegativeBalance(error, cash.id, '-10.00');
  });

  it('EC-M4-01 quitar un ingreso que deja el efectivo en −50 se rechaza', async () => {
    // Initial 0, an income of 100 and an expense of 150 after it: the balance is 50 with the income.
    const { userId, accountId } = await accountWith('cash', '0.00');
    await createLedgerTransaction(userId, {
      date: '2090-01-05',
      entries: [{ accountId, amount: '100.00' }],
    });
    await createLedgerTransaction(userId, {
      date: '2090-01-10',
      entries: [{ accountId, amount: '-50.00' }],
    });

    // Deleting the income takes its 100 out of the account.
    const error = await rejectionOf(applyInteractive(userId, [delta(accountId, '-100.00')]));

    expectNegativeBalance(error, accountId, '-50.00');
  });
});

// ---------- EC-M4-06: sobregiro de un banco ----------

describe('BalanceGuard: cuentas que pueden quedar en negativo', () => {
  it('EC-M4-06 un banco puede quedar en negativo', async () => {
    const { userId, accountId } = await accountWith('bank', '30.00');

    await expect(applyInteractive(userId, [delta(accountId, '-35.00')])).resolves.toBeUndefined();
  });

  it('EC-M4-06 un banco que ya está en negativo puede bajar más', async () => {
    const { userId, accountId } = await accountWith('bank', '-200.00');

    await expect(applyInteractive(userId, [delta(accountId, '-50.00')])).resolves.toBeUndefined();
  });
});

// ---------- RNF-10: saldo vigente al guardar ----------

describe('BalanceGuard: concurrencia', () => {
  it('RNF-10 la guarda bloquea con FOR UPDATE las filas de las cuentas hasta el fin de la transacción', async () => {
    const { userId, accountId } = await accountWith('cash', '30.00');

    const states = await uowFor(userId).run(
      async (repos: Repositories) => {
        await BalanceGuard.apply(repos, userId, [delta(accountId, '-10.00')], {
          mode: 'interactive',
        });
        return [await tryLock(accountId)];
      },
      { userLock: userId },
    );

    expect(states).toEqual(['blocked']);
    expect(await tryLock(accountId)).toBe('free');
  });

  it('RNF-10 dos aplicaciones concurrentes de −20 sobre 30 dan un éxito y un error', async () => {
    const { userId, accountId } = await accountWith('cash', '30.00');
    const uow = uowFor(userId);

    // No user lock here: only the guard's FOR UPDATE keeps the second one from using a stale balance.
    let firstChecked: () => void = () => undefined;
    const firstHasChecked = new Promise<void>((resolve) => {
      firstChecked = resolve;
    });

    const spend = (afterCheck: () => Promise<void>) =>
      uow.run(async (repos: Repositories) => {
        await BalanceGuard.apply(repos, userId, [delta(accountId, '-20.00')], {
          mode: 'interactive',
        });
        await afterCheck();
        await repos.ledger.insertTransaction(adjustmentHeader('2090-01-15'), [
          { id: uuidv7(), accountId, amount: new Decimal('-20.00') },
        ]);
      });

    const first = spend(async () => {
      firstChecked();
      // Holds the transaction open while the second one checks the balance.
      await wait(400);
    });
    const second = firstHasChecked.then(() => spend(() => Promise.resolve()));

    const results = await Promise.allSettled([first, second]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason: unknown = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined;
    expect(reason).toBeInstanceOf(AppError);
    expectNegativeBalance(reason as AppError, accountId, '-10.00');
    expect(await storedBalance(accountId)).toBe('10.00');
  });
});
