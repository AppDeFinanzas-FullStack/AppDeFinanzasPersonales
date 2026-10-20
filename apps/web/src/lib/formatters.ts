import type { SettingsDto } from '@finanzas/contracts';
import { formatDate, formatMoney, parseMoney, relativeDay } from '@finanzas/domain';

export interface Formatters {
  /** Amount as decimal text and the currency symbol, e.g. "Bs 1.234,56" (RF-M9-02). */
  money: (amount: string, symbol: string) => string;
  /** Calendar day 'YYYY-MM-DD' in the chosen date format (RF-M9-03). */
  date: (date: string) => string;
  /** "Hoy", "Ayer", "Lun 13" or the formatted date (RF-M9-03). */
  relativeDay: (date: string, today: string) => string;
}

type FormatSettings = Pick<SettingsDto, 'numberFormat' | 'dateFormat' | 'weekStart'>;

// Pure: the same settings always give the same formatters (plan §4.9.1).
export function buildFormatters(settings: FormatSettings): Formatters {
  const { numberFormat, dateFormat, weekStart } = settings;
  return {
    money: (amount, symbol) => formatMoney(parseMoney(amount), symbol, numberFormat),
    date: (date) => formatDate(date, dateFormat),
    relativeDay: (date, today) => relativeDay(date, today, weekStart, dateFormat),
  };
}
