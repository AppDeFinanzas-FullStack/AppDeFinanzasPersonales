import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import common from '@/locales/es-BO/common.json';
import errors from '@/locales/es-BO/errors.json';

export const LANGUAGE = 'es-BO';

// One namespace per feature (RNF-07); each feature adds its own JSON here.
export const resources = {
  [LANGUAGE]: { common, errors },
} as const;

void i18next.use(initReactI18next).init({
  lng: LANGUAGE,
  fallbackLng: false,
  supportedLngs: [LANGUAGE],
  resources,
  ns: Object.keys(resources[LANGUAGE]),
  defaultNS: 'common',
  initAsync: false,
  returnNull: false,
  interpolation: { escapeValue: false },
  // A missing parameter never shows a raw placeholder to the user (RNF-17).
  missingInterpolationHandler: () => '',
});

export { i18next as i18n };
