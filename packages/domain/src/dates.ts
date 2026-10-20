import { tzOffset } from '@date-fns/tz';

/** Calendar day as ISO text 'YYYY-MM-DD', in the user's time zone (RN-07). */
export type LocalDate = string;

/** Month as ISO text 'YYYY-MM'. */
export type YearMonth = string;

/** A point in time, as returned by `Clock.now()`. */
export type Instant = Date;

/** Inclusive range of calendar days. */
export interface DateRange {
  from: LocalDate;
  to: LocalDate;
}

/** Time zone of the Bolivian calendar used for market rates (RF-M3-13). */
export const BOLIVIA_TIME_ZONE = 'America/La_Paz';

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/** Wider than any UTC offset in use (±14 h), so the local day start is always inside. */
const SEARCH_WINDOW_MS = 30 * 60 * MS_PER_MINUTE;

function parseLocalDate(date: LocalDate): [number, number, number] {
  const match = LOCAL_DATE.exec(date);
  if (!match) throw new RangeError('Invalid local date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError('Invalid local date');
  }
  return [year, month, day];
}

function parseYearMonth(yearMonth: YearMonth): [number, number] {
  const match = YEAR_MONTH.exec(yearMonth);
  if (!match) throw new RangeError('Invalid year-month');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new RangeError('Invalid year-month');
  return [year, month];
}

function toLocalDate(year: number, month: number, day: number): LocalDate {
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  return utc.toISOString().slice(0, 10);
}

/** Midnight UTC of a calendar day, as epoch milliseconds (time-zone free day arithmetic). */
function utcDayMs(date: LocalDate): number {
  const [year, month, day] = parseLocalDate(date);
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  return utc.getTime();
}

function daysInMonth(year: number, month: number): number {
  const utc = new Date(0);
  utc.setUTCFullYear(year, month, 0);
  return utc.getUTCDate();
}

/** Local calendar day of an instant in a time zone (RN-07, RNF-20). */
export function todayFor(timezone: string, now: Instant): LocalDate {
  const offsetMinutes = tzOffset(timezone, now);
  if (Number.isNaN(offsetMinutes)) throw new RangeError('Invalid time zone');
  return new Date(now.getTime() + offsetMinutes * MS_PER_MINUTE).toISOString().slice(0, 10);
}

/** True when the date is after today in the user's time zone (RN-07). */
export function isFutureFor(date: LocalDate, timezone: string, now: Instant): boolean {
  return utcDayMs(date) > utcDayMs(todayFor(timezone, now));
}

/** Calendar day of an instant in Bolivia, used for market rates (RF-M3-13). */
export function boliviaDay(instant: Instant): LocalDate {
  return todayFor(BOLIVIA_TIME_ZONE, instant);
}

/** First and last day of a month 'YYYY-MM'. */
export function monthRange(yearMonth: YearMonth): DateRange {
  const [year, month] = parseYearMonth(yearMonth);
  return { from: toLocalDate(year, month, 1), to: toLocalDate(year, month, daysInMonth(year, month)) };
}

/** Day that exists in the month: a missing day falls on the last day (RF-M14-02). */
export function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

/** Adds whole months; a missing day falls on the last day of the target month (RF-M14-02). */
export function addMonths(date: LocalDate, months: number): LocalDate {
  if (!Number.isInteger(months)) throw new RangeError('Invalid month count');
  const [year, month, day] = parseLocalDate(date);
  const monthIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex - targetYear * 12 + 1;
  return toLocalDate(targetYear, targetMonth, clampDay(targetYear, targetMonth, day));
}

/** Calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((utcDayMs(to) - utcDayMs(from)) / MS_PER_DAY);
}

/**
 * First instant of a local day in a time zone (RNF-20). On days whose
 * midnight is skipped by a daylight saving change, it is the first instant
 * that exists in that day.
 */
export function startOfDayInstant(date: LocalDate, timezone: string): Instant {
  const dayMs = utcDayMs(date);
  const isOnOrAfterDay = (ms: number): boolean => utcDayMs(todayFor(timezone, new Date(ms))) >= dayMs;
  let low = dayMs - SEARCH_WINDOW_MS;
  let high = dayMs + SEARCH_WINDOW_MS;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (isOnOrAfterDay(middle)) high = middle;
    else low = middle + 1;
  }
  return new Date(low);
}
