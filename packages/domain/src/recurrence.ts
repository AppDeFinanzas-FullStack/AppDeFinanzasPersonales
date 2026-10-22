import { addMonths, clampDay } from './dates.js';
import type { LocalDate } from './dates.js';

/** Daily, weekly (a single weekday, 0 = Sunday), monthly (fixed day) or yearly (RF-M14-01). */
export type RecurrenceFrequency =
  | { type: 'daily' }
  | { type: 'weekly'; weekday: number }
  | { type: 'monthly'; day: number }
  | { type: 'yearly'; month: number; day: number };

/** No end, until a date (inclusive) or after a number of generated occurrences. */
export type RecurrenceEnd =
  | { type: 'none' }
  | { type: 'until'; date: LocalDate }
  | { type: 'count'; count: number };

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  startDate: LocalDate;
  end: RecurrenceEnd;
}

/** "Cuota X de N" (RF-M14-13). */
export interface Installment {
  current: number;
  total: number;
}

const MS_PER_DAY = 86_400_000;

function utcDate(date: LocalDate): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  return utc;
}

function toLocalDate(year: number, month: number, day: number): LocalDate {
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  return utc.toISOString().slice(0, 10);
}

function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(utcDate(date).getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Day of the month of `frequency` in a given month; a missing day falls on the last day (RF-M14-02). */
function dayIn(year: number, month: number, day: number): LocalDate {
  return toLocalDate(year, month, clampDay(year, month, day));
}

/** First occurrence of the frequency on or after `date`. */
function firstOnOrAfter(frequency: RecurrenceFrequency, date: LocalDate): LocalDate {
  const start = utcDate(date);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + 1;
  switch (frequency.type) {
    case 'daily':
      return date;
    case 'weekly':
      return addDays(date, (frequency.weekday - start.getUTCDay() + 7) % 7);
    case 'monthly': {
      const candidate = dayIn(year, month, frequency.day);
      if (candidate >= date) return candidate;
      const next = utcDate(addMonths(toLocalDate(year, month, 1), 1));
      return dayIn(next.getUTCFullYear(), next.getUTCMonth() + 1, frequency.day);
    }
    case 'yearly': {
      const candidate = dayIn(year, frequency.month, frequency.day);
      if (candidate >= date) return candidate;
      return dayIn(year + 1, frequency.month, frequency.day);
    }
  }
}

/** Occurrences on or after `from` (never before the start), stopping at an end date. */
function* occurrencesFrom(rule: RecurrenceRule, from: LocalDate): Generator<LocalDate> {
  let date = firstOnOrAfter(rule.frequency, from > rule.startDate ? from : rule.startDate);
  while (rule.end.type !== 'until' || date <= rule.end.date) {
    yield date;
    date = firstOnOrAfter(rule.frequency, addDays(date, 1));
  }
}

/**
 * The next `n` occurrences on or after `fromDate` (RF-M14-01, RF-M14-02, EC-M14-01).
 * An end date is respected; an end by count depends on the generated count (see `isFinished`).
 */
export function nextDates(rule: RecurrenceRule, fromDate: LocalDate, n: number): LocalDate[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('Invalid occurrence count');
  const dates: LocalDate[] = [];
  if (n === 0) return dates;
  for (const date of occurrencesFrom(rule, fromDate)) {
    dates.push(date);
    if (dates.length === n) break;
  }
  return dates;
}

/**
 * Occurrences skipped while paused: after `pausedAt` and before `today`, with their original
 * date, up to the end date when it passed during the pause (RF-M14-09, EC-M14-06).
 */
export function skippedDates(rule: RecurrenceRule, pausedAt: LocalDate, today: LocalDate): LocalDate[] {
  const dates: LocalDate[] = [];
  for (const date of occurrencesFrom(rule, addDays(pausedAt, 1))) {
    if (date >= today) break;
    dates.push(date);
  }
  return dates;
}

/**
 * True when the rule is Finalizada: it reached N generated occurrences (registered, pending and
 * omitted) or its end date passed (RF-M14-09, EC-M14-05, EC-M14-06).
 */
export function isFinished(rule: RecurrenceRule, generatedCount: number, date: LocalDate): boolean {
  switch (rule.end.type) {
    case 'none':
      return false;
    case 'until':
      return date > rule.end.date;
    case 'count':
      return generatedCount >= rule.end.count;
  }
}

/** "Cuota X de N" of the next occurrence when the end is by count; null otherwise (RF-M14-13). */
export function installment(rule: RecurrenceRule, generatedCount: number): Installment | null {
  if (rule.end.type !== 'count') return null;
  const total = rule.end.count;
  return { current: Math.min(generatedCount + 1, total), total };
}
