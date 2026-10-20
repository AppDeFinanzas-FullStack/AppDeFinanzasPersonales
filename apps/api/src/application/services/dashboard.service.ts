import type { DashboardDto } from '@finanzas/contracts';
import {
  comparisonWindow,
  parseMoney,
  pctChange,
  savingsRate,
  savingsRateDeltaPp,
  todayFor,
  toMoneyString,
  type YearMonth,
} from '@finanzas/domain';

import type { PeriodTotals } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

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
