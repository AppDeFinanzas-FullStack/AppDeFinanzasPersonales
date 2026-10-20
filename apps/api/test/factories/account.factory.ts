import { uuidv7 } from 'uuidv7';

import { testPrisma } from '../integration/setup/db.js';

export type TestAccountType = 'cash' | 'bank' | 'ewallet' | 'credit_card' | 'savings' | 'other';
export type TestAccountStatus = 'active' | 'archived';

export interface TestAccount {
  id: string;
  userId: string;
  type: TestAccountType;
  name: string;
  currencyCode: string;
  /** Decimal text with two decimals. */
  initialBalance: string;
  /** `YYYY-MM-DD`. */
  initialBalanceDate: string;
  status: TestAccountStatus;
  sortOrder: number;
}

export interface CreateAccountOptions {
  id?: string;
  type?: TestAccountType;
  name?: string;
  currencyCode?: string;
  initialBalance?: string;
  initialBalanceDate?: string;
  color?: string;
  icon?: string;
  cardCutDay?: number | null;
  cardPayDay?: number | null;
  cardLimit?: string | null;
  status?: TestAccountStatus;
  sortOrder?: number;
}

let sequence = 0;

/** A name no other account of the same user has (the active names are unique, RF-M4-01). */
export function uniqueAccountName(prefix = 'Cuenta'): string {
  sequence += 1;
  return `${prefix} ${sequence} ${uuidv7().slice(-6)}`;
}

/**
 * Creates an account of the user straight in `account`, by SQL, so the tests of the code that reads
 * accounts never depend on the repository that writes them (plan §3.5). By default it is an active
 * bank account in BOB with a zero initial balance on 2090-01-01. An archived account gets its
 * `archived_at`. The account goes away with its user (`deleteCreatedUsers`).
 */
export async function createAccount(
  userId: string,
  options: CreateAccountOptions = {},
): Promise<TestAccount> {
  sequence += 1;
  const account: TestAccount = {
    id: options.id ?? uuidv7(),
    userId,
    type: options.type ?? 'bank',
    name: options.name ?? uniqueAccountName(),
    currencyCode: options.currencyCode ?? 'BOB',
    initialBalance: options.initialBalance ?? '0.00',
    initialBalanceDate: options.initialBalanceDate ?? '2090-01-01',
    status: options.status ?? 'active',
    sortOrder: options.sortOrder ?? sequence,
  };
  const isCard = account.type === 'credit_card';
  const cardCutDay = options.cardCutDay ?? (isCard ? 5 : null);
  const cardPayDay = options.cardPayDay ?? (isCard ? 20 : null);
  const cardLimit = options.cardLimit ?? (isCard ? '5000.00' : null);

  await testPrisma().$executeRaw`
    INSERT INTO account (id, user_id, type, name, currency_code, initial_balance, initial_balance_date,
                         color, icon, card_cut_day, card_pay_day, card_limit, status, archived_at,
                         sort_order)
    VALUES (${account.id}::uuid, ${userId}::uuid, ${account.type}::account_type, ${account.name},
            ${account.currencyCode}, ${account.initialBalance}::numeric, ${account.initialBalanceDate}::date,
            ${options.color ?? 'blue'}, ${options.icon ?? 'bank'}, ${cardCutDay}::smallint,
            ${cardPayDay}::smallint, ${cardLimit}::numeric, ${account.status}::lifecycle_status,
            ${account.status === 'archived' ? new Date() : null}::timestamptz, ${account.sortOrder})`;

  return account;
}
