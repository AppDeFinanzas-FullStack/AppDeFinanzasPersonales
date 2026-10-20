import { AccountDto, CurrencyDto, Money, ReorderInput } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

/** Without a rate needed to convert, the amounts that depend on it come as `null` (EC-M3-02). */
const AccountsSummary = z.object({
  netWorth: z.object({ base: Money.nullable(), other: Money.nullable() }),
  breakdown: z.object({
    liquid: Money.nullable(),
    savings: Money.nullable(),
    cardDebt: Money.nullable(),
    earmarked: Money.nullable(),
  }),
});
export type AccountsSummary = z.infer<typeof AccountsSummary>;

const AccountList = z.object({ items: z.array(AccountDto), summary: AccountsSummary });
export type AccountList = z.infer<typeof AccountList>;

const AccountListQuery = z.object({ status: z.enum(['active', 'archived']) });
export type AccountStatus = z.infer<typeof AccountListQuery>['status'];

export const listAccountsEndpoint: Endpoint<z.infer<typeof AccountListQuery>, AccountList> = {
  method: 'GET',
  path: '/api/accounts',
  input: AccountListQuery,
  output: AccountList,
};

export const reorderAccountsEndpoint: Endpoint<ReorderInput, void> = {
  method: 'PUT',
  path: '/api/accounts/order',
  input: ReorderInput,
  output: z.void(),
};

const CurrencyList = z.object({ items: z.array(CurrencyDto) });

/** The user's added currencies, for the symbol of an account in one of them. */
export const listCurrenciesEndpoint: Endpoint<undefined, z.infer<typeof CurrencyList>> = {
  method: 'GET',
  path: '/api/currencies',
  input: z.undefined(),
  output: CurrencyList,
};
