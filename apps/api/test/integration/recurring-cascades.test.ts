import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { RatesContext } from '../../src/application/services/rates.service.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import {
  createCategory,
  createCategoryBudget,
  createCategoryShortcut,
  deleteCategoryUsageOf,
} from '../factories/category.factory.js';
import { deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createRule, deleteRecurringOf } from '../factories/recurring.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Archiving an account or a category pauses its active recurring rules with a `recurring_pending`
 * notice of key `rule:{id}:paused:{fecha}` (plan §4.4.2, §4.5.2, §4.14.3; EC-M14-02, RF-M5-07,
 * RF-M15-02). Deleting an account used by a rule is rejected with `ACCOUNT_IN_USE 409 {recurring}`
 * (plan §4.4.2, RF-M4-13), like `CATEGORY_IN_USE`.
 *
 * These tests go through the services of the container built with `RELEASE=1.2`, with the
 * signatures they already have: `accountsService.archive(ctx, id, { confirmNonZero })`,
 * `accountsService.remove(ctx, id)`, `categoriesService.archive(userId, id)`. A rejection is an
 * `AppError` with the code of the catalogue (ADR-09). The plan does not say which date goes in the
 * key of the notice, so only its shape `YYYY-MM-DD` is checked. `{recurring}` is read as the list of
 * the rules that use the account, each with its `id`, as in `CATEGORY_IN_USE`. Results are read
 * straight by SQL.
 */
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
/** 12:00 of 2095-05-20 in La Paz (UTC-4). */
const NOW = new Date('2095-05-20T16:00:00Z');
const TODAY = '2095-05-20';

interface SavedRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

let container: Container;
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
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  savedRates = await prisma.$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate WHERE rate_date = ${TODAY}::date`;
  await prisma.$executeRaw`DELETE FROM market_rate WHERE rate_date = ${TODAY}::date`;
  await marketRate('parallel_bid', '9.80');
  await marketRate('parallel_median', '9.90');
  await marketRate('parallel_ask', '10.00');
  await marketRate('official', '6.96');
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate WHERE rate_date = ${TODAY}::date`;
  for (const row of savedRates) {
    await prisma.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
  await deleteRecurringOf(usedUserIds);
  await deleteCategoryUsageOf(usedUserIds);
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

async function newUserId(): Promise<string> {
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
  throw new Error('Expected the promise to be rejected');
}

interface StoredRule {
  status: string;
  pausedAt: Date | null;
}

async function ruleOf(ruleId: string): Promise<StoredRule | undefined> {
  const rows = await prisma.$queryRaw<StoredRule[]>`
    SELECT status::text AS status, paused_at AS "pausedAt"
      FROM recurring_rule WHERE id = ${ruleId}::uuid`;
  return rows[0];
}

interface StoredNotice {
  type: string;
  eventKey: string;
}

/** The notices of the rule paused by an archive: their key starts with `rule:{id}:paused:`. */
async function pausedNoticesOf(userId: string, ruleId: string): Promise<StoredNotice[]> {
  const prefix = `rule:${ruleId}:paused:`;
  const rows = await prisma.$queryRaw<StoredNotice[]>`
    SELECT type::text AS type, event_key AS "eventKey"
      FROM notification WHERE user_id = ${userId}::uuid
     ORDER BY event_key`;
  return rows.filter((row) => row.eventKey.startsWith(prefix));
}

function expectPausedNotice(notices: StoredNotice[], ruleId: string): void {
  expect(notices).toHaveLength(1);
  const notice = notices[0];
  expect(notice?.type).toBe('recurring_pending');
  expect(notice?.eventKey).toMatch(new RegExp(`^rule:${ruleId}:paused:\\d{4}-\\d{2}-\\d{2}$`));
}

async function accountExists(accountId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM account WHERE id = ${accountId}::uuid`;
  return rows.length === 1;
}

async function defaultAccountOf(userId: string): Promise<string | null | undefined> {
  const rows = await prisma.$queryRaw<{ defaultAccountId: string | null }[]>`
    SELECT default_account_id::text AS "defaultAccountId"
      FROM user_settings WHERE user_id = ${userId}::uuid`;
  return rows[0]?.defaultAccountId;
}

async function setDefaultAccount(userId: string, accountId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE user_settings SET default_account_id = ${accountId}::uuid
     WHERE user_id = ${userId}::uuid`;
}

async function shortcutExists(shortcutId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM shortcut WHERE id = ${shortcutId}::uuid`;
  return rows.length === 1;
}

// ---------- Archivar una cuenta ----------

describe('Archivar la cuenta de una regla (EC-M14-02)', () => {
  it('EC-M14-02 archivar la cuenta de una regla activa la deja pausada, con un aviso', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const rule = await createRule(userId, { accountId: account.id });

    await container.accountsService.archive(ctxFor(userId), account.id, { confirmNonZero: false });

    const stored = await ruleOf(rule.id);
    expect(stored?.status).toBe('paused');
    expect(stored?.pausedAt).not.toBeNull();
  });

  it('RF-M15-02 el aviso de la regla pausada al archivar su cuenta es recurring_pending con clave rule:{id}:paused:{fecha}', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const rule = await createRule(userId, { accountId: account.id });

    await container.accountsService.archive(ctxFor(userId), account.id, { confirmNonZero: false });

    expectPausedNotice(await pausedNoticesOf(userId, rule.id), rule.id);
  });

  it('EC-M14-02 archivar la cuenta pausa todas sus reglas activas, cada una con su aviso', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const first = await createRule(userId, { accountId: account.id });
    const second = await createRule(userId, { accountId: account.id });

    await container.accountsService.archive(ctxFor(userId), account.id, { confirmNonZero: false });

    for (const rule of [first, second]) {
      expect((await ruleOf(rule.id))?.status).toBe('paused');
      expectPausedNotice(await pausedNoticesOf(userId, rule.id), rule.id);
    }
  });

  it('EC-M14-02 una regla finalizada de la cuenta no cambia ni genera aviso', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const rule = await createRule(userId, { accountId: account.id, status: 'finished' });

    await container.accountsService.archive(ctxFor(userId), account.id, { confirmNonZero: false });

    expect((await ruleOf(rule.id))?.status).toBe('finished');
    expect(await pausedNoticesOf(userId, rule.id)).toHaveLength(0);
  });

  it('EC-M14-02 una regla de otra cuenta sigue activa y sin aviso', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const other = await createRule(userId);

    await container.accountsService.archive(ctxFor(userId), account.id, { confirmNonZero: false });

    expect((await ruleOf(other.id))?.status).toBe('active');
    expect(await pausedNoticesOf(userId, other.id)).toHaveLength(0);
  });
});

// ---------- Archivar una categoría ----------

describe('Archivar una categoría con presupuesto y recurrente (RF-M5-07)', () => {
  it('RF-M5-07 Archivar una categoría con presupuesto y recurrente: "Netflix" queda pausado con un aviso para elegir otra categoría', async () => {
    const userId = await newUserId();
    const ocio = await createCategory(userId, { name: `Ocio ${uuidv7().slice(-6)}` });
    await createCategoryBudget(userId, ocio.id);
    const netflix = await createRule(userId, {
      categoryId: ocio.id,
      name: `Netflix ${uuidv7().slice(-6)}`,
    });

    await container.categoriesService.archive(userId, ocio.id);

    const stored = await ruleOf(netflix.id);
    expect(stored?.status).toBe('paused');
    expect(stored?.pausedAt).not.toBeNull();
    expectPausedNotice(await pausedNoticesOf(userId, netflix.id), netflix.id);
  });

  it('RF-M5-07 archivar la categoría principal pausa también las reglas de sus subcategorías, con aviso', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id });
    const rule = await createRule(userId, { categoryId: child.id });

    await container.categoriesService.archive(userId, parent.id);

    expect((await ruleOf(rule.id))?.status).toBe('paused');
    expectPausedNotice(await pausedNoticesOf(userId, rule.id), rule.id);
  });

  it('RF-M5-07 una regla de otra categoría sigue activa y sin aviso', async () => {
    const userId = await newUserId();
    const archived = await createCategory(userId);
    const other = await createRule(userId);

    await container.categoriesService.archive(userId, archived.id);

    expect((await ruleOf(other.id))?.status).toBe('active');
    expect(await pausedNoticesOf(userId, other.id)).toHaveLength(0);
  });
});

// ---------- Eliminar una cuenta usada por una regla ----------

describe('Eliminar una cuenta que usa una regla recurrente (RF-M4-13)', () => {
  it('RF-M4-13 eliminar una cuenta sin movimientos que usa una regla da ACCOUNT_IN_USE 409 {recurring}', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const rule = await createRule(userId, { accountId: account.id });

    const error = await rejectionOf(container.accountsService.remove(ctxFor(userId), account.id));

    expect(error.code).toBe('ACCOUNT_IN_USE');
    expect(error.status).toBe(409);
    expect(error.data?.['recurring']).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: rule.id })]),
    );
  });

  it('RF-M4-13 el rechazo no borra nada: siguen la cuenta, la regla, la cuenta por defecto y los atajos', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const rule = await createRule(userId, { accountId: account.id });
    const category = await createCategory(userId);
    const shortcut = await createCategoryShortcut(userId, category.id, account.id);
    await setDefaultAccount(userId, account.id);

    await rejectionOf(container.accountsService.remove(ctxFor(userId), account.id));

    expect(await accountExists(account.id)).toBe(true);
    expect((await ruleOf(rule.id))?.status).toBe('active');
    expect(await defaultAccountOf(userId)).toBe(account.id);
    expect(await shortcutExists(shortcut.id)).toBe(true);
  });

  it('RF-M4-13 una cuenta sin movimientos ni reglas se sigue eliminando', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);

    await container.accountsService.remove(ctxFor(userId), account.id);

    expect(await accountExists(account.id)).toBe(false);
  });
});
