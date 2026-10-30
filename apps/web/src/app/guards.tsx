import { isReleased, type MeDto, type ModuleKey } from '@finanzas/contracts';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router';

import { listAccountsEndpoint } from '@/features/accounts/api';
import { ACCOUNTS_KEY } from '@/features/accounts/hooks/use-accounts';
import { meQuery, useMe } from '@/features/auth/hooks/use-me';
import { currentMonthFor, dashboardQuery } from '@/features/dashboard/hooks/use-dashboard';
import { registerContextQuery } from '@/features/register/hooks/use-register-context';
import { PageSkeleton } from '@/components/page-skeleton';
import { ApiError, call } from '@/lib/api-client';
import { readLastSessionHint } from '@/lib/last-session-hint';

/** How long the prefetched data stays fresh, so the guard does not ask for it twice. */
const FRESH_MS = 10_000;

/**
 * Prefetches what the first screens of a user with the Onboarding finished need: the context of
 * Registrar, and the active accounts and the data of the Inicio for the current month. Opening
 * either then does not wait for its own requests behind the download of its screen (RNF-01,
 * RNF-03, plan §4.7.4).
 */
export function prefetchPrivateData(queryClient: QueryClient, me: MeDto): void {
  if (!me.onboarding.completed) return;
  void queryClient.prefetchQuery(registerContextQuery);
  prefetchHome(queryClient, me.timezone);
}

/** The active accounts and the data of the Inicio for the current month in `timezone`. */
function prefetchHome(queryClient: QueryClient, timezone: string): void {
  // The Inicio decides between its blocks and the first account form with the active accounts.
  void queryClient.prefetchQuery({
    queryKey: [...ACCOUNTS_KEY, 'active'],
    queryFn: ({ signal }) => call(listAccountsEndpoint, { status: 'active' }, { signal }),
    staleTime: FRESH_MS,
  });
  void queryClient.prefetchQuery({
    ...dashboardQuery(currentMonthFor(timezone)),
    staleTime: FRESH_MS,
  });
}

/**
 * Route loader of the private routes: asks for the session while the screen downloads, instead of
 * after it renders. With the hint of the last session (and its Onboarding finished) it asks for
 * the data of the Inicio at the same time, with the month of the hinted zone; when the session
 * answers it prefetches again only what the hint got wrong. It never blocks the route and ignores
 * errors: the guards show them (RF-M1-04).
 */
export function warmUpSession(queryClient: QueryClient): null {
  const hint = readLastSessionHint();
  if (hint?.onboardingCompleted === true) prefetchHome(queryClient, hint.timezone);
  void queryClient.fetchQuery(meQuery).then(
    (me) => {
      prefetchPrivateData(queryClient, me);
    },
    () => undefined,
  );
  return null;
}

/** Sends a visitor without a session to `/entrar` (RF-M1-04). */
export function RequireSession() {
  const me = useMe();
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/entrar" replace />;
  }
  if (!me.data) return <PageSkeleton />;
  return <Outlet />;
}

/** Keeps the user in `/bienvenida` until the Onboarding is finished (RF-M10-01). */
export function RequireOnboardingDone() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { data } = me;
  useEffect(() => {
    if (data !== undefined) prefetchPrivateData(queryClient, data);
  }, [data, queryClient]);
  if (!me.data) return <PageSkeleton />;
  if (!me.data.onboarding.completed) return <Navigate to="/bienvenida" replace />;
  return <Outlet />;
}

/** Shows the not-found page for a module that the current release does not include (RF-M2-03). */
export function ReleaseGate({ module, notFound }: { module: ModuleKey; notFound: ReactNode }) {
  const me = useMe();
  if (!me.data) return null;
  return isReleased(module, me.data.release) ? <Outlet /> : <>{notFound}</>;
}
