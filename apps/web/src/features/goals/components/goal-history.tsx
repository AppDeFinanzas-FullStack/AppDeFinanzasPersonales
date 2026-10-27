import type { GoalDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import type { GoalHistoryEntry } from '../api';

/** Earmarks and releases with their origin (RF-M12-07). A release carries a minus sign. */
export function GoalHistory({
  goal,
  history,
}: {
  goal: Pick<GoalDto, 'byAccount' | 'currencyCode'>;
  history: readonly GoalHistoryEntry[];
}) {
  const { t } = useTranslation('goals');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(goal.currencyCode);
  const nameOf = new Map(goal.byAccount.map((item) => [item.accountId, item.name]));
  return (
    <section aria-labelledby="history-title" className="flex flex-col gap-3">
      <h3 id="history-title" className="text-lg font-semibold">
        {t('history.title')}
      </h3>
      {history.length === 0 ? (
        <p className="text-muted-foreground">{t('history.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {history.map((item) => {
            const negative = item.amount.startsWith('-');
            const amount = formatters.money(negative ? item.amount.slice(1) : item.amount, symbol);
            return (
              <li
                key={`${item.createdAt}-${item.accountId}-${item.amount}`}
                className="flex min-h-11 items-center justify-between gap-4"
              >
                <span className="flex flex-col">
                  <span>{nameOf.get(item.accountId) ?? t('history.otherAccount')}</span>
                  <span className="text-sm text-muted-foreground">
                    {t(`origin.${item.origin}`, { defaultValue: item.origin })} ·{' '}
                    {formatters.date(item.date)}
                  </span>
                </span>
                <span className="tabular-nums">{negative ? `−${amount}` : `+${amount}`}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
