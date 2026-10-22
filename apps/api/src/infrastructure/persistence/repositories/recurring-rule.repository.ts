import { Prisma } from '@finanzas/db';
import { Decimal } from 'decimal.js';

import type {
  NewRecurringRule,
  RecurringRulePatch,
  RecurringRuleRepository,
  RecurringRuleRow,
  RuleKind,
  RuleMode,
  RuleStatus,
} from '../../../application/ports/repositories.js';
import type { RecurrenceEnd, RecurrenceFrequency } from '../../../domain/index.js';
import type { TransactionClient } from '../unit-of-work.js';

type FrequencyType = RecurrenceFrequency['type'];
type EndType = RecurrenceEnd['type'];

interface RuleRecord {
  id: string;
  name: string;
  kind: RuleKind;
  amount: string | null;
  accountId: string;
  destAccountId: string | null;
  categoryId: string | null;
  note: string | null;
  frequency: FrequencyType;
  weekday: number | null;
  dayOfMonth: number | null;
  month: number | null;
  startDate: string;
  endType: EndType;
  endDate: string | null;
  endCount: number | null;
  mode: RuleMode;
  status: RuleStatus;
  pausedAt: Date | null;
  generatedCount: number;
  lastGeneratedDate: string | null;
}

const COLUMNS = Prisma.sql`
  id::text AS id, name, kind::text AS kind, amount::text AS amount,
  account_id::text AS "accountId", dest_account_id::text AS "destAccountId",
  category_id::text AS "categoryId", note, frequency::text AS frequency, weekday::int AS weekday,
  day_of_month::int AS "dayOfMonth", month::int AS month,
  to_char(start_date, 'YYYY-MM-DD') AS "startDate", end_type::text AS "endType",
  to_char(end_date, 'YYYY-MM-DD') AS "endDate", end_count::int AS "endCount",
  mode::text AS mode, status::text AS status, paused_at AS "pausedAt",
  generated_count AS "generatedCount",
  to_char(last_generated_date, 'YYYY-MM-DD') AS "lastGeneratedDate"`;

function toFrequency(record: RuleRecord): RecurrenceFrequency {
  switch (record.frequency) {
    case 'daily':
      return { type: 'daily' };
    case 'weekly':
      return { type: 'weekly', weekday: record.weekday ?? 0 };
    case 'monthly':
      return { type: 'monthly', day: record.dayOfMonth ?? 1 };
    case 'yearly':
      return { type: 'yearly', month: record.month ?? 1, day: record.dayOfMonth ?? 1 };
  }
}

function toEnd(record: RuleRecord): RecurrenceEnd {
  switch (record.endType) {
    case 'none':
      return { type: 'none' };
    case 'until':
      return { type: 'until', date: record.endDate ?? record.startDate };
    case 'count':
      return { type: 'count', count: record.endCount ?? 1 };
  }
}

const toRow = (record: RuleRecord): RecurringRuleRow => ({
  id: record.id,
  name: record.name,
  kind: record.kind,
  amount: record.amount === null ? null : new Decimal(record.amount),
  accountId: record.accountId,
  destAccountId: record.destAccountId,
  categoryId: record.categoryId,
  note: record.note,
  frequency: toFrequency(record),
  startDate: record.startDate,
  end: toEnd(record),
  mode: record.mode,
  status: record.status,
  pausedAt: record.pausedAt,
  generatedCount: record.generatedCount,
  lastGeneratedDate: record.lastGeneratedDate,
});

const money = (value: Decimal | null): string | null => (value === null ? null : value.toFixed(2));

/** The `weekday`, `day_of_month` and `month` columns of a frequency. */
function frequencyColumns(frequency: RecurrenceFrequency) {
  return {
    weekday: frequency.type === 'weekly' ? frequency.weekday : null,
    dayOfMonth:
      frequency.type === 'monthly' || frequency.type === 'yearly' ? frequency.day : null,
    month: frequency.type === 'yearly' ? frequency.month : null,
  };
}

/** The `end_date` and `end_count` columns of an end rule. */
function endColumns(end: RecurrenceEnd) {
  return {
    endDate: end.type === 'until' ? end.date : null,
    endCount: end.type === 'count' ? end.count : null,
  };
}

/** The `SET` assignments of the fields present in the patch. */
function assignments(patch: RecurringRulePatch): Prisma.Sql[] {
  const sets: Prisma.Sql[] = [];
  if (patch.name !== undefined) sets.push(Prisma.sql`name = ${patch.name}`);
  if (patch.kind !== undefined) sets.push(Prisma.sql`kind = ${patch.kind}::entry_kind`);
  if (patch.amount !== undefined) sets.push(Prisma.sql`amount = ${money(patch.amount)}::numeric`);
  if (patch.accountId !== undefined) sets.push(Prisma.sql`account_id = ${patch.accountId}::uuid`);
  if (patch.destAccountId !== undefined) {
    sets.push(Prisma.sql`dest_account_id = ${patch.destAccountId}::uuid`);
  }
  if (patch.categoryId !== undefined) {
    sets.push(Prisma.sql`category_id = ${patch.categoryId}::uuid`);
  }
  if (patch.note !== undefined) sets.push(Prisma.sql`note = ${patch.note}`);
  if (patch.frequency !== undefined) {
    const columns = frequencyColumns(patch.frequency);
    sets.push(Prisma.sql`frequency = ${patch.frequency.type}::rule_frequency`);
    sets.push(Prisma.sql`weekday = ${columns.weekday}::smallint`);
    sets.push(Prisma.sql`day_of_month = ${columns.dayOfMonth}::smallint`);
    sets.push(Prisma.sql`month = ${columns.month}::smallint`);
  }
  if (patch.startDate !== undefined) sets.push(Prisma.sql`start_date = ${patch.startDate}::date`);
  if (patch.end !== undefined) {
    const columns = endColumns(patch.end);
    sets.push(Prisma.sql`end_type = ${patch.end.type}::rule_end_type`);
    sets.push(Prisma.sql`end_date = ${columns.endDate}::date`);
    sets.push(Prisma.sql`end_count = ${columns.endCount}::smallint`);
  }
  if (patch.mode !== undefined) sets.push(Prisma.sql`mode = ${patch.mode}::rule_mode`);
  if (patch.status !== undefined) sets.push(Prisma.sql`status = ${patch.status}::rule_status`);
  if (patch.pausedAt !== undefined) {
    sets.push(Prisma.sql`paused_at = ${patch.pausedAt}::timestamptz`);
  }
  if (patch.generatedCount !== undefined) {
    sets.push(Prisma.sql`generated_count = ${patch.generatedCount}::int`);
  }
  if (patch.lastGeneratedDate !== undefined) {
    sets.push(Prisma.sql`last_generated_date = ${patch.lastGeneratedDate}::date`);
  }
  return sets;
}

/** Prisma implementation over `recurring_rule`, always filtered by the user of the transaction (RN-09). */
export function createRecurringRuleRepository(
  tx: TransactionClient,
  userId: string,
): RecurringRuleRepository {
  return {
    async insert(rule: NewRecurringRule): Promise<void> {
      const frequency = frequencyColumns(rule.frequency);
      const end = endColumns(rule.end);
      await tx.$executeRaw`
        INSERT INTO recurring_rule (id, user_id, name, kind, amount, account_id, dest_account_id,
                                    category_id, note, frequency, weekday, day_of_month, month,
                                    start_date, end_type, end_date, end_count, mode)
        VALUES (${rule.id}::uuid, ${userId}::uuid, ${rule.name}, ${rule.kind}::entry_kind,
                ${money(rule.amount)}::numeric, ${rule.accountId}::uuid,
                ${rule.destAccountId}::uuid, ${rule.categoryId}::uuid, ${rule.note},
                ${rule.frequency.type}::rule_frequency, ${frequency.weekday}::smallint,
                ${frequency.dayOfMonth}::smallint, ${frequency.month}::smallint,
                ${rule.startDate}::date, ${rule.end.type}::rule_end_type, ${end.endDate}::date,
                ${end.endCount}::smallint, ${rule.mode}::rule_mode)`;
    },

    async get(id: string): Promise<RecurringRuleRow | null> {
      const records = await tx.$queryRaw<RuleRecord[]>`
        SELECT ${COLUMNS} FROM recurring_rule
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
      const record = records[0];
      return record === undefined ? null : toRow(record);
    },

    async lockForUpdate(id: string): Promise<RecurringRuleRow | null> {
      const records = await tx.$queryRaw<RuleRecord[]>`
        SELECT ${COLUMNS} FROM recurring_rule
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid
         FOR UPDATE`;
      const record = records[0];
      return record === undefined ? null : toRow(record);
    },

    async list(): Promise<RecurringRuleRow[]> {
      const records = await tx.$queryRaw<RuleRecord[]>`
        SELECT ${COLUMNS} FROM recurring_rule
         WHERE user_id = ${userId}::uuid
         ORDER BY created_at ASC, id ASC`;
      return records.map(toRow);
    },

    async update(id: string, patch: RecurringRulePatch): Promise<void> {
      const sets = assignments(patch);
      if (sets.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE recurring_rule
           SET ${Prisma.join(sets, ', ')}, updated_at = now()
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async remove(id: string): Promise<boolean> {
      const deleted = await tx.$executeRaw`
        DELETE FROM recurring_rule WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
      return deleted > 0;
    },
  };
}
