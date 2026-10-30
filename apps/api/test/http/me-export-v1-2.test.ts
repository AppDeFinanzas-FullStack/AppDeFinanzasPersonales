import { createHmac, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { deleteCategoryUsageOf } from '../factories/category.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import {
  createOccurrence,
  createRule,
  deleteRecurringOf,
  uniqueRuleName,
} from '../factories/recurring.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET /api/me/export` with `RELEASE=1.2` (plan §4.1.2, TASK-242): the ZIP adds the recurring
 * rules (M14) and their occurrences, pending and decided. With `RELEASE=1.1` they stay out. The
 * CSV file names are not fixed by the spec, so the tests look for the user's ids and values across
 * every CSV of the ZIP, as `me-export-v1-1.test.ts` does. Both apps share the database, so one
 * session cookie works against either release.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const HMAC_SECRET = 'hmac-secret-value-0123456789abcdef0123456789';
const PASSWORD = 'Clave-segura-123';
const BOM = String.fromCharCode(0xfeff);

const envSource = (release: string): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET,
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: release,
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

let container: Container;
let app: Express;
let containerV11: Container;
let appV11: Express;
const usedEmails = new Set<string>();
const usedUserIds: string[] = [];
const originalRelease = process.env['RELEASE'];

beforeAll(async () => {
  process.env['RELEASE'] = '1.1';
  containerV11 = await Promise.resolve(buildContainer(parseEnv(envSource('1.1'))));
  appV11 = await Promise.resolve(createApp(containerV11));
  process.env['RELEASE'] = '1.2';
  container = await Promise.resolve(buildContainer(parseEnv(envSource('1.2'))));
  app = await Promise.resolve(createApp(container));
});

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

afterAll(async () => {
  const emails = [...usedEmails];
  const db = testPrisma();
  await deleteRecurringOf(usedUserIds);
  await deleteCategoryUsageOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${emails}::text[])`;
  await db.$executeRaw`
    DELETE FROM email_send_log WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
  await containerV11.prisma.$disconnect();
  if (originalRelease === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = originalRelease;
});

const post = (path: string, body: object, cookie?: string) => {
  const req = request(app).post(path).set('Origin', WEB_ORIGIN);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req.send(body);
};

/** `GET` that collects the body as raw bytes, whatever its content type. */
const getBinary = (target: Express, path: string, cookie?: string) => {
  const req = request(target).get(path);
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
  const email = `${randomUUID()}@http-me-export-v1-2.test`;
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

async function exportOf(cookie: string, target: Express = app): Promise<Export> {
  const res = await getBinary(target, '/api/me/export', cookie);
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

interface SeededV12 {
  /** Ids of the rules of the user: active, paused, finished and "to be defined". */
  ruleIds: string[];
  ruleNames: string[];
  /** Ids of the pending occurrences of the user. */
  pendingIds: string[];
  /** Ids of the decided occurrences of the user (registered, skipped, omitted). */
  decidedIds: string[];
  /** Decimal amounts written in the rules. */
  values: string[];
}

/** Writes the V1.2 data of the user: recurring rules and their occurrences. */
async function seedV12(userId: string): Promise<SeededV12> {
  const active = await createRule(userId, { name: uniqueRuleName('Alquiler'), amount: '1357.91' });
  const paused = await createRule(userId, {
    name: uniqueRuleName('Gimnasio'),
    amount: '246.82',
    status: 'paused',
  });
  const finished = await createRule(userId, {
    name: uniqueRuleName('Cuota'),
    amount: '975.31',
    status: 'finished',
  });
  const undefinedAmount = await createRule(userId, {
    name: uniqueRuleName('Luz'),
    amount: null,
    mode: 'confirm',
  });
  const transfer = await createRule(userId, {
    name: uniqueRuleName('Ahorro'),
    kind: 'transfer',
    amount: '864.20',
  });

  const pending = [
    await createOccurrence(userId, undefinedAmount.id),
    await createOccurrence(userId, active.id),
  ];
  const decided = [
    await createOccurrence(userId, active.id, { status: 'registered' }),
    await createOccurrence(userId, paused.id, { status: 'skipped' }),
    await createOccurrence(userId, finished.id, { status: 'omitted' }),
  ];

  const rules = [active, paused, finished, undefinedAmount, transfer];
  return {
    ruleIds: rules.map((rule) => rule.id),
    ruleNames: rules.map((rule) => rule.name),
    pendingIds: pending.map((occurrence) => occurrence.id),
    decidedIds: decided.map((occurrence) => occurrence.id),
    values: ['1357.91', '246.82', '975.31', '864.20'],
  };
}

/** Number of CSV data rows (header excluded) where some cell holds the value. */
const rowsWith = (exp: Export, value: string) =>
  [...exp.files.values()]
    .flatMap((rows) => rows.slice(1))
    .filter((row) => row.some((cell) => cell.includes(value))).length;

describe('GET /api/me/export con RELEASE=1.2', () => {
  it('RF-M1-14 con RELEASE=1.2 el ZIP incluye las reglas recurrentes y los pendientes', async () => {
    const { userId, cookie } = await activeAccount();
    const seeded = await seedV12(userId);

    const exp = await exportOf(cookie);

    expect(exp.contentType).toMatch(/application\/zip/);
    const names = [...exp.files.keys()];
    expect(names.every((name) => name.toLowerCase().endsWith('.csv'))).toBe(true);
    for (const id of seeded.ruleIds) expect(hasValue(exp, id)).toBe(true);
    for (const name of seeded.ruleNames) expect(hasValue(exp, name)).toBe(true);
    for (const id of seeded.pendingIds) expect(hasValue(exp, id)).toBe(true);
    for (const value of seeded.values) expect(hasValue(exp, value)).toBe(true);
  });

  it('RF-M1-14 con RELEASE=1.2 las reglas pausadas y terminadas y las ocurrencias decididas van en el ZIP', async () => {
    const { userId, cookie } = await activeAccount();
    const seeded = await seedV12(userId);

    const exp = await exportOf(cookie);

    for (const id of seeded.decidedIds) expect(hasValue(exp, id)).toBe(true);
    expect(hasValue(exp, seeded.ruleNames[1] ?? '')).toBe(true);
    expect(hasValue(exp, seeded.ruleNames[2] ?? '')).toBe(true);
  });

  it('RF-M1-14 con RELEASE=1.2 cada regla y cada ocurrencia del usuario tiene su fila', async () => {
    const { userId, cookie } = await activeAccount();
    const seeded = await seedV12(userId);

    const exp = await exportOf(cookie);

    const ids = [...seeded.ruleIds, ...seeded.pendingIds, ...seeded.decidedIds];
    for (const id of ids) expect(rowsWith(exp, id)).toBeGreaterThanOrEqual(1);
  });

  it('RF-M1-14 con RELEASE=1.2 los CSV nuevos usan coma, punto decimal y celdas neutralizadas', async () => {
    const { userId, cookie } = await activeAccount();
    await seedV12(userId);
    const dangerous = `=HIPERVINCULO(${randomUUID().slice(0, 8)})`;
    const rule = await createRule(userId, { name: dangerous, amount: '1234.56' });
    await createOccurrence(userId, rule.id);

    const exp = await exportOf(cookie);

    expect(hasValue(exp, rule.id)).toBe(true);
    expect(hasValue(exp, dangerous)).toBe(true);
    expect(hasValue(exp, '1234.56')).toBe(true);
    for (const cell of exp.cells) expect(cell).not.toMatch(/^[=+\-@]/);
    expect(exp.text).not.toContain('1,234.56');
    expect(exp.text).not.toContain('1.234,56');
    expect(exp.text).not.toContain('1.357,91');
    expect(exp.text).not.toContain('1,357.91');
    for (const rows of exp.files.values()) {
      const width = rows[0]?.length ?? 0;
      expect(width).toBeGreaterThan(0);
      for (const row of rows) expect(row).toHaveLength(width);
    }
  });

  it('RF-M1-14 con RELEASE=1.1 el ZIP no incluye las reglas recurrentes ni los pendientes', async () => {
    const { userId, cookie } = await activeAccount();
    const seeded = await seedV12(userId);

    const exp = await exportOf(cookie, appV11);

    expect(exp.contentType).toMatch(/application\/zip/);
    for (const id of seeded.ruleIds) expect(hasValue(exp, id)).toBe(false);
    for (const name of seeded.ruleNames) expect(hasValue(exp, name)).toBe(false);
    for (const id of [...seeded.pendingIds, ...seeded.decidedIds]) {
      expect(hasValue(exp, id)).toBe(false);
    }
    for (const name of exp.files.keys()) expect(name).not.toMatch(/recurr|occurrence/i);
  });

  it('RNF-16 con RELEASE=1.2 el ZIP tiene todos los datos del usuario y ninguna regla ni pendiente de otro', async () => {
    const mine = await activeAccount('Ana Pérez Ñandú');
    const other = await activeAccount('Otro Usuario Ajeno');
    const own = await seedV12(mine.userId);
    const theirs = await seedV12(other.userId);

    const exp = await exportOf(mine.cookie);

    for (const id of [...own.ruleIds, ...own.pendingIds, ...own.decidedIds]) {
      expect(hasValue(exp, id)).toBe(true);
    }
    for (const id of [...theirs.ruleIds, ...theirs.pendingIds, ...theirs.decidedIds]) {
      expect(hasValue(exp, id)).toBe(false);
    }
    for (const name of theirs.ruleNames) expect(hasValue(exp, name)).toBe(false);
  });
});
