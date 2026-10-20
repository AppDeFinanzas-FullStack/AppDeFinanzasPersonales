import { isReleased, type ModuleKey } from '@finanzas/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router';

import { useMe } from '@/features/auth/hooks/use-me';
import { registerContextQuery } from '@/features/register/hooks/use-register-context';
import { ApiError } from '@/lib/api-client';

/** Sends a visitor without a session to `/entrar` (RF-M1-04). */
export function RequireSession() {
  const me = useMe();
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/entrar" replace />;
  }
  if (!me.data) return null;
  return <Outlet />;
}

/**
 * Keeps the user in `/bienvenida` until the Onboarding is finished. Once it is, the context of
 * Registrar is prefetched, so opening it needs no request (RNF-01, plan §4.7.4).
 */
export function RequireOnboardingDone() {
  const me = useMe();
  const queryClient = useQueryClient();
  const ready = me.data?.onboarding.completed === true;
  useEffect(() => {
    if (ready) void queryClient.prefetchQuery(registerContextQuery);
  }, [ready, queryClient]);
  if (!me.data) return null;
  if (!me.data.onboarding.completed) return <Navigate to="/bienvenida" replace />;
  return <Outlet />;
}

/** Shows the not-found page for a module that the current release does not include (RF-M2-03). */
export function ReleaseGate({ module, notFound }: { module: ModuleKey; notFound: ReactNode }) {
  const me = useMe();
  if (!me.data) return null;
  return isReleased(module, me.data.release) ? <Outlet /> : <>{notFound}</>;
}
