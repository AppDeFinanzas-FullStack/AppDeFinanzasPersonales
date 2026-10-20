import type { RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import auth from '@/locales/es-BO/auth.json';

import { CheckEmail } from './components/check-email';
import { ConfirmLink } from './components/confirm-link';
import { SignUpForm } from './components/sign-up-form';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'auth', auth, true, true);

/** Public routes of M1 (plan §4.1.4). */
export const authRoutes: RouteObject[] = [
  { path: 'registro', element: <SignUpForm /> },
  { path: 'revisa-tu-correo', element: <CheckEmail /> },
  { path: 'confirmar', element: <ConfirmLink /> },
];
