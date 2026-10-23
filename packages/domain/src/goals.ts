import { Decimal } from 'decimal.js';
import { parseMoney, round2, toMoneyString } from './money.js';

export interface GoalMoney {
  amount: string;
  currencyCode: string;
}

export interface GoalRates {
  goalCurrency: string;
  /** Bs per unit of each currency (BOB = 1). */
  bobPerUnit: Record<string, Decimal>;
}

export type GoalStatus = 'in_progress' | 'achieved' | 'overdue';

export interface GoalStatusInput {
  target: string;
  currencyCode: string;
  targetDate?: string | undefined;
}

export interface SuggestedMonthly {
  kind: 'monthly' | 'this_month' | 'calculator' | 'pick_new_date' | 'none';
  amount?: string;
  untilMonth?: string;
}

export interface EarmarkSource {
  goalId: string;
  targetDate?: string | undefined;
  amount: string;
}

export interface EarmarkTake {
  goalId: string;
  amount: string;
}

function rateOf(rates: GoalRates, code: string): Decimal {
  const rate = rates.bobPerUnit[code];
  if (!rate) throw new Error(`Missing rate for ${code}`);
  return rate;
}

function toGoalCurrency(money: GoalMoney, rates: GoalRates): Decimal {
  const amount = parseMoney(money.amount);
  if (money.currencyCode === rates.goalCurrency) return amount;
  return amount.times(rateOf(rates, money.currencyCode)).div(rateOf(rates, rates.goalCurrency));
}

export function progress(dedicated: GoalMoney | null, earmarks: GoalMoney[], rates: GoalRates): string {
  let total = new Decimal(0);
  if (dedicated) {
    const converted = toGoalCurrency(dedicated, rates);
    if (converted.greaterThan(0)) total = total.plus(converted);
  }
  for (const earmark of earmarks) total = total.plus(toGoalCurrency(earmark, rates));
  return toMoneyString(round2(total));
}

export function status(goal: GoalStatusInput, progressText: string, today: string): GoalStatus {
  if (parseMoney(progressText).greaterThanOrEqualTo(parseMoney(goal.target))) return 'achieved';
  if (goal.targetDate && goal.targetDate < today) return 'overdue';
  return 'in_progress';
}

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

export function suggestedMonthly(
  target: string,
  progressText: string,
  targetDate: string | undefined,
  today: string,
): SuggestedMonthly {
  const missing = parseMoney(target).minus(parseMoney(progressText));
  if (missing.lessThanOrEqualTo(0)) return { kind: 'none' };
  if (!targetDate) return { kind: 'calculator' };
  if (targetDate < today) return { kind: 'pick_new_date' };
  const months = monthIndex(targetDate) - monthIndex(today) + 1;
  if (months <= 1) return { kind: 'this_month', amount: toMoneyString(round2(missing)) };
  return { kind: 'monthly', amount: toMoneyString(round2(missing.div(months))) };
}

export function earmarkProposal(shortfall: string, earmarksByGoal: EarmarkSource[]): EarmarkTake[] {
  const sorted = [...earmarksByGoal].sort((a, b) => {
    if (!a.targetDate && !b.targetDate) return 0;
    if (!a.targetDate) return -1;
    if (!b.targetDate) return 1;
    return a.targetDate < b.targetDate ? 1 : a.targetDate > b.targetDate ? -1 : 0;
  });
  let remaining = parseMoney(shortfall);
  const result: EarmarkTake[] = [];
  for (const item of sorted) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const available = parseMoney(item.amount);
    if (available.lessThanOrEqualTo(0)) continue;
    const take = Decimal.min(available, remaining);
    result.push({ goalId: item.goalId, amount: toMoneyString(round2(take)) });
    remaining = remaining.minus(take);
  }
  return result;
}
