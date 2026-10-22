import type { Repositories } from '../ports/repositories.js';

/**
 * Tells whether the user still uses a currency in one module (accounts, goals, budgets, debts or
 * rules), inside the transaction that deactivates it (plan §4.3.3, EC-M3-05).
 */
export type CurrencyUsageCheck = (
  tx: Repositories,
  userId: string,
  code: string,
) => Promise<boolean>;

const checks = new Map<string, CurrencyUsageCheck>();

/**
 * Registry of the modules that use currencies (plan §4.0). Each module registers its check in its
 * own phase; deactivating a currency asks all of them.
 */
export const CurrencyUsage = {
  /** Registers the check of a module; registering the same module again replaces its check. */
  register(module: string, check: CurrencyUsageCheck): void {
    checks.set(module, check);
  },

  /** The modules that use the currency, in registration order; empty when none does. */
  async check(tx: Repositories, userId: string, code: string): Promise<string[]> {
    const usedBy: string[] = [];
    for (const [module, check] of checks) {
      if (await check(tx, userId, code)) {
        usedBy.push(module);
      }
    }
    return usedBy;
  },
};

// Goals (M12): a goal that is not archived uses its currency (EC-M3-05).
CurrencyUsage.register('goals', async (tx, _userId, code) => {
  // Units of work wired before the goals existed have no goal repository.
  const goals: Repositories['goals'] | undefined = tx.goals;
  if (!goals) {
    return false;
  }
  return (await goals.list()).some((goal) => goal.currencyCode === code);
});

// Accounts (M4): an active account in the currency uses it (plan §4.3.3).
CurrencyUsage.register('accounts', async (tx, _userId, code) =>
  (await tx.accounts.list('active')).some((account) => account.currencyCode === code),
);
