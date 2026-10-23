import type {
  ConfirmOccurrenceInput,
  CreateRuleInput,
  EarmarkWithdrawals,
  OccurrenceDto,
  RecurringOverviewDto,
  RuleDto,
  UpcomingDto,
} from '@finanzas/contracts';
import {
  amountInFrom,
  customRateOn,
  daysBetween,
  installment,
  isFinished,
  isFutureFor,
  nextDates,
  todayFor,
  toMoneyString,
  type RecurrenceRule,
} from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type { Clock, LocalDate } from '../ports/clock.js';
import type {
  AccountRow,
  LedgerEntryInput,
  RecurringOccurrenceRow,
  RecurringRuleRow,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  BalanceGuard,
  type BalanceDelta,
  type BalanceGuardOptions,
} from '../shared/balance-guard.js';
import type { LedgerChange, LedgerHooks } from '../shared/ledger-hooks.js';
import { assertLimit } from '../shared/limits.js';
import type { RecurringGenerator } from '../shared/recurring-generator.js';
import type { MovementRates, RatesContext, RatesService } from './rates.service.js';

export type RecurringContext = RatesContext;

export interface RecurringService {
  /**
   * Creates a rule, idempotent by `input.id` (ADR-11), with a cap of 100 (RNF-28). The start date
   * is today or later; a rule that starts today generates today's occurrence (RF-M14-03).
   */
  create(
    ctx: RecurringContext,
    input: CreateRuleInput,
  ): Promise<{ created: boolean; rule: RuleDto }>;
  /** The rules with their next dates, the pending occurrences and the next 30 days (RF-M14-13). */
  overview(ctx: RecurringContext): Promise<RecurringOverviewDto>;
  /**
   * Registers a pending occurrence as a movement `origin = recurring` with its original date or
   * another one up to today, and resolves its notice (RF-M14-08, EC-M15-01). Of simultaneous
   * decisions only one succeeds; the others get `ALREADY_DECIDED` (RNF-11).
   */
  confirm(
    ctx: RecurringContext,
    occurrenceId: string,
    input: ConfirmOccurrenceInput,
  ): Promise<{ transactionId: string }>;
  /** Skips a pending occurrence without a movement and resolves its notice (plan §4.14.2). */
  skip(ctx: RecurringContext, occurrenceId: string): Promise<void>;
}

export interface RecurringServiceDeps {
  uow: UnitOfWork;
  generator: RecurringGenerator;
  rates: RatesService;
  ledgerHooks: LedgerHooks;
  clock: Clock;
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
  const afterLast =
    rule.lastGeneratedDate === null ? rule.startDate : nextDay(rule.lastGeneratedDate);
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
    installment:
      rule.status === 'finished' ? null : installment(recurrenceOf(rule), rule.generatedCount),
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

/** The guard options of an interactive operation with the earmark withdrawals the user confirmed. */
function interactive(withdrawals: EarmarkWithdrawals | undefined): BalanceGuardOptions {
  return {
    mode: 'interactive',
    earmarkWithdrawals: (withdrawals ?? []).map((w) => ({
      goalId: w.goalId,
      accountId: w.accountId,
      amount: new Decimal(w.amount),
    })),
  };
}

/** The delta of an entry, or none when it is dated before the initial balance (RN-12). */
function deltaFor(account: AccountRow, date: LocalDate, amount: Decimal): BalanceDelta[] {
  return date < account.initialBalanceDate ? [] : [{ accountId: account.id, amount }];
}

/** Confirming needs an active account: an archived one must be replaced (RF-M14-08). */
async function activeAccount(repos: Repositories, id: string): Promise<AccountRow> {
  const account = await repos.accounts.get(id);
  if (account === null) {
    throw new AppError('NOT_FOUND');
  }
  if (account.status !== 'active') {
    throw new AppError('ACCOUNT_ARCHIVED');
  }
  return account;
}

/** Confirming needs an active category of the kind: an archived one must be replaced (RF-M14-08). */
async function assertConfirmCategory(
  repos: Repositories,
  categoryId: string,
  kind: 'expense' | 'income',
): Promise<void> {
  const category = await repos.categories.get(categoryId);
  if (category === null) {
    throw new AppError('NOT_FOUND');
  }
  if (category.status !== 'active') {
    throw new AppError('CATEGORY_ARCHIVED');
  }
  if (category.kind !== kind) {
    throw new AppError('CATEGORY_KIND_MISMATCH');
  }
}

/** Creations take the currency `FOR SHARE` so it cannot be deactivated meanwhile (plan §4.3.3). */
async function assertActiveCurrency(repos: Repositories, code: string): Promise<void> {
  const currency = await repos.currencies.lockForShare(code);
  if (currency?.status !== 'active') {
    throw new AppError('CURRENCY_INACTIVE');
  }
}

/** The movement a confirmation saves: its header data, entries and deltas. */
interface ConfirmedMovement {
  categoryId: string | null;
  rates: MovementRates;
  declaredRate: Decimal | null;
  entries: LedgerEntryInput[];
  deltas: BalanceDelta[];
  change: LedgerChange;
}

/** The user's pending occurrence; `null` when it is decided or is not the user's. */
async function pendingOccurrence(
  repos: Repositories,
  occurrenceId: string,
): Promise<RecurringOccurrenceRow | null> {
  const pending = await repos.recurringOccurrences.pending();
  return pending.find((occurrence) => occurrence.id === occurrenceId) ?? null;
}

export function createRecurringService({
  uow,
  generator,
  rates,
  ledgerHooks,
}: RecurringServiceDeps): RecurringService {
  /** The rates the movement stores (RN-04); the USD rate the user gave, when given (EC-M3-02). */
  async function simpleRates(
    repos: Repositories,
    ctx: RecurringContext,
    currencyCode: string,
    date: LocalDate,
    manual: Decimal | null,
  ): Promise<MovementRates> {
    if (manual === null) {
      return rates.ratesForMovement(repos, ctx, currencyCode, date);
    }
    if (currencyCode === 'BOB') {
      return { rateCurBob: new Decimal(1), rateUsdBob: manual };
    }
    if (currencyCode === 'USD') {
      return { rateCurBob: manual, rateUsdBob: manual };
    }
    const events = await repos.userFxEvents.eventsUntil(ctx.now);
    const rateCurBob = customRateOn(events, currencyCode, date, ctx.timezone);
    if (rateCurBob === null) {
      throw new AppError('RATE_REQUIRED');
    }
    return { rateCurBob, rateUsdBob: manual };
  }

  /** The rates a transfer between currencies stores, in the currency of the origin (plan §4.6.1). */
  async function transferRates(
    repos: Repositories,
    ctx: RecurringContext,
    from: string,
    to: string,
    date: LocalDate,
    declaredRate: Decimal | null,
  ): Promise<MovementRates> {
    if (declaredRate === null || (from !== 'BOB' && to !== 'BOB')) {
      return rates.ratesForMovement(repos, ctx, from, date);
    }
    const rateCurBob = from === 'BOB' ? new Decimal(1) : declaredRate;
    if (from === 'USD' || to === 'USD') {
      return { rateCurBob, rateUsdBob: declaredRate };
    }
    const { rateUsdBob } = await rates.ratesForMovement(repos, ctx, 'BOB', date);
    return { rateCurBob, rateUsdBob };
  }

  /** An expense or income on the chosen account and category, or the rule's ones (RF-M14-08). */
  async function planSimple(
    repos: Repositories,
    ctx: RecurringContext,
    rule: RecurringRuleRow,
    kind: 'expense' | 'income',
    input: ConfirmOccurrenceInput,
    amount: Decimal,
    date: LocalDate,
  ): Promise<ConfirmedMovement> {
    const account = await activeAccount(repos, input.accountId ?? rule.accountId);
    const categoryId = input.categoryId ?? rule.categoryId;
    if (categoryId !== null) {
      await assertConfirmCategory(repos, categoryId, kind);
    }
    await assertActiveCurrency(repos, account.currencyCode);
    const manual = input.rateUsdBob === undefined ? null : new Decimal(input.rateUsdBob);
    const signed = kind === 'expense' ? amount.negated() : amount;
    return {
      categoryId,
      rates: await simpleRates(repos, ctx, account.currencyCode, date, manual),
      declaredRate: null,
      entries: [{ id: uuidv7(), accountId: account.id, amount: signed }],
      deltas: deltaFor(account, date, signed),
      change: {
        dates: [date],
        categoryIds: categoryId === null ? [] : [categoryId],
        accountIds: [account.id],
      },
    };
  }

  /**
   * A transfer of the rule; between currencies the user may adjust the rate, else it takes the
   * prefill of RF-M3-07 of the movement's date (RF-M14-06).
   */
  async function planTransfer(
    repos: Repositories,
    ctx: RecurringContext,
    rule: RecurringRuleRow,
    input: ConfirmOccurrenceInput,
    amount: Decimal,
    date: LocalDate,
  ): Promise<ConfirmedMovement> {
    if (rule.destAccountId === null) {
      throw new AppError('INTERNAL_ERROR');
    }
    const fromId = input.accountId ?? rule.accountId;
    if (fromId === rule.destAccountId) {
      throw invalidField('accountId', 'same_account');
    }
    const from = await activeAccount(repos, fromId);
    const to = await activeAccount(repos, rule.destAccountId);
    await assertActiveCurrency(repos, from.currencyCode);
    if (to.currencyCode !== from.currencyCode) {
      await assertActiveCurrency(repos, to.currencyCode);
    }
    let declaredRate: Decimal | null = null;
    let amountIn = amount;
    if (from.currencyCode !== to.currencyCode) {
      declaredRate =
        input.declaredRate === undefined
          ? await rates.transferRate(repos, ctx, from.currencyCode, to.currencyCode, date)
          : new Decimal(input.declaredRate);
      if (declaredRate === null) {
        throw new AppError('RATE_REQUIRED');
      }
      amountIn = amountInFrom(amount, declaredRate, from.currencyCode);
    }
    const amountOut = amount.negated();
    return {
      categoryId: null,
      rates: await transferRates(
        repos,
        ctx,
        from.currencyCode,
        to.currencyCode,
        date,
        declaredRate,
      ),
      declaredRate,
      entries: [
        { id: uuidv7(), accountId: from.id, amount: amountOut },
        { id: uuidv7(), accountId: to.id, amount: amountIn },
      ],
      deltas: [...deltaFor(from, date, amountOut), ...deltaFor(to, date, amountIn)],
      change: { dates: [date], categoryIds: [], accountIds: [from.id, to.id] },
    };
  }

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
          return {
            created: true,
            rule: toRuleDto(rule, currencyOf(byAccount, rule.accountId), today),
          };
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
            rules: rules.map((rule) =>
              toRuleDto(rule, currencyOf(byAccount, rule.accountId), today),
            ),
            pending,
            upcoming30,
          };
        },
        { userLock: ctx.userId, readOnly: true },
      );
    },

    async confirm(ctx, occurrenceId, input) {
      return uow.run(
        async (repos) => {
          const occurrence = await pendingOccurrence(repos, occurrenceId);
          // Only a pending occurrence is decided, and only once (RNF-11).
          if (
            occurrence === null ||
            !(await repos.recurringOccurrences.decideIf(occurrence.id, 'pending', 'registered'))
          ) {
            throw new AppError('ALREADY_DECIDED');
          }
          const rule = await repos.recurringRules.get(occurrence.ruleId);
          if (rule === null) {
            throw new AppError('NOT_FOUND');
          }

          // The original date or another one, never in the future (RF-M14-08, RN-07).
          const date = input.date ?? occurrence.scheduledDate;
          if (isFutureFor(date, ctx.timezone, ctx.now)) {
            throw new AppError('FUTURE_DATE');
          }
          // A rule without amount takes it when it is confirmed (RF-M14-08).
          const amount = input.amount === undefined ? rule.amount : new Decimal(input.amount);
          if (amount === null) {
            throw invalidField('amount', 'required');
          }

          const planned =
            rule.kind === 'transfer'
              ? await planTransfer(repos, ctx, rule, input, amount, date)
              : await planSimple(repos, ctx, rule, rule.kind, input, amount, date);
          await BalanceGuard.apply(
            repos,
            ctx.userId,
            planned.deltas,
            interactive(input.earmarkWithdrawals),
          );

          const inserted = await repos.ledger.insertTransaction(
            {
              id: input.transactionId,
              kind: rule.kind,
              date,
              note: rule.note,
              categoryId: planned.categoryId,
              origin: 'recurring',
              originId: null,
              parentTransactionId: null,
              recurringRuleId: rule.id,
              recurringLabel: rule.name,
              rateCurBob: planned.rates.rateCurBob,
              rateUsdBob: planned.rates.rateUsdBob,
              declaredRate: planned.declaredRate,
            },
            planned.entries,
          );
          if (!inserted) {
            // The id is taken by another movement (ADR-11).
            throw new AppError('IDEMPOTENCY_CONFLICT');
          }
          await ledgerHooks.afterChange(repos, ctx.userId, planned.change);
          // The notice of the occurrence in the inbox is resolved (EC-M15-01).
          await repos.notifications.resolveDecision(ctx.userId, 'occurrence', occurrence.id);
          return { transactionId: input.transactionId };
        },
        { userLock: ctx.userId },
      );
    },

    async skip(ctx, occurrenceId) {
      await uow.run(
        async (repos) => {
          if (!(await repos.recurringOccurrences.decideIf(occurrenceId, 'pending', 'skipped'))) {
            throw new AppError('ALREADY_DECIDED');
          }
          await repos.notifications.resolveDecision(ctx.userId, 'occurrence', occurrenceId);
        },
        { userLock: ctx.userId },
      );
    },
  };
}
