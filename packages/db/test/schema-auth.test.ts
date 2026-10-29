import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closeSql, sql } from './helpers.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/** Tables of plan §3.3 (M1: user account and security). */
const AUTH_TABLES = [
  'auth_user',
  'auth_session',
  'auth_account',
  'auth_verification',
  'email_link',
  'login_throttle',
  'email_outbox',
  'email_send_log',
  'signup_ticket',
] as const;

/** Tables of plan §3.3 that carry an updated_at column. */
const UPDATED_AT_TABLES = ['auth_user', 'auth_session', 'auth_account', 'auth_verification'] as const;

afterAll(async () => {
  await closeSql();
});

/** Runs `fn` inside a transaction that is always rolled back. */
async function inTx(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await sql().connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Runs a statement under a savepoint and returns the SQLSTATE it raised, or null if it succeeded. */
async function sqlState(c: pg.PoolClient, text: string, values: unknown[] = []): Promise<string | null> {
  await c.query('SAVEPOINT probe');
  try {
    await c.query(text, values);
    await c.query('RELEASE SAVEPOINT probe');
    return null;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT probe');
    return (err as { code?: string }).code ?? 'unknown';
  }
}

const INSERT_USER = `INSERT INTO auth_user (id, name, email, terms_accepted_at, registered_at)
                     VALUES ($1, $2, $3, now(), now())`;

/** Inserts a valid auth_user and returns its id. */
async function insertUser(c: pg.PoolClient): Promise<string> {
  const id = randomUUID();
  await c.query(INSERT_USER, [id, 'Ana', `${id}@test.local`]);
  return id;
}

const INSERT_LINK = `INSERT INTO email_link (id, user_id, purpose, token_hash, expires_at)
                     VALUES ($1, $2, $3, $4, now() + interval '24 hours')`;

function tokenHash(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);
}

describe('TASK-012 auth tables exist', () => {
  it.each(AUTH_TABLES)('TASK-012 the table %s exists', async (table) => {
    const { rows } = await sql().query<{ reg: string | null }>(`SELECT to_regclass($1)::text AS reg`, [
      `public.${table}`,
    ]);
    expect(rows[0]!.reg).toBe(table);
  });

  it.each(AUTH_TABLES)('TASK-012 schema.prisma declares a model mapped to %s', (table) => {
    const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const models = [...source.matchAll(/^\s*model\s+\w+\s*\{([^}]*)\}/gm)];
    const mapped = models.filter(([, body]) => new RegExp(`@@map\\(\\s*"${table}"\\s*\\)`).test(body!));
    expect(mapped).toHaveLength(1);
  });
});

describe('RF-M1-02 email normalization CHECK on auth_user', () => {
  it('RF-M1-02 an email with uppercase letters violates the CHECK', async () => {
    await inTx(async (c) => {
      expect(await sqlState(c, INSERT_USER, [randomUUID(), 'Ana', 'Ana@Test.local'])).toBe(CHECK_VIOLATION);
    });
  });

  it('RF-M1-02 an email with leading or trailing spaces violates the CHECK', async () => {
    await inTx(async (c) => {
      expect(await sqlState(c, INSERT_USER, [randomUUID(), 'Ana', ' ana@test.local'])).toBe(CHECK_VIOLATION);
      expect(await sqlState(c, INSERT_USER, [randomUUID(), 'Ana', 'ana@test.local '])).toBe(CHECK_VIOLATION);
    });
  });

  it('RF-M1-02 a trimmed lowercase email is accepted and is unique', async () => {
    await inTx(async (c) => {
      const email = `${randomUUID()}@test.local`;
      expect(await sqlState(c, INSERT_USER, [randomUUID(), 'Ana', email])).toBeNull();
      expect(await sqlState(c, INSERT_USER, [randomUUID(), 'Beto', email])).toBe(UNIQUE_VIOLATION);
    });
  });
});

describe('RN-13 trimmed name CHECK on auth_user', () => {
  it('RN-13 a name with leading spaces violates the CHECK', async () => {
    await inTx(async (c) => {
      const id = randomUUID();
      expect(await sqlState(c, INSERT_USER, [id, ' Ana', `${id}@test.local`])).toBe(CHECK_VIOLATION);
    });
  });

  it('RN-13 a name with trailing spaces violates the CHECK', async () => {
    await inTx(async (c) => {
      const id = randomUUID();
      expect(await sqlState(c, INSERT_USER, [id, 'Ana ', `${id}@test.local`])).toBe(CHECK_VIOLATION);
    });
  });

  it('RN-13 an empty name violates the CHECK', async () => {
    await inTx(async (c) => {
      const id = randomUUID();
      expect(await sqlState(c, INSERT_USER, [id, '', `${id}@test.local`])).toBe(CHECK_VIOLATION);
    });
  });

  it('RN-13 a trimmed name with inner spaces is accepted', async () => {
    await inTx(async (c) => {
      const id = randomUUID();
      expect(await sqlState(c, INSERT_USER, [id, 'Ana María', `${id}@test.local`])).toBeNull();
    });
  });
});

describe('RF-M1-05 one active email link per user and purpose', () => {
  it('RF-M1-05 two active links of the same user and purpose cannot coexist', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await sqlState(c, INSERT_LINK, [randomUUID(), userId, 'confirm_email', tokenHash()])).toBeNull();
      expect(await sqlState(c, INSERT_LINK, [randomUUID(), userId, 'confirm_email', tokenHash()])).toBe(
        UNIQUE_VIOLATION,
      );
    });
  });

  it('RF-M1-05 after invalidating the previous link a new active link is accepted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const first = randomUUID();
      await c.query(INSERT_LINK, [first, userId, 'confirm_email', tokenHash()]);
      await c.query(`UPDATE email_link SET invalidated_at = now() WHERE id = $1`, [first]);
      expect(await sqlState(c, INSERT_LINK, [randomUUID(), userId, 'confirm_email', tokenHash()])).toBeNull();
    });
  });

  it('RF-M1-05 after using the previous link a new active link is accepted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const first = randomUUID();
      await c.query(INSERT_LINK, [first, userId, 'reset_password', tokenHash()]);
      await c.query(`UPDATE email_link SET used_at = now() WHERE id = $1`, [first]);
      expect(await sqlState(c, INSERT_LINK, [randomUUID(), userId, 'reset_password', tokenHash()])).toBeNull();
    });
  });

  it('RF-M1-05 the same user can hold one active link per distinct purpose', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await sqlState(c, INSERT_LINK, [randomUUID(), userId, 'confirm_email', tokenHash()])).toBeNull();
      expect(await sqlState(c, INSERT_LINK, [randomUUID(), userId, 'reset_password', tokenHash()])).toBeNull();
    });
  });

  it('RF-M1-05 different users can each hold an active link of the same purpose', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      expect(await sqlState(c, INSERT_LINK, [randomUUID(), a, 'confirm_email', tokenHash()])).toBeNull();
      expect(await sqlState(c, INSERT_LINK, [randomUUID(), b, 'confirm_email', tokenHash()])).toBeNull();
    });
  });

  it('RF-M1-05 the partial unique index email_link_one_active exists', async () => {
    const { rows } = await sql().query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'email_link_one_active'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.def;
    expect(def).toMatch(/UNIQUE/i);
    expect(def).toMatch(/\(user_id, purpose\)/);
    expect(def).toMatch(/used_at IS NULL/);
    expect(def).toMatch(/invalidated_at IS NULL/);
  });

  it('TASK-012 a link cannot be both used and invalidated', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(
        await sqlState(
          c,
          `INSERT INTO email_link (id, user_id, purpose, token_hash, expires_at, used_at, invalidated_at)
           VALUES ($1, $2, 'confirm_email', $3, now() + interval '1 hour', now(), now())`,
          [randomUUID(), userId, tokenHash()],
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('TASK-012 token_hash is unique across links', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const hash = tokenHash();
      await c.query(INSERT_LINK, [randomUUID(), a, 'confirm_email', hash]);
      expect(await sqlState(c, INSERT_LINK, [randomUUID(), b, 'reset_password', hash])).toBe(UNIQUE_VIOLATION);
    });
  });

  it('TASK-012 deleting a user cascades to its links and sessions', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await c.query(INSERT_LINK, [randomUUID(), userId, 'confirm_email', tokenHash()]);
      await c.query(
        `INSERT INTO auth_session (id, token, user_id, expires_at, last_activity_at)
         VALUES ($1, $2, $3, now() + interval '1 day', now())`,
        [randomUUID(), randomUUID(), userId],
      );
      await c.query(`DELETE FROM auth_user WHERE id = $1`, [userId]);
      const links = await c.query(`SELECT 1 FROM email_link WHERE user_id = $1`, [userId]);
      const sessions = await c.query(`SELECT 1 FROM auth_session WHERE user_id = $1`, [userId]);
      expect(links.rowCount).toBe(0);
      expect(sessions.rowCount).toBe(0);
    });
  });
});

describe('RF-M1-16 the account emails', () => {
  it('RF-M1-16 email_kind has exactly the 5 account emails', async () => {
    const { rows } = await sql().query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'email_kind'
        ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual([
      'confirm',
      'register_attempt',
      'reset',
      'password_changed',
      'account_deleted',
    ]);
  });

  it('RF-M1-16 the temporary type email_kind_old does not remain', async () => {
    const { rows } = await sql().query<{ reg: string | null }>(
      `SELECT to_regtype('public.email_kind_old')::text AS reg`,
    );
    expect(rows[0]!.reg).toBeNull();
  });

  it.each(['email_outbox', 'email_send_log'])('RF-M1-16 %s.kind is typed as email_kind', async (table) => {
    const { rows } = await sql().query<{ udt: string }>(
      `SELECT udt_name AS udt FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'kind'`,
      [table],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.udt).toBe('email_kind');
  });

  it.each(['email_outbox', 'email_send_log'])('RF-M1-16 %s.kind stays NOT NULL', async (table) => {
    const { rows } = await sql().query<{ nullable: string }>(
      `SELECT is_nullable AS nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'kind'`,
      [table],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.nullable).toBe('NO');
  });

  it('RF-M1-16 email_outbox and email_send_log reject the kind login_alert', async () => {
    await inTx(async (c) => {
      expect(
        await sqlState(
          c,
          `INSERT INTO email_outbox (id, to_address, kind, payload) VALUES ($1, 'a@test.local', 'login_alert', '{}')`,
          [randomUUID()],
        ),
      ).toBe('22P02');
      expect(
        await sqlState(c, `INSERT INTO email_send_log (email_hmac, kind) VALUES ($1, 'login_alert')`, [tokenHash()]),
      ).toBe('22P02');
    });
  });

  it('RF-M1-16 email_outbox rejects a kind outside the 5 account emails', async () => {
    await inTx(async (c) => {
      expect(
        await sqlState(
          c,
          `INSERT INTO email_outbox (id, to_address, kind, payload) VALUES ($1, 'a@test.local', 'confirm', '{}')`,
          [randomUUID()],
        ),
      ).toBeNull();
      expect(
        await sqlState(
          c,
          `INSERT INTO email_outbox (id, to_address, kind, payload) VALUES ($1, 'a@test.local', 'budget_alert', '{}')`,
          [randomUUID()],
        ),
      ).toBe('22P02');
    });
  });

  it('TASK-012 email_outbox defaults status to pending and attempts to 0', async () => {
    await inTx(async (c) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO email_outbox (id, to_address, kind, payload) VALUES ($1, 'a@test.local', 'reset', '{}')`,
        [id],
      );
      const { rows } = await c.query<{ status: string; attempts: number }>(
        `SELECT status::text AS status, attempts FROM email_outbox WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ status: 'pending', attempts: 0 });
    });
  });
});

describe('TASK-012 other constraints of plan §3.3', () => {
  it('TASK-012 auth_user.locale only accepts es-BO and defaults timezone and verification', async () => {
    await inTx(async (c) => {
      const id = await insertUser(c);
      const { rows } = await c.query<{ locale: string; timezone: string; email_verified: boolean }>(
        `SELECT locale, timezone, email_verified FROM auth_user WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ locale: 'es-BO', timezone: 'America/La_Paz', email_verified: false });
      const other = randomUUID();
      expect(
        await sqlState(
          c,
          `INSERT INTO auth_user (id, name, email, locale, terms_accepted_at, registered_at)
           VALUES ($1, 'Ana', $2, 'en-US', now(), now())`,
          [other, `${other}@test.local`],
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('TASK-012 login_throttle.consecutive_failures cannot be negative', async () => {
    await inTx(async (c) => {
      expect(
        await sqlState(c, `INSERT INTO login_throttle (email_hmac, consecutive_failures) VALUES ($1, -1)`, [
          tokenHash(),
        ]),
      ).toBe(CHECK_VIOLATION);
      expect(
        await sqlState(c, `INSERT INTO login_throttle (email_hmac) VALUES ($1)`, [tokenHash()]),
      ).toBeNull();
    });
  });

  it('TASK-012 auth_account is unique by (provider_id, account_id)', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const insert = `INSERT INTO auth_account (id, user_id, account_id, provider_id) VALUES ($1, $2, 'acc-1', 'credential')`;
      expect(await sqlState(c, insert, [randomUUID(), userId])).toBeNull();
      expect(await sqlState(c, insert, [randomUUID(), userId])).toBe(UNIQUE_VIOLATION);
    });
  });

  it('TASK-012 email_send_log generates its id and defaults sent_at', async () => {
    await inTx(async (c) => {
      const { rows } = await c.query<{ id: string; has_sent_at: boolean }>(
        `INSERT INTO email_send_log (email_hmac, kind) VALUES ($1, 'confirm')
         RETURNING id::text AS id, sent_at IS NOT NULL AS has_sent_at`,
        [tokenHash()],
      );
      expect(rows[0]!.id).toMatch(/^\d+$/);
      expect(rows[0]!.has_sent_at).toBe(true);
    });
  });

  it.each(UPDATED_AT_TABLES)('TASK-012 %s has a trigger that refreshes updated_at on update', async (table) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const past = '2000-01-01T00:00:00Z';
      let id: string;
      if (table === 'auth_user') {
        // A user inserted with an explicit past updated_at proves the trigger on the next update.
        id = randomUUID();
        await c.query(
          `INSERT INTO auth_user (id, name, email, terms_accepted_at, registered_at, updated_at)
           VALUES ($1, 'Ana', $2, now(), now(), $3)`,
          [id, `${id}@test.local`, past],
        );
      } else if (table === 'auth_session') {
        id = randomUUID();
        await c.query(
          `INSERT INTO auth_session (id, token, user_id, expires_at, last_activity_at, updated_at)
           VALUES ($1, $2, $3, now() + interval '1 day', now(), $4)`,
          [id, randomUUID(), userId, past],
        );
      } else if (table === 'auth_account') {
        id = randomUUID();
        await c.query(
          `INSERT INTO auth_account (id, user_id, account_id, provider_id, updated_at)
           VALUES ($1, $2, $3, 'credential', $4)`,
          [id, userId, randomUUID(), past],
        );
      } else {
        id = randomUUID();
        await c.query(
          `INSERT INTO auth_verification (id, identifier, value, expires_at, updated_at)
           VALUES ($1, 'x', 'y', now() + interval '1 hour', $2)`,
          [id, past],
        );
      }
      const touchColumn: Record<(typeof UPDATED_AT_TABLES)[number], string> = {
        auth_user: `name = 'Beto'`,
        auth_session: `user_agent = 'ua'`,
        auth_account: `scope = 's'`,
        auth_verification: `value = 'z'`,
      };
      await c.query(`UPDATE ${table} SET ${touchColumn[table]} WHERE id = $1`, [id]);
      const { rows } = await c.query<{ fresh: boolean }>(
        `SELECT updated_at > $2::timestamptz AS fresh FROM ${table} WHERE id = $1`,
        [id, past],
      );
      expect(rows[0]!.fresh).toBe(true);
    });
  });
});

/** The migration 0012 SQL, without explicit transaction control so it runs inside the test transaction. */
function migration0012(): string {
  const path = fileURLToPath(new URL('../prisma/migrations/0012_remove_login_alert/migration.sql', import.meta.url));
  return readFileSync(path, 'utf8').replace(/^\s*(BEGIN|START TRANSACTION|COMMIT)\s*;\s*$/gim, '');
}

/** Puts back, inside the transaction, the shape migration 0011 left: email_kind with login_alert and last_alert_sent_at. */
async function restorePre0012(c: pg.PoolClient): Promise<void> {
  await c.query(`ALTER TYPE email_kind RENAME TO email_kind_pre`);
  await c.query(
    `CREATE TYPE email_kind AS ENUM ('confirm','register_attempt','reset','password_changed','login_alert','account_deleted')`,
  );
  await c.query(`ALTER TABLE email_outbox ALTER COLUMN kind TYPE email_kind USING kind::text::email_kind`);
  await c.query(`ALTER TABLE email_send_log ALTER COLUMN kind TYPE email_kind USING kind::text::email_kind`);
  await c.query(`DROP TYPE email_kind_pre`);
  await c.query(`ALTER TABLE login_throttle ADD COLUMN IF NOT EXISTS last_alert_sent_at timestamptz`);
}

describe('TASK-263 migration 0012 removes login_alert and last_alert_sent_at', () => {
  it('TASK-263 migrating a database with a pending login_alert row in email_outbox deletes it and does not fail', async () => {
    const migration = migration0012();
    await inTx(async (c) => {
      await restorePre0012(c);
      const alertId = randomUUID();
      const keptId = randomUUID();
      const alertHmac = tokenHash();
      const keptHmac = tokenHash();
      await c.query(
        `INSERT INTO email_outbox (id, to_address, kind, payload) VALUES ($1, 'a@test.local', 'login_alert', '{}')`,
        [alertId],
      );
      await c.query(
        `INSERT INTO email_outbox (id, to_address, kind, payload) VALUES ($1, 'a@test.local', 'confirm', '{}')`,
        [keptId],
      );
      await c.query(`INSERT INTO email_send_log (email_hmac, kind) VALUES ($1, 'login_alert')`, [alertHmac]);
      await c.query(`INSERT INTO email_send_log (email_hmac, kind) VALUES ($1, 'reset')`, [keptHmac]);

      expect(await sqlState(c, migration)).toBeNull();

      const outbox = await c.query<{ id: string; kind: string }>(
        `SELECT id::text AS id, kind::text AS kind FROM email_outbox WHERE id = ANY($1::uuid[])`,
        [[alertId, keptId]],
      );
      expect(outbox.rows).toEqual([{ id: keptId, kind: 'confirm' }]);
      const log = await c.query<{ hmac: string; kind: string }>(
        `SELECT email_hmac AS hmac, kind::text AS kind FROM email_send_log WHERE email_hmac = ANY($1::text[])`,
        [[alertHmac, keptHmac]],
      );
      expect(log.rows).toEqual([{ hmac: keptHmac, kind: 'reset' }]);
    });
  });

  it('RF-M1-16 after migrating a pre-0012 database email_kind has the 5 values and both kind columns use it', async () => {
    const migration = migration0012();
    await inTx(async (c) => {
      await restorePre0012(c);
      expect(await sqlState(c, migration)).toBeNull();
      const labels = await c.query<{ label: string }>(`SELECT unnest(enum_range(NULL::email_kind))::text AS label`);
      expect(labels.rows.map((r) => r.label)).toEqual([
        'confirm',
        'register_attempt',
        'reset',
        'password_changed',
        'account_deleted',
      ]);
      const columns = await c.query<{ tbl: string; udt: string }>(
        `SELECT table_name AS tbl, udt_name AS udt FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'kind'
            AND table_name IN ('email_outbox', 'email_send_log')
          ORDER BY table_name`,
      );
      expect(columns.rows).toEqual([
        { tbl: 'email_outbox', udt: 'email_kind' },
        { tbl: 'email_send_log', udt: 'email_kind' },
      ]);
      const old = await c.query<{ reg: string | null }>(`SELECT to_regtype('public.email_kind_old')::text AS reg`);
      expect(old.rows[0]!.reg).toBeNull();
      const throttle = await c.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'login_throttle' AND column_name = 'last_alert_sent_at'`,
      );
      expect(throttle.rowCount).toBe(0);
    });
  });

  it('TASK-263 login_throttle no longer has last_alert_sent_at', async () => {
    const { rows } = await sql().query<{ col: string }>(
      `SELECT column_name AS col FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'login_throttle'
        ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => r.col)).toEqual(['email_hmac', 'consecutive_failures', 'last_failure_at', 'locked_until']);
  });

  it('TASK-263 schema.prisma no longer declares lastAlertSentAt nor loginAlert', () => {
    const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/lastAlertSentAt|last_alert_sent_at/);
    expect(source).not.toMatch(/loginAlert|login_alert/);
  });

  it('TASK-263 the email_send_log index on (email_hmac, kind, sent_at DESC) is kept', async () => {
    const { rows } = await sql().query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'email_send_log'`,
    );
    expect(rows.map((r) => r.def).some((d) => /\(email_hmac, kind, sent_at DESC\)/.test(d))).toBe(true);
  });
});

const INSERT_TICKET = `INSERT INTO signup_ticket (token_hash, user_id, expires_at)
                       VALUES ($1, $2, now() + interval '24 hours')`;

describe('RF-M1-18 signup_ticket for the app waiting for the confirmation', () => {
  it('RF-M1-18 signup_ticket has token_hash char(64) as its primary key', async () => {
    const { rows } = await sql().query<{ col: string }>(
      `SELECT a.attname AS col
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass('public.signup_ticket') AND i.indisprimary`,
    );
    expect(rows.map((r) => r.col)).toEqual(['token_hash']);
    const type = await sql().query<{ udt: string; len: number | null }>(
      `SELECT udt_name AS udt, character_maximum_length AS len FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'signup_ticket' AND column_name = 'token_hash'`,
    );
    expect(type.rows).toEqual([{ udt: 'bpchar', len: 64 }]);
  });

  it('RF-M1-18 signup_ticket has the columns of plan 3.3 and only confirmed_at admits null', async () => {
    const { rows } = await sql().query<{ col: string; nullable: string }>(
      `SELECT column_name AS col, is_nullable AS nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'signup_ticket'
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { col: 'confirmed_at', nullable: 'YES' },
      { col: 'created_at', nullable: 'NO' },
      { col: 'expires_at', nullable: 'NO' },
      { col: 'token_hash', nullable: 'NO' },
      { col: 'user_id', nullable: 'NO' },
    ]);
  });

  it('RF-M1-18 a new ticket is stored with confirmed_at null and created_at defaulted, and can be confirmed', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const hash = tokenHash();
      await c.query(INSERT_TICKET, [hash, userId]);
      const { rows } = await c.query<{ owner: string; confirmed: Date | null; created: boolean }>(
        `SELECT user_id::text AS owner, confirmed_at AS confirmed, created_at IS NOT NULL AS created
           FROM signup_ticket WHERE token_hash = $1`,
        [hash],
      );
      expect(rows).toEqual([{ owner: userId, confirmed: null, created: true }]);
      await c.query(`UPDATE signup_ticket SET confirmed_at = now() WHERE token_hash = $1`, [hash]);
      const after = await c.query(`SELECT 1 FROM signup_ticket WHERE token_hash = $1 AND confirmed_at IS NOT NULL`, [
        hash,
      ]);
      expect(after.rowCount).toBe(1);
    });
  });

  it('RF-M1-18 EC-M1-14 a second ticket for the same user is rejected by the UNIQUE on user_id', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await c.query(INSERT_TICKET, [tokenHash(), userId]);
      expect(await sqlState(c, INSERT_TICKET, [tokenHash(), userId])).toBe(UNIQUE_VIOLATION);
    });
  });

  it('RF-M1-18 the same token_hash cannot be stored twice', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const hash = tokenHash();
      await c.query(INSERT_TICKET, [hash, a]);
      expect(await sqlState(c, INSERT_TICKET, [hash, b])).toBe(UNIQUE_VIOLATION);
    });
  });

  it('RF-M1-18 a ticket must reference an existing user', async () => {
    await inTx(async (c) => {
      expect(await sqlState(c, INSERT_TICKET, [tokenHash(), randomUUID()])).toBe(FOREIGN_KEY_VIOLATION);
    });
  });

  it('RF-M1-18 RNF-26 deleting the user cascades to its ticket and keeps the tickets of other users', async () => {
    await inTx(async (c) => {
      const gone = await insertUser(c);
      const kept = await insertUser(c);
      await c.query(INSERT_TICKET, [tokenHash(), gone]);
      await c.query(INSERT_TICKET, [tokenHash(), kept]);
      await c.query(`DELETE FROM auth_user WHERE id = $1`, [gone]);
      const { rows } = await c.query<{ owner: string }>(
        `SELECT user_id::text AS owner FROM signup_ticket WHERE user_id = ANY($1::uuid[])`,
        [[gone, kept]],
      );
      expect(rows).toEqual([{ owner: kept }]);
    });
  });
});
