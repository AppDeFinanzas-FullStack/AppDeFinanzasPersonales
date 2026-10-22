import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createRecurringOccurrenceRepository } from '../../src/infrastructure/persistence/repositories/recurring-occurrence.repository.js';
import { createRecurringRuleRepository } from '../../src/infrastructure/persistence/repositories/recurring-rule.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import {
  createOccurrence,
  createRule,
  deleteRecurringOf,
  occurrencesOf,
  occurrenceStatus,
  uniqueRuleName,
} from '../factories/recurring.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes the operations of both repositories (tasks.md, TASK-225) but not the names of
 * their factories nor their row shapes. These tests assume, like those of TASK-099 and TASK-110:
 * - `createRecurringRuleRepository(tx, userId)` and `createRecurringOccurrenceRepository(tx, userId)`
 *   build a repository over the client of a transaction; `Repositories` exposes them as
 *   `recurringRules` and `recurringOccurrences`. The user comes from the `UnitOfWork` (`userLock`),
 *   never from an argument (ADR-05).
 * - Amounts are `Decimal`, instants are `Date` and days are `YYYY-MM-DD` strings.
 * - A rule row has `id`, `name`, `kind`, `amount` (`null` when "to be defined"), `accountId`,
 *   `destAccountId`, `categoryId`, `note`, `frequency` and `end` (the discriminated unions of the
 *   contracts and of `packages/domain/recurrence`, plan §4.14.1), `startDate`, `mode`, `status`,
 *   `pausedAt`, `generatedCount` and `lastGeneratedDate`. `insert` takes `id`, `name`, `kind`,
 *   `amount`, `accountId`, `destAccountId`, `categoryId`, `note`, `frequency`, `startDate`, `end` and
 *   `mode` (a rule is always created active, with nothing generated); `update(id, patch)` takes some
 *   of them.
 * - `get(id)` and `lockForUpdate(id)` return the rule or `null` when the user has no such rule;
 *   `list()` returns the user's rules; `remove(id)` returns `false` when the user has no such rule.
 * - An occurrence row has `id`, `ruleId`, `scheduledDate`, `status`, `transactionId`,
 *   `pendingSince` and `decidedAt`.
 * - `insertIfAbsent(ruleId, date)` returns the inserted occurrence (`RETURNING`), or `null` when the
 *   rule already had one on that date (`ON CONFLICT (rule_id, scheduled_date) DO NOTHING`).
 * - `pending()` returns the user's pending occurrences; `expiredPending(before)` the user's pending
 *   occurrences whose `pendingSince` is before the instant.
 * - `decideIf(id, expectedStatus, newStatus)` returns something truthy when it changed the
 *   occurrence (`UPDATE … WHERE status = expectedStatus RETURNING`) and something falsy otherwise.
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';

const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx, userId) => ({
  recurringRules: createRecurringRuleRepository(tx, userId ?? NIL_USER),
  recurringOccurrences: createRecurringOccurrenceRepository(tx, userId ?? NIL_USER),
}));

const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteRecurringOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

async function newUser(): Promise<TestUser> {
  const user = await createUser();
  usedUserIds.push(user.id);
  return user;
}

const withUser = <T>(userId: string, fn: (repos: Repositories) => Promise<T>) =>
  uow.run(fn, { userLock: userId });

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

const DAY_MS = 86_400_000;

/** `'free'` when the rule row can be locked right now, `'blocked'` when another transaction holds it. */
async function tryLockRule(ruleId: string): Promise<'free' | 'blocked'> {
  const query = `SELECT id FROM recurring_rule WHERE id = '${ruleId}'::uuid FOR UPDATE NOWAIT`;
  try {
    await testPrisma().$queryRawUnsafe(query);
    return 'free';
  } catch {
    return 'blocked';
  }
}

interface StoredRule {
  name: string;
  amount: string | null;
  status: string;
}

/** The stored row of a rule, read outside of any UnitOfWork. */
async function storedRule(id: string): Promise<StoredRule | undefined> {
  const rows = await testPrisma().$queryRaw<StoredRule[]>`
    SELECT name, amount::text AS amount, status::text AS status
      FROM recurring_rule WHERE id = ${id}::uuid`;
  return rows[0];
}

// ---------- reglas: insert y get ----------

describe('recurringRules.insert y recurringRules.get', () => {
  it('TASK-225 insert guarda una regla mensual activa y get la devuelve con sus campos', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const category = await createCategory(user.id);
    const id = uuidv7();
    const name = uniqueRuleName('Alquiler');

    await withUser(user.id, (repos) =>
      repos.recurringRules.insert({
        id,
        name,
        kind: 'expense',
        amount: new Decimal('1500.50'),
        accountId: account.id,
        destAccountId: null,
        categoryId: category.id,
        note: 'Depto',
        frequency: { type: 'monthly', day: 31 },
        startDate: '2090-01-31',
        end: { type: 'count', count: 12 },
        mode: 'auto',
      }),
    );
    const rule = await withUser(user.id, (repos) => repos.recurringRules.get(id));

    expect(rule).toMatchObject({
      id,
      name,
      kind: 'expense',
      accountId: account.id,
      destAccountId: null,
      categoryId: category.id,
      note: 'Depto',
      frequency: { type: 'monthly', day: 31 },
      startDate: '2090-01-31',
      end: { type: 'count', count: 12 },
      mode: 'auto',
      status: 'active',
      pausedAt: null,
      generatedCount: 0,
      lastGeneratedDate: null,
    });
    expect(rule?.amount?.toFixed(2)).toBe('1500.50');
  });

  it('TASK-225 insert guarda una transferencia anual en modo confirmación sin monto y con fecha de fin', async () => {
    const user = await newUser();
    const from = await createAccount(user.id);
    const to = await createAccount(user.id);
    const id = uuidv7();

    await withUser(user.id, (repos) =>
      repos.recurringRules.insert({
        id,
        name: uniqueRuleName('Ahorro'),
        kind: 'transfer',
        amount: null,
        accountId: from.id,
        destAccountId: to.id,
        categoryId: null,
        note: null,
        frequency: { type: 'yearly', month: 2, day: 29 },
        startDate: '2090-02-28',
        end: { type: 'until', date: '2095-12-31' },
        mode: 'confirm',
      }),
    );
    const rule = await withUser(user.id, (repos) => repos.recurringRules.get(id));

    expect(rule).toMatchObject({
      id,
      kind: 'transfer',
      amount: null,
      accountId: from.id,
      destAccountId: to.id,
      categoryId: null,
      note: null,
      frequency: { type: 'yearly', month: 2, day: 29 },
      end: { type: 'until', date: '2095-12-31' },
      mode: 'confirm',
      status: 'active',
    });
  });

  it('TASK-225 insert guarda una regla semanal y una diaria sin fin', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const category = await createCategory(user.id, { kind: 'income' });
    const weeklyId = uuidv7();
    const dailyId = uuidv7();
    const base = {
      kind: 'income' as const,
      amount: new Decimal('20.00'),
      accountId: account.id,
      destAccountId: null,
      categoryId: category.id,
      note: null,
      startDate: '2090-03-01',
      end: { type: 'none' as const },
      mode: 'auto' as const,
    };

    const [weekly, daily] = await withUser(user.id, async (repos) => {
      await repos.recurringRules.insert({
        ...base,
        id: weeklyId,
        name: uniqueRuleName('Semanal'),
        frequency: { type: 'weekly', weekday: 3 },
      });
      await repos.recurringRules.insert({
        ...base,
        id: dailyId,
        name: uniqueRuleName('Diaria'),
        frequency: { type: 'daily' },
      });
      return [
        await repos.recurringRules.get(weeklyId),
        await repos.recurringRules.get(dailyId),
      ] as const;
    });

    expect(weekly).toMatchObject({ frequency: { type: 'weekly', weekday: 3 }, end: { type: 'none' } });
    expect(daily).toMatchObject({ frequency: { type: 'daily' }, end: { type: 'none' } });
  });

  it('TASK-225 get de una regla inexistente devuelve null', async () => {
    const user = await newUser();

    expect(await withUser(user.id, (repos) => repos.recurringRules.get(uuidv7()))).toBeNull();
  });
});

// ---------- reglas: list, update y remove ----------

describe('recurringRules.list, update y remove', () => {
  it('TASK-225 list devuelve las reglas del usuario', async () => {
    const user = await newUser();
    const first = await createRule(user.id);
    const second = await createRule(user.id, { status: 'paused' });

    const rules = await withUser(user.id, (repos) => repos.recurringRules.list());

    expect(sorted(rules.map((rule) => rule.id))).toEqual(sorted([first.id, second.id]));
  });

  it('TASK-225 update cambia el nombre y el monto de la regla', async () => {
    const user = await newUser();
    const rule = await createRule(user.id);
    const name = uniqueRuleName('Internet');

    await withUser(user.id, (repos) =>
      repos.recurringRules.update(rule.id, { name, amount: new Decimal('200.00') }),
    );

    expect(await storedRule(rule.id)).toMatchObject({ name, amount: '200.00', status: 'active' });
  });

  it('TASK-225 remove borra la regla y sus ocurrencias; con una regla inexistente devuelve false', async () => {
    const user = await newUser();
    const rule = await createRule(user.id);
    await createOccurrence(user.id, rule.id);

    const [removed, missing] = await withUser(
      user.id,
      async (repos) =>
        [
          await repos.recurringRules.remove(rule.id),
          await repos.recurringRules.remove(uuidv7()),
        ] as const,
    );

    expect(removed).toBe(true);
    expect(missing).toBe(false);
    expect(await storedRule(rule.id)).toBeUndefined();
    expect(await occurrencesOf(rule.id)).toEqual([]);
  });
});

// ---------- reglas: lockForUpdate ----------

describe('recurringRules.lockForUpdate', () => {
  it('TASK-225 lockForUpdate devuelve la regla y bloquea su fila hasta el fin de la transacción', async () => {
    const user = await newUser();
    const rule = await createRule(user.id);

    const outcome = await withUser(user.id, async (repos) => {
      const locked = await repos.recurringRules.lockForUpdate(rule.id);
      const state = await tryLockRule(rule.id);
      return { locked, state };
    });

    expect(outcome.locked).toMatchObject({ id: rule.id, name: rule.name, status: 'active' });
    expect(outcome.state).toBe('blocked');
    expect(await tryLockRule(rule.id)).toBe('free');
  });

  it('TASK-225 lockForUpdate de una regla inexistente devuelve null', async () => {
    const user = await newUser();

    expect(
      await withUser(user.id, (repos) => repos.recurringRules.lockForUpdate(uuidv7())),
    ).toBeNull();
  });
});

// ---------- ocurrencias: insertIfAbsent ----------

describe('recurringOccurrences.insertIfAbsent', () => {
  it('RF-M14-12 insertar dos veces la misma regla y fecha deja una sola fila', async () => {
    const user = await newUser();
    const rule = await createRule(user.id);

    const [first, second] = await withUser(
      user.id,
      async (repos) =>
        [
          await repos.recurringOccurrences.insertIfAbsent(rule.id, '2090-02-05'),
          await repos.recurringOccurrences.insertIfAbsent(rule.id, '2090-02-05'),
        ] as const,
    );

    const stored = await occurrencesOf(rule.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ userId: user.id, ruleId: rule.id, scheduledDate: '2090-02-05' });
    expect(first).toMatchObject({ id: stored[0]?.id, ruleId: rule.id, scheduledDate: '2090-02-05' });
    expect(second).toBeNull();
  });

  it('RF-M14-12 insertIfAbsent en transacciones separadas no duplica la ocurrencia de esa fecha', async () => {
    const user = await newUser();
    const rule = await createRule(user.id);
    await createOccurrence(user.id, rule.id, { scheduledDate: '2090-03-05', status: 'registered' });

    const again = await withUser(user.id, (repos) =>
      repos.recurringOccurrences.insertIfAbsent(rule.id, '2090-03-05'),
    );

    expect(again).toBeNull();
    const stored = await occurrencesOf(rule.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('registered');
  });

  it('RF-M14-12 insertIfAbsent recupera fechas distintas de la misma regla, una fila por fecha', async () => {
    const user = await newUser();
    const rule = await createRule(user.id);
    const dates = ['2090-04-05', '2090-05-05', '2090-06-05'];

    await withUser(user.id, async (repos) => {
      for (const date of dates) {
        await repos.recurringOccurrences.insertIfAbsent(rule.id, date);
      }
      for (const date of dates) {
        await repos.recurringOccurrences.insertIfAbsent(rule.id, date);
      }
    });

    expect((await occurrencesOf(rule.id)).map((row) => row.scheduledDate)).toEqual(dates);
  });
});

// ---------- ocurrencias: pending ----------

describe('recurringOccurrences.pending', () => {
  it('TASK-225 pending devuelve solo las ocurrencias pendientes del usuario', async () => {
    const user = await newUser();
    const rule = await createRule(user.id, { amount: null });
    const a = await createOccurrence(user.id, rule.id);
    const b = await createOccurrence(user.id, rule.id);
    await createOccurrence(user.id, rule.id, { status: 'registered' });
    await createOccurrence(user.id, rule.id, { status: 'skipped' });
    await createOccurrence(user.id, rule.id, { status: 'omitted' });

    const pending = await withUser(user.id, (repos) => repos.recurringOccurrences.pending());

    expect(sorted(pending.map((row) => row.id))).toEqual(sorted([a.id, b.id]));
    expect(pending.find((row) => row.id === a.id)).toMatchObject({
      id: a.id,
      ruleId: rule.id,
      scheduledDate: a.scheduledDate,
      status: 'pending',
    });
  });
});

// ---------- ocurrencias: decideIf ----------

describe('recurringOccurrences.decideIf', () => {
  it('TASK-225 decideIf cambia una ocurrencia que está en el estado esperado', async () => {
    const user = await newUser();
    const rule = await createRule(user.id, { amount: null });
    const occurrence = await createOccurrence(user.id, rule.id);

    const changed = await withUser(user.id, (repos) =>
      repos.recurringOccurrences.decideIf(occurrence.id, 'pending', 'skipped'),
    );

    expect(changed).toBeTruthy();
    expect(await occurrenceStatus(occurrence.id)).toBe('skipped');
  });

  it('TASK-225 decideIf no cambia una ocurrencia que no está en el estado esperado', async () => {
    const user = await newUser();
    const rule = await createRule(user.id, { amount: null });
    const occurrence = await createOccurrence(user.id, rule.id, { status: 'registered' });

    const changed = await withUser(user.id, (repos) =>
      repos.recurringOccurrences.decideIf(occurrence.id, 'pending', 'skipped'),
    );

    expect(changed).toBeFalsy();
    expect(await occurrenceStatus(occurrence.id)).toBe('registered');
  });

  it('TASK-225 de dos decideIf seguidos sobre la misma pendiente solo el primero la cambia', async () => {
    const user = await newUser();
    const rule = await createRule(user.id, { amount: null });
    const occurrence = await createOccurrence(user.id, rule.id);

    const [first, second] = await withUser(
      user.id,
      async (repos) =>
        [
          await repos.recurringOccurrences.decideIf(occurrence.id, 'pending', 'registered'),
          await repos.recurringOccurrences.decideIf(occurrence.id, 'pending', 'skipped'),
        ] as const,
    );

    expect(first).toBeTruthy();
    expect(second).toBeFalsy();
    expect(await occurrenceStatus(occurrence.id)).toBe('registered');
  });

  it('TASK-225 decideIf de una ocurrencia inexistente no cambia nada', async () => {
    const user = await newUser();

    const changed = await withUser(user.id, (repos) =>
      repos.recurringOccurrences.decideIf(uuidv7(), 'pending', 'omitted'),
    );

    expect(changed).toBeFalsy();
  });
});

// ---------- ocurrencias: expiredPending ----------

describe('recurringOccurrences.expiredPending', () => {
  it('TASK-225 expiredPending devuelve las pendientes cuyo pending_since es anterior al instante', async () => {
    const user = await newUser();
    const rule = await createRule(user.id, { amount: null });
    const now = Date.now();
    const old = await createOccurrence(user.id, rule.id, {
      pendingSince: new Date(now - 31 * DAY_MS),
    });
    await createOccurrence(user.id, rule.id, { pendingSince: new Date(now - DAY_MS) });
    await createOccurrence(user.id, rule.id, {
      status: 'skipped',
      pendingSince: new Date(now - 40 * DAY_MS),
    });

    const expired = await withUser(user.id, (repos) =>
      repos.recurringOccurrences.expiredPending(new Date(now - 30 * DAY_MS)),
    );

    expect(expired.map((row) => row.id)).toEqual([old.id]);
    expect(expired[0]).toMatchObject({ id: old.id, ruleId: rule.id, status: 'pending' });
  });
});

// ---------- aislamiento ----------

describe('recurrentes aislamiento', () => {
  it('RN-09 no se ven las reglas de otro usuario: get, lockForUpdate y list', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const anaRule = await createRule(ana.id);
    const betoRule = await createRule(beto.id);

    const [got, locked, list] = await withUser(
      ana.id,
      async (repos) =>
        [
          await repos.recurringRules.get(betoRule.id),
          await repos.recurringRules.lockForUpdate(betoRule.id),
          await repos.recurringRules.list(),
        ] as const,
    );

    expect(got).toBeNull();
    expect(locked).toBeNull();
    expect(list.map((rule) => rule.id)).toEqual([anaRule.id]);
  });

  it('RN-09 update y remove no modifican la regla de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoRule = await createRule(beto.id);

    await withUser(ana.id, (repos) =>
      repos.recurringRules.update(betoRule.id, { name: 'Robada', amount: new Decimal('1.00') }),
    ).catch(() => undefined);
    const removed = await withUser(ana.id, (repos) =>
      repos.recurringRules.remove(betoRule.id),
    ).catch(() => false);

    expect(removed).toBe(false);
    expect(await storedRule(betoRule.id)).toMatchObject({
      name: betoRule.name,
      amount: '150.00',
      status: 'active',
    });
  });

  it('RN-09 no se ven ni se deciden las ocurrencias de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoRule = await createRule(beto.id, { amount: null });
    const betoPending = await createOccurrence(beto.id, betoRule.id);
    const betoOld = await createOccurrence(beto.id, betoRule.id, {
      pendingSince: new Date(Date.now() - 31 * DAY_MS),
    });

    const [pending, expired, changed] = await withUser(
      ana.id,
      async (repos) =>
        [
          await repos.recurringOccurrences.pending(),
          await repos.recurringOccurrences.expiredPending(new Date(Date.now() - 30 * DAY_MS)),
          await repos.recurringOccurrences.decideIf(betoPending.id, 'pending', 'skipped'),
        ] as const,
    );

    expect(pending).toEqual([]);
    expect(expired).toEqual([]);
    expect(changed).toBeFalsy();
    expect(await occurrenceStatus(betoPending.id)).toBe('pending');
    expect(await occurrenceStatus(betoOld.id)).toBe('pending');
  });

  it('RN-09 insertIfAbsent no crea ocurrencias en la regla de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoRule = await createRule(beto.id);

    const inserted = await withUser(ana.id, (repos) =>
      repos.recurringOccurrences.insertIfAbsent(betoRule.id, '2090-07-05'),
    ).catch(() => null);

    expect(inserted).toBeNull();
    expect(await occurrencesOf(betoRule.id)).toEqual([]);
  });
});
