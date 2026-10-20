import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { z } from 'zod';

import { i18n } from '@/app/providers/i18n';
import { call, type Endpoint } from '@/lib/api-client';
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
    mutationFn: (id: string) => call(deleteTransactionEndpoint(id), undefined),
    onMutate: async (id) => {
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
    onSuccess: ({ undoToken }) => {
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
