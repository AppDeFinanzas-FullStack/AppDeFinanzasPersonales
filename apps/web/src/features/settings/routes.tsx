import type { RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import settings from '@/locales/es-BO/settings.json';

import { GeneralSettings } from './components/general-settings';
import { SettingsHub } from './components/settings-hub';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'settings', settings, true, true);

/** Private routes of Ajustes (plan §4.9.4). */
export const settingsRoutes: RouteObject[] = [
  { path: 'ajustes', element: <SettingsHub /> },
  { path: 'ajustes/general', element: <GeneralSettings /> },
];
