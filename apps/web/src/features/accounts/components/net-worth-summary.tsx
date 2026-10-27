import { useTranslation } from 'react-i18next';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import goals from '@/locales/es-BO/goals.json';

import type { AccountsSummary } from '../api';
import { useCurrencySymbol } from '../hooks/use-accounts';

i18n.addResourceBundle(LANGUAGE, 'goals', goals, true, true);

const BREAKDOWN = ['liquid', 'savings', 'cardDebt'] as const;

/**
 * Net worth of the active accounts in the base currency and in the other one, with its breakdown
 * (RF-M4-10). "Apartado para metas" arrives with goals in V1.1.
 */
export function NetWorthSummary({
  summary,
  base,
  other,
}: {
  summary: AccountsSummary;
  base: string;
  other: string;
}) {
  const { t } = useTranslation('accounts');
  const { t: tGoals } = useTranslation('goals');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const money = (amount: string | null, code: string) =>
    amount === null ? t('noRate') : formatters.money(amount, symbolOf(code));

  return (
    <section aria-labelledby="net-worth" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="net-worth" className="text-sm text-muted-foreground">
          {t('summary.title')}
        </h2>
        <p className="text-3xl font-semibold tabular-nums" data-testid="net-worth-base">
          {money(summary.netWorth.base, base)}
        </p>
        <p className="text-sm text-muted-foreground tabular-nums">
          {t('summary.equivalent', { amount: money(summary.netWorth.other, other) })}
        </p>
      </div>
      <dl className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {BREAKDOWN.map((key) => (
          <div key={key} className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt>{t(`summary.breakdown.${key}`)}</dt>
            <dd className="text-right font-medium tabular-nums">
              {money(summary.breakdown[key], base)}
            </dd>
          </div>
        ))}
        {summary.breakdown.earmarked !== null && (
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt>{tGoals('summary.earmarked')}</dt>
            <dd className="text-right font-medium tabular-nums">
              {money(summary.breakdown.earmarked, base)}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
