import { uuidv7 } from 'uuidv7';

import { testPrisma } from '../integration/setup/db.js';

export type TestBudgetScope = 'category' | 'general';
export type TestBudgetStatus = 'active' | 'paused' | 'finalizing' | 'finalized';
export type TestPeriodStatus = 'open' | 'closed_pending' | 'decided' | 'defaulted';

export interface TestBudget {
  id: string;
  userId: string;
  scope: TestBudgetScope;
  categoryId: string | null;
  /** Decimal text with two decimals. */
  amount: string;
  currencyCode: string;
}

export interface CreateBudgetOptions {
  id?: string;
  /** Required by a category budget; a general budget has none. */
  categoryId?: string | null;
  amount?: string;
  currencyCode?: string;
  startDay?: number;
  thresholds?: number[];
  status?: TestBudgetStatus;
}

export interface TestBudgetPeriod {
  id: string;
  budgetId: string;
  startDate: string;
  endDate: string;
}

export interface CreateBudgetPeriodOptions {
  id?: string;
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`. */
  endDate: string;
  amount?: string;
  carryoverIn?: string;
  status?: TestPeriodStatus;
}

/**
 * Writes a budget straight in `budget`, by SQL (plan §3.6). It is general when `categoryId` is
 * omitted or `null`, and of that category otherwise. By default 500.00 in BOB, active, from day 1.
 */
export async function createBudget(
  userId: string,
  options: CreateBudgetOptions = {},
): Promise<TestBudget> {
  const categoryId = options.categoryId ?? null;
  const budget: TestBudget = {
    id: options.id ?? uuidv7(),
    userId,
    scope: categoryId === null ? 'general' : 'category',
    categoryId,
    amount: options.amount ?? '500.00',
    currencyCode: options.currencyCode ?? 'BOB',
  };
  const thresholds = options.thresholds ?? [80, 100];
  await testPrisma().$executeRaw`
    INSERT INTO budget (id, user_id, scope, category_id, amount, currency_code, start_day,
                        thresholds, status)
    VALUES (${budget.id}::uuid, ${userId}::uuid, ${budget.scope}::budget_scope,
            ${budget.categoryId}::uuid, ${budget.amount}::numeric, ${budget.currencyCode},
            ${options.startDay ?? 1}::smallint, ${thresholds}::smallint[],
            ${options.status ?? 'active'}::budget_status)`;
  return budget;
}

/** Writes a period of the budget straight in `budget_period`, by SQL (plan §3.6). */
export async function createBudgetPeriod(
  userId: string,
  budget: Pick<TestBudget, 'id' | 'amount'>,
  options: CreateBudgetPeriodOptions,
): Promise<TestBudgetPeriod> {
  const period: TestBudgetPeriod = {
    id: options.id ?? uuidv7(),
    budgetId: budget.id,
    startDate: options.startDate,
    endDate: options.endDate,
  };
  const status = options.status ?? 'open';
  const decided = status === 'decided' || status === 'defaulted';
  await testPrisma().$executeRaw`
    INSERT INTO budget_period (id, user_id, budget_id, start_date, end_date, amount, carryover_in,
                               status, decided_at)
    VALUES (${period.id}::uuid, ${userId}::uuid, ${budget.id}::uuid, ${period.startDate}::date,
            ${period.endDate}::date, ${options.amount ?? budget.amount}::numeric,
            ${options.carryoverIn ?? '0.00'}::numeric, ${status}::budget_period_status,
            ${decided ? new Date() : null}::timestamptz)`;
  return period;
}

export interface CreateSpendOptions {
  accountId: string;
  categoryId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Positive decimal text, in the currency of the account. */
  amount: string;
  kind?: 'expense' | 'income' | 'transfer' | 'adjustment';
  /** The rate to BOB stored in the movement (RN-05); `1.00` by default. */
  rateCurBob?: string;
  /** The USD to BOB rate stored in the movement (RN-05); `6.96` by default. */
  rateUsdBob?: string;
  deletedAt?: Date | null;
}

/**
 * Writes an expense (or another kind) with an entry that takes `amount` out of the account, by SQL,
 * with the rates the test fixes (plan §3.5). A transfer or an adjustment has no category.
 */
export async function createSpend(userId: string, options: CreateSpendOptions): Promise<string> {
  const id = uuidv7();
  const kind = options.kind ?? 'expense';
  const categoryId = kind === 'expense' || kind === 'income' ? options.categoryId : null;
  const db = testPrisma();
  await db.$executeRaw`
    INSERT INTO ledger_transaction (id, user_id, kind, date, category_id, rate_cur_bob,
                                    rate_usd_bob, deleted_at)
    VALUES (${id}::uuid, ${userId}::uuid, ${kind}::transaction_kind, ${options.date}::date,
            ${categoryId}::uuid, ${options.rateCurBob ?? '1.00'}::numeric,
            ${options.rateUsdBob ?? '6.96'}::numeric,
            ${options.deletedAt ?? null}::timestamptz)`;
  await db.$executeRaw`
    INSERT INTO ledger_entry (id, user_id, transaction_id, account_id, amount, date)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${id}::uuid, ${options.accountId}::uuid,
            ${'-' + options.amount}::numeric, ${options.date}::date)`;
  return id;
}

/** The id of the system category `debts` or `debts_interest` of the kind of the user. */
export async function systemCategoryId(
  userId: string,
  key: 'debts' | 'debts_interest',
  kind: 'expense' | 'income' = 'expense',
): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM category
     WHERE user_id = ${userId}::uuid AND system_key = ${key}::system_category_key
       AND kind = ${kind}::category_kind`;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(`The user has no ${key} category of kind ${kind}`);
  }
  return id;
}

/** The raw `budget_threshold_hit` thresholds of a period, ascending. */
export async function thresholdHitsOf(periodId: string): Promise<number[]> {
  const rows = await testPrisma().$queryRaw<{ threshold: number }[]>`
    SELECT threshold::int AS threshold FROM budget_threshold_hit
     WHERE period_id = ${periodId}::uuid ORDER BY threshold`;
  return rows.map((row) => row.threshold);
}

/**
 * Deletes the budgets of the users with their history. They go first: `budget → category` is
 * `ON DELETE RESTRICT`, so they must not outlive the categories when the users are deleted.
 */
export async function deleteBudgetsOf(userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  const db = testPrisma();
  await db.$executeRaw`DELETE FROM budget_late_adjustment WHERE user_id = ANY(${userIds}::uuid[])`;
  await db.$executeRaw`DELETE FROM budget_period WHERE user_id = ANY(${userIds}::uuid[])`;
  await db.$executeRaw`DELETE FROM budget WHERE user_id = ANY(${userIds}::uuid[])`;
}
