import { Decimal } from 'decimal.js';
import { addMonths, monthRange } from './dates.js';
import type { DateRange, LocalDate, YearMonth } from './dates.js';
import { parseMoney } from './money.js';

export interface ComparisonWindow {
  current: DateRange;
  previous: DateRange;
}

/**
 * Ranges compared on the dashboard (RF-M8-04, EC-M8-03): in the current month, the same
 * span of days of the previous month (up to its last day if shorter); in a closed month,
 * the whole previous month.
 */
export function comparisonWindow(month: YearMonth, today: LocalDate): ComparisonWindow {
  const full = monthRange(month);
  const previousFull = monthRange(addMonths(full.from, -1).slice(0, 7));
  if (today < full.from || today > full.to) {
    return { current: full, previous: previousFull };
  }
  const previousTo = addMonths(today, -1);
  return {
    current: { from: full.from, to: today },
    previous: { from: previousFull.from, to: previousTo < previousFull.to ? previousTo : previousFull.to },
  };
}

function roundHalfUpInt(value: Decimal): number {
  return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

/** Percentage change as an integer, half rounded up; null when the previous value is 0 (RF-M8-04). */
export function pctChange(current: string, previous: string): number | null {
  const prev = parseMoney(previous);
  if (prev.isZero()) return null;
  const change = parseMoney(current).minus(prev).div(prev).times(100);
  return roundHalfUpInt(change) + 0;
}

/** Savings rate in whole percent; null with no income or a negative balance (RF-M8-03). */
export function savingsRate(income: string, expense: string): number | null {
  const inc = parseMoney(income);
  if (!inc.isPositive() || inc.isZero()) return null;
  const balance = inc.minus(parseMoney(expense));
  if (balance.isNegative()) return null;
  return roundHalfUpInt(balance.div(inc).times(100)) + 0;
}

/** Savings rate variation in percentage points; null if either rate is missing (RF-M8-04). */
export function savingsRateDeltaPp(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}
