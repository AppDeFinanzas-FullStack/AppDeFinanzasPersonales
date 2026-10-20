import { Decimal } from 'decimal.js';
import { convert } from './fx.js';
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

export interface NetWorthAccount {
  type: AccountType;
  currencyCode: string;
  balance: string;
}

export interface NetWorthRates {
  baseCurrency: string;
  otherCurrency: string;
  /** Bs per unit of each currency (BOB = 1), like `convert` in fx.ts. */
  bobPerUnit: Record<string, Decimal | null>;
}

export interface NetWorthResult {
  netWorth: { base: string | null; other: string | null };
  breakdown: {
    liquid: string | null;
    savings: string | null;
    cardDebt: string | null;
    earmarked: string | null;
  };
}

/** Sum of each balance converted and rounded per account into one currency; null if a rate is missing. */
function totalIn(accounts: readonly NetWorthAccount[], rates: NetWorthRates, target: string, pick: (a: NetWorthAccount) => boolean): string | null {
  const targetRate = rates.bobPerUnit[target];
  if (!targetRate) {
    return null;
  }
  let total = new Decimal(0);
  for (const account of accounts) {
    const rate = rates.bobPerUnit[account.currencyCode];
    if (!rate) {
      return null;
    }
    if (pick(account)) {
      total = total.plus(convert(parseMoney(account.balance), rate, targetRate));
    }
  }
  return toMoneyString(total);
}

/** Net worth in the base and the other currency, with the breakdown in the base (RF-M4-10, RN-05, RN-06). */
export function netWorth(accounts: readonly NetWorthAccount[], rates: NetWorthRates): NetWorthResult {
  const base = rates.baseCurrency;
  const group = (types: readonly AccountType[]) => totalIn(accounts, rates, base, (a) => types.includes(a.type));
  const hasBase = totalIn(accounts, rates, base, () => true);
  return {
    netWorth: { base: hasBase, other: totalIn(accounts, rates, rates.otherCurrency, () => true) },
    breakdown: {
      liquid: group(['cash', 'bank', 'ewallet', 'other']),
      savings: group(['savings']),
      cardDebt: group(['credit_card']),
      earmarked: hasBase === null ? null : '0.00',
    },
  };
}
