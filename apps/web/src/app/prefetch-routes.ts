import { isReleased, type MeDto, type ModuleKey } from '@finanzas/contracts';
import type { QueryClient } from '@tanstack/react-query';

import { accountsQuery } from '@/features/accounts/hooks/use-accounts';
import { ME_QUERY_KEY, meQuery } from '@/features/auth/hooks/use-me';
import { budgetsQuery } from '@/features/budgets/hooks/use-budgets';
import { categoriesQuery } from '@/features/categories/hooks/use-categories';
import { currentMonthFor } from '@/features/dashboard/hooks/use-dashboard';
import { debtsQuery } from '@/features/debts/hooks/use-debts';
import { goalsQuery } from '@/features/goals/hooks/use-goals';
import { recurringQuery } from '@/features/recurring/hooks/use-recurring';
import { transactionsQuery } from '@/features/transactions/hooks/use-transactions';

/** How long prefetched data stays fresh, so asking again right away does not repeat the request. */
export const PREFETCH_FRESH_MS = 10_000;

interface RoutePrefetch {
  /** The module whose release must include the user's, so the API is not asked for a 404. */
  module: ModuleKey;
  /** Starts the request of the main query of the route; the caller does not wait for it. */
  start: (queryClient: QueryClient, me: MeDto) => void;
}

/**
 * The main query of each main route, with the parameters its screen asks with by default. The
 * screen reads the same cache entry through the same factory (RNF-29).
 */
const ROUTES: Record<string, RoutePrefetch> = {
  '/movimientos': {
    module: 'M6',
    start: (queryClient, me) => {
      void queryClient.prefetchInfiniteQuery({
        ...transactionsQuery({ month: currentMonthFor(me.timezone) }),
        staleTime: PREFETCH_FRESH_MS,
      });
    },
  },
  '/cuentas': {
    module: 'M4',
    start: (queryClient) => {
      void queryClient.prefetchQuery({
        ...accountsQuery('active'),
        staleTime: PREFETCH_FRESH_MS,
      });
    },
  },
  '/presupuestos': {
    module: 'M11',
    start: (queryClient) => {
      void queryClient.prefetchQuery({ ...budgetsQuery(), staleTime: PREFETCH_FRESH_MS });
    },
  },
  '/metas': {
    module: 'M12',
    start: (queryClient) => {
      void queryClient.prefetchQuery({ ...goalsQuery(), staleTime: PREFETCH_FRESH_MS });
    },
  },
  '/deudas': {
    module: 'M13',
    start: (queryClient) => {
      void queryClient.prefetchQuery({ ...debtsQuery('debt'), staleTime: PREFETCH_FRESH_MS });
    },
  },
  '/recurrentes': {
    module: 'M14',
    start: (queryClient) => {
      void queryClient.prefetchQuery({ ...recurringQuery(), staleTime: PREFETCH_FRESH_MS });
    },
  },
  '/categorias': {
    module: 'M5',
    start: (queryClient) => {
      void queryClient.prefetchQuery({
        ...categoriesQuery({ kind: 'expense', status: 'active' }),
        staleTime: PREFETCH_FRESH_MS,
      });
    },
  },
};

/**
 * Starts the request of the main data of a main route, if the user's release includes its module
 * (RF-M2-03). It never blocks and never shows an error: a failed prefetch leaves the query in
 * error, and the screen asks again when it mounts. Without the profile in the cache it asks for it
 * first, which is the request the session already makes.
 */
export function prefetchRoute(queryClient: QueryClient, path: string): void {
  const route = ROUTES[path];
  if (route === undefined) return;
  const run = (me: MeDto): void => {
    if (isReleased(route.module, me.release)) route.start(queryClient, me);
  };
  const me = queryClient.getQueryData<MeDto>(ME_QUERY_KEY);
  if (me !== undefined) {
    run(me);
    return;
  }
  void queryClient.fetchQuery(meQuery).then(run, () => undefined);
}
