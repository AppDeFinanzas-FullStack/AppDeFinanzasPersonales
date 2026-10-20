import { Decimal } from 'decimal.js';

import type {
  BalancePoint,
  LedgerEntryInput,
  LedgerRepository,
  LedgerTransactionHeader,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

const rate = (value: Decimal | null): string | null => (value === null ? null : value.toFixed(2));

/**
 * Prisma implementation over `ledger_transaction` and `ledger_entry` (ADR-04), always filtered by
 * the user of the transaction (RN-09). A balance is the initial balance plus the entries dated on
 * or after the initial balance date, leaving out deleted transactions (RN-01).
 */
export function createLedgerRepository(tx: TransactionClient, userId: string): LedgerRepository {
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
  };
}
