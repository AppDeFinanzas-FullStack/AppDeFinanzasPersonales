import { i18n, LANGUAGE } from '@/app/providers/i18n';
import fx from '@/locales/es-BO/fx.json';
import settings from '@/locales/es-BO/settings.json';

import { BlocksOrderList } from './components/blocks-order-list';
import { CurrencySettings } from './components/currency-settings';
import { GeneralSettings } from './components/general-settings';
import { PreferencesList } from './components/preferences-list';
import { RegisterSettings } from './components/register-settings';
import { SettingsHub } from './components/settings-hub';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'settings', settings, true, true);
// The panel of the exchange rate in `/ajustes/monedas` reuses the texts of the `fx` namespace.
i18n.addResourceBundle(LANGUAGE, 'fx', fx, true, true);

export {
  BlocksOrderList,
  CurrencySettings,
  GeneralSettings,
  PreferencesList,
  RegisterSettings,
  SettingsHub,
};
