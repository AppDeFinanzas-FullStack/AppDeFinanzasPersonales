import type { BudgetDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import type { BudgetPeriodSummary } from '../api';

import { signedMoney } from './carryover-breakdown';

const HISTORY_SIZE = 12;

/** The 12 last periods, the most recent on top (plan §4.11.4). */
export function PeriodHistory({
  budget,
  periods,
}: {
  budget: Pick<BudgetDto, 'currencyCode'>;
  periods: readonly BudgetPeriodSummary[];
}) {
  const { t } = useTranslation('budgets');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(budget.currencyCode);
  const latest = [...periods].sort((a, b) => b.start.localeCompare(a.start)).slice(0, HISTORY_SIZE);
  return (
    <section aria-labelledby="budget-history" className="flex flex-col gap-3">
      <h3 id="budget-history" className="text-lg font-semibold">
        {t('history.title')}
      </h3>
      {latest.length === 0 ? (
        <p className="text-muted-foreground">{t('history.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {latest.map((period) => (
            <li key={period.id} className="flex min-h-11 items-center justify-between gap-4 py-2">
              <span className="flex flex-col">
                <span>
                  {t('period', {
                    start: formatters.date(period.start),
                    end: formatters.date(period.end),
                  })}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(`history.status.${period.status}`)}
                </span>
              </span>
              <span className="flex flex-col items-end text-right tabular-nums">
                <span>
                  {t('history.amount', { amount: formatters.money(period.amount, symbol) })}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t('history.carryover', {
                    amount: signedMoney(period.carryoverIn, symbol, formatters.money),
                  })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
