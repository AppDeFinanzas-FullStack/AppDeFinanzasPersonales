import { Prisma } from '@finanzas/db';
import { Decimal } from 'decimal.js';

import { AppError } from '../../../application/errors.js';
import type {
  BalancePoint,
  DayNet,
  LedgerEntryInput,
  LedgerEntryView,
  LedgerListFilters,
  LedgerPage,
  LedgerRepository,
  LedgerTotals,
  LedgerTransactionDetail,
  LedgerTransactionHeader,
  LedgerTransactionView,
  TransactionKind,
  TransactionOrigin,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

const rate = (value: Decimal | null): string | null => (value === null ? null : value.toFixed(2));

const decimalOrNull = (value: string | null): Decimal | null =>
  value === null ? null : new Decimal(value);

interface TransactionRecord {
  id: string;
  kind: TransactionKind;
  date: string;
  note: string | null;
  categoryId: string | null;
  origin: TransactionOrigin;
  originId: string | null;
  parentTransactionId: string | null;
  recurringLabel: string | null;
  rateCurBob: string;
  rateUsdBob: string | null;
  declaredRate: string | null;
  createdAt: Date;
  /** `created_at` in UTC with its microseconds, so the cursor keeps the exact moment. */
  createdAtKey: string;
}

interface EntryRecord {
  transactionId: string;
  accountId: string;
  currencyCode: string;
  amount: string;
}

/** The position after which a page starts: the last movement of the previous page. */
interface CursorKey {
  date: string;
  createdAt: string;
  id: string;
}

const TRANSACTION_COLUMNS = Prisma.sql`
  t.id::text AS id, t.kind::text AS kind, to_char(t.date, 'YYYY-MM-DD') AS date, t.note,
  t.category_id::text AS "categoryId", t.origin::text AS origin, t.origin_id::text AS "originId",
  t.parent_transaction_id::text AS "parentTransactionId", t.recurring_label AS "recurringLabel",
  t.rate_cur_bob::text AS "rateCurBob", t.rate_usd_bob::text AS "rateUsdBob",
  t.declared_rate::text AS "declaredRate", t.created_at AS "createdAt",
  to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtKey"`;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CREATED_AT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A search that is an amount: digits with up to two decimals after a point or a comma. */
const AMOUNT_SEARCH = /^\d{1,9}(?:[.,]\d{1,2})?$/;

function encodeCursor(record: TransactionRecord): string {
  const key: CursorKey = { date: record.date, createdAt: record.createdAtKey, id: record.id };
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function invalidCursor(): AppError {
  return new AppError('VALIDATION_ERROR', { issues: [{ path: 'cursor', code: 'invalid_cursor' }] });
}

function decodeCursor(cursor: string): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw invalidCursor();
  }
  const { date, createdAt, id } = parsed as Record<string, unknown>;
  if (
    typeof date !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof id !== 'string' ||
    !LOCAL_DATE.test(date) ||
    !CREATED_AT_KEY.test(createdAt) ||
    !UUID.test(id)
  ) {
    throw invalidCursor();
  }
  return { date, createdAt, id };
}

/** `q` over the note, ignoring case and accents, or as an exact amount in its own currency. */
function searchCondition(userId: string, q: string): Prisma.Sql {
  if (AMOUNT_SEARCH.test(q)) {
    const amount = q.replace(',', '.');
    return Prisma.sql`EXISTS (
      SELECT 1 FROM ledger_entry se
       WHERE se.user_id = ${userId}::uuid AND se.transaction_id = t.id
         AND abs(se.amount) = ${amount}::numeric)`;
  }
  const pattern = `%${q.replace(/[!%_]/g, '!$&')}%`;
  return Prisma.sql`unaccent(lower(t.note)) LIKE unaccent(lower(${pattern})) ESCAPE '!'`;
}

/** The conditions of the filters over `ledger_transaction t`, always bound to the user (RN-09). */
function filterConditions(userId: string, filters: LedgerListFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`t.user_id = ${userId}::uuid`,
    Prisma.sql`t.deleted_at IS NULL`,
    Prisma.sql`t.date >= ${filters.from}::date`,
    Prisma.sql`t.date <= ${filters.to}::date`,
  ];
  if (filters.kind !== undefined) {
    conditions.push(Prisma.sql`t.kind = ${filters.kind}::transaction_kind`);
  }
  if (filters.accountId !== undefined) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM ledger_entry ae
       WHERE ae.user_id = ${userId}::uuid AND ae.transaction_id = t.id
         AND ae.account_id = ${filters.accountId}::uuid)`);
  }
  if (filters.categoryId !== undefined) {
    conditions.push(Prisma.sql`t.category_id IN (
      SELECT fc.id FROM category fc
       WHERE fc.user_id = ${userId}::uuid
         AND (fc.id = ${filters.categoryId}::uuid OR fc.parent_id = ${filters.categoryId}::uuid))`);
  }
  const q = filters.q?.trim() ?? '';
  if (q !== '') {
    conditions.push(searchCondition(userId, q));
  }
  return Prisma.join(conditions, ' AND ');
}

/**
 * The matching movements that count as income or expense (RN-02: no transfers, adjustments nor
 * "Deudas y préstamos" except "Intereses") with their signed amount in the currency of the `base`
 * CTE. Each one is converted with its stored rates (RN-05) and rounded to 2 decimals; a base that
 * the movement did not store takes the user's rate of that currency on its date (RN-04).
 */
function countedAmounts(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT t.date, t.kind,
           CASE WHEN a.currency_code = base.code THEN e.amount
                ELSE round(e.amount * t.rate_cur_bob
                           / CASE base.code
                               WHEN 'BOB' THEN 1
                               WHEN 'USD' THEN t.rate_usd_bob
                               ELSE user_rate_on(t.user_id, base.code, t.date)
                             END, 2)
           END AS amount
      FROM ledger_transaction t
      JOIN category c ON c.user_id = t.user_id AND c.id = t.category_id
      JOIN ledger_entry e ON e.user_id = t.user_id AND e.transaction_id = t.id
      JOIN account a ON a.user_id = e.user_id AND a.id = e.account_id
     CROSS JOIN base
     WHERE ${where}
       AND t.kind IN ('expense', 'income')
       AND c.system_key IS DISTINCT FROM 'debts'`;
}

function toView(record: TransactionRecord, entries: LedgerEntryView[]): LedgerTransactionView {
  return {
    id: record.id,
    kind: record.kind,
    date: record.date,
    note: record.note,
    categoryId: record.categoryId,
    origin: record.origin,
    originId: record.originId,
    parentTransactionId: record.parentTransactionId,
    recurringLabel: record.recurringLabel,
    rateCurBob: new Decimal(record.rateCurBob),
    rateUsdBob: decimalOrNull(record.rateUsdBob),
    declaredRate: decimalOrNull(record.declaredRate),
    createdAt: record.createdAt,
    entries,
  };
}

/**
 * Prisma implementation over `ledger_transaction` and `ledger_entry` (ADR-04), always filtered by
 * the user of the transaction (RN-09). A balance is the initial balance plus the entries dated on
 * or after the initial balance date, leaving out deleted transactions (RN-01).
 */
export function createLedgerRepository(tx: TransactionClient, userId: string): LedgerRepository {
  /** The entries of the user's transactions among the ids, keyed by transaction. */
  async function entriesOf(ids: string[]): Promise<Map<string, LedgerEntryView[]>> {
    const byTransaction = new Map<string, LedgerEntryView[]>();
    if (ids.length === 0) {
      return byTransaction;
    }
    const rows = await tx.$queryRaw<EntryRecord[]>`
      SELECT e.transaction_id::text AS "transactionId", e.account_id::text AS "accountId",
             a.currency_code::text AS "currencyCode", e.amount::text AS amount
        FROM ledger_entry e
        JOIN account a ON a.user_id = e.user_id AND a.id = e.account_id
       WHERE e.user_id = ${userId}::uuid AND e.transaction_id = ANY(${ids}::uuid[])
       ORDER BY e.id ASC`;
    for (const row of rows) {
      const entries = byTransaction.get(row.transactionId) ?? [];
      entries.push({
        accountId: row.accountId,
        currencyCode: row.currencyCode,
        amount: new Decimal(row.amount),
      });
      byTransaction.set(row.transactionId, entries);
    }
    return byTransaction;
  }

  /** The net of each date among the matching movements, in the user's base currency. */
  async function dayNetsOf(filters: LedgerListFilters, dates: string[]): Promise<DayNet[]> {
    if (dates.length === 0) {
      return [];
    }
    const where = Prisma.sql`${filterConditions(userId, filters)}
      AND t.date = ANY(${dates}::date[])`;
    const rows = await tx.$queryRaw<{ date: string; net: string }[]>`
      WITH base AS (
        SELECT COALESCE((SELECT s.base_currency FROM user_settings s
                          WHERE s.user_id = ${userId}::uuid), 'BOB')::char(3) AS code
      )
      SELECT to_char(counted.date, 'YYYY-MM-DD') AS date,
             COALESCE(SUM(counted.amount), 0)::text AS net
        FROM (${countedAmounts(where)}) counted
       GROUP BY counted.date`;
    const nets = new Map(rows.map((row) => [row.date, new Decimal(row.net)]));
    return dates.map((date) => ({ date, net: nets.get(date) ?? new Decimal(0) }));
  }

  return {
    async insertTransaction(
      header: LedgerTransactionHeader,
      entries: LedgerEntryInput[],
    ): Promise<boolean> {
      const inserted = await tx.$executeRaw`
        INSERT INTO ledger_transaction (id, user_id, kind, date, note, category_id, origin, origin_id,
                                        parent_transaction_id, recurring_rule_id, recurring_label,
                                        rate_cur_bob, rate_usd_bob, declared_rate)
        VALUES (${header.id}::uuid, ${userId}::uuid, ${header.kind}::transaction_kind,
                ${header.date}::date, ${header.note}, ${header.categoryId}::uuid,
                ${header.origin}::transaction_origin, ${header.originId}::uuid,
                ${header.parentTransactionId}::uuid, ${header.recurringRuleId}::uuid,
                ${header.recurringLabel}, ${header.rateCurBob.toFixed(2)}::numeric,
                ${rate(header.rateUsdBob)}::numeric, ${rate(header.declaredRate)}::numeric)
        ON CONFLICT (id) DO NOTHING`;
      if (inserted === 0) {
        return false;
      }
      if (entries.length > 0) {
        const ids = entries.map((entry) => entry.id);
        const accountIds = entries.map((entry) => entry.accountId);
        const amounts = entries.map((entry) => entry.amount.toFixed(2));
        await tx.$executeRaw`
          INSERT INTO ledger_entry (id, user_id, transaction_id, account_id, amount, date)
          SELECT entry.id, ${userId}::uuid, ${header.id}::uuid, entry.account_id, entry.amount,
                 ${header.date}::date
            FROM unnest(${ids}::uuid[], ${accountIds}::uuid[], ${amounts}::numeric[])
                 AS entry(id, account_id, amount)`;
      }
      return true;
    },

    async balances(accountIds: string[]): Promise<Map<string, Decimal>> {
      const balances = new Map<string, Decimal>();
      if (accountIds.length === 0) {
        return balances;
      }
      const rows = await tx.$queryRaw<{ accountId: string; balance: string }[]>`
        SELECT account.id::text AS "accountId",
               (account.initial_balance + COALESCE(SUM(entry.amount), 0))::text AS balance
          FROM account
          LEFT JOIN (ledger_entry entry
                     JOIN ledger_transaction header
                       ON header.id = entry.transaction_id AND header.deleted_at IS NULL)
            ON entry.user_id = account.user_id
           AND entry.account_id = account.id
           AND entry.date >= account.initial_balance_date
         WHERE account.user_id = ${userId}::uuid AND account.id = ANY(${accountIds}::uuid[])
         GROUP BY account.id, account.initial_balance`;
      for (const row of rows) {
        balances.set(row.accountId, new Decimal(row.balance));
      }
      return balances;
    },

    async balanceSeries(accountId: string, from: string, to: string): Promise<BalancePoint[]> {
      const rows = await tx.$queryRaw<{ date: string; balance: string }[]>`
        WITH owned AS (
          SELECT id, initial_balance, initial_balance_date
            FROM account
           WHERE user_id = ${userId}::uuid AND id = ${accountId}::uuid
        ), daily AS (
          SELECT entry.date, SUM(entry.amount) AS total
            FROM ledger_entry entry
            JOIN owned ON owned.id = entry.account_id
            JOIN ledger_transaction header
              ON header.id = entry.transaction_id AND header.deleted_at IS NULL
           WHERE entry.user_id = ${userId}::uuid
             AND entry.account_id = ${accountId}::uuid
             AND entry.date >= owned.initial_balance_date
             AND entry.date <= ${to}::date
           GROUP BY entry.date
        ), days AS (
          SELECT day::date AS date
            FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS day
        )
        SELECT to_char(days.date, 'YYYY-MM-DD') AS date,
               (owned.initial_balance
                + COALESCE((SELECT SUM(total) FROM daily WHERE daily.date < ${from}::date), 0)
                + SUM(COALESCE(daily.total, 0)) OVER (ORDER BY days.date))::text AS balance
          FROM owned
         CROSS JOIN days
          LEFT JOIN daily ON daily.date = days.date
         ORDER BY days.date ASC`;
      return rows.map((row) => ({ date: row.date, balance: new Decimal(row.balance) }));
    },

    async list(filters: LedgerListFilters, cursor: string | null): Promise<LedgerPage> {
      const conditions = [filterConditions(userId, filters)];
      if (cursor !== null) {
        const after = decodeCursor(cursor);
        conditions.push(Prisma.sql`(t.date, t.created_at, t.id)
          < (${after.date}::date, ${after.createdAt}::timestamptz, ${after.id}::uuid)`);
      }
      const records = await tx.$queryRaw<TransactionRecord[]>`
        SELECT ${TRANSACTION_COLUMNS}
          FROM ledger_transaction t
         WHERE ${Prisma.join(conditions, ' AND ')}
         ORDER BY t.date DESC, t.created_at DESC, t.id DESC
         LIMIT ${filters.limit + 1}::int`;

      const page = records.slice(0, filters.limit);
      const last = page.at(-1);
      const nextCursor =
        records.length > filters.limit && last !== undefined ? encodeCursor(last) : null;
      const entries = await entriesOf(page.map((record) => record.id));
      const dates = [...new Set(page.map((record) => record.date))];

      return {
        items: page.map((record) => toView(record, entries.get(record.id) ?? [])),
        nextCursor,
        dayNets: await dayNetsOf(filters, dates),
      };
    },

    async summary(filters: LedgerListFilters, base: string): Promise<LedgerTotals> {
      const rows = await tx.$queryRaw<{ income: string; expense: string; net: string }[]>`
        WITH base AS (SELECT ${base}::char(3) AS code)
        SELECT COALESCE(SUM(counted.amount) FILTER (WHERE counted.kind = 'income'), 0)::text
                 AS income,
               COALESCE(-SUM(counted.amount) FILTER (WHERE counted.kind = 'expense'), 0)::text
                 AS expense,
               COALESCE(SUM(counted.amount), 0)::text AS net
          FROM (${countedAmounts(filterConditions(userId, filters))}) counted`;
      const row = rows[0];
      return {
        income: new Decimal(row?.income ?? 0),
        expense: new Decimal(row?.expense ?? 0),
        net: new Decimal(row?.net ?? 0),
      };
    },

    async get(id: string): Promise<LedgerTransactionDetail | null> {
      const records = await tx.$queryRaw<TransactionRecord[]>`
        SELECT ${TRANSACTION_COLUMNS}
          FROM ledger_transaction t
         WHERE t.user_id = ${userId}::uuid AND t.id = ${id}::uuid AND t.deleted_at IS NULL`;
      const record = records[0];
      if (record === undefined) {
        return null;
      }
      const fees = await tx.$queryRaw<TransactionRecord[]>`
        SELECT ${TRANSACTION_COLUMNS}
          FROM ledger_transaction t
         WHERE t.user_id = ${userId}::uuid AND t.parent_transaction_id = ${id}::uuid
           AND t.origin = 'fee' AND t.deleted_at IS NULL
         ORDER BY t.created_at ASC, t.id ASC
         LIMIT 1`;
      const fee = fees[0];
      const entries = await entriesOf(fee === undefined ? [record.id] : [record.id, fee.id]);

      return {
        ...toView(record, entries.get(record.id) ?? []),
        fee: fee === undefined ? null : toView(fee, entries.get(fee.id) ?? []),
      };
    },
  };
}
