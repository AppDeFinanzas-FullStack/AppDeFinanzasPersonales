import type { LocalDate } from './dates.js';
import { isGreaterThan, isLessThan, parseMoney, toMoneyString } from './money.js';

export type AccountType = 'cash' | 'ewallet' | 'bank' | 'savings' | 'other' | 'credit_card';

export interface LedgerEntry {
  date: LocalDate;
  /** Signed decimal text: inflow positive, outflow negative. */
  amount: string;
}

export type RuleResult = { ok: true } | { ok: false; reason: string };

export interface CardView {
  label: string;
  availableCredit: string | null;
  overLimit: boolean;
}

export interface TypeChangeInput {
  from: AccountType;
  to: AccountType;
  initialBalance: string;
  currentBalance: string;
  dedicated: boolean;
  hasEarmarks: boolean;
}

const MAX_ABSOLUTE = '999999999.99';
const NON_NEGATIVE_TYPES: readonly AccountType[] = ['cash', 'ewallet'];
const DECIMAL_TEXT = /^-?\d+(\.\d{1,2})?$/;

/** Initial balance plus the entries dated on or after the initial date (RN-01, RN-12). */
export function balanceFrom(initial: string, initialDate: LocalDate, entries: readonly LedgerEntry[]): string {
  const total = entries
    .filter((entry) => entry.date >= initialDate)
    .reduce((sum, entry) => sum.plus(parseMoney(entry.amount)), parseMoney(initial));
  return toMoneyString(total);
}

/** Validates the initial balance for the account type (RF-M4-02). */
export function validateInitialBalance(type: AccountType, value: string): RuleResult {
  const text = value.trim();
  if (!DECIMAL_TEXT.test(text)) {
    return { ok: false, reason: 'INVALID_AMOUNT' };
  }
  const amount = parseMoney(text);
  if (isGreaterThan(amount.abs(), parseMoney(MAX_ABSOLUTE))) {
    return { ok: false, reason: 'AMOUNT_OUT_OF_RANGE' };
  }
  if (NON_NEGATIVE_TYPES.includes(type) && isLessThan(amount, parseMoney('0'))) {
    return { ok: false, reason: 'NEGATIVE_INITIAL_BALANCE' };
  }
  return { ok: true };
}

/** Card balance as "Debes X" / "A favor X", with available credit against the limit (RF-M4-08). */
export function cardView(balance: string, limit: string | null): CardView {
  const amount = parseMoney(balance);
  const negative = isLessThan(amount, parseMoney('0'));
  const label = negative ? `Debes ${toMoneyString(amount.abs())}` : `A favor ${toMoneyString(amount)}`;
  if (limit === null) {
    return { label, availableCredit: null, overLimit: false };
  }
  const debt = negative ? amount.abs() : parseMoney('0');
  const available = parseMoney(limit).minus(debt);
  return {
    label,
    availableCredit: toMoneyString(available),
    overLimit: isLessThan(available, parseMoney('0')),
  };
}

/** Decides whether an account may change type; the reason explains a rejection (RF-M4-07). */
export function validateTypeChange(input: TypeChangeInput): RuleResult {
  const { to, initialBalance, currentBalance, dedicated, hasEarmarks } = input;
  const initial = validateInitialBalance(to, initialBalance);
  if (!initial.ok) {
    return { ok: false, reason: 'INITIAL_BALANCE_INVALID_FOR_TYPE' };
  }
  if (NON_NEGATIVE_TYPES.includes(to) && isLessThan(parseMoney(currentBalance), parseMoney('0'))) {
    return { ok: false, reason: 'CURRENT_BALANCE_NEGATIVE' };
  }
  if (to === 'credit_card' && (dedicated || hasEarmarks)) {
    return { ok: false, reason: 'CARD_CANNOT_BE_DEDICATED_OR_EARMARKED' };
  }
  return { ok: true };
}
