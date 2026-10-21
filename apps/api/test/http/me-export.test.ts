import { createHmac, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount, uniqueAccountName } from '../factories/account.factory.js';
import {
  createCategory,
  createCategoryBudget,
  createCategoryRule,
  createCategoryShortcut,
  deleteCategoryUsageOf,
  uniqueCategoryName,
} from '../factories/category.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET /api/me/export` (plan §4.1.2). Accounts are made through `sign-up` and `confirm` over the
 * test database with fake integrations, as in `me-delete.test.ts`; the user's data is written by
 * SQL with the factories. The CSV file names are not fixed by the spec, so the tests look for the
 * user's values across every CSV of the ZIP.
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
  RELEASE: '1.0',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

interface Problem {
  code?: string;
  status?: number;
}
const problem = (res: { body: unknown }) => res.body as Problem;

let container: Container;
let app: Express;
const usedEmails = new Set<string>();
const usedUserIds: string[] = [];
const originalRelease = process.env['RELEASE'];

beforeAll(async () => {
  process.env['RELEASE'] = '1.0';
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
});

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

afterAll(async () => {
  const emails = [...usedEmails];
  const db = testPrisma();
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
  const email = `${randomUUID()}@http-me-export.test`;
  usedEmails.add(email);
  const up = await post('/api/auth/sign-up', { name, email, password: PASSWORD, acceptTerms: true });
  expect(up.status).toBe(202);
  const db = testPrisma();
  const links = await db.$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = 'confirm'::email_kind
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const token = /[A-Za-z0-9_-]{43}/.exec(links[0]?.link ?? '')?.[0];
  if (token === undefined) throw new Error('no confirmation token');
  const res = await post('/api/auth/confirm', { token });
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

interface Seeded {
  accountNames: string[];
  archivedAccountName: string;
  categoryName: string;
  archivedCategoryName: string;
  notes: string[];
  shortcutName: string;
}

/** Writes the V1.0 data of the user: accounts, categories, movements, a manual rate, a shortcut. */
async function seedV10(userId: string): Promise<Seeded> {
  const first = await createAccount(userId, {
    name: uniqueAccountName('Banco'),
    initialBalance: '1234.56',
  });
  const second = await createAccount(userId, { name: uniqueAccountName('Efectivo') });
  const archived = await createAccount(userId, {
    name: uniqueAccountName('Vieja'),
    status: 'archived',
  });
  const category = await createCategory(userId, { name: uniqueCategoryName('Comida') });
  const archivedCategory = await createCategory(userId, {
    name: uniqueCategoryName('Antigua'),
    status: 'archived',
  });
  const notes = [`Nota uno ${uuidv7().slice(-8)}`, `Nota dos ${uuidv7().slice(-8)}`];
  await createLedgerTransaction(userId, {
    kind: 'expense',
    date: '2026-09-10',
    categoryId: category.id,
    note: notes[0] ?? null,
    entries: [{ accountId: first.id, amount: '-4321.09' }],
  });
  await createLedgerTransaction(userId, {
    kind: 'transfer',
    date: '2026-09-11',
    note: notes[1] ?? null,
    entries: [
      { accountId: first.id, amount: '-50.00' },
      { accountId: second.id, amount: '50.00' },
    ],
  });
  await testPrisma().$executeRaw`
    INSERT INTO user_fx_event (id, user_id, kind, currency_code, value)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, 'manual_usd_on', 'USD', 9.87)`;
  const shortcut = await createCategoryShortcut(userId, category.id, first.id);
  return {
    accountNames: [first.name, second.name],
    archivedAccountName: archived.name,
    categoryName: category.name,
    archivedCategoryName: archivedCategory.name,
    notes,
    shortcutName: shortcut.name,
  };
}

/** Patterns of the CSV names of the modules of later releases (V1.1 and V1.2). */
const UNRELEASED_NAMES = [
  /budget/i,
  /presupuesto/i,
  /goal/i,
  /(^|[^a-z])metas?([^a-z]|$)/i,
  /debt/i,
  /deuda/i,
  /recurr/i,
  /occurrence/i,
  /pendiente/i,
  /notification/i,
  /aviso/i,
  /reminder/i,
  /recordatorio/i,
];

describe('GET /api/me/export', () => {
  it('RNF-16 responde 200 application/zip con un CSV por cada tipo de dato liberado', async () => {
    const { userId, cookie } = await activeAccount();
    await seedV10(userId);

    const exp = await exportOf(cookie);

    expect(exp.contentType).toMatch(/application\/zip/);
    const names = [...exp.files.keys()];
    expect(names.every((name) => name.toLowerCase().endsWith('.csv'))).toBe(true);
    // Perfil y ajustes, monedas y tasas manuales, cuentas, categorías, movimientos y atajos.
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  it('RNF-16 el ZIP trae todas las filas del usuario, incluidas las cuentas y categorías archivadas', async () => {
    const { email, userId, cookie } = await activeAccount();
    const seeded = await seedV10(userId);

    const exp = await exportOf(cookie);

    expect(hasValue(exp, email)).toBe(true);
    expect(hasValue(exp, 'Ana Pérez Ñandú')).toBe(true);
    for (const name of seeded.accountNames) expect(hasValue(exp, name)).toBe(true);
    expect(hasValue(exp, seeded.archivedAccountName)).toBe(true);
    expect(hasValue(exp, seeded.categoryName)).toBe(true);
    expect(hasValue(exp, seeded.archivedCategoryName)).toBe(true);
    for (const note of seeded.notes) expect(hasValue(exp, note)).toBe(true);
    expect(hasValue(exp, seeded.shortcutName)).toBe(true);
  });

  it('RNF-16 los movimientos salen con sus asientos y sus tasas, y las monedas con el historial de tasas manuales', async () => {
    const { userId, cookie } = await activeAccount();
    await seedV10(userId);

    const exp = await exportOf(cookie);

    expect(hasValue(exp, '4321.09')).toBe(true);
    expect(hasValue(exp, '50.00')).toBe(true);
    expect(hasValue(exp, '6.96')).toBe(true);
    expect(hasValue(exp, '9.87')).toBe(true);
    expect(hasValue(exp, 'USD')).toBe(true);
    expect(hasValue(exp, 'BOB')).toBe(true);
  });

  it('RF-M1-14 con RELEASE=1.0 no hay CSV de presupuestos, metas, deudas, recurrentes ni avisos', async () => {
    const { userId, cookie } = await activeAccount();
    const category = await createCategory(userId);
    const account = await createAccount(userId);
    await createCategoryBudget(userId, category.id);
    const rule = await createCategoryRule(userId, category.id, account.id);
    const goalName = `Meta ${uuidv7().slice(-8)}`;
    await testPrisma().$executeRaw`
      INSERT INTO goal (id, user_id, name, target, currency_code, icon, color)
      VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${goalName}, 1000.00, 'BOB', 'target', 'blue')`;

    const exp = await exportOf(cookie);

    for (const name of exp.files.keys()) {
      for (const pattern of UNRELEASED_NAMES) expect(name).not.toMatch(pattern);
    }
    expect(hasValue(exp, rule.name)).toBe(false);
    expect(hasValue(exp, goalName)).toBe(false);
  });

  it('RF-M1-14 los CSV van en UTF-8, con coma y números con punto decimal y sin separador de miles', async () => {
    const { userId, cookie } = await activeAccount();
    await seedV10(userId);

    const exp = await exportOf(cookie);

    expect(hasValue(exp, 'Ana Pérez Ñandú')).toBe(true);
    expect(hasValue(exp, '1234.56')).toBe(true);
    expect(exp.text).not.toContain('1,234.56');
    expect(exp.text).not.toContain('1.234,56');
    expect(exp.text).not.toContain('1234,56');
    expect(exp.text).not.toContain('4,321.09');
    expect(exp.text).not.toContain('4.321,09');
    for (const rows of exp.files.values()) {
      // Every row of a CSV has the same number of comma-separated columns as its header.
      const width = rows[0]?.length ?? 0;
      expect(width).toBeGreaterThan(0);
      for (const row of rows) expect(row).toHaveLength(width);
    }
  });

  it('RF-M1-14 una celda que empieza con =, +, - o @ queda neutralizada', async () => {
    const { userId, cookie } = await activeAccount();
    const dangerous = ['=HIPERVINCULO(1)', '+SUMA(A1)', '-RESTA(A1)', '@CELDA(A1)'];
    for (const name of dangerous) await createAccount(userId, { name });

    const exp = await exportOf(cookie);

    for (const name of dangerous) expect(hasValue(exp, name)).toBe(true);
    for (const cell of exp.cells) expect(cell).not.toMatch(/^[=+\-@]/);
  });

  it('RF-M1-14 se genera en el momento, sin pasar por el correo', async () => {
    const { email, cookie } = await activeAccount();
    const before = await outboxCount(email);

    const exp = await exportOf(cookie);

    expect(exp.status).toBe(200);
    expect(await outboxCount(email)).toBe(before);
  });

  it('RN-09 el ZIP no contiene datos de otro usuario', async () => {
    const mine = await activeAccount('Ana Pérez Ñandú');
    const other = await activeAccount('Otro Usuario Ajeno');
    await seedV10(mine.userId);
    const theirs = await seedV10(other.userId);

    const exp = await exportOf(mine.cookie);

    expect(hasValue(exp, other.email)).toBe(false);
    expect(hasValue(exp, other.userId)).toBe(false);
    expect(hasValue(exp, 'Otro Usuario Ajeno')).toBe(false);
    for (const name of theirs.accountNames) expect(hasValue(exp, name)).toBe(false);
    expect(hasValue(exp, theirs.archivedAccountName)).toBe(false);
    expect(hasValue(exp, theirs.categoryName)).toBe(false);
    expect(hasValue(exp, theirs.archivedCategoryName)).toBe(false);
    for (const note of theirs.notes) expect(hasValue(exp, note)).toBe(false);
    expect(hasValue(exp, theirs.shortcutName)).toBe(false);
  });

  it('RN-09 sin sesión responde 401 SESSION_EXPIRED', async () => {
    const res = await request(app).get('/api/me/export');

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });
});

async function outboxCount(email: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM email_outbox WHERE to_address = ${email}`;
  return rows[0]?.n ?? 0;
}
