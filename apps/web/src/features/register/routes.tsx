import { i18n, LANGUAGE } from '@/app/providers/i18n';
import accounts from '@/locales/es-BO/accounts.json';
import categories from '@/locales/es-BO/categories.json';
import register from '@/locales/es-BO/register.json';
import transactions from '@/locales/es-BO/transactions.json';

import { RegisterForm } from './components/register-form';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'register', register, true, true);
// The form of the first account, the categories and the undo reuse these namespaces.
i18n.addResourceBundle(LANGUAGE, 'accounts', accounts, true, true);
i18n.addResourceBundle(LANGUAGE, 'categories', categories, true, true);
i18n.addResourceBundle(LANGUAGE, 'transactions', transactions, true, true);

/** The quick form to record a movement at `/registrar` (plan §4.7.4). */
export function RegisterPage() {
  return <RegisterForm />;
}
