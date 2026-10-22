import type { RuleResult } from './balance.js';
import { addMonths, daysBetween } from './dates.js';
import type { LocalDate } from './dates.js';
import { formatDate } from './format.js';
import type { DateFormat } from './format.js';
import { isGreaterThan, isGreaterThanOrEqual, isLessThan, moneyEquals, parseMoney, round2, sumRounded, toMoneyString } from './money.js';

/** Inclusive budget period, as calendar days 'YYYY-MM-DD' (plan §4.11.1). */
export interface BudgetPeriod {
  start: LocalDate;
  end: LocalDate;
}

const MIN_START_DAY = 1;
const MAX_START_DAY = 28;

function assertStartDay(startDay: number): void {
  if (!Number.isInteger(startDay) || startDay < MIN_START_DAY || startDay > MAX_START_DAY) {
    throw new RangeError('Invalid budget start day');
  }
}

function addDays(date: LocalDate, days: number): LocalDate {
  daysBetween(date, date);
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day + days);
  return utc.toISOString().slice(0, 10);
}

function withDay(date: LocalDate, day: number): LocalDate {
  return `${date.slice(0, 8)}${String(day).padStart(2, '0')}`;
}

/** First day >= `from` that falls on `day` (day is 1–28, so it exists in every month). */
function nextOnDay(from: LocalDate, day: number): LocalDate {
  const sameMonth = withDay(from, day);
  return daysBetween(from, sameMonth) >= 0 ? sameMonth : addMonths(sameMonth, 1);
}

/** Monthly period that starts on `startDay` and contains `date` (RF-M11-04). */
function regularPeriod(startDay: number, date: LocalDate): BudgetPeriod {
  const sameMonth = withDay(date, startDay);
  const start = daysBetween(sameMonth, date) >= 0 ? sameMonth : addMonths(sameMonth, -1);
  return { start, end: addDays(addMonths(start, 1), -1) };
}

/** Stretches a period until the day before the new start day (RF-M11-07). */
function stretched(period: BudgetPeriod, nextStartDay: number): BudgetPeriod {
  return { start: period.start, end: addDays(nextOnDay(addDays(period.end, 1), nextStartDay), -1) };
}

/**
 * Period that contains `date` for a budget that starts on `startDay` (RF-M11-04).
 * With a pending `nextStartDay`, the current period stretches until the day before
 * the new start day; a date in that stretch belongs to the stretched period (RF-M11-07).
 */
export function periodFor(startDay: number, nextStartDay: number | null, date: LocalDate): BudgetPeriod {
  assertStartDay(startDay);
  const regular = regularPeriod(startDay, date);
  if (nextStartDay === null) return regular;
  assertStartDay(nextStartDay);
  const previous = stretched(regularPeriod(startDay, addDays(regular.start, -1)), nextStartDay);
  if (daysBetween(date, previous.end) >= 0) return previous;
  return stretched(regular, nextStartDay);
}

/** Period that follows `period`, starting on `startDay` (RF-M11-07). */
export function nextPeriod(period: BudgetPeriod, startDay: number): BudgetPeriod {
  assertStartDay(startDay);
  return regularPeriod(startDay, addDays(period.end, 1));
}

/** Readable label of a period, e.g. "15/10/2026 – 14/11/2026". */
export function periodLabel(period: BudgetPeriod, dateFormat: DateFormat = 'dmy'): string {
  return `${formatDate(period.start, dateFormat)} – ${formatDate(period.end, dateFormat)}`;
}

/** Available money of a period: amount + carryover in + non-voided late adjustments (RF-M11-05). */
export function available(amount: string, carryoverIn: string, lateAdjustments: readonly string[]): string {
  return toMoneyString(sumRounded([parseMoney(amount), parseMoney(carryoverIn), ...lateAdjustments.map(parseMoney)]));
}

/** Surplus (positive) or deficit (negative) of a period: available − spent (RF-M11-08, RF-M11-14). */
export function result(availableAmount: string, spent: string): string {
  return toMoneyString(parseMoney(availableAmount).minus(parseMoney(spent)));
}

/** A surplus split into carry, goal and discard must add up exactly to the result (RF-M11-08). */
export function validateSplit(resultAmount: string, carry: string, toGoal: string | null, discard: string): RuleResult {
  const parts = [parseMoney(carry), parseMoney(discard)];
  if (toGoal !== null) parts.push(parseMoney(toGoal));
  if (!moneyEquals(sumRounded(parts), parseMoney(resultAmount))) {
    return { ok: false, reason: 'SPLIT_MISMATCH' };
  }
  return { ok: true };
}

const PERCENT = 100;

/**
 * Thresholds (percent of the period amount, not of the available) to notify now (RF-M11-13).
 * Each one notifies once per period (RN-10); when a budget is created or a period starts
 * already above several thresholds, only the highest crossed one is notified.
 */
export function thresholdsCrossed(
  spent: string,
  amount: string,
  thresholds: readonly number[],
  alreadyHit: readonly number[],
  isPeriodStart: boolean,
): number[] {
  const base = parseMoney(amount);
  if (!isGreaterThan(base, parseMoney('0'))) return [];
  const spentPercent = parseMoney(spent).times(PERCENT);
  const crossed = [...thresholds]
    .sort((a, b) => a - b)
    .filter((threshold) => isGreaterThanOrEqual(spentPercent, base.times(threshold)));
  if (isPeriodStart) {
    const highest = crossed[crossed.length - 1];
    return highest === undefined || alreadyHit.includes(highest) ? [] : [highest];
  }
  return crossed.filter((threshold) => !alreadyHit.includes(threshold));
}

/** Amount that should have been spent by the end of `today` at an even pace (plan §4.11.1). */
export function todayShouldBe(availableAmount: string, period: BudgetPeriod, today: LocalDate): string {
  const totalDays = daysBetween(period.start, period.end) + 1;
  const elapsed = Math.min(Math.max(daysBetween(period.start, today) + 1, 0), totalDays);
  const base = parseMoney(availableAmount);
  if (!isGreaterThan(base, parseMoney('0'))) return toMoneyString(parseMoney('0'));
  return toMoneyString(round2(base.times(elapsed).div(totalDays)));
}

export interface BudgetPace {
  kind: 'daily' | 'over' | 'exceeded';
  amount: string;
  days?: number;
}

/**
 * Pace of the current period (plan §4.11.1): exceeded when the result is negative or nothing
 * is available, over when spending is ahead of the even pace, otherwise the daily allowance.
 */
export function pace(availableAmount: string, spent: string, period: BudgetPeriod, today: LocalDate): BudgetPace {
  const zero = parseMoney('0');
  const left = parseMoney(result(availableAmount, spent));
  if (isLessThan(left, zero) || !isGreaterThan(parseMoney(availableAmount), zero)) {
    return { kind: 'exceeded', amount: toMoneyString(isLessThan(left, zero) ? left.negated() : zero) };
  }
  const ideal = parseMoney(todayShouldBe(availableAmount, period, today));
  const spentAmount = parseMoney(spent);
  if (isGreaterThan(spentAmount, ideal)) {
    return { kind: 'over', amount: toMoneyString(spentAmount.minus(ideal)) };
  }
  const days = Math.max(daysBetween(today, period.end) + 1, 1);
  return { kind: 'daily', amount: toMoneyString(round2(left.div(days))), days };
}

/** Readable pace text: "Puedes gastar X/día durante N días", "Vas X por encima del ritmo" or "Superado por X". */
export function paceText(availableAmount: string, spent: string, period: BudgetPeriod, today: LocalDate): string {
  const current = pace(availableAmount, spent, period, today);
  if (current.kind === 'exceeded') return `Superado por ${current.amount}`;
  if (current.kind === 'over') return `Vas ${current.amount} por encima del ritmo`;
  const days = current.days ?? 1;
  return `Puedes gastar ${current.amount}/día durante ${days} ${days === 1 ? 'día' : 'días'}`;
}
