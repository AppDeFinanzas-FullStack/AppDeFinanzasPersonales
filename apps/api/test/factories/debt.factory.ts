import { uuidv7 } from 'uuidv7';

import { testPrisma } from '../integration/setup/db.js';

export type TestDebtDirection = 'i_owe' | 'owed_to_me';
export type TestDebtStatus = 'active' | 'paid' | 'forgiven';
export type TestInterestPeriod = 'monthly' | 'yearly';

export interface CreateDebtOptions {
  id?: string;
  direction?: TestDebtDirection;
  /** Trimmed, 1 to 40 characters (plan §3.6). */
  person?: string;
  /** Written as is; `lower(unaccent(person))` by default. */
  personKey?: string;
  /** Decimal text with two decimals. */
  principal?: string;
  currencyCode?: string;
  /** `YYYY-MM-DD`. */
  startDate?: string;
  dueDate?: string | null;
  note?: string | null;
  /** Decimal text; it goes with `interestPeriod` (plan §3.6). */
  interestRate?: string | null;
  interestPeriod?: TestInterestPeriod | null;
  status?: TestDebtStatus;
  /** Required by a `forgiven` debt (plan §3.6). */
  forgivenAmount?: string | null;
  /** `principal` by default. */
  capitalOutstanding?: string;
  interestUnpaid?: string;
  /** `startDate` by default. */
  accruedThrough?: string;
}

export interface TestDebt {
  id: string;
  userId: string;
  direction: TestDebtDirection;
  person: string;
  principal: string;
  currencyCode: string;
  startDate: string;
  status: TestDebtStatus;
}

/**
 * Writes a debt of the user straight in `debt`, by SQL, so the tests of the code that reads debts
 * never depend on the repository that writes them (plan §3.6). By default it is an active
 * "Debo" debt of 1000.00 BOB with Juan, without interest, started on 2090-01-01, whose
 * `person_key` is `lower(unaccent(person))`. The debt goes away with its user
 * (`deleteCreatedUsers`).
 */
export async function createDebt(
  userId: string,
  options: CreateDebtOptions = {},
): Promise<TestDebt> {
  const debt: TestDebt = {
    id: options.id ?? uuidv7(),
    userId,
    direction: options.direction ?? 'i_owe',
    person: options.person ?? 'Juan',
    principal: options.principal ?? '1000.00',
    currencyCode: options.currencyCode ?? 'BOB',
    startDate: options.startDate ?? '2090-01-01',
    status: options.status ?? 'active',
  };
  const forgivenAmount =
    options.forgivenAmount ?? (debt.status === 'forgiven' ? debt.principal : null);

  await testPrisma().$executeRaw`
    INSERT INTO debt (id, user_id, direction, person, person_key, principal, currency_code,
                      start_date, due_date, note, interest_rate, interest_period, status,
                      forgiven_amount, capital_outstanding, interest_unpaid, accrued_through)
    VALUES (${debt.id}::uuid, ${userId}::uuid, ${debt.direction}::debt_direction, ${debt.person},
            COALESCE(${options.personKey ?? null}::text, lower(unaccent(${debt.person}::text))),
            ${debt.principal}::numeric, ${debt.currencyCode}, ${debt.startDate}::date,
            ${options.dueDate ?? null}::date, ${options.note ?? null},
            ${options.interestRate ?? null}::numeric,
            ${options.interestPeriod ?? null}::interest_period, ${debt.status}::debt_status,
            ${forgivenAmount}::numeric,
            ${options.capitalOutstanding ?? debt.principal}::numeric,
            ${options.interestUnpaid ?? '0'}::numeric,
            ${options.accruedThrough ?? debt.startDate}::date)`;

  return debt;
}

export interface CreateDebtPaymentOptions {
  id?: string;
  /** Decimal text with two decimals; `interestPart + capitalPart` (plan §3.6). */
  interestPart?: string;
  capitalPart?: string;
  /** `YYYY-MM-DD`; the start of the debt is not checked here. */
  date?: string;
  note?: string | null;
  /** When the payment was registered; `now()` by default. */
  createdAt?: Date;
}

export interface TestDebtPayment {
  id: string;
  debtId: string;
  amount: string;
  createdAt: Date | null;
}

/**
 * Writes a payment of the debt straight in `debt_payment`, by SQL, without an account nor linked
 * transactions (plan §3.6). By default it pays 100.00 of capital and no interest, dated
 * 2090-01-15. It does not touch the debt's balances. It goes away with its debt and its user.
 */
export async function createDebtPayment(
  userId: string,
  debtId: string,
  options: CreateDebtPaymentOptions = {},
): Promise<TestDebtPayment> {
  const id = options.id ?? uuidv7();
  const interestPart = options.interestPart ?? '0.00';
  const capitalPart = options.capitalPart ?? '100.00';
  const rows = await testPrisma().$queryRaw<{ amount: string }[]>`
    SELECT (${interestPart}::numeric + ${capitalPart}::numeric)::numeric(14,2)::text AS amount`;
  const amount = rows[0]?.amount ?? '0.00';

  await testPrisma().$executeRaw`
    INSERT INTO debt_payment (id, user_id, debt_id, amount, interest_part, capital_part, date, note,
                              created_at)
    VALUES (${id}::uuid, ${userId}::uuid, ${debtId}::uuid, ${amount}::numeric,
            ${interestPart}::numeric, ${capitalPart}::numeric,
            ${options.date ?? '2090-01-15'}::date, ${options.note ?? null},
            COALESCE(${options.createdAt ?? null}::timestamptz, now()))`;

  return { id, debtId, amount, createdAt: options.createdAt ?? null };
}

/** A `debt` row as it is stored, read outside of any UnitOfWork. */
export interface StoredDebt {
  id: string;
  userId: string;
  direction: string;
  person: string;
  personKey: string;
  principal: string;
  status: string;
  note: string | null;
  dueDate: string | null;
  forgivenAmount: string | null;
  capitalOutstanding: string;
  interestUnpaid: string;
  accruedThrough: string;
}

/** Reads a `debt` row straight by SQL; `null` when there is none. */
export async function findStoredDebt(id: string): Promise<StoredDebt | null> {
  const rows = await testPrisma().$queryRaw<StoredDebt[]>`
    SELECT id::text AS id, user_id::text AS "userId", direction::text AS direction, person,
           person_key AS "personKey", principal::text AS principal, status::text AS status, note,
           to_char(due_date, 'YYYY-MM-DD') AS "dueDate", forgiven_amount::text AS "forgivenAmount",
           capital_outstanding::text AS "capitalOutstanding",
           interest_unpaid::text AS "interestUnpaid",
           to_char(accrued_through, 'YYYY-MM-DD') AS "accruedThrough"
      FROM debt
     WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
}

/** The ids of the stored payments of the debt, oldest first. */
export async function storedPaymentIdsOf(debtId: string): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM debt_payment WHERE debt_id = ${debtId}::uuid
     ORDER BY created_at, id`;
  return rows.map((row) => row.id);
}
