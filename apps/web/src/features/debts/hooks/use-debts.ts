import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, call } from '@/lib/api-client';

import {
  deleteDebtEndpoint,
  deleteLastPaymentEndpoint,
  forgiveDebtEndpoint,
  listDebtsEndpoint,
  type DebtsView,
} from '../api';

export const DEBTS_KEY = ['debts'] as const;

// Plan §4.13.4: `['debts', view]`.
export function useDebts(view: DebtsView) {
  return useQuery({
    queryKey: [...DEBTS_KEY, view],
    queryFn: ({ signal }) => call(listDebtsEndpoint, { view }, { signal }),
  });
}

// Plan §4.13.4: `['debt', id]`. The API lists the debts; another user's debt is not in the list.
export function useDebt(id: string) {
  return useQuery({
    queryKey: ['debt', id],
    queryFn: async ({ signal }) => {
      const { debts } = await call(listDebtsEndpoint, { view: 'debt' }, { signal });
      const debt = debts.find((item) => item.id === id);
      if (debt === undefined) throw new ApiError({ code: 'NOT_FOUND', status: 404 });
      return debt;
    },
    retry: false,
  });
}

/** The mutations of a debt also refresh the movements, the accounts and Inicio (plan §4.13.4). */
function useInvalidateDebts(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: DEBTS_KEY }),
      queryClient.invalidateQueries({ queryKey: ['debt', id] }),
      queryClient.invalidateQueries({ queryKey: ['transactions'] }),
      queryClient.invalidateQueries({ queryKey: ['accounts'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);
}

/** "Condonar saldo" (RF-M13-12). */
export function useForgiveDebt(id: string) {
  const invalidate = useInvalidateDebts(id);
  return useMutation({
    mutationFn: () => call(forgiveDebtEndpoint(id), undefined),
    onSuccess: invalidate,
  });
}

/** "Eliminar último pago" (EC-M13-05). */
export function useDeleteLastPayment(id: string) {
  const invalidate = useInvalidateDebts(id);
  return useMutation({
    mutationFn: () => call(deleteLastPaymentEndpoint(id), undefined),
    onSuccess: invalidate,
  });
}

/** Deletes the debt; with movements, the API asks for the choice about them (RF-M13-11). */
export function useDeleteDebt(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (movements?: 'delete' | 'keep') =>
      call(deleteDebtEndpoint(id), movements === undefined ? {} : { movements }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['debt', id] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: DEBTS_KEY }),
        queryClient.invalidateQueries({ queryKey: ['transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}
