import {
  isReleased,
  type AccountDto,
  type BudgetBarDto,
  type DashboardDto,
  type ModuleKey,
  type Release,
  type UpcomingItemDto,
} from '@finanzas/contracts';
import {
  addMonths,
  clampDay,
  comparisonWindow,
  daysBetween,
  monthRange,
  nextDates,
  parseMoney,
  pctChange,
  savingsRate,
  savingsRateDeltaPp,
  todayFor,
  toMoneyString,
  type YearMonth,
} from '@finanzas/domain';

import { Decimal } from 'decimal.js';

import type {
  DebtRow,
  PeriodTotals,
  RecurringRuleRow,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { AccountsService } from './accounts.service.js';
import type { DescribedTransaction, TransactionsService } from './transactions.service.js';

/** Request context built from the session (plan §1.4). */
export interface DashboardContext {
  userId: string;
  timezone: string;
  now: Date;
  traceId: string;
}

export interface DashboardCards {
  range: DashboardDto['range'];
  cards: DashboardDto['cards'];
}

/** The cards plus what the user chose to see and the base currency they were computed in. */
export interface DashboardOpening extends DashboardCards {
  /** Keys of the blocks the user hid. */
  hidden: Set<string>;
  base: string;
}

export interface DashboardService {
  /**
   * The settings of the Inicio and its cards from one transaction: the base currency is read once
   * and the cards use it.
   */
  readonly opening: (ctx: DashboardContext, month: YearMonth) => Promise<DashboardOpening>;
  /**
   * Range of months and cards with their variations for the month (RF-M8-01 to RF-M8-04). A caller
   * that already read the user's base currency passes it and saves that read.
   */
  readonly cards: (
    ctx: DashboardContext,
    month: YearMonth,
    base?: string,
  ) => Promise<DashboardCards>;
}

export interface DashboardServiceDeps {
  uow: UnitOfWork;
}

const FALLBACK_BASE = 'BOB';

function formatPct(value: number | null): string | null {
  if (value === null) {
    return null;
  }
  return `${value > 0 ? '+' : ''}${value}%`;
}

function summarize(totals: PeriodTotals): {
  income: string;
  expense: string;
  balance: string;
  rate: number | null;
} {
  const income = toMoneyString(totals.income);
  const expense = toMoneyString(totals.expense);
  return {
    income,
    expense,
    balance: toMoneyString(parseMoney(income).minus(parseMoney(expense))),
    rate: savingsRate(income, expense),
  };
}

/** Expense of one day and top-level category, in the base currency (RF-M5-03). */
export interface DashboardExpenseRow {
  date: string;
  categoryId: string | null;
  name: string | null;
  amount: string;
}

/** Source of the expenses the charts add up, always for the given user (RN-09). */
export interface DashboardExpenseSource {
  expenses(
    userId: string,
    base: string,
    range: { from: string; to: string },
  ): Promise<DashboardExpenseRow[]>;
}

type Blocks = Pick<DashboardDto, 'byCategory' | 'pace'>;

/** The dashboard answer: the blocks hidden by the user or not released are absent. */
export interface DashboardView extends DashboardCards {
  budgets?: BudgetBarDto[];
  upcoming?: UpcomingItemDto[];
  byCategory?: Blocks['byCategory'];
  pace?: Blocks['pace'];
  balances?: {
    netWorth: { base: string; other: string | null };
    top: AccountDto[];
    asOfToday: true;
  };
  recent?: DescribedTransaction[];
}

export interface DashboardViewService {
  /** The blocks of `GET /api/dashboard` for the month (plan §4.8.2). */
  readonly view: (ctx: DashboardContext, month: YearMonth) => Promise<DashboardView>;
}

export interface DashboardViewServiceDeps {
  uow: UnitOfWork;
  dashboard: DashboardService;
  accounts: Pick<AccountsService, 'listWithSummary'>;
  transactions: Pick<TransactionsService, 'list'>;
  expenses: DashboardExpenseSource;
}

const TOP_CATEGORIES = 5;
const PERIODS_LOOKBACK = 36;
const RELEASES: readonly string[] = ['1.0', '1.1', '1.2'];

/** The release the server runs, read on every request like the release gate does (ADR-18). */
function released(module: ModuleKey): boolean {
  const current = process.env['RELEASE'];
  return (
    current !== undefined && RELEASES.includes(current) && isReleased(module, current as Release)
  );
}
/** Days ahead of today that "Próximos pagos y deudas" covers (RF-M8-09). */
const UPCOMING_DAYS = 7;
const TOP_ACCOUNTS = 5;
const RECENT_MOVEMENTS = 5;

function percentOf(part: Decimal, total: Decimal): number {
  return total.isZero() ? 0 : part.dividedBy(total).times(100).toDecimalPlaces(1).toNumber();
}

function byCategoryOf(rows: DashboardExpenseRow[]): Blocks['byCategory'] {
  const perCategory = new Map<string, { name: string; amount: Decimal }>();
  let total = new Decimal(0);
  for (const row of rows) {
    const amount = new Decimal(row.amount);
    total = total.plus(amount);
    if (row.categoryId !== null) {
      const entry = perCategory.get(row.categoryId);
      perCategory.set(row.categoryId, {
        name: row.name ?? '',
        amount: (entry?.amount ?? new Decimal(0)).plus(amount),
      });
    }
  }
  const ranked = [...perCategory.entries()]
    .filter(([, entry]) => entry.amount.greaterThan(0))
    .sort(([, a], [, b]) => b.amount.comparedTo(a.amount) || a.name.localeCompare(b.name));
  const top = ranked.slice(0, TOP_CATEGORIES).map(([categoryId, entry]) => ({
    categoryId,
    name: entry.name,
    amount: toMoneyString(entry.amount),
    pct: percentOf(entry.amount, total),
  }));
  const topTotal = ranked
    .slice(0, TOP_CATEGORIES)
    .reduce((sum, [, entry]) => sum.plus(entry.amount), new Decimal(0));
  const rest = total.minus(topTotal);
  return {
    top,
    others: rest.greaterThan(0)
      ? { amount: toMoneyString(rest), pct: percentOf(rest, total) }
      : null,
  };
}

/** Cumulative expense of each day of the month, up to `lastDay`. */
function cumulativeOf(
  rows: DashboardExpenseRow[],
  month: YearMonth,
  lastDay: number,
): Blocks['pace']['current'] {
  const perDay = new Map<number, Decimal>();
  for (const row of rows) {
    if (row.date.startsWith(month)) {
      const day = Number(row.date.slice(8, 10));
      perDay.set(day, (perDay.get(day) ?? new Decimal(0)).plus(row.amount));
    }
  }
  let running = new Decimal(0);
  const points: Blocks['pace']['current'] = [];
  for (let day = 1; day <= lastDay; day += 1) {
    running = running.plus(perDay.get(day) ?? 0);
    points.push({ day, cumulative: toMoneyString(running) });
  }
  return points;
}

/**
 * One bar per active budget with its period in course in the current month; in a past month, one per
 * period that ended inside it (RF-M8-08). A general budget has no category, so its bar carries its
 * own id and an empty name.
 */
async function budgetBarsIn(
  repos: Repositories,
  month: YearMonth,
  currentMonth: YearMonth,
): Promise<BudgetBarDto[]> {
  const { from, to } = monthRange(month);
  const isPast = month < currentMonth;
  const bars: BudgetBarDto[] = [];
  for (const budget of await repos.budgets.list()) {
    if (!isPast && budget.status !== 'active') continue;
    const periods = isPast
      ? (await repos.budgetPeriods.listByBudget(budget.id, PERIODS_LOOKBACK))
          .filter((p) => p.status !== 'open' && p.endDate >= from && p.endDate <= to)
          .reverse()
      : [await repos.budgetPeriods.current(budget.id)];
    const category =
      budget.categoryId === null ? null : await repos.categories.get(budget.categoryId);
    for (const period of periods) {
      if (period === null || period.startDate > to || period.endDate < from) continue;
      const spent = await repos.budgetPeriods.spent(budget, period);
      const limit = period.amount.plus(period.carryoverIn);
      bars.push({
        categoryId: budget.categoryId ?? budget.id,
        name: category?.name ?? '',
        spent: toMoneyString(spent),
        limit: toMoneyString(limit),
        pct: percentOf(spent, limit),
      });
    }
  }
  return bars;
}

/** The date of that day in the month `YYYY-MM`; a missing day falls on the last one (RF-M4-08). */
function dayOfMonth(month: YearMonth, day: number): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  return `${month}-${String(clampDay(year, number, day)).padStart(2, '0')}`;
}

/** The dates of a monthly day that fall from today to `UPCOMING_DAYS` days ahead. */
function upcomingDates(day: number, today: string): string[] {
  const month = today.slice(0, 7);
  const next = addMonths(`${month}-01`, 1).slice(0, 7);
  return [dayOfMonth(month, day), dayOfMonth(next, day)].filter((date) => {
    const days = daysBetween(today, date);
    return days >= 0 && days <= UPCOMING_DAYS;
  });
}

const MS_PER_DAY = 86_400_000;

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The next due date of an active expense or transfer rule inside the window: never before today nor
 * on an already generated date, respecting its end by date or by count (RF-M14-13).
 */
function recurringDueDate(rule: RecurringRuleRow, today: string): string | null {
  if (rule.status !== 'active' || rule.kind === 'income') return null;
  if (rule.end.type === 'count' && rule.generatedCount >= rule.end.count) return null;
  const afterLast =
    rule.lastGeneratedDate === null ? rule.startDate : nextDay(rule.lastGeneratedDate);
  const from = afterLast > today ? afterLast : today;
  const [date] = nextDates(
    { frequency: rule.frequency, startDate: rule.startDate, end: rule.end },
    from,
    1,
  );
  if (date === undefined) return null;
  const days = daysBetween(today, date);
  return days >= 0 && days <= UPCOMING_DAYS ? date : null;
}

/**
 * The due dates of the next days (RF-M8-09): active debts with a balance in both directions, the
 * cut and payment days of the active cards (RF-M4-08) and, since the V1.2, the next date of the
 * expense and transfer recurring rules, by date.
 */
async function upcomingSourcesIn(
  repos: Repositories,
): Promise<{ debts: DebtRow[]; rules: RecurringRuleRow[] }> {
  return {
    debts: await repos.debts.list(),
    rules: released('M14') ? await repos.recurringRules.list() : [],
  };
}

interface LedgerBlocks {
  budgets?: BudgetBarDto[];
  sources?: { debts: DebtRow[]; rules: RecurringRuleRow[] };
}

/**
 * What the budgets and the upcoming payments need from the ledger, read in one transaction: the
 * two blocks do not depend on the accounts nor on the charts, so they share one trip.
 */
async function blocksOf(
  uow: UnitOfWork,
  userId: string,
  wanted: { budgets: { month: YearMonth; currentMonth: YearMonth } | null; upcoming: boolean },
): Promise<LedgerBlocks> {
  if (wanted.budgets === null && !wanted.upcoming) {
    return {};
  }
  return uow.run(
    async (repos) => {
      const blocks: LedgerBlocks = {};
      if (wanted.budgets !== null) {
        blocks.budgets = await budgetBarsIn(
          repos,
          wanted.budgets.month,
          wanted.budgets.currentMonth,
        );
      }
      if (wanted.upcoming) {
        blocks.sources = await upcomingSourcesIn(repos);
      }
      return blocks;
    },
    { userLock: userId, readOnly: true },
  );
}

function upcomingOf(
  { debts, rules }: { debts: DebtRow[]; rules: RecurringRuleRow[] },
  today: string,
  accounts: AccountDto[],
): UpcomingItemDto[] {
  const items: UpcomingItemDto[] = [];
  for (const debt of debts) {
    if (debt.status !== 'active' || debt.dueDate === null) continue;
    const balance = debt.capitalOutstanding.plus(debt.interestUnpaid);
    const days = daysBetween(today, debt.dueDate);
    if (balance.lte(0) || days < 0 || days > UPCOMING_DAYS) continue;
    items.push({
      id: debt.id,
      kind: debt.direction === 'i_owe' ? 'debt_i_owe' : 'debt_owed_to_me',
      name: debt.person,
      amount: toMoneyString(balance),
      dueDate: debt.dueDate,
    });
  }
  for (const account of accounts) {
    if (account.type !== 'credit_card' || account.card === undefined) continue;
    const balance = new Decimal(account.balance);
    const owed = toMoneyString(balance.isNegative() ? balance.negated() : new Decimal(0));
    const days = [
      { kind: 'card_cut', day: account.card.cutDay },
      { kind: 'card_payment', day: account.card.payDay },
    ];
    for (const { kind, day } of days) {
      if (day === null) continue;
      for (const dueDate of upcomingDates(day, today)) {
        items.push({ id: account.id, kind, name: account.name, amount: owed, dueDate });
      }
    }
  }
  for (const rule of rules) {
    const dueDate = recurringDueDate(rule, today);
    if (dueDate === null) continue;
    items.push({
      id: rule.id,
      kind: `recurring_${rule.kind}`,
      name: rule.name,
      amount: toMoneyString(rule.amount ?? new Decimal(0)),
      dueDate,
    });
  }
  return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
}

/**
 * The expenses of the month and of the one before, read once for "Por categoría" and "Ritmo"
 * (RF-M5-03): the two charts share this single read.
 */
async function expensesOf(
  source: DashboardExpenseSource,
  userId: string,
  base: string,
  month: YearMonth,
  today: string,
): Promise<{
  rows: DashboardExpenseRow[];
  current: DashboardExpenseRow[];
  previousMonth: YearMonth;
  currentLastDay: number;
  previousLastDay: number;
}> {
  const window = comparisonWindow(month, today);
  const previousMonth = addMonths(monthRange(month).from, -1).slice(0, 7);
  const previousFull = monthRange(previousMonth);
  const rows = await source.expenses(userId, base, {
    from: previousFull.from,
    to: window.current.to,
  });
  return {
    rows,
    current: rows.filter((row) => row.date.startsWith(month)),
    previousMonth,
    currentLastDay: Number(window.current.to.slice(8, 10)),
    previousLastDay: Number(previousFull.to.slice(8, 10)),
  };
}

export function createDashboardViewService(deps: DashboardViewServiceDeps): DashboardViewService {
  return {
    async view(ctx, month) {
      const today = todayFor(ctx.timezone, ctx.now);
      const { hidden, base, range, cards } = await deps.dashboard.opening(ctx, month);

      const currentMonth = today.slice(0, 7);
      const showBudgets = !hidden.has('budget') && released('M11');
      const showUpcoming = !hidden.has('upcoming') && released('M13') && month >= currentMonth;
      const showBalances = !hidden.has('balances');
      const showCategories = !hidden.has('byCategory');
      const showPace = !hidden.has('pace');
      const showRecent = !hidden.has('recent');

      // The rest reads in independent trips, each in one read-only transaction, and none waits
      // for another (reads do not lock, TASK-256).
      const blocksRead = blocksOf(deps.uow, ctx.userId, {
        budgets: showBudgets ? { month, currentMonth } : null,
        upcoming: showUpcoming,
      });
      const accountsRead =
        showUpcoming || showBalances ? deps.accounts.listWithSummary(ctx) : undefined;
      const expensesRead =
        showCategories || showPace
          ? expensesOf(deps.expenses, ctx.userId, base, month, today)
          : undefined;
      const recentRead = showRecent
        ? deps.transactions.list(
            ctx,
            { from: `${range.firstMonth}-01`, to: today, limit: RECENT_MOVEMENTS },
            base,
          )
        : undefined;

      const [blocks, accounts, expenses, recent] = await Promise.all([
        blocksRead,
        accountsRead,
        expensesRead,
        recentRead,
      ]);
      const { budgets, sources } = blocks;

      const view: DashboardView = { range, cards };
      if (budgets !== undefined) {
        view.budgets = budgets;
      }
      if (sources !== undefined && accounts !== undefined) {
        view.upcoming = upcomingOf(sources, today, accounts.items);
      }
      if (expenses !== undefined) {
        if (showCategories) {
          view.byCategory = byCategoryOf(expenses.current);
        }
        if (showPace) {
          view.pace = {
            current: cumulativeOf(expenses.rows, month, expenses.currentLastDay),
            previous: cumulativeOf(expenses.rows, expenses.previousMonth, expenses.previousLastDay),
          };
        }
      }
      if (showBalances && accounts !== undefined) {
        const { items, summary } = accounts;
        view.balances = {
          netWorth: { base: summary.netWorth.base ?? '0.00', other: summary.netWorth.other },
          top: items.slice(0, TOP_ACCOUNTS),
          asOfToday: true,
        };
      }
      if (recent !== undefined) {
        view.recent = recent.items.slice(0, RECENT_MOVEMENTS);
      }
      return view;
    },
  };
}

async function cardsIn(
  repos: Repositories,
  ctx: DashboardContext,
  month: YearMonth,
  base: string,
): Promise<DashboardCards> {
  const today = todayFor(ctx.timezone, ctx.now);
  const window = comparisonWindow(month, today);
  const currentMonth = today.slice(0, 7);

  const { firstMonth: first, ...totals } = await repos.dashboard.totals(
    window.current,
    window.previous,
    base,
  );
  const current = summarize(totals.current);
  const previous = summarize(totals.previous);
  const firstMonth = first !== null && first < currentMonth ? first : currentMonth;

  return {
    range: { firstMonth, currentMonth },
    cards: {
      income: current.income,
      expense: current.expense,
      balance: current.balance,
      savingsRatePct: current.rate,
      variations: {
        income: formatPct(pctChange(current.income, previous.income)),
        expense: formatPct(pctChange(current.expense, previous.expense)),
        balance: toMoneyString(parseMoney(current.balance).minus(parseMoney(previous.balance))),
        savingsRatePp: savingsRateDeltaPp(current.rate, previous.rate),
      },
    },
  };
}

export function createDashboardService(deps: DashboardServiceDeps): DashboardService {
  return {
    async opening(ctx, month) {
      return deps.uow.run(
        async (repos) => {
          const settings = await repos.dashboard.settings();
          const base = settings?.baseCurrency ?? FALLBACK_BASE;
          return {
            hidden: new Set(settings?.hiddenBlocks ?? []),
            base,
            ...(await cardsIn(repos, ctx, month, base)),
          };
        },
        { userLock: ctx.userId, readOnly: true },
      );
    },

    async cards(ctx, month, knownBase) {
      return deps.uow.run(
        async (repos) =>
          cardsIn(
            repos,
            ctx,
            month,
            knownBase ??
              (await repos.userSettings.fxSettings(ctx.userId))?.baseCurrency ??
              FALLBACK_BASE,
          ),
        { userLock: ctx.userId, readOnly: true },
      );
    },
  };
}
