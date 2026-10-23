import type { GoalDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

/** What each account contributes to the goal (RF-M12-07). */
export function ProgressByAccount({ goal }: { goal: GoalDto }) {
  const { t } = useTranslation('goals');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(goal.currencyCode);
  return (
    <section aria-labelledby="by-account-title" className="flex flex-col gap-3">
      <h3 id="by-account-title" className="text-lg font-semibold">
        {t('byAccount.title')}
      </h3>
      <ul className="flex flex-col divide-y divide-border">
        {goal.byAccount.map((item) => (
          <li key={item.accountId} className="flex min-h-11 items-center justify-between gap-4">
            <span>
              {item.name}
              {item.dedicated && (
                <span className="ml-2 text-sm text-muted-foreground">
                  {t('byAccount.dedicated')}
                </span>
              )}
            </span>
            <span className="tabular-nums">{formatters.money(item.amount, symbol)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
