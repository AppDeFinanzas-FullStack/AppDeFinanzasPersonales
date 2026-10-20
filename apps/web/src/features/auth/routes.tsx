import { Navigate, type RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { ApiError } from '@/lib/api-client';
import auth from '@/locales/es-BO/auth.json';

import { CheckEmail } from './components/check-email';
import { ConfirmLink } from './components/confirm-link';
import { SignInForm } from './components/sign-in-form';
import { SignUpForm } from './components/sign-up-form';
import { useMe } from './hooks/use-me';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'auth', auth, true, true);

/** Sends a visitor without a session to `/entrar` (RF-M1-04). */
function RequireSession() {
  const me = useMe();
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/entrar" replace />;
  }
  return null;
}

/** Public routes of M1 (plan §4.1.4). */
export const authRoutes: RouteObject[] = [
  { path: 'registro', element: <SignUpForm /> },
  { path: 'entrar', element: <SignInForm /> },
  { path: 'revisa-tu-correo', element: <CheckEmail /> },
  { path: 'confirmar', element: <ConfirmLink /> },
  { path: 'perfil', element: <RequireSession /> },
];
