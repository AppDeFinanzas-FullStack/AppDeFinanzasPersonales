import type { RuleDto, UpcomingDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '@/features/settings/hooks/use-settings';

import { useRuleAmount } from './rules-list';

/** "Próximos vencimientos" of the next 30 days (RF-M14-13). */
export function Upcoming30({ upcoming, rules }: { upcoming: UpcomingDto[]; rules: RuleDto[] }) {
  const { t } = useTranslation('recurring');
  const formatters = useFormatters();
  const amountOf = useRuleAmount();
  const kindOf = (ruleId: string) => rules.find((rule) => rule.id === ruleId)?.kind ?? 'expense';
  return (
    <section className="flex flex-col gap-3" aria-labelledby="recurring-upcoming">
      <h3 id="recurring-upcoming" className="text-lg font-semibold">
        {t('upcoming.title')}
      </h3>
      {upcoming.length === 0 ? (
        <p className="text-muted-foreground">{t('upcoming.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border border-y border-border">
          {upcoming.map((item) => (
            <li
              key={`${item.ruleId}-${item.date}`}
              className="flex items-baseline justify-between gap-4 py-3"
            >
              <span className="flex flex-col">
                <span>{item.ruleName}</span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {formatters.date(item.date)}
                </span>
              </span>
              <span className="text-right tabular-nums">
                {amountOf(kindOf(item.ruleId), item.amount, item.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
