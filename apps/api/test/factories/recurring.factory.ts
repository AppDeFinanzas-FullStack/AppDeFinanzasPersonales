import { uuidv7 } from 'uuidv7';

import { testPrisma } from '../integration/setup/db.js';
import { createAccount } from './account.factory.js';
import { createCategory } from './category.factory.js';

export type TestRuleKind = 'expense' | 'income' | 'transfer';
export type TestRuleStatus = 'active' | 'paused' | 'finished';
export type TestOccurrenceStatus = 'pending' | 'registered' | 'skipped' | 'omitted';

export interface TestRule {
  id: string;
  userId: string;
  name: string;
  kind: TestRuleKind;
  /** Decimal text with two decimals, or `null` for "to be defined" (confirm mode). */
  amount: string | null;
  accountId: string;
  destAccountId: string | null;
  categoryId: string | null;
  status: TestRuleStatus;
}

export interface CreateRuleOptions {
  id?: string;
  name?: string;
  kind?: TestRuleKind;
  amount?: string | null;
  accountId?: string;
  destAccountId?: string;
  categoryId?: string;
  /** Day of the month of the monthly rule. */
  dayOfMonth?: number;
  startDate?: string;
  mode?: 'auto' | 'confirm';
  status?: TestRuleStatus;
}

export interface TestOccurrence {
  id: string;
  userId: string;
  ruleId: string;
  scheduledDate: string;
  status: TestOccurrenceStatus;
}

export interface CreateOccurrenceOptions {
  id?: string;
  /** `YYYY-MM-DD`; by default a new date of 2090 for each occurrence. */
  scheduledDate?: string;
  status?: TestOccurrenceStatus;
  /** By default `now()` for a pending occurrence and `null` otherwise. */
  pendingSince?: Date | null;
}

let sequence = 0;

/** A name no other rule of the factory has. */
export function uniqueRuleName(prefix = 'Regla'): string {
  sequence += 1;
  return `${prefix} ${sequence} ${uuidv7().slice(-6)}`;
}

/**
 * Creates a monthly recurring rule of the user straight in `recurring_rule`, by SQL, so the tests of
 * the code that reads rules never depend on the repository that writes them (plan §3.6). By default
 * it is an active expense of 150.00 in auto mode on day 5, starting on 2090-01-05, over a new account
 * and a new expense category of the user. A transfer gets a new destination account and no category.
 * A paused rule gets its `paused_at`. Delete it with `deleteRecurringOf` before its user.
 */
export async function createRule(userId: string, options: CreateRuleOptions = {}): Promise<TestRule> {
  const kind = options.kind ?? 'expense';
  const accountId = options.accountId ?? (await createAccount(userId)).id;
  const destAccountId =
    kind === 'transfer' ? (options.destAccountId ?? (await createAccount(userId)).id) : null;
  const categoryId =
    kind === 'transfer'
      ? null
      : (options.categoryId ?? (await createCategory(userId, { kind })).id);
  const rule: TestRule = {
    id: options.id ?? uuidv7(),
    userId,
    name: options.name ?? uniqueRuleName(),
    kind,
    amount: options.amount === undefined ? '150.00' : options.amount,
    accountId,
    destAccountId,
    categoryId,
    status: options.status ?? 'active',
  };
  const mode = options.mode ?? (rule.amount === null ? 'confirm' : 'auto');

  await testPrisma().$executeRaw`
    INSERT INTO recurring_rule (id, user_id, name, kind, amount, account_id, dest_account_id,
                                category_id, frequency, day_of_month, start_date, mode, status,
                                paused_at)
    VALUES (${rule.id}::uuid, ${userId}::uuid, ${rule.name}, ${rule.kind}::entry_kind,
            ${rule.amount}::numeric, ${accountId}::uuid, ${destAccountId}::uuid,
            ${categoryId}::uuid, 'monthly', ${options.dayOfMonth ?? 5}::smallint,
            ${options.startDate ?? '2090-01-05'}::date, ${mode}::rule_mode,
            ${rule.status}::rule_status,
            ${rule.status === 'paused' ? new Date() : null}::timestamptz)`;

  return rule;
}

let daySequence = 0;

/** A date of 2090 or later that no other occurrence of the factory has used. */
function nextScheduledDate(): string {
  daySequence += 1;
  const date = new Date(Date.UTC(2090, 0, 1) + daySequence * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/**
 * Creates an occurrence of the rule straight in `recurring_occurrence`, by SQL (plan §3.6). By
 * default it is pending since now, on a new date. A decided occurrence (`registered`, `skipped`,
 * `omitted`) gets its `decided_at`.
 */
export async function createOccurrence(
  userId: string,
  ruleId: string,
  options: CreateOccurrenceOptions = {},
): Promise<TestOccurrence> {
  const occurrence: TestOccurrence = {
    id: options.id ?? uuidv7(),
    userId,
    ruleId,
    scheduledDate: options.scheduledDate ?? nextScheduledDate(),
    status: options.status ?? 'pending',
  };
  const pending = occurrence.status === 'pending';
  const pendingSince =
    options.pendingSince === undefined ? (pending ? new Date() : null) : options.pendingSince;

  await testPrisma().$executeRaw`
    INSERT INTO recurring_occurrence (id, user_id, rule_id, scheduled_date, status, pending_since,
                                      decided_at)
    VALUES (${occurrence.id}::uuid, ${userId}::uuid, ${ruleId}::uuid,
            ${occurrence.scheduledDate}::date, ${occurrence.status}::occurrence_status,
            ${pendingSince}::timestamptz, ${pending ? null : new Date()}::timestamptz)`;

  return occurrence;
}

export interface StoredOccurrence {
  id: string;
  userId: string;
  ruleId: string;
  scheduledDate: string;
  status: TestOccurrenceStatus;
}

/** The stored occurrences of the rule, by date, read outside of any UnitOfWork. */
export async function occurrencesOf(ruleId: string): Promise<StoredOccurrence[]> {
  return testPrisma().$queryRaw<StoredOccurrence[]>`
    SELECT id::text AS id, user_id::text AS "userId", rule_id::text AS "ruleId",
           to_char(scheduled_date, 'YYYY-MM-DD') AS "scheduledDate", status::text AS status
      FROM recurring_occurrence
     WHERE rule_id = ${ruleId}::uuid
     ORDER BY scheduled_date, id`;
}

/** The stored status of an occurrence, or `undefined` when it does not exist. */
export async function occurrenceStatus(id: string): Promise<TestOccurrenceStatus | undefined> {
  const rows = await testPrisma().$queryRaw<{ status: TestOccurrenceStatus }[]>`
    SELECT status::text AS status FROM recurring_occurrence WHERE id = ${id}::uuid`;
  return rows[0]?.status;
}

/**
 * Deletes the recurring rules of the users, and their occurrences by cascade. They go first:
 * `recurring_rule` points to `account` and `category` with `ON DELETE RESTRICT`, so it must not
 * outlive them when the users are deleted.
 */
export async function deleteRecurringOf(userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  await testPrisma().$executeRaw`DELETE FROM recurring_rule WHERE user_id = ANY(${userIds}::uuid[])`;
}
