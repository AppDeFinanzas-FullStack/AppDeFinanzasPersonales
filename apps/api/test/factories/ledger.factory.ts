import { uuidv7 } from 'uuidv7';

import { testPrisma } from '../integration/setup/db.js';

export type TestTransactionKind = 'expense' | 'income' | 'transfer' | 'adjustment';

export interface TestEntry {
  accountId: string;
  /** Signed decimal text: positive comes into the account, negative goes out (ADR-04). */
  amount: string;
}

export interface CreateLedgerTransactionOptions {
  id?: string;
  kind?: TestTransactionKind;
  /** `YYYY-MM-DD`; every entry copies it (plan §3.5). */
  date: string;
  /** Required by `expense` and `income`; found among the user's categories when omitted. */
  categoryId?: string;
  note?: string | null;
  /** A deleted transaction, still inside the undo window or not (plan §3.5, ADR-07). */
  deletedAt?: Date | null;
  entries: TestEntry[];
}

export interface TestLedgerTransaction {
  id: string;
  entryIds: string[];
}

/** The id of one active category of that kind among the user's initial categories. */
export async function categoryIdOf(userId: string, kind: 'expense' | 'income'): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM category
     WHERE user_id = ${userId}::uuid AND kind = ${kind}::category_kind AND status = 'active'
     ORDER BY sort_order, id
     LIMIT 1`;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(`The user has no ${kind} category`);
  }
  return id;
}

/**
 * Writes a `ledger_transaction` and its `ledger_entry` rows straight by SQL, so the tests of the
 * code that reads the ledger never depend on the repository that writes it (plan §3.5, ADR-04).
 * By default it is an adjustment (no category) in BOB (`rate_cur_bob` 1.00). The rows go away with
 * their user (`deleteCreatedUsers` and `deleteLedgerOf`).
 */
export async function createLedgerTransaction(
  userId: string,
  options: CreateLedgerTransactionOptions,
): Promise<TestLedgerTransaction> {
  const id = options.id ?? uuidv7();
  const kind = options.kind ?? 'adjustment';
  const needsCategory = kind === 'expense' || kind === 'income';
  const categoryId = needsCategory
    ? (options.categoryId ?? (await categoryIdOf(userId, kind)))
    : null;
  const db = testPrisma();

  await db.$executeRaw`
    INSERT INTO ledger_transaction (id, user_id, kind, date, note, category_id, rate_cur_bob,
                                    rate_usd_bob, deleted_at)
    VALUES (${id}::uuid, ${userId}::uuid, ${kind}::transaction_kind, ${options.date}::date,
            ${options.note ?? null}, ${categoryId}::uuid, 1.00, 6.96,
            ${options.deletedAt ?? null}::timestamptz)`;

  const entryIds: string[] = [];
  for (const entry of options.entries) {
    const entryId = uuidv7();
    entryIds.push(entryId);
    await db.$executeRaw`
      INSERT INTO ledger_entry (id, user_id, transaction_id, account_id, amount, date)
      VALUES (${entryId}::uuid, ${userId}::uuid, ${id}::uuid, ${entry.accountId}::uuid,
              ${entry.amount}::numeric, ${options.date}::date)`;
  }

  return { id, entryIds };
}

export interface BulkLedgerOptions {
  /** How many movements (one transaction with one entry each). */
  count: number;
  /** Signed decimal text of every entry. */
  amount: string;
  /** `YYYY-MM-DD` of the first movement. */
  firstDate: string;
  /** The movements spread over this many consecutive days, starting at `firstDate`. */
  days: number;
}

/** Writes `count` adjustments of one entry each on the account, in two statements (RNF-03). */
export async function createBulkLedger(
  userId: string,
  accountId: string,
  options: BulkLedgerOptions,
): Promise<void> {
  const db = testPrisma();
  await db.$executeRaw`
    WITH movement AS (
      SELECT gen_random_uuid() AS tx_id, gen_random_uuid() AS entry_id,
             (${options.firstDate}::date + ((n - 1) % ${options.days}::int)) AS day
        FROM generate_series(1, ${options.count}::int) AS n
    ), headers AS (
      INSERT INTO ledger_transaction (id, user_id, kind, date, rate_cur_bob, rate_usd_bob)
      SELECT tx_id, ${userId}::uuid, 'adjustment', day, 1.00, 6.96 FROM movement
      RETURNING id
    )
    INSERT INTO ledger_entry (id, user_id, transaction_id, account_id, amount, date)
    SELECT entry_id, ${userId}::uuid, tx_id, ${accountId}::uuid, ${options.amount}::numeric, day
      FROM movement JOIN headers ON headers.id = movement.tx_id`;
}

/**
 * Deletes every ledger row of the users. The entries go first: `ledger_entry → account` is
 * `ON DELETE RESTRICT`, so they must not outlive the accounts when the users are deleted.
 */
export async function deleteLedgerOf(userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  const db = testPrisma();
  await db.$executeRaw`DELETE FROM ledger_entry WHERE user_id = ANY(${userIds}::uuid[])`;
  await db.$executeRaw`DELETE FROM ledger_transaction WHERE user_id = ANY(${userIds}::uuid[])`;
}
