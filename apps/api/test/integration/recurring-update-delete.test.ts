import type { UpdateRuleInput } from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import type { RatesContext } from '../../src/application/services/rates.service.js';
import type { RecurringGenerator } from '../../src/application/shared/recurring-generator.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import {
  createRule,
  deleteRecurringOf,
  occurrencesOf,
  occurrenceStatus,
  uniqueRuleName,
  type StoredOccurrence,
} from '../factories/recurring.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task adds editing and deleting rules to `RecurringService` (plan §4.14.2: `PATCH` and
 * `DELETE /api/recurring/:id`), with `UpdateRuleInput` of `@finanzas/contracts` as the body of the
 * edit, but it does not fix their signatures. These tests assume:
 * - `createRecurringService(deps)` takes, as in TASK-227 to TASK-230, `uow`, `generator`, `rates`,
 *   `ledgerHooks` and `clock` from the container built with `RELEASE=1.2`.
 * - `update(ctx, ruleId, input)` mirrors `PATCH /api/recurring/:id` with `input` as its body, and
 *   `remove(ctx, ruleId)` mirrors `DELETE /api/recurring/:id`, as `update` and `remove` of the
 *   accounts and goals services.
 * - The plan does not name an error for a rule of another user, so only that nothing of the owner
 *   changes is checked.
 * - "Today" is the local date of `ctx.now` in `ctx.timezone`.
 *
 * The pending occurrences, their `recurring_pending` notices and the confirmed movements come from
 * the `RecurringGenerator` of TASK-226 and `confirm` of TASK-228, over rules written by SQL. Results
 * are read straight by SQL. `market_rate` is global (ADR-12): the rows this file writes are on its
 * own dates, and whatever was there is put back.
 */
interface RecurringServiceUnderTest {
  confirm(ctx: RatesContext, occurrenceId: string, input: { transactionId: string }): Promise<unknown>;
  update(ctx: RatesContext, ruleId: string, input: UpdateRuleInput): Promise<unknown>;
  remove(ctx: RatesContext, ruleId: string): Promise<unknown>;
}
type CreateRecurringService = (deps: {
  uow: UnitOfWork;
  generator: RecurringGenerator;
  rates: Container['ratesService'];
  ledgerHooks: Container['ledgerHooks'];
  clock: Container['clock'];
}) => RecurringServiceUnderTest;

const { createRecurringService } =
  (await import('../../src/application/services/recurring.service.js')) as unknown as {
    createRecurringService: CreateRecurringService;
  };

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.2',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

const prisma = testPrisma();
const TZ = 'America/La_Paz';
/** 12:00 of 2094-03-20 in La Paz (UTC-4). */
const NOW = new Date('2094-03-20T16:00:00Z');
const TODAY = '2094-03-20';
/** Every rule of this file is monthly on day 10, starting on the first of these dates. */
const FIRST = '2094-02-10';
const SECOND = '2094-03-10';
const RATE_DATES = [FIRST, SECOND, TODAY];

interface SavedRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

let container: Container;
let recurring: RecurringServiceUnderTest;
let savedRates: SavedRate[] = [];
const usedUserIds: string[] = [];

async function marketRate(kind: string, rateDate: string, value: string): Promise<void> {
  const source = kind === 'official' ? 'bcb' : 'paralelo_bo';
  await prisma.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${kind}::market_rate_kind, ${rateDate}::date, ${value}::numeric,
            ${new Date(`${rateDate}T12:00:00Z`)}, ${source}::rate_source)`;
}

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  recurring = createRecurringService({
    uow: container.uow,
    generator: container.recurringGenerator,
    rates: container.ratesService,
    ledgerHooks: container.ledgerHooks,
    clock: container.clock,
  });
  savedRates = await prisma.$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate WHERE rate_date = ANY(${RATE_DATES}::date[])`;
  await prisma.$executeRaw`DELETE FROM market_rate WHERE rate_date = ANY(${RATE_DATES}::date[])`;
  for (const date of RATE_DATES) {
    await marketRate('parallel_bid', date, '9.80');
    await marketRate('parallel_median', date, '9.90');
    await marketRate('parallel_ask', date, '10.00');
    await marketRate('official', date, '6.96');
  }
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate WHERE rate_date = ANY(${RATE_DATES}::date[])`;
  for (const row of savedRates) {
    await prisma.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
  await deleteRecurringOf(usedUserIds);
  await deleteGoalsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

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

/** Runs the call ignoring its outcome: whether it rejects or not, nothing of the owner changes. */
async function settle(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // The plan names no error for a rule of another user (plan §4.14.2).
  }
}

interface History {
  ruleId: string;
  ruleName: string;
  accountId: string;
  /** The movement confirmed from the occurrence of `FIRST`. */
  transactionId: string;
  /** The occurrence of `FIRST`, registered. */
  registeredId: string;
  /** The occurrence of `SECOND`, still pending with its notice. */
  pendingId: string;
}

/**
 * A monthly rule of 150.00 in confirmation mode on day 10, starting on `FIRST`. The generator leaves
 * the occurrences of `FIRST` and `SECOND` pending with their notices; the one of `FIRST` is then
 * confirmed, so the rule has one movement and one pending occurrence.
 */
async function ruleWithHistory(userId: string): Promise<History> {
  const account = await createAccount(userId, {
    type: 'bank',
    initialBalance: '100000.00',
    initialBalanceDate: '2094-01-01',
  });
  const rule = await createRule(userId, {
    name: uniqueRuleName('Alquiler'),
    amount: '150.00',
    accountId: account.id,
    mode: 'confirm',
    dayOfMonth: 10,
    startDate: FIRST,
  });
  await container.uow.run(
    async (repos) => {
      const locked = await repos.recurringRules.lockForUpdate(rule.id);
      if (locked === null) {
        throw new Error('The rule does not exist');
      }
      await container.recurringGenerator.generateDue(repos, userId, locked, TODAY);
    },
    { userLock: userId },
  );
  const generated = await occurrencesOf(rule.id);
  const [first, second] = generated;
  if (
    generated.length !== 2 ||
    first?.scheduledDate !== FIRST ||
    first.status !== 'pending' ||
    second?.scheduledDate !== SECOND ||
    second.status !== 'pending'
  ) {
    throw new Error('The generator was expected to leave two pending occurrences');
  }
  const transactionId = uuidv7();
  await recurring.confirm(ctxFor(userId), first.id, { transactionId });
  if ((await occurrenceStatus(first.id)) !== 'registered') {
    throw new Error('The first occurrence was expected to be registered');
  }
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    accountId: account.id,
    transactionId,
    registeredId: first.id,
    pendingId: second.id,
  };
}

interface StoredTransaction {
  id: string;
  date: string;
  origin: string;
  recurringRuleId: string | null;
  recurringLabel: string | null;
}

async function transactionsOf(userId: string): Promise<StoredTransaction[]> {
  return prisma.$queryRaw<StoredTransaction[]>`
    SELECT id::text AS id, to_char(date, 'YYYY-MM-DD') AS date, origin::text AS origin,
           recurring_rule_id::text AS "recurringRuleId", recurring_label AS "recurringLabel"
      FROM ledger_transaction
     WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
     ORDER BY date, id`;
}

async function entriesOf(transactionId: string): Promise<{ accountId: string; amount: string }[]> {
  return prisma.$queryRaw<{ accountId: string; amount: string }[]>`
    SELECT account_id::text AS "accountId", amount::text AS amount
      FROM ledger_entry WHERE transaction_id = ${transactionId}::uuid
     ORDER BY account_id`;
}

/** The decision status of the `recurring_pending` notice of the occurrence. */
async function noticeStatus(userId: string, occurrenceId: string): Promise<string | null | undefined> {
  const rows = await prisma.$queryRaw<{ status: string | null }[]>`
    SELECT decision_status::text AS status
      FROM notification
     WHERE user_id = ${userId}::uuid AND event_key = ${`recurring_pending:${occurrenceId}`}`;
  return rows[0]?.status;
}

interface StoredRule {
  name: string;
  amount: string | null;
  status: string;
  endType: string;
  endDate: string | null;
}

async function storedRule(ruleId: string): Promise<StoredRule | undefined> {
  const rows = await prisma.$queryRaw<StoredRule[]>`
    SELECT name, amount::text AS amount, status::text AS status, end_type::text AS "endType",
           to_char(end_date, 'YYYY-MM-DD') AS "endDate"
      FROM recurring_rule WHERE id = ${ruleId}::uuid`;
  return rows[0];
}

const snapshot = (occurrences: StoredOccurrence[]): string[] =>
  occurrences.map((o) => `${o.id}:${o.scheduledDate}:${o.status}`);

// ---------- Editar ----------

describe('RecurringService.update', () => {
  it('RF-M14-10 cambiar el monto no cambia los pendientes ni los movimientos ya creados', async () => {
    const userId = await newUser();
    const history = await ruleWithHistory(userId);
    const before = snapshot(await occurrencesOf(history.ruleId));
    const transactionsBefore = await transactionsOf(userId);

    await recurring.update(ctxFor(userId), history.ruleId, { amount: '200.00' });

    expect((await storedRule(history.ruleId))?.amount).toBe('200.00');
    expect(snapshot(await occurrencesOf(history.ruleId))).toEqual(before);
    expect(await occurrenceStatus(history.pendingId)).toBe('pending');
    expect(await noticeStatus(userId, history.pendingId)).toBe('waiting');
    expect(await transactionsOf(userId)).toEqual(transactionsBefore);
    expect(await entriesOf(history.transactionId)).toEqual([
      { accountId: history.accountId, amount: '-150.00' },
    ]);
  });

  it('RF-M14-10 cambiar el nombre no cambia la etiqueta de los movimientos ya creados', async () => {
    const userId = await newUser();
    const history = await ruleWithHistory(userId);
    const newName = uniqueRuleName('Renta');

    await recurring.update(ctxFor(userId), history.ruleId, { name: newName });

    expect((await storedRule(history.ruleId))?.name).toBe(newName);
    const transactions = await transactionsOf(userId);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      id: history.transactionId,
      date: FIRST,
      recurringRuleId: history.ruleId,
      recurringLabel: history.ruleName,
    });
    expect(await occurrenceStatus(history.pendingId)).toBe('pending');
  });

  it('TASK-231 extender el fin de una regla finalizada la vuelve a Activa', async () => {
    const userId = await newUser();
    const rule = await createRule(userId, {
      amount: '150.00',
      mode: 'auto',
      dayOfMonth: 10,
      startDate: FIRST,
      status: 'finished',
    });
    await prisma.$executeRaw`
      UPDATE recurring_rule
         SET end_type = 'until'::rule_end_type, end_date = ${SECOND}::date,
             generated_count = 2, last_generated_date = ${SECOND}::date
       WHERE id = ${rule.id}::uuid`;

    await recurring.update(ctxFor(userId), rule.id, {
      end: { type: 'until', date: '2094-06-30' },
    });

    expect(await storedRule(rule.id)).toMatchObject({
      status: 'active',
      endType: 'until',
      endDate: '2094-06-30',
    });
  });

  it('TASK-231 no edita la regla de otro usuario', async () => {
    const ownerId = await newUser();
    const otherId = await newUser();
    const history = await ruleWithHistory(ownerId);

    await settle(recurring.update(ctxFor(otherId), history.ruleId, { amount: '200.00' }));

    expect((await storedRule(history.ruleId))?.amount).toBe('150.00');
  });
});

// ---------- Eliminar ----------

describe('RecurringService.remove', () => {
  it('RF-M14-11 eliminar una regla conserva sus movimientos con su etiqueta "De recurrente: X"', async () => {
    const userId = await newUser();
    const history = await ruleWithHistory(userId);

    await recurring.remove(ctxFor(userId), history.ruleId);

    expect(await storedRule(history.ruleId)).toBeUndefined();
    const transactions = await transactionsOf(userId);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      id: history.transactionId,
      date: FIRST,
      origin: 'recurring',
      recurringRuleId: null,
      recurringLabel: history.ruleName,
    });
    expect(await entriesOf(history.transactionId)).toEqual([
      { accountId: history.accountId, amount: '-150.00' },
    ]);
  });

  it('RF-M14-11 eliminar una regla borra sus pendientes', async () => {
    const userId = await newUser();
    const history = await ruleWithHistory(userId);

    await recurring.remove(ctxFor(userId), history.ruleId);

    expect(await occurrencesOf(history.ruleId)).toEqual([]);
    expect(await occurrenceStatus(history.pendingId)).toBeUndefined();
  });

  it('EC-M14-04 se elimina una regla con un pendiente: el pendiente desaparece y su aviso queda resuelto', async () => {
    const userId = await newUser();
    const history = await ruleWithHistory(userId);
    expect(await noticeStatus(userId, history.pendingId)).toBe('waiting');

    await recurring.remove(ctxFor(userId), history.ruleId);

    expect(await occurrenceStatus(history.pendingId)).toBeUndefined();
    expect(await noticeStatus(userId, history.pendingId)).toBe('resolved');
    const transactions = await transactionsOf(userId);
    expect(transactions.map((t) => t.recurringLabel)).toEqual([history.ruleName]);
  });

  it('TASK-231 no elimina la regla de otro usuario', async () => {
    const ownerId = await newUser();
    const otherId = await newUser();
    const history = await ruleWithHistory(ownerId);

    await settle(recurring.remove(ctxFor(otherId), history.ruleId));

    expect(await storedRule(history.ruleId)).toBeDefined();
    expect(await occurrenceStatus(history.pendingId)).toBe('pending');
    expect(await noticeStatus(ownerId, history.pendingId)).toBe('waiting');
    expect((await transactionsOf(ownerId))[0]?.recurringRuleId).toBe(history.ruleId);
  });
});
