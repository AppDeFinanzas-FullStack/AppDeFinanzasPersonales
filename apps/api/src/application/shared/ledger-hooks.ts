import type { LocalDate } from '../ports/clock.js';
import type { Repositories } from '../ports/repositories.js';

/** What a ledger change touched, for the modules that react to it (plan §4.0). */
export interface LedgerChange {
  dates: LocalDate[];
  categoryIds: string[];
  accountIds: string[];
}

/** Runs inside the transaction of the change; if it throws, the whole change is rolled back. */
export type LedgerChangeHandler = (
  tx: Repositories,
  userId: string,
  change: LedgerChange,
) => Promise<void>;

export interface LedgerHooks {
  register(handler: LedgerChangeHandler): void;
  afterChange(tx: Repositories, userId: string, change: LedgerChange): Promise<void>;
}

export function createLedgerHooks(): LedgerHooks {
  const handlers: LedgerChangeHandler[] = [];
  return {
    register(handler) {
      handlers.push(handler);
    },
    async afterChange(tx, userId, change) {
      for (const handler of handlers) {
        await handler(tx, userId, change);
      }
    },
  };
}
