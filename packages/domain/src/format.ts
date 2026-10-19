import type { Decimal } from 'decimal.js';
import { parseMoney, toMoneyString } from './money.js';

export type NumberFormat = 'dot_comma' | 'comma_dot';

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
