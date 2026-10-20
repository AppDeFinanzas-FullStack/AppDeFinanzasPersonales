import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Badge } from '@/components/ui/badge';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import fx from '@/locales/es-BO/fx.json';

import { useCurrentRate } from '../hooks/use-current-rate';

i18n.addResourceBundle(LANGUAGE, 'fx', fx, true, true);

const USD_SYMBOL = '$';

// Plan §4.3.4: the USD rate in use, a badge when it is the manual value and "$ —" without a rate.
export function RateChip() {
  const { t } = useTranslation('fx');
  const formatters = useFormatters();
  const { data } = useCurrentRate();
  const value = data?.inUse.value ?? null;
  const manual = data?.inUse.kind === 'manual';
  const text = value === null ? t('chip.noRate') : formatters.money(value, USD_SYMBOL);
  const label =
    value === null
      ? t('chip.labelNoRate')
      : t(manual ? 'chip.labelManual' : 'chip.label', { value: text });
  return (
    <Link
      to="/tipo-de-cambio"
      aria-label={label}
      data-testid="rate-chip"
      className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span>{text}</span>
      {value !== null && manual ? (
        <Badge variant="secondary" className="rounded-[calc(var(--radius)-2px)]">
          {t('chip.manual')}
        </Badge>
      ) : null}
    </Link>
  );
}
