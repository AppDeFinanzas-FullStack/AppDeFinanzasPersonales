import { Prisma } from '@finanzas/db';
import { Decimal } from 'decimal.js';

import type {
  DebtPaymentRepository,
  DebtPaymentRow,
  NewDebtPayment,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface DebtPaymentRecord {
  id: string;
  debtId: string;
  amount: string;
  interestPart: string;
  capitalPart: string;
  date: string;
  accountId: string | null;
  declaredRate: string | null;
  accountAmount: string | null;
  capitalTransactionId: string | null;
  interestTransactionId: string | null;
  note: string | null;
  createdAt: Date;
}

const COLUMNS = Prisma.sql`
  id::text AS id, debt_id::text AS "debtId", amount::text AS amount,
  interest_part::text AS "interestPart", capital_part::text AS "capitalPart",
  to_char(date, 'YYYY-MM-DD') AS date, account_id::text AS "accountId",
  declared_rate::text AS "declaredRate", account_amount::text AS "accountAmount",
  capital_transaction_id::text AS "capitalTransactionId",
  interest_transaction_id::text AS "interestTransactionId", note, created_at AS "createdAt"`;

const decimalOrNull = (value: string | null): Decimal | null =>
  value === null ? null : new Decimal(value);

const toRow = (record: DebtPaymentRecord): DebtPaymentRow => ({
  ...record,
  amount: new Decimal(record.amount),
  interestPart: new Decimal(record.interestPart),
  capitalPart: new Decimal(record.capitalPart),
  declaredRate: decimalOrNull(record.declaredRate),
  accountAmount: decimalOrNull(record.accountAmount),
});

const money = (value: Decimal | null): string | null => (value === null ? null : value.toFixed(2));

/**
 * Prisma implementation over `debt_payment`, always filtered by the user of the transaction
 * (RN-09).
 */
export function createDebtPaymentRepository(
  tx: TransactionClient,
  userId: string,
): DebtPaymentRepository {
  return {
    async insert(payment: NewDebtPayment): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO debt_payment (id, user_id, debt_id, amount, interest_part, capital_part, date,
                                  account_id, declared_rate, account_amount,
                                  capital_transaction_id, interest_transaction_id, note)
        VALUES (${payment.id}::uuid, ${userId}::uuid, ${payment.debtId}::uuid,
                ${payment.amount.toFixed(2)}::numeric, ${payment.interestPart.toFixed(2)}::numeric,
                ${payment.capitalPart.toFixed(2)}::numeric, ${payment.date}::date,
                ${payment.accountId}::uuid, ${money(payment.declaredRate)}::numeric,
                ${money(payment.accountAmount)}::numeric, ${payment.capitalTransactionId}::uuid,
                ${payment.interestTransactionId}::uuid, ${payment.note})`;
    },

    async list(debtId: string): Promise<DebtPaymentRow[]> {
      const rows = await tx.$queryRaw<DebtPaymentRecord[]>`
        SELECT ${COLUMNS}
          FROM debt_payment
         WHERE user_id = ${userId}::uuid AND debt_id = ${debtId}::uuid
         ORDER BY created_at ASC, id ASC`;
      return rows.map(toRow);
    },

    async last(debtId: string): Promise<DebtPaymentRow | null> {
      const rows = await tx.$queryRaw<DebtPaymentRecord[]>`
        SELECT ${COLUMNS}
          FROM debt_payment
         WHERE user_id = ${userId}::uuid AND debt_id = ${debtId}::uuid
         ORDER BY created_at DESC, id DESC
         LIMIT 1`;
      const row = rows[0];
      return row === undefined ? null : toRow(row);
    },

    async delete(id: string): Promise<void> {
      await tx.$executeRaw`
        DELETE FROM debt_payment WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },
  };
}
