import { isReleased, type ModuleKey } from '@finanzas/contracts';
import type { ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router';

import { useMe } from '@/features/auth/hooks/use-me';
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

/** Keeps the user in `/bienvenida` until the Onboarding is finished. */
export function RequireOnboardingDone() {
  const me = useMe();
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
