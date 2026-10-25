import { Prisma } from '@finanzas/db';
import { Decimal } from 'decimal.js';

import type {
  DebtDirection,
  DebtInterestPeriod,
  DebtPatch,
  DebtRepository,
  DebtRow,
  NewDebt,
  StoredDebtStatus,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface DebtRecord {
  id: string;
  direction: DebtDirection;
  person: string;
  personKey: string;
  principal: string;
  currencyCode: string;
  startDate: string;
  dueDate: string | null;
  note: string | null;
  interestRate: string | null;
  interestPeriod: DebtInterestPeriod | null;
  status: StoredDebtStatus;
  forgivenAmount: string | null;
  initialTransactionId: string | null;
  capitalOutstanding: string;
  interestUnpaid: string;
  accruedThrough: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = Prisma.sql`
  id::text AS id, direction::text AS direction, person, person_key AS "personKey",
  principal::text AS principal, currency_code::text AS "currencyCode",
  to_char(start_date, 'YYYY-MM-DD') AS "startDate", to_char(due_date, 'YYYY-MM-DD') AS "dueDate",
  note, interest_rate::text AS "interestRate", interest_period::text AS "interestPeriod",
  status::text AS status, forgiven_amount::text AS "forgivenAmount",
  initial_transaction_id::text AS "initialTransactionId",
  capital_outstanding::text AS "capitalOutstanding", interest_unpaid::text AS "interestUnpaid",
  to_char(accrued_through, 'YYYY-MM-DD') AS "accruedThrough", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

const decimalOrNull = (value: string | null): Decimal | null =>
  value === null ? null : new Decimal(value);

const toRow = (record: DebtRecord): DebtRow => ({
  ...record,
  principal: new Decimal(record.principal),
  interestRate: decimalOrNull(record.interestRate),
  forgivenAmount: decimalOrNull(record.forgivenAmount),
  capitalOutstanding: new Decimal(record.capitalOutstanding),
  interestUnpaid: new Decimal(record.interestUnpaid),
});

const money = (value: Decimal | null): string | null => (value === null ? null : value.toFixed(2));

/** The `SET` assignments of the fields present in the patch. */
function assignments(patch: DebtPatch): Prisma.Sql[] {
  const sets: Prisma.Sql[] = [];
  if (patch.person !== undefined) {
    sets.push(Prisma.sql`person = ${patch.person}`);
    sets.push(Prisma.sql`person_key = lower(unaccent(${patch.person}::text))`);
  }
  if (patch.note !== undefined) sets.push(Prisma.sql`note = ${patch.note}`);
  if (patch.dueDate !== undefined) sets.push(Prisma.sql`due_date = ${patch.dueDate}::date`);
  if (patch.principal !== undefined) {
    sets.push(Prisma.sql`principal = ${patch.principal.toFixed(2)}::numeric`);
  }
  if (patch.status !== undefined) sets.push(Prisma.sql`status = ${patch.status}::debt_status`);
  if (patch.forgivenAmount !== undefined) {
    sets.push(Prisma.sql`forgiven_amount = ${money(patch.forgivenAmount)}::numeric`);
  }
  if (patch.capitalOutstanding !== undefined) {
    sets.push(Prisma.sql`capital_outstanding = ${patch.capitalOutstanding.toFixed(2)}::numeric`);
  }
  if (patch.interestUnpaid !== undefined) {
    sets.push(Prisma.sql`interest_unpaid = ${patch.interestUnpaid.toFixed(10)}::numeric`);
  }
  if (patch.accruedThrough !== undefined) {
    sets.push(Prisma.sql`accrued_through = ${patch.accruedThrough}::date`);
  }
  if (patch.initialTransactionId !== undefined) {
    sets.push(Prisma.sql`initial_transaction_id = ${patch.initialTransactionId}::uuid`);
  }
  return sets;
}

/** Prisma implementation over `debt`, always filtered by the user of the transaction (RN-09). */
export function createDebtRepository(tx: TransactionClient, userId: string): DebtRepository {
  return {
    async insert(debt: NewDebt): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO debt (id, user_id, direction, person, person_key, principal, currency_code,
                          start_date, due_date, note, interest_rate, interest_period,
                          initial_transaction_id, capital_outstanding, accrued_through)
        VALUES (${debt.id}::uuid, ${userId}::uuid, ${debt.direction}::debt_direction,
                ${debt.person}, lower(unaccent(${debt.person}::text)),
                ${debt.principal.toFixed(2)}::numeric, ${debt.currencyCode},
                ${debt.startDate}::date, ${debt.dueDate}::date, ${debt.note},
                ${debt.interestRate === null ? null : debt.interestRate.toFixed(4)}::numeric,
                ${debt.interestPeriod}::interest_period, ${debt.initialTransactionId}::uuid,
                ${debt.capitalOutstanding.toFixed(2)}::numeric, ${debt.accruedThrough}::date)`;
    },

    async get(id: string): Promise<DebtRow | null> {
      const rows = await tx.$queryRaw<DebtRecord[]>`
        SELECT ${COLUMNS}
          FROM debt
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
      const row = rows[0];
      return row === undefined ? null : toRow(row);
    },

    async lockForUpdate(id: string): Promise<DebtRow | null> {
      const rows = await tx.$queryRaw<DebtRecord[]>`
        SELECT ${COLUMNS}
          FROM debt
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid
           FOR UPDATE`;
      const row = rows[0];
      return row === undefined ? null : toRow(row);
    },

    async list(): Promise<DebtRow[]> {
      const rows = await tx.$queryRaw<DebtRecord[]>`
        SELECT ${COLUMNS}
          FROM debt
         WHERE user_id = ${userId}::uuid
         ORDER BY created_at ASC, id ASC`;
      return rows.map(toRow);
    },

    async update(id: string, patch: DebtPatch): Promise<void> {
      const sets = assignments(patch);
      if (sets.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE debt
           SET ${Prisma.join(sets, ', ')}
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async delete(id: string): Promise<void> {
      await tx.$executeRaw`
        DELETE FROM debt WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async persons(): Promise<string[]> {
      const rows = await tx.$queryRaw<{ person: string }[]>`
        SELECT DISTINCT person
          FROM debt
         WHERE user_id = ${userId}::uuid
         ORDER BY person ASC`;
      return rows.map((row) => row.person);
    },
  };
}
