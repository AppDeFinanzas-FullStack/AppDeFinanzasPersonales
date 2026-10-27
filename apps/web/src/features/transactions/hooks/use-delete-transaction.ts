import { DeleteTransactionInput, type EarmarkWithdrawals } from '@finanzas/contracts';
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { z } from 'zod';

import { i18n } from '@/app/providers/i18n';
import { call, createApiClient, type Endpoint } from '@/lib/api-client';
import { online } from '@/lib/online';
import { uiStore } from '@/lib/ui-store';

import type { TransactionPage } from '../api';

import { TRANSACTIONS_KEY } from './use-transactions';

const DeleteResult = z.object({ undoToken: z.string() });

const deleteTransactionEndpoint = (
  id: string,
): Endpoint<undefined, z.infer<typeof DeleteResult>> => ({
  method: 'DELETE',
  path: `/api/transactions/${encodeURIComponent(id)}`,
  input: z.undefined(),
  output: DeleteResult,
});

/**
 * What a confirmed deletion sends: the goals to take from (RF-M12-05). The API reads them from the
 * body of the DELETE, but `api-client` sends the input of a DELETE as a query string. So the
 * endpoint is declared as `PUT` (which makes the client write a JSON body) and `callWithBody` swaps
 * the verb to `DELETE` just before the request leaves.
 */
const confirmedDeleteEndpoint = (
  id: string,
): Endpoint<DeleteTransactionInput, z.infer<typeof DeleteResult>> => ({
  method: 'PUT',
  path: `/api/transactions/${encodeURIComponent(id)}`,
  input: DeleteTransactionInput,
  output: DeleteResult,
});

const callWithBody = createApiClient({
  fetch: (input, init) => fetch(input, { ...init, method: 'DELETE' }),
  store: uiStore,
  online,
});

/** The id alone, or with the earmarks the user confirmed to take (RF-M12-05). */
export interface DeleteDetails {
  id: string;
  earmarkWithdrawals?: EarmarkWithdrawals | undefined;
  /** The account the deletion leaves short, kept so "Deshacer" can ask about it (RF-M12-05). */
  account?: { id: string; currencyCode: string } | undefined;
}
export type DeleteVariables = string | DeleteDetails;

/** The account behind each undo token, for the earmark confirmation of "Deshacer". */
const undoAccounts = new Map<string, { id: string; currencyCode: string }>();

/** The account of a deletion whose undo token is given, if it was known. */
export const undoAccountOf = (token: string) => undoAccounts.get(token);

/** Keeps the account behind an undo token, so its "Deshacer" can ask about earmarks (RF-M12-05). */
export const rememberUndoAccount = (
  token: string,
  account: { id: string; currencyCode: string },
) => {
  undoAccounts.set(token, account);
};

/** How long "Deshacer" stays on screen (plan §4.6.4). */
export const UNDO_MS = 10_000;

/** Every mutation of a movement refreshes these (plan §4.6.4). */
export const AFFECTED_KEYS = [TRANSACTIONS_KEY, ['accounts'], ['dashboard'], ['budgets']] as const;

const LIST_KEY = [...TRANSACTIONS_KEY, 'list'] as const;

type ListData = InfiniteData<TransactionPage, string | null>;

/**
 * Deletes a movement with its fee (plan §4.6.2). It is optimistic: the row leaves the loaded lists
 * at once and comes back if the API rejects it; then "Deshacer" shows for 10 s (plan §4.6.4).
 */
export function useDeleteTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: DeleteVariables) => {
      if (typeof variables === 'string')
        return call(deleteTransactionEndpoint(variables), undefined);
      const { id, earmarkWithdrawals } = variables;
      if (earmarkWithdrawals === undefined) return call(deleteTransactionEndpoint(id), undefined);
      return callWithBody(confirmedDeleteEndpoint(id), { earmarkWithdrawals });
    },
    onMutate: async (variables) => {
      const id = typeof variables === 'string' ? variables : variables.id;
      await queryClient.cancelQueries({ queryKey: LIST_KEY });
      const previous = queryClient.getQueriesData<ListData>({ queryKey: LIST_KEY });
      queryClient.setQueriesData<ListData>({ queryKey: LIST_KEY }, (data) =>
        data === undefined
          ? data
          : {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== id),
              })),
            },
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      for (const [queryKey, data] of context?.previous ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    onSuccess: ({ undoToken }, variables) => {
      if (typeof variables !== 'string' && variables.account !== undefined)
        rememberUndoAccount(undoToken, variables.account);
      uiStore.showUndo({
        token: undoToken,
        label: i18n.t('undo.deleted', { ns: 'transactions' }),
        expiresAt: Date.now() + UNDO_MS,
      });
    },
    // Not awaited, so the screen moves on while the balances refresh.
    onSettled: () => {
      for (const queryKey of AFFECTED_KEYS) void queryClient.invalidateQueries({ queryKey });
    },
  });
}
