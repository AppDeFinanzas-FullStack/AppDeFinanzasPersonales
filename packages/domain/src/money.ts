import { Decimal } from 'decimal.js';

/**
 * Decimal constructor used for money arithmetic (ADR-03, constitution §3).
 * High precision so sums never lose cents; half away from zero (RN-06).
 */
const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

const MONEY_SCALE = 2;
const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/** Rounds to 2 decimals with the half away from zero (RN-06): -0.005 -> -0.01. */
export function round2(value: Decimal): Decimal {
  return new MoneyDecimal(value).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

/** Parses decimal text such as "1234.56" into an exact Decimal. */
export function parseMoney(text: string): Decimal {
  const trimmed = text.trim();
  if (!DECIMAL_TEXT.test(trimmed)) {
    throw new RangeError('Invalid decimal text');
  }
  return new MoneyDecimal(trimmed);
}

/** Formats a value as plain decimal text with exactly 2 decimals ("1234.56"). */
export function toMoneyString(value: Decimal): string {
  const rounded = round2(value);
  return (rounded.isZero() ? rounded.abs() : rounded).toFixed(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

/** Total as the exact sum of already rounded values (RN-06, RNF-18). */
export function sumRounded(values: readonly Decimal[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.plus(value), new MoneyDecimal(0));
}

export function moneyEquals(a: Decimal, b: Decimal): boolean {
  return new MoneyDecimal(a).eq(b);
}

export function isLessThan(a: Decimal, b: Decimal): boolean {
  return new MoneyDecimal(a).lt(b);
}

export function isLessThanOrEqual(a: Decimal, b: Decimal): boolean {
  return new MoneyDecimal(a).lte(b);
}

export function isGreaterThan(a: Decimal, b: Decimal): boolean {
  return new MoneyDecimal(a).gt(b);
}

export function isGreaterThanOrEqual(a: Decimal, b: Decimal): boolean {
  return new MoneyDecimal(a).gte(b);
}
