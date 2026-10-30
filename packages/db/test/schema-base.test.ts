import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { closeSql, sql } from './helpers.js';

/** Enumerated types of plan §3.2, with their values in declaration order. */
const PLAN_ENUMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['email_link_purpose', ['confirm_email', 'reset_password']],
  ['email_kind', ['confirm', 'register_attempt', 'reset', 'password_changed', 'account_deleted']],
  ['outbox_status', ['pending', 'sent', 'failed']],
  ['number_format', ['dot_comma', 'comma_dot']],
  ['date_format', ['dmy', 'iso', 'short_text']],
  ['week_start', ['monday', 'sunday']],
  ['theme_mode', ['system', 'light', 'dark']],
  ['market_rate_kind', ['parallel_bid', 'parallel_ask', 'parallel_median', 'official']],
  ['rate_source', ['paralelo_bo', 'bcb', 'seed']],
  ['currency_status', ['active', 'inactive']],
  ['fx_event_kind', ['reference_set', 'manual_usd_on', 'manual_usd_off', 'custom_rate']],
  ['account_type', ['cash', 'bank', 'ewallet', 'credit_card', 'savings', 'other']],
  ['lifecycle_status', ['active', 'archived']],
  ['category_kind', ['expense', 'income']],
  ['system_category_key', ['debts', 'debts_interest']],
  ['transaction_kind', ['expense', 'income', 'transfer', 'adjustment']],
  ['transaction_origin', ['manual', 'recurring', 'debt_initial', 'debt_payment', 'fee', 'goal_transfer']],
  ['undo_kind', ['delete', 'recategorize', 'create']],
  ['entry_kind', ['expense', 'income', 'transfer']],
  ['budget_scope', ['category', 'general']],
  ['budget_status', ['active', 'paused', 'finalizing', 'finalized']],
  ['budget_default_action', ['discard', 'carry']],
  ['budget_period_status', ['open', 'closed_pending', 'decided', 'defaulted']],
  ['allocation_origin', ['manual', 'budget', 'confirmed_spend', 'use_and_close', 'adjustment']],
  ['debt_direction', ['i_owe', 'owed_to_me']],
  ['debt_status', ['active', 'paid', 'forgiven']],
  ['interest_period', ['monthly', 'yearly']],
  ['rule_frequency', ['daily', 'weekly', 'monthly', 'yearly']],
  ['rule_end_type', ['none', 'until', 'count']],
  ['rule_mode', ['auto', 'confirm']],
  ['rule_status', ['active', 'paused', 'finished']],
  ['occurrence_status', ['pending', 'registered', 'skipped', 'omitted']],
  ['notification_type', ['payment_upcoming', 'budget_alert', 'period_close', 'recurring_pending', 'log_day', 'goal_progress']],
  ['decision_status', ['waiting', 'resolved']],
];

/** Database enum labels of a type in the public schema, in their sort order. */
async function dbEnumLabels(typeName: string): Promise<string[]> {
  const { rows } = await sql().query<{ label: string }>(
    `SELECT e.enumlabel AS label
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = $1
      ORDER BY e.enumsortorder`,
    [typeName],
  );
  return rows.map((r) => r.label);
}

interface PrismaEnum {
  name: string;
  sqlName: string;
  values: string[];
}

/** Parses the enum blocks of schema.prisma, resolving `@map` and `@@map`. */
function prismaEnums(): PrismaEnum[] {
  const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
  const source = readFileSync(path, 'utf8');
  const blocks = source.matchAll(/^\s*enum\s+(\w+)\s*\{([^}]*)\}/gm);
  const result: PrismaEnum[] = [];
  for (const [, name, body] of blocks) {
    let sqlName = name!;
    const values: string[] = [];
    for (const raw of body!.split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      const blockMap = /^@@map\(\s*"([^"]+)"\s*\)/.exec(line);
      if (blockMap) {
        sqlName = blockMap[1]!;
        continue;
      }
      if (line.startsWith('@@')) continue;
      const value = /^(\w+)(?:\s+@map\(\s*"([^"]+)"\s*\))?/.exec(line);
      if (value) values.push(value[2] ?? value[1]!);
    }
    result.push({ name: name!, sqlName, values });
  }
  return result;
}

afterAll(async () => {
  await closeSql();
});

describe('TASK-011 base migration: enumerated types', () => {
  it.each(PLAN_ENUMS)('TASK-011 the database type %s exists with its exact values in plan order', async (typeName, expected) => {
    expect(await dbEnumLabels(typeName)).toEqual([...expected]);
  });

  it.each(PLAN_ENUMS)('TASK-011 schema.prisma declares an enum mapped to %s with the same values and order', (typeName, expected) => {
    const matches = prismaEnums().filter((e) => e.sqlName === typeName);
    expect(matches, `exactly one Prisma enum with @@map("${typeName}")`).toHaveLength(1);
    expect(matches[0]!.values).toEqual([...expected]);
  });
});

describe('RF-M1-16 email_kind without the failed sign-in alert', () => {
  it('RF-M1-16 the database type email_kind has exactly the 5 account emails', async () => {
    expect(await dbEnumLabels('email_kind')).toEqual([
      'confirm',
      'register_attempt',
      'reset',
      'password_changed',
      'account_deleted',
    ]);
  });

  it('RF-M1-16 schema.prisma maps email_kind without login_alert', () => {
    const matches = prismaEnums().filter((e) => e.sqlName === 'email_kind');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.values).not.toContain('login_alert');
    expect(matches[0]!.values).not.toContain('loginAlert');
  });
});

describe('TASK-011 base migration: extension and trigger function', () => {
  it('TASK-011 the unaccent extension is installed', async () => {
    const { rows } = await sql().query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'unaccent'`,
    );
    expect(rows).toHaveLength(1);
    const unaccented = await sql().query<{ v: string }>(`SELECT unaccent('Categoría Ñandú') AS v`);
    expect(unaccented.rows[0]!.v).toBe('Categoria Nandu');
  });

  it('TASK-011 the set_updated_at function exists and returns trigger', async () => {
    const { rows } = await sql().query<{ rettype: string }>(
      `SELECT format_type(p.prorettype, NULL) AS rettype
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'set_updated_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rettype).toBe('trigger');
  });

  it('TASK-011 set_updated_at refreshes updated_at when a row is updated', async () => {
    const client = await sql().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `CREATE TEMP TABLE set_updated_at_probe (
           id int PRIMARY KEY,
           note text NOT NULL,
           updated_at timestamptz NOT NULL
         ) ON COMMIT DROP`,
      );
      await client.query(
        `CREATE TRIGGER set_updated_at_probe_trg BEFORE UPDATE ON set_updated_at_probe
           FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
      );
      await client.query(
        `INSERT INTO set_updated_at_probe (id, note, updated_at) VALUES (1, 'a', '2000-01-01T00:00:00Z')`,
      );
      await client.query(`UPDATE set_updated_at_probe SET note = 'b' WHERE id = 1`);
      const { rows } = await client.query<{ fresh: boolean }>(
        `SELECT updated_at > '2000-01-01T00:00:00Z'::timestamptz AS fresh FROM set_updated_at_probe WHERE id = 1`,
      );
      expect(rows[0]!.fresh).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
