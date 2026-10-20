import type { RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import register from '@/locales/es-BO/register.json';

import { RegisterForm } from './components/register-form';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'register', register, true, true);

/** `/registrar`: the quick form to record a movement (plan §4.7.4). */
export function RegisterPage() {
  return <RegisterForm />;
}

/** Private routes of Registrar (plan §4.7.4). */
export const registerRoutes: RouteObject[] = [{ path: 'registrar', element: <RegisterPage /> }];
