import type { RuleDto, RuleKind } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

const SIGN: Record<RuleKind, string> = { expense: '−', income: '+', transfer: '' };

/** The amount of a rule with its sign, or "monto por definir" without one (RF-M14-14). */
export function useRuleAmount(): (
  kind: RuleKind,
  amount: string | undefined,
  currency: string,
) => string {
  const { t } = useTranslation('recurring');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  return (kind, amount, currency) =>
    amount === undefined
      ? t('amountToDefine')
      : `${SIGN[kind]}${formatters.money(amount, symbolOf(currency))}`;
}

/** The rules with their next date, the 3 following ones and "Cuota X de N" (RF-M14-13). */
export function RulesList({ rules }: { rules: RuleDto[] }) {
  const { t } = useTranslation('recurring');
  const formatters = useFormatters();
  const amountOf = useRuleAmount();
  return (
    <section className="flex flex-col gap-3" aria-labelledby="recurring-rules">
      <h3 id="recurring-rules" className="text-lg font-semibold">
        {t('rules.title')}
      </h3>
      {rules.length === 0 ? (
        <p className="text-muted-foreground">{t('rules.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border border-y border-border">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-col gap-1 py-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-medium">{rule.name}</span>
                <span className="text-right tabular-nums">
                  {amountOf(rule.kind, rule.amount, rule.currency)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{t(`rules.mode.${rule.mode}`)}</span>
                {rule.status !== 'active' && (
                  <Badge variant="outline">{t(`rules.status.${rule.status}`)}</Badge>
                )}
                {rule.installment !== null && (
                  <span>
                    {t('rules.installment', {
                      current: rule.installment.current,
                      total: rule.installment.total,
                    })}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground tabular-nums">
                {rule.nextDate === null
                  ? t('rules.noNext')
                  : t('rules.next', { date: formatters.date(rule.nextDate) })}
              </p>
              {rule.next3.length > 0 && (
                <p className="text-sm text-muted-foreground tabular-nums">
                  {t('rules.following', {
                    dates: rule.next3.map((date) => formatters.date(date)).join(', '),
                  })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
