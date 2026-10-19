import type { Decimal } from 'decimal.js';
import { daysBetween } from './dates.js';
import type { LocalDate } from './dates.js';
import { parseMoney, toMoneyString } from './money.js';

export type NumberFormat = 'dot_comma' | 'comma_dot';

export type DateFormat = 'dmy' | 'iso' | 'short_text';

export type WeekStart = 'monday' | 'sunday';

const TYPOGRAPHIC_MINUS = '\u2212';
const THOUSANDS_GROUP = /\B(?=(\d{3})+(?!\d))/g;
const AMOUNT_INPUT = /^(\d+)(?:[.,](\d{1,2}))?$/;

const SEPARATORS: Record<NumberFormat, { thousands: string; decimal: string }> = {
  dot_comma: { thousands: '.', decimal: ',' },
  comma_dot: { thousands: ',', decimal: '.' },
};

/** Formats an amount as "Bs 1.234,56" or "Bs 1,234.56" (RF-M9-02); negatives use U+2212. */
export function formatMoney(amount: Decimal, symbol: string, numberFormat: NumberFormat): string {
  const text = toMoneyString(amount);
  const negative = text.startsWith('-');
  const [integerPart = '0', fractionPart = '00'] = (negative ? text.slice(1) : text).split('.');
  const { thousands, decimal } = SEPARATORS[numberFormat];
  const grouped = integerPart.replace(THOUSANDS_GROUP, thousands);
  return `${symbol} ${negative ? TYPOGRAPHIC_MINUS : ''}${grouped}${decimal}${fractionPart}`;
}

/**
 * Parses what the user typed as an amount (RF-M7-02): digits only, with an optional
 * final "." or "," followed by 1 or 2 digits as the decimal part. No thousands
 * separators nor operations; anything else gives null.
 */
export function parseAmountInput(raw: string): Decimal | null {
  const match = AMOUNT_INPUT.exec(raw);
  if (match === null) {
    return null;
  }
  const [, integerPart, fractionPart] = match;
  return parseMoney(fractionPart === undefined ? `${integerPart}` : `${integerPart}.${fractionPart}`);
}

/** Abbreviated day names, indexed by day of week (0 = Sunday). */
const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'] as const;

export type WeekDay = (typeof DAY_LABELS)[number];

const MONTH_LABELS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

const TODAY_LABEL = 'Hoy';
const YESTERDAY_LABEL = 'Ayer';
/** A known Sunday, used as the origin to compute the day of week. */
const REFERENCE_SUNDAY: LocalDate = '1970-01-04';
const DAYS_PER_WEEK = 7;
const WEEK_START_INDEX: Record<WeekStart, number> = { sunday: 0, monday: 1 };

/** Throws RangeError when the text is not a valid calendar day 'YYYY-MM-DD'. */
function assertLocalDate(date: LocalDate): void {
  daysBetween(date, date);
}

/** Day of week of a calendar day (0 = Sunday); validates the date. */
function dayOfWeek(date: LocalDate): number {
  const offset = daysBetween(REFERENCE_SUNDAY, date) % DAYS_PER_WEEK;
  return offset < 0 ? offset + DAYS_PER_WEEK : offset;
}

/** Formats a calendar day as "15/10/2026", "2026-10-15" or "15 oct 2026" (RF-M9-03). */
export function formatDate(date: LocalDate, dateFormat: DateFormat): string {
  assertLocalDate(date);
  const [year = '', month = '', day = ''] = date.split('-');
  if (dateFormat === 'iso') {
    return date;
  }
  if (dateFormat === 'dmy') {
    return `${day}/${month}/${year}`;
  }
  return `${Number(day)} ${MONTH_LABELS[Number(month) - 1] ?? ''} ${year}`;
}

/**
 * Relative label for list rows (RF-M9-03): "Hoy", "Ayer", or the abbreviated day and
 * its number ("Lun 13") inside the week of `today` that starts on `weekStart`
 * (RF-M9-04); outside that week, the date in the chosen format.
 */
export function relativeDay(
  date: LocalDate,
  today: LocalDate,
  weekStart: WeekStart,
  dateFormat: DateFormat = 'dmy',
): string {
  const offset = daysBetween(today, date);
  if (offset === 0) {
    return TODAY_LABEL;
  }
  if (offset === -1) {
    return YESTERDAY_LABEL;
  }
  const todayIndex = (dayOfWeek(today) - WEEK_START_INDEX[weekStart] + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  const weekOffset = todayIndex + offset;
  if (weekOffset < 0 || weekOffset >= DAYS_PER_WEEK) {
    return formatDate(date, dateFormat);
  }
  return `${DAY_LABELS[dayOfWeek(date)] ?? ''} ${Number(date.slice(8, 10))}`;
}

/** Abbreviated day names in calendar order, starting on `weekStart` (RF-M9-04). */
export function weekDays(weekStart: WeekStart): WeekDay[] {
  const start = WEEK_START_INDEX[weekStart];
  return [...DAY_LABELS.slice(start), ...DAY_LABELS.slice(0, start)];
}
