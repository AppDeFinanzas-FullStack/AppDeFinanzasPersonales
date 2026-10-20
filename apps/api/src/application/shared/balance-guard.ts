import { Decimal } from 'decimal.js';

import { AppError } from '../errors.js';
import type { AccountType, Repositories } from '../ports/repositories.js';

/** A signed change to the balance of an account: negative takes money out (plan §4.0). */
export interface BalanceDelta {
  accountId: string;
  amount: Decimal;
}

export type BalanceGuardMode = 'interactive' | 'automatic' | 'batch';

export interface BalanceGuardOptions {
  mode: BalanceGuardMode;
}

/** What the guard tells a `batch` caller when the change must not be applied. */
export type BalanceGuardOutcome = 'skip' | undefined;

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

  for (const account of accounts) {
    if (!NON_NEGATIVE_TYPES.has(account.type)) {
      continue;
    }
    const current = balances.get(account.id) ?? account.initialBalance;
    const resulting = current.plus(totals.get(account.id) ?? new Decimal(0));
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
  return undefined;
}

export const BalanceGuard = { apply };
