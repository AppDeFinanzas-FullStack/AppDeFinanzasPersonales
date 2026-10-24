import { Decimal } from 'decimal.js';
import { daysBetween } from './dates.js';
import type { LocalDate } from './dates.js';

/**
 * Decimal constructor for debt interest (ADR-03, ADR-14): high precision so the
 * daily rate stays exact and accrued interest never drifts (RNF-18).
 */
const InterestDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

/** Scale of `interest_unpaid NUMERIC(24,10)` (ADR-14). */
const INTEREST_SCALE = 10;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

export type InterestPeriod = 'monthly' | 'yearly';
export type DebtStatus = 'active' | 'overdue' | 'paid' | 'forgiven';

export interface PaymentSplit {
  interestPart: Decimal;
  capitalPart: Decimal;
}

export interface PaymentCheck {
  amount: Decimal;
  interestPart: Decimal;
  capitalPart: Decimal;
  interestAccrued: Decimal;
  capitalOutstanding: Decimal;
}

export type PaymentValidation =
  | { ok: true }
  | { ok: false; reason: 'SPLIT_INVALID' | 'PAYMENT_EXCEEDS_BALANCE' };

export interface DebtState {
  capitalOutstanding: Decimal;
  interestUnpaid: Decimal;
  dueDate?: LocalDate | null;
  forgiven: boolean;
}

/** Daily rate: rate ÷ 100 ÷ 30 (monthly) or ÷ 365 (yearly) (RF-M13-02). */
export function dailyRate(rate: Decimal, period: InterestPeriod): Decimal {
  const days = period === 'monthly' ? DAYS_PER_MONTH : DAYS_PER_YEAR;
  return new InterestDecimal(rate).div(100).div(days);
}

/**
 * Unpaid interest carried from `fromDate` to `toDate` with simple daily interest on the
 * outstanding capital, kept at 10 decimals (RF-M13-02, ADR-14, RNF-18). With capital 0
 * nothing more accrues (EC-M13-02).
 */
export function accrue(
  capital: Decimal,
  interestUnpaid: Decimal,
  rate: Decimal,
  fromDate: LocalDate,
  toDate: LocalDate,
): Decimal {
  const unpaid = new InterestDecimal(interestUnpaid);
  const days = daysBetween(fromDate, toDate);
  if (days <= 0 || new InterestDecimal(capital).lte(0)) {
    return unpaid.toDecimalPlaces(INTEREST_SCALE, Decimal.ROUND_HALF_UP);
  }
  const accrued = new InterestDecimal(capital).times(rate).times(days);
  return unpaid.plus(accrued).toDecimalPlaces(INTEREST_SCALE, Decimal.ROUND_HALF_UP);
}

/** Prefilled split of a payment: interest first, the rest to capital (RF-M13-05). */
export function proposeSplit(amount: Decimal, interestAccrued: Decimal, capital: Decimal): PaymentSplit {
  const total = new InterestDecimal(amount);
  const interestPart = Decimal.min(total, interestAccrued);
  const capitalPart = Decimal.min(total.minus(interestPart), capital);
  return { interestPart: new InterestDecimal(interestPart), capitalPart: new InterestDecimal(capitalPart) };
}

/**
 * Payment rules (RF-M13-05, RF-M13-06, EC-M13-01): the amount cannot exceed the pending
 * balance; interest ≤ accrued, capital ≤ outstanding and both parts add up to the amount.
 */
export function validatePayment(input: PaymentCheck): PaymentValidation {
  const pending = new InterestDecimal(input.capitalOutstanding).plus(input.interestAccrued);
  if (new InterestDecimal(input.amount).gt(pending)) {
    return { ok: false, reason: 'PAYMENT_EXCEEDS_BALANCE' };
  }
  const splitValid =
    new InterestDecimal(input.interestPart).gte(0) &&
    new InterestDecimal(input.capitalPart).gte(0) &&
    new InterestDecimal(input.interestPart).lte(input.interestAccrued) &&
    new InterestDecimal(input.capitalPart).lte(input.capitalOutstanding) &&
    new InterestDecimal(input.interestPart).plus(input.capitalPart).eq(input.amount);
  return splitValid ? { ok: true } : { ok: false, reason: 'SPLIT_INVALID' };
}

/**
 * Debt status (spec §2.13.2): forgiven when its balance was forgiven, paid when capital
 * and interest are 0, overdue once the due date has passed with a pending balance.
 */
export function deriveStatus(debt: DebtState, today: LocalDate): DebtStatus {
  if (debt.forgiven) return 'forgiven';
  if (new InterestDecimal(debt.capitalOutstanding).lte(0) && new InterestDecimal(debt.interestUnpaid).lte(0)) {
    return 'paid';
  }
  if (debt.dueDate != null && today > debt.dueDate) return 'overdue';
  return 'active';
}
