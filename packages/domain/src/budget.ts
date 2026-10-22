import { addMonths, daysBetween } from './dates.js';
import type { LocalDate } from './dates.js';
import { formatDate } from './format.js';
import type { DateFormat } from './format.js';

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
