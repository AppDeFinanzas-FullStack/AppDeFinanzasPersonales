import { earmarkProposal } from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type { AccountType, Repositories } from '../ports/repositories.js';

/** A signed change to the balance of an account: negative takes money out (plan §4.0). */
export interface BalanceDelta {
  accountId: string;
  amount: Decimal;
}

export type BalanceGuardMode = 'interactive' | 'automatic' | 'batch';

/** Money taken out of a goal's earmark on an account to cover a spend (RF-M12-05). */
export interface EarmarkWithdrawal {
  goalId: string;
  accountId: string;
  amount: Decimal;
}

export interface BalanceGuardOptions {
  mode: BalanceGuardMode;
  earmarkWithdrawals?: EarmarkWithdrawal[];
}

/** An `automatic` change that touches earmarked money: the caller leaves it pending (EC-M12-05). */
export interface AutoBlocked {
  kind: 'AutoBlocked';
  accountId: string;
}

/** What the guard tells a `batch` caller when the change must not be applied. */
export type BalanceGuardOutcome = 'skip' | AutoBlocked | undefined;

/** Accounts whose current balance can never go below zero (RF-M4-04, EC-M4-06). */
const NON_NEGATIVE_TYPES: ReadonlySet<AccountType> = new Set<AccountType>(['cash', 'ewallet']);

/** The deltas added up per account, so the amount and the fee of a transfer count together. */
function totalsByAccount(deltas: BalanceDelta[]): Map<string, Decimal> {
  const totals = new Map<string, Decimal>();
  for (const { accountId, amount } of deltas) {
    totals.set(accountId, (totals.get(accountId) ?? new Decimal(0)).plus(amount));
  }
  return totals;
}

/**
 * Checks the deltas against the current balance of each account, locked with `FOR UPDATE` in id
 * order until the transaction ends (RNF-10). Only the current total balance is checked, never the
 * balance of past days (RF-M4-04). A cash or e-wallet account left below zero rejects the change
 * with `NEGATIVE_BALANCE`, or returns `'skip'` in `batch` mode.
 */
async function apply(
  repos: Repositories,
  userId: string,
  deltas: BalanceDelta[],
  opts: BalanceGuardOptions,
): Promise<BalanceGuardOutcome> {
  const totals = totalsByAccount(deltas);
  const ids = [...totals.keys()];
  if (ids.length === 0) {
    return undefined;
  }

  const accounts = await repos.accounts.lockForUpdate(ids);
  if (accounts.length !== ids.length) {
    throw new AppError('NOT_FOUND');
  }
  const balances = await repos.ledger.balances(ids);
  const resultings = new Map<string, Decimal>();

  for (const account of accounts) {
    const current = balances.get(account.id) ?? account.initialBalance;
    const resulting = current.plus(totals.get(account.id) ?? new Decimal(0));
    resultings.set(account.id, resulting);
    if (!NON_NEGATIVE_TYPES.has(account.type)) {
      continue;
    }
    if (resulting.lessThan(0)) {
      if (opts.mode === 'batch') {
        return 'skip';
      }
      throw new AppError('NEGATIVE_BALANCE', {
        accountId: account.id,
        resultingBalance: resulting.toFixed(2, Decimal.ROUND_HALF_UP),
      });
    }
  }

  return protectEarmarks(repos, totals, resultings, opts);
}

/**
 * Earmarks (V1.1): a change that leaves a non-dedicated account below what is earmarked on it asks
 * for confirmation, unless the withdrawals cover the shortfall; then they are saved as
 * `confirmed_spend` events in the same transaction (RF-M12-05, EC-M12-07).
 */
async function protectEarmarks(
  repos: Repositories,
  totals: Map<string, Decimal>,
  resultings: Map<string, Decimal>,
  opts: BalanceGuardOptions,
): Promise<BalanceGuardOutcome> {
  // Units of work wired before the goals existed have no allocations: nothing is earmarked there.
  const allocations: Repositories['goalAllocations'] | undefined = repos.goalAllocations;
  if (!allocations) {
    return undefined;
  }
  const pending: { goalId: string; accountId: string; amount: Decimal }[] = [];
  for (const [accountId, resulting] of [...resultings].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if ((totals.get(accountId) ?? new Decimal(0)).greaterThanOrEqualTo(0)) {
      continue;
    }
    const earmarks = (await allocations.earmarkedByAccount(accountId)).filter((e) =>
      e.amount.greaterThan(0),
    );
    const total = earmarks.reduce((sum, e) => sum.plus(e.amount), new Decimal(0));
    const shortfall = total.minus(resulting);
    if (earmarks.length === 0 || shortfall.lessThanOrEqualTo(0)) {
      continue;
    }

    const sources = [];
    let dedicated = false;
    for (const earmark of earmarks) {
      const goal = await repos.goals.get(earmark.goalId);
      if (goal?.dedicatedAccountId === accountId) {
        dedicated = true;
        break;
      }
      sources.push({
        goalId: earmark.goalId,
        ...(goal?.targetDate ? { targetDate: goal.targetDate } : {}),
        amount: earmark.amount.toFixed(2, Decimal.ROUND_HALF_UP),
      });
    }
    if (dedicated) {
      continue;
    }

    if (opts.mode === 'batch') {
      return 'skip';
    }
    if (opts.mode === 'automatic') {
      return { kind: 'AutoBlocked', accountId };
    }

    const withdrawals = (opts.earmarkWithdrawals ?? []).filter((w) => w.accountId === accountId);
    const covered = withdrawals.reduce((sum, w) => sum.plus(w.amount), new Decimal(0));
    const withinEarmarks = withdrawals.every((w) =>
      earmarks.some((e) => e.goalId === w.goalId && e.amount.greaterThanOrEqualTo(w.amount)),
    );
    if (covered.lessThan(shortfall) || !withinEarmarks) {
      const shortfallText = shortfall.toFixed(2, Decimal.ROUND_HALF_UP);
      throw new AppError('EARMARK_CONFIRMATION_REQUIRED', {
        shortfall: shortfallText,
        proposal: earmarkProposal(shortfallText, sources),
      });
    }
    pending.push(...withdrawals);
  }

  for (const withdrawal of pending) {
    await allocations.insert({
      id: uuidv7(),
      goalId: withdrawal.goalId,
      accountId: withdrawal.accountId,
      amount: withdrawal.amount.negated(),
      origin: 'confirmed_spend',
      relatedTransactionId: null,
    });
  }
  return undefined;
}

export const BalanceGuard = { apply };
