import type { DebtsSummaryDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

/** "Debes X · Te deben Y", in the base currency (RF-M13-13). */
export function DebtsSummary({ summary, base }: { summary: DebtsSummaryDto; base: string }) {
  const { t } = useTranslation('debts');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(base);
  return (
    <section
      aria-label={t('summary.label')}
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
    >
      <p className="flex items-baseline gap-2">
        <span className="text-muted-foreground">{t('summary.iOwe')}</span>
        <span className="text-2xl font-semibold tabular-nums">
          {formatters.money(summary.iOwe, symbol)}
        </span>
      </p>
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <p className="flex items-baseline gap-2">
        <span className="text-muted-foreground">{t('summary.owedToMe')}</span>
        <span className="text-2xl font-semibold tabular-nums">
          {formatters.money(summary.owedToMe, symbol)}
        </span>
      </p>
    </section>
  );
}
