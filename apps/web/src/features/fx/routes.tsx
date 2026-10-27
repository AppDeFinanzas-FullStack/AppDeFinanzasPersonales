import { useTranslation } from 'react-i18next';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Separator } from '@/components/ui/separator';
import fx from '@/locales/es-BO/fx.json';

import { CurrenciesList } from './components/currencies-list';
import { CurrentRatesCard } from './components/current-rates-card';
import { GapCard } from './components/gap-card';
import { ManualValueCard } from './components/manual-value-card';
import { RateHistoryChart } from './components/rate-history-chart';
import { ReferenceSelector } from './components/reference-selector';
import { useCurrentRate } from './hooks/use-current-rate';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'fx', fx, true, true);

/** `/tipo-de-cambio` (plan §4.3.4). */
export function ExchangeRatePage() {
  const { t } = useTranslation('fx');
  const rates = useCurrentRate();
  if (rates.isError && rates.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('current.loadError')}
      </p>
    );
  }
  if (rates.data === undefined) return null;
  const { inUse, gap } = rates.data;
  return (
    <div className="flex flex-col gap-8">
      <CurrentRatesCard rates={rates.data} now={rates.dataUpdatedAt} />
      <Separator />
      <GapCard gap={gap} />
      <Separator />
      {/* With a manual value the chart follows the default reference (RF-M3-03). */}
      <RateHistoryChart kind={inUse.kind === 'manual' ? 'parallel_median' : inUse.kind} />
      <Separator />
      <ReferenceSelector inUse={inUse} />
      <Separator />
      <ManualValueCard inUse={inUse} now={rates.dataUpdatedAt} />
      <Separator />
      <CurrenciesList />
    </div>
  );
}
