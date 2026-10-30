import { createHmac, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createBudget, createBudgetPeriod, deleteBudgetsOf } from '../factories/budget.factory.js';
import {
  createCategory,
  createCategoryRule,
  deleteCategoryUsageOf,
} from '../factories/category.factory.js';
import { createDebt, createDebtPayment } from '../factories/debt.factory.js';
import { createAllocationEvent, createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET /api/me/export` with `RELEASE=1.1` (plan §4.1.2, TASK-221): the ZIP adds the data of the
 * V1.1 modules (earmarks and withdrawals, budgets and their periods, goals, debts and payments,
 * and notifications). The CSV file names are not fixed by the spec, so the tests look for the
 * user's ids and values across every CSV of the ZIP, as `me-export.test.ts` does.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const HMAC_SECRET = 'hmac-secret-value-0123456789abcdef0123456789';
const PASSWORD = 'Clave-segura-123';
const BOM = String.fromCharCode(0xfeff);

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET,
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.1',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

let container: Container;
let app: Express;
const usedEmails = new Set<string>();
const usedUserIds: string[] = [];
const originalRelease = process.env['RELEASE'];

beforeAll(async () => {
  process.env['RELEASE'] = '1.1';
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
});

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

afterAll(async () => {
  const emails = [...usedEmails];
  const db = testPrisma();
  await deleteGoalsOf(usedUserIds);
  await deleteBudgetsOf(usedUserIds);
  await deleteCategoryUsageOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${emails}::text[])`;
  await db.$executeRaw`
    DELETE FROM email_send_log WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
  if (originalRelease === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = originalRelease;
});

const post = (path: string, body: object, cookie?: string) => {
  const req = request(app).post(path).set('Origin', WEB_ORIGIN);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req.send(body);
};

/** `GET` that collects the body as raw bytes, whatever its content type. */
const getBinary = (path: string, cookie?: string) => {
  const req = request(app).get(path);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk);
    });
    res.on('end', () => {
      callback(null, Buffer.concat(chunks));
    });
  });
};

const TICKET_COOKIE = '__Secure-signup-ticket';

/** The `name=value` pair of the signup ticket cookie that the sign-up sets (RF-M1-18). */
const ticketCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${TICKET_COOKIE}=`),
  );
  if (header === undefined) throw new Error('the sign-up sets no ticket cookie');
  return header.split(';')[0] ?? '';
};

const sessionCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${COOKIE_NAME}=`),
  );
  if (header === undefined) throw new Error('the response sets no session cookie');
  return header.split(';')[0] ?? '';
};

interface Account {
  email: string;
  userId: string;
  cookie: string;
}

async function activeAccount(name = 'Ana Pérez Ñandú'): Promise<Account> {
  const email = `${randomUUID()}@http-me-export-v1-1.test`;
  usedEmails.add(email);
  const up = await post('/api/auth/sign-up', {
    name,
    email,
    password: PASSWORD,
    acceptTerms: true,
  });
  expect(up.status).toBe(202);
  const db = testPrisma();
  const links = await db.$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = 'confirm'::email_kind
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const token = /[A-Za-z0-9_-]{43}/.exec(links[0]?.link ?? '')?.[0];
  if (token === undefined) throw new Error('no confirmation token');
  const confirmed = await post('/api/auth/confirm', { token });
  expect(confirmed.status).toBe(200);
  // The link only confirms; the session comes from the ticket of the sign-up (RF-M1-18).
  const res = await request(app)
    .post('/api/auth/confirmation/status')
    .set('Origin', WEB_ORIGIN)
    .set('Cookie', ticketCookieOf(up));
  expect(res.status).toBe(200);
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  const userId = ids[0]?.id;
  if (userId === undefined) throw new Error('no user');
  usedUserIds.push(userId);
  return { email, userId, cookie: sessionCookieOf(res) };
}

/** Minimal ZIP reader based on the central directory (stored or deflate entries). */
function unzip(zip: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** RFC 4180 parser: comma separator, double quotes, CRLF or LF line endings. */
function parseCsv(text: string): string[][] {
  const source = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

interface Export {
  status: number;
  contentType: string;
  files: Map<string, string[][]>;
  /** Every cell of every CSV. */
  cells: string[];
  /** The raw text of every CSV, joined. */
  text: string;
}

async function exportOf(cookie: string): Promise<Export> {
  const res = await getBinary('/api/me/export', cookie);
  const contentType = String(res.headers['content-type'] ?? '');
  expect(res.status).toBe(200);
  const entries = unzip(res.body as Buffer);
  const files = new Map<string, string[][]>();
  const texts: string[] = [];
  for (const [name, data] of entries) {
    const text = data.toString('utf8');
    texts.push(text);
    files.set(name, parseCsv(text));
  }
  const cells = [...files.values()].flat(2);
  return { status: res.status, contentType, files, cells, text: texts.join('\n') };
}

/** True when some cell holds the value (neutralized or not). */
const hasValue = (exp: Export, value: string) => exp.cells.some((cell) => cell.includes(value));

interface SeededV11 {
  /** Ids of every V1.1 row of the user, each of which must appear in the ZIP. */
  ids: string[];
  /** Decimal values written in the V1.1 rows. */
  values: string[];
  goalName: string;
  archivedGoalName: string;
  debtPersons: string[];
  paymentNotes: string[];
}

const tag = () => uuidv7().slice(-8);

/** Writes the V1.1 data of the user: budgets and periods, goals and earmarks, debts, notifications. */
async function seedV11(userId: string): Promise<SeededV11> {
  const db = testPrisma();
  const account = await createAccount(userId, { initialBalance: '9000.00' });
  const category = await createCategory(userId);

  const categoryBudget = await createBudget(userId, { categoryId: category.id, amount: '777.31' });
  const generalBudget = await createBudget(userId, { amount: '1888.42' });
  const firstPeriod = await createBudgetPeriod(userId, categoryBudget, {
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    status: 'decided',
  });
  const secondPeriod = await createBudgetPeriod(userId, categoryBudget, {
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    carryoverIn: '15.73',
  });
  const generalPeriod = await createBudgetPeriod(userId, generalBudget, {
    startDate: '2026-09-01',
    endDate: '2026-09-30',
  });

  const goalName = `Meta viva ${tag()}`;
  const archivedGoalName = `Meta archivada ${tag()}`;
  const goal = await createGoal(userId, { name: goalName, target: '5432.10' });
  const archivedGoal = await createGoal(userId, { name: archivedGoalName, target: '2468.24' });
  await db.$executeRaw`UPDATE goal SET archived_at = now() WHERE id = ${archivedGoal.id}::uuid`;
  const earmark = await createAllocationEvent(userId, goal.id, account.id, { amount: '321.17' });
  const withdrawal = await createAllocationEvent(userId, goal.id, account.id, {
    amount: '-21.03',
  });
  const archivedEarmark = await createAllocationEvent(userId, archivedGoal.id, account.id, {
    amount: '135.79',
  });

  const juan = `Juan ${tag()}`;
  const rosa = `Rosa ${tag()}`;
  const owe = await createDebt(userId, { person: juan, principal: '3141.59' });
  const owed = await createDebt(userId, {
    person: rosa,
    direction: 'owed_to_me',
    principal: '2718.28',
    status: 'paid',
  });
  const notes = { one: `Pago uno ${tag()}`, two: `Pago dos ${tag()}`, three: `Pago tres ${tag()}` };
  const payments = [
    await createDebtPayment(userId, owe.id, { capitalPart: '111.11', note: notes.one }),
    await createDebtPayment(userId, owe.id, {
      capitalPart: '222.22',
      date: '2090-02-15',
      note: notes.two,
    }),
    await createDebtPayment(userId, owed.id, { capitalPart: '2718.28', note: notes.three }),
  ];

  const alertId = uuidv7();
  const upcomingId = uuidv7();
  await db.$executeRaw`
    INSERT INTO notification (id, user_id, type, event_key, params, target_route)
    VALUES (${alertId}::uuid, ${userId}::uuid, 'budget_alert'::notification_type,
            ${`budget:${categoryBudget.id}:2026-09:80`}, '{}'::jsonb, '/presupuestos')`;
  await db.$executeRaw`
    INSERT INTO notification (id, user_id, type, event_key, params, target_route, read_at)
    VALUES (${upcomingId}::uuid, ${userId}::uuid, 'payment_upcoming'::notification_type,
            ${`debt:${owe.id}:due:2090-03-01:d-3`}, '{}'::jsonb, '/deudas', now())`;

  return {
    ids: [
      categoryBudget.id,
      generalBudget.id,
      firstPeriod.id,
      secondPeriod.id,
      generalPeriod.id,
      goal.id,
      archivedGoal.id,
      earmark,
      withdrawal,
      archivedEarmark,
      owe.id,
      owed.id,
      ...payments.map((payment) => payment.id),
      alertId,
      upcomingId,
    ],
    values: [
      '777.31',
      '1888.42',
      '15.73',
      '5432.10',
      '2468.24',
      '321.17',
      '21.03',
      '135.79',
      '3141.59',
      '2718.28',
      '111.11',
      '222.22',
    ],
    goalName,
    archivedGoalName,
    debtPersons: [juan, rosa],
    paymentNotes: [notes.one, notes.two, notes.three],
  };
}

/** Number of CSV data rows (header excluded) where some cell holds the value. */
const rowsWith = (exp: Export, value: string) =>
  [...exp.files.values()]
    .flatMap((rows) => rows.slice(1))
    .filter((row) => row.some((cell) => cell.includes(value))).length;

describe('GET /api/me/export con RELEASE=1.1', () => {
  it('RF-M1-14 con RELEASE=1.1 el ZIP incluye los CSV de apartados y retiros, presupuestos y períodos, metas, deudas y pagos, y avisos', async () => {
    const { userId, cookie } = await activeAccount();
    const seeded = await seedV11(userId);

    const exp = await exportOf(cookie);

    expect(exp.contentType).toMatch(/application\/zip/);
    const names = [...exp.files.keys()];
    expect(names.every((name) => name.toLowerCase().endsWith('.csv'))).toBe(true);
    for (const id of seeded.ids) expect(hasValue(exp, id)).toBe(true);
    for (const value of seeded.values) expect(hasValue(exp, value)).toBe(true);
  });

  it('RF-M1-14 con RELEASE=1.1 las metas archivadas van en el ZIP, con sus apartados', async () => {
    const { userId, cookie } = await activeAccount();
    const seeded = await seedV11(userId);

    const exp = await exportOf(cookie);

    expect(hasValue(exp, seeded.goalName)).toBe(true);
    expect(hasValue(exp, seeded.archivedGoalName)).toBe(true);
    expect(hasValue(exp, '2468.24')).toBe(true);
    expect(hasValue(exp, '135.79')).toBe(true);
  });

  it('RF-M1-14 con RELEASE=1.1 los CSV nuevos usan coma, punto decimal y celdas neutralizadas', async () => {
    const { userId, cookie } = await activeAccount();
    await seedV11(userId);
    const dangerous = '=HIPERVINCULO(1)';
    await createDebt(userId, { person: dangerous, principal: '1234.56' });

    const exp = await exportOf(cookie);

    expect(hasValue(exp, dangerous)).toBe(true);
    expect(hasValue(exp, '1234.56')).toBe(true);
    for (const cell of exp.cells) expect(cell).not.toMatch(/^[=+\-@]/);
    expect(exp.text).not.toContain('1,234.56');
    expect(exp.text).not.toContain('1.234,56');
    expect(exp.text).not.toContain('3.141,59');
    expect(exp.text).not.toContain('3,141.59');
    for (const rows of exp.files.values()) {
      const width = rows[0]?.length ?? 0;
      expect(width).toBeGreaterThan(0);
      for (const row of rows) expect(row).toHaveLength(width);
    }
  });

  it('RF-M1-14 con RELEASE=1.1 no se exportan los recurrentes, que son de V1.2', async () => {
    const { userId, cookie } = await activeAccount();
    const category = await createCategory(userId);
    const account = await createAccount(userId);
    const rule = await createCategoryRule(userId, category.id, account.id);

    const exp = await exportOf(cookie);

    expect(hasValue(exp, rule.id)).toBe(false);
    expect(hasValue(exp, rule.name)).toBe(false);
    for (const name of exp.files.keys()) expect(name).not.toMatch(/recurr|occurrence/i);
  });

  it('RNF-16 cada CSV de V1.1 tiene todas las filas del usuario', async () => {
    const { userId, cookie } = await activeAccount();
    const seeded = await seedV11(userId);

    const exp = await exportOf(cookie);

    for (const id of seeded.ids) expect(rowsWith(exp, id)).toBeGreaterThanOrEqual(1);
    for (const person of seeded.debtPersons) expect(hasValue(exp, person)).toBe(true);
    for (const note of seeded.paymentNotes) expect(hasValue(exp, note)).toBe(true);
  });

  it('RNF-16 el ZIP de V1.1 no contiene filas de otro usuario', async () => {
    const mine = await activeAccount('Ana Pérez Ñandú');
    const other = await activeAccount('Otro Usuario Ajeno');
    await seedV11(mine.userId);
    const theirs = await seedV11(other.userId);

    const exp = await exportOf(mine.cookie);

    for (const id of theirs.ids) expect(hasValue(exp, id)).toBe(false);
    expect(hasValue(exp, theirs.goalName)).toBe(false);
    expect(hasValue(exp, theirs.archivedGoalName)).toBe(false);
    for (const person of theirs.debtPersons) expect(hasValue(exp, person)).toBe(false);
    for (const note of theirs.paymentNotes) expect(hasValue(exp, note)).toBe(false);
  });
});
