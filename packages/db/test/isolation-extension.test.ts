import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { forUser } from '../src/index.js';
import { closeSql, sql } from './helpers.js';

function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  return url;
}

/** Base client over the test database. Every scoped client of this file wraps it. */
const prisma = new PrismaClient({ datasourceUrl: testDatabaseUrl() });

/** Keys created by this file, removed in afterAll even if a test fails half way. */
const created = {
  users: [] as string[],
  marketRateDates: [] as string[],
  jobs: [] as string[],
  outboxIds: [] as string[],
  throttleHmacs: [] as string[],
  sendLogHmacs: [] as string[],
};

afterAll(async () => {
  const db = sql();
  await db.query('DELETE FROM auth_user WHERE id = ANY($1::uuid[])', [created.users]);
  await db.query(`DELETE FROM market_rate WHERE kind = 'official' AND rate_date = ANY($1::date[])`, [
    created.marketRateDates,
  ]);
  await db.query('DELETE FROM job_run WHERE job = ANY($1::text[])', [created.jobs]);
  await db.query('DELETE FROM email_outbox WHERE id = ANY($1::uuid[])', [created.outboxIds]);
  await db.query('DELETE FROM login_throttle WHERE email_hmac = ANY($1::text[])', [
    created.throttleHmacs,
  ]);
  await db.query('DELETE FROM email_send_log WHERE email_hmac = ANY($1::text[])', [
    created.sendLogHmacs,
  ]);
  await prisma.$disconnect();
  await closeSql();
});

// ---------- Fixtures (raw SQL, independent of the extension under test) ----------

async function insertUser(): Promise<string> {
  const id = randomUUID();
  created.users.push(id);
  await sql().query(
    `INSERT INTO auth_user (id, name, email, terms_accepted_at, registered_at)
     VALUES ($1, 'Ana', $2, now(), now())`,
    [id, `${id}@test.local`],
  );
  await sql().query(
    `INSERT INTO currency (user_id, code, symbol, is_system, status)
     VALUES ($1, 'BOB', 'Bs', true, 'active')`,
    [id],
  );
  return id;
}

async function insertCategory(userId: string, name: string): Promise<string> {
  const id = randomUUID();
  await sql().query(
    `INSERT INTO category (id, user_id, kind, name, color, icon, sort_order)
     VALUES ($1, $2, 'expense', $3, '#22c55e', 'tag', 0)`,
    [id, userId, name],
  );
  return id;
}

async function insertAccount(userId: string, name: string): Promise<string> {
  const id = randomUUID();
  await sql().query(
    `INSERT INTO account (id, user_id, type, name, currency_code, initial_balance_date, color, icon, sort_order)
     VALUES ($1, $2, 'bank', $3, 'BOB', '2026-01-01', '#22c55e', 'wallet', 0)`,
    [id, userId, name],
  );
  return id;
}

interface TwoUsers {
  a: string;
  b: string;
  /** The two categories of A. */
  aCategories: string[];
  /** The only category of B. */
  bCategory: string;
  aAccount: string;
  bAccount: string;
}

/** Fresh users A and B: A owns two categories and one account, B owns one of each. */
async function twoUsers(): Promise<TwoUsers> {
  const a = await insertUser();
  const b = await insertUser();
  const aCategories = [await insertCategory(a, 'Comida'), await insertCategory(a, 'Transporte')];
  const bCategory = await insertCategory(b, 'Comida');
  const aAccount = await insertAccount(a, 'Banco');
  const bAccount = await insertAccount(b, 'Banco');
  return { a, b, aCategories, bCategory, aAccount, bAccount };
}

interface CategoryRow {
  user_id: string;
  color: string;
  icon: string;
}

/** Reads a category straight from the database. */
async function categoryRow(id: string): Promise<CategoryRow | undefined> {
  const { rows } = await sql().query<CategoryRow>(
    'SELECT user_id, color, icon FROM category WHERE id = $1',
    [id],
  );
  return rows[0];
}

async function accountName(id: string): Promise<string | undefined> {
  const { rows } = await sql().query<{ name: string }>('SELECT name FROM account WHERE id = $1', [
    id,
  ]);
  return rows[0]?.name;
}

/** Runs `run` and returns what it threw, or undefined if it succeeded. */
async function failure(run: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** The identity of an error, to compare "foreign" against "missing". */
function errorKind(err: unknown): { name: string; code: unknown } {
  const e = err as { constructor?: { name?: string }; code?: unknown };
  return { name: e.constructor?.name ?? typeof err, code: e.code };
}

const sorted = (ids: string[]): string[] => [...ids].sort();

const hmac = (): string => randomBytes(32).toString('hex');

// ---------- RN-09: reads only see the user's rows ----------

describe('forUser: lecturas', () => {
  it('RN-09 findMany con la extensión devuelve solo las filas del usuario', async () => {
    const f = await twoUsers();

    const rowsA = await forUser(prisma, f.a).category.findMany();
    expect(sorted(rowsA.map((r) => r.id))).toEqual(sorted(f.aCategories));
    expect(rowsA.every((r) => r.userId === f.a)).toBe(true);

    const rowsB = await forUser(prisma, f.b).category.findMany();
    expect(rowsB.map((r) => r.id)).toEqual([f.bCategory]);
  });

  it('RN-09 findMany con un filtro hacia otro usuario no devuelve sus filas', async () => {
    const f = await twoUsers();
    const scoped = forUser(prisma, f.a);

    const byUser = await scoped.category.findMany({ where: { userId: f.b } });
    expect(byUser.some((r) => r.userId === f.b)).toBe(false);

    const byId = await scoped.category.findMany({ where: { id: f.bCategory } });
    expect(byId).toEqual([]);
  });

  it('RN-09 findMany aísla también otro modelo del usuario (account)', async () => {
    const f = await twoUsers();

    const rows = await forUser(prisma, f.a).account.findMany();
    expect(rows.map((r) => r.id)).toEqual([f.aAccount]);
  });

  it('RN-09 findFirst de un id ajeno devuelve null, igual que un id inexistente', async () => {
    const f = await twoUsers();
    const scoped = forUser(prisma, f.a);

    expect(await scoped.category.findFirst({ where: { id: f.bCategory } })).toBeNull();
    expect(await scoped.category.findFirst({ where: { id: randomUUID() } })).toBeNull();
    const own = await scoped.category.findFirst({ where: { id: f.aCategories[0]! } });
    expect(own?.id).toBe(f.aCategories[0]);
  });

  it('RN-09 findUnique de un id ajeno devuelve null, igual que un id inexistente', async () => {
    const f = await twoUsers();
    const scoped = forUser(prisma, f.a);

    expect(await scoped.category.findUnique({ where: { id: f.bCategory } })).toBeNull();
    expect(await scoped.category.findUnique({ where: { id: randomUUID() } })).toBeNull();
    const own = await scoped.category.findUnique({ where: { id: f.aCategories[0]! } });
    expect(own?.id).toBe(f.aCategories[0]);
  });

  it('RN-09 findFirstOrThrow y findUniqueOrThrow de un id ajeno fallan igual que con un id inexistente', async () => {
    const f = await twoUsers();
    const scoped = forUser(prisma, f.a);
    const missing = randomUUID();

    const firstForeign = await failure(() =>
      scoped.category.findFirstOrThrow({ where: { id: f.bCategory } }),
    );
    const firstMissing = await failure(() =>
      scoped.category.findFirstOrThrow({ where: { id: missing } }),
    );
    expect(firstForeign).toBeInstanceOf(Error);
    expect(errorKind(firstForeign)).toEqual(errorKind(firstMissing));

    const uniqueForeign = await failure(() =>
      scoped.category.findUniqueOrThrow({ where: { id: f.bCategory } }),
    );
    const uniqueMissing = await failure(() =>
      scoped.category.findUniqueOrThrow({ where: { id: missing } }),
    );
    expect(uniqueForeign).toBeInstanceOf(Error);
    expect(errorKind(uniqueForeign)).toEqual(errorKind(uniqueMissing));
  });

  it('RN-09 count cuenta solo las filas del usuario', async () => {
    const f = await twoUsers();
    const scoped = forUser(prisma, f.a);

    expect(await scoped.category.count()).toBe(2);
    expect(await scoped.category.count({ where: { id: f.bCategory } })).toBe(0);
    expect(await scoped.account.count()).toBe(1);
    expect(await forUser(prisma, f.b).category.count()).toBe(1);
  });
});

// ---------- RNF-14: writes never reach another user's rows ----------

describe('forUser: escrituras', () => {
  it('RNF-14 crear con otro userId lanza un error y no inserta la fila', async () => {
    const f = await twoUsers();
    const id = randomUUID();

    const err = await failure(() =>
      forUser(prisma, f.a).category.create({
        data: {
          id,
          userId: f.b,
          kind: 'expense',
          name: 'Salud',
          color: '#22c55e',
          icon: 'tag',
          sortOrder: 1,
        },
      }),
    );

    expect(err).toBeInstanceOf(Error);
    expect(await categoryRow(id)).toBeUndefined();
  });

  it('RNF-14 crear con el userId propio inserta la fila del usuario', async () => {
    const f = await twoUsers();
    const id = randomUUID();

    const row = await forUser(prisma, f.a).category.create({
      data: {
        id,
        userId: f.a,
        kind: 'expense',
        name: 'Salud',
        color: '#22c55e',
        icon: 'tag',
        sortOrder: 1,
      },
    });

    expect(row.id).toBe(id);
    expect((await categoryRow(id))?.user_id).toBe(f.a);
  });

  it('RNF-14 actualizar un id ajeno con updateMany afecta 0 filas y no cambia la fila', async () => {
    const f = await twoUsers();

    const result = await forUser(prisma, f.a).category.updateMany({
      where: { id: f.bCategory },
      data: { color: '#000000' },
    });

    expect(result.count).toBe(0);
    expect((await categoryRow(f.bCategory))?.color).toBe('#22c55e');
  });

  it('RNF-14 updateMany con ids propios y ajenos actualiza solo las filas del usuario', async () => {
    const f = await twoUsers();

    // The filter is bounded to this test's rows, so a missing scope never touches other data.
    const result = await forUser(prisma, f.a).category.updateMany({
      where: { id: { in: [...f.aCategories, f.bCategory] } },
      data: { icon: 'star' },
    });

    expect(result.count).toBe(2);
    for (const id of f.aCategories) {
      expect((await categoryRow(id))?.icon).toBe('star');
    }
    expect((await categoryRow(f.bCategory))?.icon).toBe('tag');
  });

  it('RNF-14 actualizar un id ajeno con update falla igual que con un id inexistente y no cambia la fila', async () => {
    const f = await twoUsers();
    const scoped = forUser(prisma, f.a);

    const foreign = await failure(() =>
      scoped.category.update({ where: { id: f.bCategory }, data: { color: '#000000' } }),
    );
    const missing = await failure(() =>
      scoped.category.update({ where: { id: randomUUID() }, data: { color: '#000000' } }),
    );

    expect(foreign).toBeInstanceOf(Error);
    expect(errorKind(foreign)).toEqual(errorKind(missing));
    expect((await categoryRow(f.bCategory))?.color).toBe('#22c55e');
  });

  it('RNF-14 actualizar un id ajeno con updateManyAndReturn no devuelve ni cambia filas', async () => {
    const f = await twoUsers();

    const rows = await forUser(prisma, f.a).category.updateManyAndReturn({
      where: { id: f.bCategory },
      data: { color: '#000000' },
    });

    expect(rows).toEqual([]);
    expect((await categoryRow(f.bCategory))?.color).toBe('#22c55e');
  });

  it('RNF-14 actualizar una cuenta ajena afecta 0 filas', async () => {
    const f = await twoUsers();

    const result = await forUser(prisma, f.a).account.updateMany({
      where: { id: f.bAccount },
      data: { name: 'Ajena' },
    });

    expect(result.count).toBe(0);
    expect(await accountName(f.bAccount)).toBe('Banco');
  });

  it('RNF-14 borrar un id ajeno con deleteMany afecta 0 filas y la fila sigue existiendo', async () => {
    const f = await twoUsers();

    const result = await forUser(prisma, f.a).category.deleteMany({ where: { id: f.bCategory } });

    expect(result.count).toBe(0);
    expect(await categoryRow(f.bCategory)).toBeDefined();
  });

  it('RNF-14 deleteMany con ids propios y ajenos borra solo las filas del usuario', async () => {
    const f = await twoUsers();

    // The filter is bounded to this test's rows, so a missing scope never touches other data.
    const result = await forUser(prisma, f.a).category.deleteMany({
      where: { id: { in: [...f.aCategories, f.bCategory] } },
    });

    expect(result.count).toBe(2);
    for (const id of f.aCategories) {
      expect(await categoryRow(id)).toBeUndefined();
    }
    expect(await categoryRow(f.bCategory)).toBeDefined();
  });

  it('RNF-14 borrar un id ajeno con delete falla igual que con un id inexistente y la fila sigue existiendo', async () => {
    const f = await twoUsers();
    const scoped = forUser(prisma, f.a);

    const foreign = await failure(() => scoped.category.delete({ where: { id: f.bCategory } }));
    const missing = await failure(() => scoped.category.delete({ where: { id: randomUUID() } }));

    expect(foreign).toBeInstanceOf(Error);
    expect(errorKind(foreign)).toEqual(errorKind(missing));
    expect(await categoryRow(f.bCategory)).toBeDefined();
  });
});

// ---------- Global models are exempt (ADR-12): no user_id to inject or verify ----------

describe('forUser: modelos globales exentos', () => {
  it('TASK-032 ADR-12 market_rate se crea, se lee, se cuenta, se actualiza y se borra sin userId', async () => {
    const user = await insertUser();
    const scoped = forUser(prisma, user);
    // A day in the 1900s that no other test uses for the official rate.
    const day = new Date(Date.UTC(1900 + Math.floor(Math.random() * 100), 0, 1));
    day.setUTCDate(1 + Math.floor(Math.random() * 365));
    const isoDay = day.toISOString().slice(0, 10);
    created.marketRateDates.push(isoDay);
    const where = { kind: 'official' as const, rateDate: day };

    await scoped.marketRate.create({
      data: { ...where, value: '6.96', observedAt: new Date(), source: 'seed' },
    });

    expect(await scoped.marketRate.findMany({ where })).toHaveLength(1);
    expect(await scoped.marketRate.count({ where })).toBe(1);
    expect(await scoped.marketRate.count()).toBe(await prisma.marketRate.count());
    expect((await scoped.marketRate.updateMany({ where, data: { value: '6.97' } })).count).toBe(1);
    expect((await scoped.marketRate.deleteMany({ where })).count).toBe(1);
  });

  it('TASK-032 job_run se crea, se lee, se cuenta y se borra sin userId', async () => {
    const scoped = forUser(prisma, await insertUser());
    const job = `test-${randomUUID()}`;
    created.jobs.push(job);

    await scoped.jobRun.create({ data: { job } });

    expect(await scoped.jobRun.findMany({ where: { job } })).toHaveLength(1);
    expect(await scoped.jobRun.count()).toBe(await prisma.jobRun.count());
    expect((await scoped.jobRun.deleteMany({ where: { job } })).count).toBe(1);
  });

  it('TASK-032 email_outbox se crea, se lee, se cuenta y se borra sin userId', async () => {
    const scoped = forUser(prisma, await insertUser());
    const id = randomUUID();
    created.outboxIds.push(id);

    await scoped.emailOutbox.create({
      data: { id, toAddress: `${id}@test.local`, kind: 'confirm', payload: {} },
    });

    expect(await scoped.emailOutbox.findMany({ where: { id } })).toHaveLength(1);
    expect(await scoped.emailOutbox.count()).toBe(await prisma.emailOutbox.count());
    expect((await scoped.emailOutbox.deleteMany({ where: { id } })).count).toBe(1);
  });

  it('TASK-032 login_throttle se crea, se lee, se cuenta y se borra sin userId', async () => {
    const scoped = forUser(prisma, await insertUser());
    const emailHmac = hmac();
    created.throttleHmacs.push(emailHmac);

    await scoped.loginThrottle.create({ data: { emailHmac } });

    expect(await scoped.loginThrottle.findMany({ where: { emailHmac } })).toHaveLength(1);
    expect(await scoped.loginThrottle.count()).toBe(await prisma.loginThrottle.count());
    expect((await scoped.loginThrottle.deleteMany({ where: { emailHmac } })).count).toBe(1);
  });

  it('TASK-032 email_send_log se crea, se lee, se cuenta y se borra sin userId', async () => {
    const scoped = forUser(prisma, await insertUser());
    const emailHmac = hmac();
    created.sendLogHmacs.push(emailHmac);

    await scoped.emailSendLog.create({ data: { emailHmac, kind: 'confirm' } });

    expect(await scoped.emailSendLog.findMany({ where: { emailHmac } })).toHaveLength(1);
    expect(await scoped.emailSendLog.count()).toBe(await prisma.emailSendLog.count());
    expect((await scoped.emailSendLog.deleteMany({ where: { emailHmac } })).count).toBe(1);
  });
});
