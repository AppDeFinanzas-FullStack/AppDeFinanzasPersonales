import type { AccountDto, DashboardDto } from '@finanzas/contracts';
import {
  addMonths,
  comparisonWindow,
  monthRange,
  parseMoney,
  pctChange,
  savingsRate,
  savingsRateDeltaPp,
  todayFor,
  toMoneyString,
  type YearMonth,
} from '@finanzas/domain';

import { Decimal } from 'decimal.js';

import type { PeriodTotals } from '../ports/repositories.js';
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

export interface DashboardService {
  /** Range of months and cards with their variations for the month (RF-M8-01 to RF-M8-04). */
  readonly cards: (ctx: DashboardContext, month: YearMonth) => Promise<DashboardCards>;
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
  accounts: Pick<AccountsService, 'list' | 'summary'>;
  transactions: Pick<TransactionsService, 'list'>;
  expenses: DashboardExpenseSource;
}

const TOP_CATEGORIES = 5;
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

export function createDashboardViewService(deps: DashboardViewServiceDeps): DashboardViewService {
  return {
    async view(ctx, month) {
      const today = todayFor(ctx.timezone, ctx.now);
      const { range, cards } = await deps.dashboard.cards(ctx, month);
      const { hidden, base } = await deps.uow.run(
        async (repos) => {
          const settings = await repos.userSettings.find(ctx.userId);
          const fx = await repos.userSettings.fxSettings(ctx.userId);
          return {
            hidden: new Set(
              (settings?.dashboardBlocks ?? []).filter((b) => !b.visible).map((b) => b.key),
            ),
            base: fx?.baseCurrency ?? FALLBACK_BASE,
          };
        },
        { userLock: ctx.userId, readOnly: true },
      );
      const view: DashboardView = { range, cards };

      const showCategories = !hidden.has('byCategory');
      const showPace = !hidden.has('pace');
      if (showCategories || showPace) {
        const window = comparisonWindow(month, today);
        const previousMonth = addMonths(monthRange(month).from, -1).slice(0, 7);
        const previousFull = monthRange(previousMonth);
        const rows = await deps.expenses.expenses(ctx.userId, base, {
          from: previousFull.from,
          to: window.current.to,
        });
        if (showCategories) {
          view.byCategory = byCategoryOf(rows.filter((row) => row.date.startsWith(month)));
        }
        if (showPace) {
          view.pace = {
            current: cumulativeOf(rows, month, Number(window.current.to.slice(8, 10))),
            previous: cumulativeOf(rows, previousMonth, Number(previousFull.to.slice(8, 10))),
          };
        }
      }

      if (!hidden.has('balances')) {
        const [accounts, summary] = await Promise.all([
          deps.accounts.list(ctx, 'active'),
          deps.accounts.summary(ctx),
        ]);
        view.balances = {
          netWorth: { base: summary.netWorth.base ?? '0.00', other: summary.netWorth.other },
          top: accounts.slice(0, TOP_ACCOUNTS),
          asOfToday: true,
        };
      }

      if (!hidden.has('recent')) {
        const page = await deps.transactions.list(ctx, {
          from: `${range.firstMonth}-01`,
          to: today,
          limit: RECENT_MOVEMENTS,
        });
        view.recent = page.items.slice(0, RECENT_MOVEMENTS);
      }
      return view;
    },
  };
}

export function createDashboardService(deps: DashboardServiceDeps): DashboardService {
  return {
    async cards(ctx, month) {
      const today = todayFor(ctx.timezone, ctx.now);
      const window = comparisonWindow(month, today);
      const currentMonth = today.slice(0, 7);

      const { totals, first } = await deps.uow.run(
        async (repos) => {
          const settings = await repos.userSettings.fxSettings(ctx.userId);
          const base = settings?.baseCurrency ?? FALLBACK_BASE;
          return {
            totals: await repos.dashboard.totals(window.current, window.previous, base),
            first: await repos.dashboard.firstMonth(),
          };
        },
        { userLock: ctx.userId, readOnly: true },
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
    },
  };
}
