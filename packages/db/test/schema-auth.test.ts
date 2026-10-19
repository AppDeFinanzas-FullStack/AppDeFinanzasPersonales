import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closeSql, sql } from './helpers.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

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
  it('RF-M1-16 email_kind has exactly the 6 account emails', async () => {
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
      'login_alert',
      'account_deleted',
    ]);
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

  it('RF-M1-16 email_outbox rejects a kind outside the 6 account emails', async () => {
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
        `INSERT INTO email_send_log (email_hmac, kind) VALUES ($1, 'login_alert')
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
