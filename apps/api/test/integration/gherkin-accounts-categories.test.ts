import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createBudget, deleteBudgetsOf } from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { createRule, deleteRecurringOf } from '../factories/recurring.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * TASK-243: the scenarios and rules of M3 to M7 that the phases without new tests left unnamed
 * (plan §5.2, §5.4). They check behavior that already exists, through the HTTP API over the test
 * database with fake integrations: accounts (plan §4.4.2), categories (§4.5.2), movements
 * (§4.6.2), settings, shortcuts and the context of Registrar (§4.7.2).
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
const SHORTCUT_LIMIT = 12;

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.2',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

interface Problem {
  code?: string;
  status?: number;
}
const problem = (res: { body: unknown }) => res.body as Problem;

interface AccountBody {
  id: string;
  name: string;
  currencyCode: string;
  status: string;
  sortOrder: number;
  balance: string;
}
interface AccountList {
  items: AccountBody[];
  summary: { netWorth: { base: string | null } };
}
interface CategoryNodeBody {
  id: string;
  name: string;
  isSystem: boolean;
  status: string;
  children: CategoryNodeBody[];
}
interface TransactionBody {
  id: string;
  kind: string;
  amountInBase: string | null;
  rateUsdBob: string | null;
  beforeInitialBalance: boolean;
  entries: { accountId: string; amount: string }[];
}
interface CreatedBody {
  transaction: TransactionBody;
  undoToken: string | null;
}
interface PageBody {
  items: TransactionBody[];
}
interface Totals {
  income: string;
  expense: string;
  net: string;
}
interface RegisterContextBody {
  defaultAccountId: string | null;
  lastUsed: { expense: string | null; income: string | null };
  accounts: { id: string; name: string }[];
}
interface SettingsBody {
  defaultAccountId: string | null;
}
interface ShortcutList {
  items: { id: string }[];
}

interface Signed {
  cookie: string;
  userId: string;
}

const db = testPrisma();
let container: Container;
let app: Express;
const usedEmails: string[] = [];
const usedUsers: string[] = [];
const originalRelease = process.env['RELEASE'];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const sessionCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${COOKIE_NAME}=`),
  );
  if (header === undefined) throw new Error('the response sets no session cookie');
  return header.split(';')[0] ?? '';
};

async function signedIn(): Promise<Signed> {
  const support = container.testSupport;
  if (support === null) throw new Error('test support is off');
  const { email, password } = await support.createUser();
  usedEmails.push(email);
  const res = await request(app)
    .post('/api/auth/sign-in')
    .set('Origin', WEB_ORIGIN)
    .send({ email, password });
  expect(res.status).toBe(200);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('the signed-in user is not in auth_user');
  usedUsers.push(userId);
  return { cookie: sessionCookieOf(res), userId };
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
const call = (method: Method, path: string, cookie: string, body?: object) => {
  const req = request(app)[method](path).set('Cookie', cookie);
  if (method !== 'get') req.set('Origin', WEB_ORIGIN);
  return method === 'get' || method === 'delete' ? req : req.send(body ?? {});
};

const expectSuccess = (res: { status: number }) => {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
};

/** Today in Bolivia (the timezone of the test users) as `YYYY-MM-DD`. */
const today = (): string => new Date(Date.now() - BOLIVIA_OFFSET_MS).toISOString().slice(0, 10);
const thisMonth = (): string => today().slice(0, 7);

interface NewAccount {
  name: string;
  type?: string;
  currencyCode?: string;
  initialBalance?: string;
}

async function openAccount(user: Signed, input: NewAccount): Promise<AccountBody> {
  const res = await call('post', '/api/accounts', user.cookie, {
    id: uuidv7(),
    type: input.type ?? 'bank',
    name: input.name,
    currencyCode: input.currencyCode ?? 'BOB',
    initialBalance: input.initialBalance ?? '0.00',
    initialBalanceDate: '2020-01-01',
    color: 'teal',
    icon: 'wallet',
  });
  expect(res.status).toBe(201);
  return res.body as AccountBody;
}

async function accountsOf(user: Signed, status = 'active'): Promise<AccountList> {
  const res = await call('get', `/api/accounts?status=${status}`, user.cookie);
  expectSuccess(res);
  return res.body as AccountList;
}

async function balanceOf(user: Signed, accountId: string): Promise<string | undefined> {
  return (await accountsOf(user)).items.find((item) => item.id === accountId)?.balance;
}

async function categoryTree(user: Signed, status = 'active'): Promise<CategoryNodeBody[]> {
  const res = await call('get', `/api/categories?kind=expense&status=${status}`, user.cookie);
  expectSuccess(res);
  return res.body as CategoryNodeBody[];
}

/** An active expense category of the preloaded ones, by name, at any level. */
async function presetCategory(user: Signed, name: string): Promise<CategoryNodeBody> {
  for (const root of await categoryTree(user)) {
    if (root.name === name) return root;
    const child = root.children.find((node) => node.name === name);
    if (child !== undefined) return child;
  }
  throw new Error(`The preloaded category ${name} does not exist`);
}

async function createExpense(
  user: Signed,
  accountId: string,
  categoryId: string,
  amount: string,
  extra: object = {},
): Promise<CreatedBody> {
  const res = await call('post', '/api/transactions', user.cookie, {
    kind: 'expense',
    id: uuidv7(),
    accountId,
    categoryId,
    amount,
    date: today(),
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as CreatedBody;
}

async function totalsOf(user: Signed): Promise<Totals> {
  const res = await call('get', `/api/transactions/summary?month=${thisMonth()}`, user.cookie);
  expectSuccess(res);
  return res.body as Totals;
}

async function registerContextOf(user: Signed): Promise<RegisterContextBody> {
  const res = await call('get', '/api/register/context', user.cookie);
  expectSuccess(res);
  return res.body as RegisterContextBody;
}

beforeAll(async () => {
  process.env['RELEASE'] = '1.2';
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
}, 30_000);

afterAll(async () => {
  if (originalRelease === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = originalRelease;
  await sleep(300);
  await deleteRecurringOf(usedUsers);
  await deleteBudgetsOf(usedUsers);
  await deleteLedgerOf(usedUsers);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 60_000);

describe('M3 la historia no se reescribe', () => {
  it('RF-M3-11 La historia no se reescribe al cambiar la base: el gasto de $ 10,00 sigue valiendo Bs 100,00', async () => {
    const user = await signedIn();
    const usd = await openAccount(user, {
      name: 'Dólares',
      currencyCode: 'USD',
      initialBalance: '100.00',
    });
    const category = await presetCategory(user, 'Comida');

    // The dollar is at Bs 10,00 the day the expense is registered.
    expectSuccess(await call('put', '/api/fx/manual', user.cookie, { value: '10.00' }));
    const created = await createExpense(user, usd.id, category.id, '10.00');
    // An expense is stored with a negative sign: Bs 100,00 going out.
    expect(created.transaction.amountInBase).toBe('-100.00');
    expect(created.transaction.rateUsdBob).toBe('10.00');

    // The dollar rises to Bs 11,00 and the base goes to USD and back to BOB.
    expectSuccess(await call('put', '/api/fx/manual', user.cookie, { value: '11.00' }));
    expectSuccess(await call('patch', '/api/fx-settings', user.cookie, { baseCurrency: 'USD' }));
    expectSuccess(await call('patch', '/api/fx-settings', user.cookie, { baseCurrency: 'BOB' }));

    const after = await call('get', `/api/transactions/${created.transaction.id}`, user.cookie);
    expectSuccess(after);
    const movement = after.body as TransactionBody;
    expect(movement.amountInBase).toBe('-100.00');
    expect(movement.rateUsdBob).toBe('10.00');
  });
});

describe('M4 cuentas', () => {
  it('RF-M4-05 Ajuste de saldo: el saldo real de Bs 1.250,00 crea un ajuste de +50,00 y los ingresos no cambian', async () => {
    const user = await signedIn();
    const bank = await openAccount(user, { name: 'Banco', initialBalance: '1200.00' });
    const before = await totalsOf(user);

    const transactionId = uuidv7();
    const res = await call('post', `/api/accounts/${bank.id}/adjust`, user.cookie, {
      transactionId,
      realBalance: '1250.00',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: true, transactionId });

    const adjustment = await call('get', `/api/transactions/${transactionId}`, user.cookie);
    expectSuccess(adjustment);
    const movement = adjustment.body as TransactionBody;
    expect(movement.kind).toBe('adjustment');
    expect(movement.entries.map((entry) => entry.amount)).toEqual(['50.00']);

    expect(await balanceOf(user, bank.id)).toBe('1250.00');
    expect(await totalsOf(user)).toEqual(before);
  });

  it('EC-M4-08 ajustar el saldo al mismo valor no crea ningún ajuste', async () => {
    const user = await signedIn();
    const bank = await openAccount(user, { name: 'Banco', initialBalance: '1200.00' });

    const res = await call('post', `/api/accounts/${bank.id}/adjust`, user.cookie, {
      transactionId: uuidv7(),
      realBalance: '1200.00',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: false });

    const adjustments = await call('get', '/api/transactions?kind=adjustment', user.cookie);
    expectSuccess(adjustments);
    expect((adjustments.body as PageBody).items).toEqual([]);
    expect(await balanceOf(user, bank.id)).toBe('1200.00');
  });

  it('RF-M4-06 la moneda de una cuenta solo cambia si no tiene movimientos', async () => {
    const user = await signedIn();
    const fresh = await openAccount(user, { name: 'Sin uso', initialBalance: '50.00' });
    const used = await openAccount(user, { name: 'Con uso', initialBalance: '50.00' });
    const category = await presetCategory(user, 'Comida');
    await createExpense(user, used.id, category.id, '10.00');

    // The initial balance is not a movement: the first account still changes currency.
    const changed = await call('patch', `/api/accounts/${fresh.id}`, user.cookie, {
      currencyCode: 'USD',
    });
    expect(changed.status).toBe(200);
    expect((changed.body as AccountBody).currencyCode).toBe('USD');

    const rejected = await call('patch', `/api/accounts/${used.id}`, user.cookie, {
      currencyCode: 'USD',
    });
    expect(rejected.status).toBe(409);
    expect(problem(rejected).code).toBe('CURRENCY_LOCKED');
    const items = (await accountsOf(user)).items;
    expect(items.find((item) => item.id === used.id)?.currencyCode).toBe('BOB');
  });

  it('RF-M4-09 una cuenta archivada sale de los selectores y los totales, pero sus movimientos siguen en el mes', async () => {
    const user = await signedIn();
    const keep = await openAccount(user, { name: 'Activa', initialBalance: '200.00' });
    const archived = await openAccount(user, { name: 'Archivada', initialBalance: '300.00' });
    const category = await presetCategory(user, 'Comida');
    const spent = await createExpense(user, archived.id, category.id, '40.00');
    expect((await accountsOf(user)).summary.netWorth.base).toBe('460.00');
    const monthBefore = await totalsOf(user);

    const res = await call('post', `/api/accounts/${archived.id}/archive`, user.cookie, {
      confirmNonZero: true,
    });
    expect(res.status).toBe(200);

    // Not in the active list, the selectors of Registrar, nor the net worth.
    const active = await accountsOf(user);
    expect(active.items.map((item) => item.id)).toEqual([keep.id]);
    expect(active.summary.netWorth.base).toBe('200.00');
    const context = await registerContextOf(user);
    expect(context.accounts.map((item) => item.id)).toEqual([keep.id]);

    // The history is kept and its movements still count in the income and expense of the month.
    const kept = await accountsOf(user, 'archived');
    expect(kept.items.map((item) => item.id)).toEqual([archived.id]);
    const movement = await call('get', `/api/transactions/${spent.transaction.id}`, user.cookie);
    expectSuccess(movement);
    expect(await totalsOf(user)).toEqual(monthBefore);
    expect(monthBefore.expense).toBe('40.00');
  });

  it('RF-M4-11 las cuentas se reordenan y la lista respeta ese orden', async () => {
    const user = await signedIn();
    const first = await openAccount(user, { name: 'Primera' });
    const second = await openAccount(user, { name: 'Segunda' });
    const third = await openAccount(user, { name: 'Tercera' });
    expect((await accountsOf(user)).items.map((item) => item.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);

    const wanted = [third.id, first.id, second.id];
    const res = await call('put', '/api/accounts/order', user.cookie, { ids: wanted });
    expect(res.status).toBe(204);

    const list = (await accountsOf(user)).items;
    expect(list.map((item) => item.id)).toEqual(wanted);
    const orders = list.map((item) => item.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('RF-M4-12 al archivar la última cuenta usada, Registrar pasa a la primera cuenta activa', async () => {
    const user = await signedIn();
    const first = await openAccount(user, { name: 'Primera', initialBalance: '100.00' });
    const last = await openAccount(user, { name: 'Última usada', initialBalance: '100.00' });
    const category = await presetCategory(user, 'Comida');
    await createExpense(user, last.id, category.id, '5.00');
    expect((await registerContextOf(user)).lastUsed.expense).toBe(last.id);

    expectSuccess(
      await call('post', `/api/accounts/${last.id}/archive`, user.cookie, {
        confirmNonZero: true,
      }),
    );

    const context = await registerContextOf(user);
    expect(context.lastUsed.expense).toBe(first.id);
    expect(context.accounts.map((item) => item.id)).toEqual([first.id]);
  });

  it('EC-M4-04 restaurar una cuenta cuyo nombre está en uso pide un nombre nuevo', async () => {
    const user = await signedIn();
    const old = await openAccount(user, { name: 'Caja' });
    expectSuccess(await call('post', `/api/accounts/${old.id}/archive`, user.cookie, {}));
    await openAccount(user, { name: 'caja' });

    const blocked = await call('post', `/api/accounts/${old.id}/restore`, user.cookie, {});
    expect(blocked.status).toBe(409);
    expect(problem(blocked).code).toBe('NAME_TAKEN');
    expect((await accountsOf(user, 'archived')).items.map((item) => item.id)).toEqual([old.id]);

    const restored = await call('post', `/api/accounts/${old.id}/restore`, user.cookie, {
      newName: 'Caja vieja',
    });
    expect(restored.status).toBe(200);
    expect((restored.body as AccountBody).status).toBe('active');
    expect((restored.body as AccountBody).name).toBe('Caja vieja');
  });

  it('EC-M4-05 al archivar la única cuenta activa no quedan cuentas para Registrar ni para el Inicio', async () => {
    const user = await signedIn();
    const only = await openAccount(user, { name: 'Única' });
    expect((await registerContextOf(user)).accounts).toHaveLength(1);

    expectSuccess(await call('post', `/api/accounts/${only.id}/archive`, user.cookie, {}));

    expect((await accountsOf(user)).items).toEqual([]);
    const context = await registerContextOf(user);
    expect(context.accounts).toEqual([]);
    expect(context.defaultAccountId).toBeNull();
    expect(context.lastUsed.expense).toBeNull();
  });

  it('EC-M4-07 restaurar una cuenta cuya moneda está inactiva pide reactivar la moneda primero', async () => {
    const user = await signedIn();
    expectSuccess(
      await call('post', '/api/currencies', user.cookie, {
        code: 'EUR',
        symbol: '€',
        rate: '7.50',
      }),
    );
    const euro = await openAccount(user, { name: 'Euros', currencyCode: 'EUR' });
    expectSuccess(await call('post', `/api/accounts/${euro.id}/archive`, user.cookie, {}));
    expectSuccess(await call('post', '/api/currencies/EUR/deactivate', user.cookie, {}));

    const res = await call('post', `/api/accounts/${euro.id}/restore`, user.cookie, {});
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('CURRENCY_INACTIVE');
    expect((await accountsOf(user, 'archived')).items.map((item) => item.id)).toEqual([euro.id]);
    expect((await accountsOf(user)).items).toEqual([]);
  });

  it('EC-M7-05 al archivar la cuenta por defecto el ajuste se limpia', async () => {
    const user = await signedIn();
    const preferred = await openAccount(user, { name: 'Preferida' });
    const other = await openAccount(user, { name: 'Otra' });
    const set = await call('patch', '/api/settings', user.cookie, {
      defaultAccountId: preferred.id,
    });
    expectSuccess(set);
    expect((await registerContextOf(user)).defaultAccountId).toBe(preferred.id);

    expectSuccess(await call('post', `/api/accounts/${preferred.id}/archive`, user.cookie, {}));

    const settings = await call('get', '/api/settings', user.cookie);
    expectSuccess(settings);
    expect((settings.body as SettingsBody).defaultAccountId).toBeNull();
    const context = await registerContextOf(user);
    expect(context.defaultAccountId).toBeNull();
    // RF-M7-03: without a default, the last used one that is active, else the first one.
    expect(context.lastUsed.expense).toBe(other.id);
  });
});

describe('M5 categorías', () => {
  it('RF-M5-08 Fusionar duplicados: "Taxi/Apps" queda con 52 movimientos y "Taxis" deja de existir', async () => {
    const user = await signedIn();
    const account = await createAccount(user.userId, { initialBalance: '0.00' });
    const target = await presetCategory(user, 'Taxi/Apps');
    const duplicate = await call('post', '/api/categories', user.cookie, {
      id: uuidv7(),
      kind: 'expense',
      parentId: null,
      name: 'Taxis',
      icon: 'car',
    });
    expect(duplicate.status).toBe(201);
    const taxisId = (duplicate.body as CategoryNodeBody).id;
    for (let index = 0; index < 12; index += 1) {
      await createLedgerTransaction(user.userId, {
        kind: 'expense',
        date: today(),
        categoryId: taxisId,
        entries: [{ accountId: account.id, amount: '-5.00' }],
      });
    }
    for (let index = 0; index < 40; index += 1) {
      await createLedgerTransaction(user.userId, {
        kind: 'expense',
        date: today(),
        categoryId: target.id,
        entries: [{ accountId: account.id, amount: '-5.00' }],
      });
    }
    const countOf = async (categoryId: string): Promise<number> => {
      const res = await call(
        'get',
        `/api/transactions?categoryId=${categoryId}&month=${thisMonth()}&limit=100`,
        user.cookie,
      );
      expectSuccess(res);
      return (res.body as PageBody).items.length;
    };
    expect(await countOf(taxisId)).toBe(12);
    expect(await countOf(target.id)).toBe(40);

    const preview = await call(
      'get',
      `/api/categories/merge-preview?from=${taxisId}&to=${target.id}`,
      user.cookie,
    );
    expectSuccess(preview);
    expect((preview.body as { movements: number }).movements).toBe(12);

    const merged = await call('post', '/api/categories/merge', user.cookie, {
      fromId: taxisId,
      toId: target.id,
    });
    expect(merged.status).toBe(204);

    expect(await countOf(target.id)).toBe(52);
    const names = (await categoryTree(user)).flatMap((root) => [root, ...root.children]);
    expect(names.some((node) => node.id === taxisId)).toBe(false);
    expect(names.some((node) => node.id === target.id)).toBe(true);
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM category WHERE id = ${taxisId}::uuid`;
    expect(Number(rows[0]?.n ?? -1)).toBe(0);

    // Repeating the merge: the source no longer exists.
    const again = await call('post', '/api/categories/merge', user.cookie, {
      fromId: taxisId,
      toId: target.id,
    });
    expect(again.status).toBe(404);
    expect(problem(again).code).toBe('CATEGORY_NOT_FOUND');
  });

  it('EC-M5-02 fusionar una categoría con subcategorías se rechaza hasta fusionar o mover las hijas', async () => {
    const user = await signedIn();
    const parent = await presetCategory(user, 'Transporte');
    const target = await presetCategory(user, 'Ocio');
    expect(parent.children.length).toBeGreaterThan(0);

    const preview = await call(
      'get',
      `/api/categories/merge-preview?from=${parent.id}&to=${target.id}`,
      user.cookie,
    );
    expect(preview.status).toBe(422);
    expect(problem(preview).code).toBe('MERGE_INVALID');
    const merge = await call('post', '/api/categories/merge', user.cookie, {
      fromId: parent.id,
      toId: target.id,
    });
    expect(merge.status).toBe(422);
    expect(problem(merge).code).toBe('MERGE_INVALID');

    // Nothing moved: both categories are still there, with the children.
    const roots = await categoryTree(user);
    const kept = roots.find((node) => node.id === parent.id);
    expect(kept?.children).toHaveLength(parent.children.length);
    expect(roots.some((node) => node.id === target.id)).toBe(true);
  });

  it('RF-M5-05 Categoría del sistema protegida: "Deudas y préstamos" no se archiva ni con SQL directo', async () => {
    const user = await signedIn();
    const system = await presetCategory(user, 'Deudas y préstamos');
    expect(system.isSystem).toBe(true);

    const archive = await call('post', `/api/categories/${system.id}/archive`, user.cookie);
    expect(archive.status).toBe(422);
    expect(problem(archive).code).toBe('SYSTEM_CATEGORY');

    // The database refuses it too (plan §4.5.3): a system category only changes color and icon.
    await expect(
      db.$executeRaw`
        UPDATE category SET status = 'archived', archived_at = now()
         WHERE user_id = ${user.userId}::uuid AND id = ${system.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`
        UPDATE category SET name = 'Otro nombre'
         WHERE user_id = ${user.userId}::uuid AND id = ${system.id}::uuid`,
    ).rejects.toThrow();

    const rows = await db.$queryRaw<{ status: string; name: string }[]>`
      SELECT status::text AS status, name FROM category
       WHERE user_id = ${user.userId}::uuid AND id = ${system.id}::uuid`;
    expect(rows[0]).toEqual({ status: 'active', name: 'Deudas y préstamos' });
  });

  it('EC-M5-07 eliminar una categoría sin movimientos que usa un presupuesto o una regla recurrente se rechaza', async () => {
    const user = await signedIn();
    const budgeted = await createCategory(user.userId, { name: 'Con presupuesto' });
    await createBudget(user.userId, { categoryId: budgeted.id });
    const ruled = await createCategory(user.userId, { name: 'Con regla' });
    await createRule(user.userId, { categoryId: ruled.id });

    for (const category of [budgeted, ruled]) {
      const res = await call('delete', `/api/categories/${category.id}`, user.cookie);
      expect(res.status).toBe(409);
      expect(problem(res).code).toBe('CATEGORY_IN_USE');
    }
    const names = (await categoryTree(user)).map((node) => node.name);
    expect(names).toContain('Con presupuesto');
    expect(names).toContain('Con regla');

    // Archiving, the alternative the user is offered, is allowed.
    const archive = await call('post', `/api/categories/${budgeted.id}/archive`, user.cookie);
    expect(archive.status).toBe(204);
  });
});

describe('M6 y M7 registro rápido', () => {
  it('RF-M7-07 Deshacer después de guardar: el undo de una creación deja el gasto eliminado y el saldo restablecido', async () => {
    const user = await signedIn();
    const cash = await openAccount(user, {
      name: 'Efectivo',
      type: 'cash',
      initialBalance: '500.00',
    });
    const category = await presetCategory(user, 'Comida');

    const saved = await createExpense(user, cash.id, category.id, '35.00');
    expect(await balanceOf(user, cash.id)).toBe('465.00');
    expect(saved.undoToken).not.toBeNull();

    const undo = await call('post', '/api/transactions/undo', user.cookie, {
      undoToken: saved.undoToken,
    });
    expect(undo.status).toBe(204);

    const gone = await call('get', `/api/transactions/${saved.transaction.id}`, user.cookie);
    expect(gone.status).toBe(404);
    expect(await balanceOf(user, cash.id)).toBe('500.00');
    expect(await totalsOf(user)).toMatchObject({ expense: '0.00' });
  });

  it('EC-M7-06 con 12 atajos el trece se rechaza con el límite y no se guarda', async () => {
    const user = await signedIn();
    const cash = await openAccount(user, { name: 'Efectivo', type: 'cash' });
    const category = await presetCategory(user, 'Restaurantes');
    const create = (name: string) =>
      call('post', '/api/shortcuts', user.cookie, {
        id: uuidv7(),
        name,
        kind: 'expense',
        accountId: cash.id,
        categoryId: category.id,
      });
    for (let index = 1; index <= SHORTCUT_LIMIT; index += 1) {
      expect((await create(`Atajo ${index}`)).status).toBe(201);
    }

    const extra = await create('Atajo 13');
    expect(extra.status).toBe(409);
    expect(problem(extra).code).toBe('LIMIT_REACHED');

    const list = await call('get', '/api/shortcuts', user.cookie);
    expectSuccess(list);
    expect((list.body as ShortcutList).items).toHaveLength(SHORTCUT_LIMIT);
  });
});
