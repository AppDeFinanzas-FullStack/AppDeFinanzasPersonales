import type { GoalDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

const MONTH_FORMAT = new Intl.DateTimeFormat('es-BO', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** The suggested monthly contribution and its variants (RF-M12-06). Nothing when reached. */
export function SuggestedBox({ goal }: { goal: GoalDto }) {
  const { t } = useTranslation('goals');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(goal.currencyCode);
  const { kind, amount, untilMonth } = goal.suggested;
  if (kind === 'none') return null;

  const money = amount === undefined ? '' : formatters.money(amount, symbol);
  const month =
    untilMonth === undefined
      ? ''
      : MONTH_FORMAT.format(new Date(`${untilMonth.slice(0, 7)}-01T00:00:00Z`));

  return (
    <section
      aria-labelledby="suggested-title"
      className="flex flex-col gap-1 rounded-lg border border-border p-4"
    >
      <h3 id="suggested-title" className="text-sm text-muted-foreground">
        {t('suggested.title')}
      </h3>
      <p className="text-lg font-semibold tabular-nums">
        {kind === 'monthly' && t('suggested.monthly', { amount: money })}
        {kind === 'this_month' && t('suggested.thisMonth', { amount: money })}
        {kind === 'calculator' && t('suggested.calculator', { amount: money, month })}
        {kind === 'pick_new_date' && t('suggested.pickNewDate')}
      </p>
    </section>
  );
}
