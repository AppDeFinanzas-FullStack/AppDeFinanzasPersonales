import type { RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import fx from '@/locales/es-BO/fx.json';
import settings from '@/locales/es-BO/settings.json';

import { BlocksOrderList } from './components/blocks-order-list';
import { CurrencySettings } from './components/currency-settings';
import { GeneralSettings } from './components/general-settings';
import { RegisterSettings } from './components/register-settings';
import { SettingsHub } from './components/settings-hub';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'settings', settings, true, true);
// The panel of the exchange rate in `/ajustes/monedas` reuses the texts of the `fx` namespace.
i18n.addResourceBundle(LANGUAGE, 'fx', fx, true, true);

/** Private routes of Ajustes (plan §4.9.4). */
export const settingsRoutes: RouteObject[] = [
  { path: 'ajustes', element: <SettingsHub /> },
  { path: 'ajustes/general', element: <GeneralSettings /> },
  { path: 'ajustes/monedas', element: <CurrencySettings /> },
  { path: 'ajustes/registrar', element: <RegisterSettings /> },
  { path: 'ajustes/inicio', element: <BlocksOrderList /> },
];
