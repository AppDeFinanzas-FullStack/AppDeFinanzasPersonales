import type {
  CreateRuleInput,
  OccurrenceDto,
  RecurringOverviewDto,
  RuleDto,
  UpcomingDto,
} from '@finanzas/contracts';
import {
  daysBetween,
  installment,
  isFinished,
  nextDates,
  todayFor,
  toMoneyString,
  type RecurrenceRule,
} from '@finanzas/domain';
import { Decimal } from 'decimal.js';

import { AppError } from '../errors.js';
import type { LocalDate } from '../ports/clock.js';
import type { AccountRow, RecurringRuleRow, Repositories } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { assertLimit } from '../shared/limits.js';
import type { RecurringGenerator } from '../shared/recurring-generator.js';
import type { RatesContext } from './rates.service.js';

export type RecurringContext = RatesContext;

export interface RecurringService {
  /**
   * Creates a rule, idempotent by `input.id` (ADR-11), with a cap of 100 (RNF-28). The start date
   * is today or later; a rule that starts today generates today's occurrence (RF-M14-03).
   */
  create(ctx: RecurringContext, input: CreateRuleInput): Promise<{ created: boolean; rule: RuleDto }>;
  /** The rules with their next dates, the pending occurrences and the next 30 days (RF-M14-13). */
  overview(ctx: RecurringContext): Promise<RecurringOverviewDto>;
}

export interface RecurringServiceDeps {
  uow: UnitOfWork;
  generator: RecurringGenerator;
}

/** How many next dates each rule shows (RF-M14-13). */
const NEXT_DATES = 3;
/** The window of "Próximos vencimientos", in days from today (RF-M14-13). */
const UPCOMING_DAYS = 30;

const MS_PER_DAY = 86_400_000;

function nextDay(date: LocalDate): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + MS_PER_DAY).toISOString().slice(0, 10);
}

function recurrenceOf(rule: RecurringRuleRow): RecurrenceRule {
  return { frequency: rule.frequency, startDate: rule.startDate, end: rule.end };
}

function invalidField(path: string, code: string): AppError {
  return new AppError('VALIDATION_ERROR', { issues: [{ path, code }] });
}

/**
 * The dates still to come of the rule, from the day after the last generated one and never before
 * today, respecting its end by date or by count (RF-M14-03, RF-M14-13).
 */
function comingDates(rule: RecurringRuleRow, today: LocalDate, n: number): LocalDate[] {
  if (rule.status === 'finished') {
    return [];
  }
  const recurrence = recurrenceOf(rule);
  if (isFinished(recurrence, rule.generatedCount, today)) {
    return [];
  }
  const afterLast = rule.lastGeneratedDate === null ? rule.startDate : nextDay(rule.lastGeneratedDate);
  const from = afterLast > today ? afterLast : today;
  const remaining =
    rule.end.type === 'count' ? Math.max(rule.end.count - rule.generatedCount, 0) : n;
  return nextDates(recurrence, from, Math.min(n, remaining));
}

function sameRule(row: RecurringRuleRow, input: CreateRuleInput): boolean {
  const amount = input.amount === undefined ? null : new Decimal(input.amount);
  const sameAmount =
    row.amount === null || amount === null ? row.amount === amount : row.amount.equals(amount);
  return (
    row.name === input.name.trim() &&
    row.kind === input.kind &&
    sameAmount &&
    row.accountId === input.accountId &&
    row.startDate === input.startDate &&
    row.mode === input.mode &&
    JSON.stringify(row.frequency) === JSON.stringify(input.frequency) &&
    JSON.stringify(row.end) === JSON.stringify(input.end)
  );
}

async function requireActiveAccount(
  repos: Repositories,
  id: string,
  path: string,
): Promise<AccountRow> {
  const account = await repos.accounts.get(id);
  if (account === null) {
    throw invalidField(path, 'not_found');
  }
  if (account.status !== 'active') {
    throw new AppError('ACCOUNT_ARCHIVED');
  }
  return account;
}

/** The account, category and destination of the rule must be the user's and active. */
async function validateTargets(repos: Repositories, input: CreateRuleInput): Promise<void> {
  await requireActiveAccount(repos, input.accountId, 'accountId');
  if (input.kind === 'transfer') {
    if (input.destAccountId === undefined) {
      throw invalidField('destAccountId', 'required');
    }
    if (input.destAccountId === input.accountId) {
      throw invalidField('destAccountId', 'same_account');
    }
    await requireActiveAccount(repos, input.destAccountId, 'destAccountId');
    return;
  }
  if (input.categoryId === undefined) {
    return;
  }
  const category = await repos.categories.get(input.categoryId);
  if (category === null) {
    throw invalidField('categoryId', 'not_found');
  }
  if (category.kind !== input.kind) {
    throw invalidField('categoryId', 'kind_mismatch');
  }
  if (category.status !== 'active') {
    throw new AppError('CATEGORY_ARCHIVED');
  }
}

/** The currency of each account of the user, active or archived. */
async function currencies(repos: Repositories): Promise<Map<string, string>> {
  const accounts = [
    ...(await repos.accounts.list('active')),
    ...(await repos.accounts.list('archived')),
  ];
  return new Map(accounts.map((account) => [account.id, account.currencyCode]));
}

function currencyOf(byAccount: Map<string, string>, accountId: string): string {
  const code = byAccount.get(accountId);
  if (code === undefined) {
    throw new AppError('INTERNAL_ERROR');
  }
  return code;
}

function toRuleDto(rule: RecurringRuleRow, currency: string, today: LocalDate): RuleDto {
  const next = comingDates(rule, today, NEXT_DATES);
  const dto: RuleDto = {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    currency,
    accountId: rule.accountId,
    frequency: rule.frequency,
    startDate: rule.startDate,
    end: rule.end,
    mode: rule.mode,
    status: rule.status,
    nextDate: next[0] ?? null,
    next3: next,
    installment: rule.status === 'finished' ? null : installment(recurrenceOf(rule), rule.generatedCount),
  };
  // A rule without amount is "monto por definir" (RF-M14-14).
  if (rule.amount !== null) dto.amount = toMoneyString(rule.amount);
  if (rule.destAccountId !== null) dto.destAccountId = rule.destAccountId;
  if (rule.categoryId !== null) dto.categoryId = rule.categoryId;
  if (rule.note !== null) dto.note = rule.note;
  return dto;
}

/** The dates of the rule within the next 30 days; a paused rule generates nothing (RF-M14-13). */
function upcomingOf(rule: RecurringRuleRow, currency: string, today: LocalDate): UpcomingDto[] {
  if (rule.status !== 'active') {
    return [];
  }
  const items: UpcomingDto[] = [];
  const horizon = rule.end.type === 'count' ? rule.end.count : UPCOMING_DAYS + 1;
  for (const date of comingDates(rule, today, horizon)) {
    if (daysBetween(today, date) > UPCOMING_DAYS) {
      break;
    }
    const item: UpcomingDto = { ruleId: rule.id, ruleName: rule.name, date, currency };
    if (rule.amount !== null) item.amount = toMoneyString(rule.amount);
    items.push(item);
  }
  return items;
}

export function createRecurringService({ uow, generator }: RecurringServiceDeps): RecurringService {
  return {
    async create(ctx, input) {
      const today = todayFor(ctx.timezone, ctx.now);
      return uow.run(
        async (repos) => {
          const existing = await repos.recurringRules.get(input.id);
          if (existing !== null) {
            if (!sameRule(existing, input)) {
              throw new AppError('IDEMPOTENCY_CONFLICT');
            }
            const byAccount = await currencies(repos);
            return {
              created: false,
              rule: toRuleDto(existing, currencyOf(byAccount, existing.accountId), today),
            };
          }

          if (input.amount === undefined && input.mode === 'auto') {
            throw new AppError('AMOUNT_REQUIRED_FOR_AUTO');
          }
          // "Today" is the local date of the user (RF-M14-03, RN-07).
          if (input.startDate < today) {
            throw new AppError('START_DATE_IN_PAST');
          }
          assertLimit((await repos.recurringRules.list()).length, 'recurringRules');
          await validateTargets(repos, input);

          const transfer = input.kind === 'transfer';
          await repos.recurringRules.insert({
            id: input.id,
            name: input.name.trim(),
            kind: input.kind,
            amount: input.amount === undefined ? null : new Decimal(input.amount),
            accountId: input.accountId,
            destAccountId: transfer ? (input.destAccountId ?? null) : null,
            categoryId: transfer ? null : (input.categoryId ?? null),
            note: input.note ?? null,
            frequency: input.frequency,
            startDate: input.startDate,
            end: input.end,
            mode: input.mode,
          });

          if (input.startDate === today) {
            // Today's occurrence is generated when the rule is saved (EC-M14-07).
            const locked = await repos.recurringRules.lockForUpdate(input.id);
            if (locked === null) {
              throw new AppError('INTERNAL_ERROR');
            }
            await generator.generateDue(repos, ctx.userId, locked, today);
          }

          const rule = await repos.recurringRules.get(input.id);
          if (rule === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          const byAccount = await currencies(repos);
          return { created: true, rule: toRuleDto(rule, currencyOf(byAccount, rule.accountId), today) };
        },
        { userLock: ctx.userId },
      );
    },

    async overview(ctx) {
      const today = todayFor(ctx.timezone, ctx.now);
      return uow.run(
        async (repos) => {
          const rules = await repos.recurringRules.list();
          const occurrences = await repos.recurringOccurrences.pending();
          const byAccount = await currencies(repos);
          const byId = new Map(rules.map((rule) => [rule.id, rule]));

          const pending: OccurrenceDto[] = [];
          for (const occurrence of occurrences) {
            const rule = byId.get(occurrence.ruleId);
            if (rule === undefined) {
              continue;
            }
            const item: OccurrenceDto = {
              transactionId: occurrence.id,
              ruleId: rule.id,
              ruleName: rule.name,
              date: occurrence.scheduledDate,
              currency: currencyOf(byAccount, rule.accountId),
              accountId: rule.accountId,
            };
            if (rule.amount !== null) item.amount = toMoneyString(rule.amount);
            if (rule.categoryId !== null) item.categoryId = rule.categoryId;
            pending.push(item);
          }

          const upcoming30 = rules
            .flatMap((rule) => upcomingOf(rule, currencyOf(byAccount, rule.accountId), today))
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

          return {
            rules: rules.map((rule) => toRuleDto(rule, currencyOf(byAccount, rule.accountId), today)),
            pending,
            upcoming30,
          };
        },
        { userLock: ctx.userId, readOnly: true },
      );
    },
  };
}
