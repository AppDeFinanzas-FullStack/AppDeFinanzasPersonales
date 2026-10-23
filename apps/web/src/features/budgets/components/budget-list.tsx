import type { BudgetDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import { BudgetBar, useBudgetName } from './budget-progress';
import { PaceText } from './pace-text';

const BADGE = 'rounded-[calc(var(--radius)-2px)] border px-2 py-1 text-sm';

/** Neutral text badge of the status, plus "Decidir cierre" when a close awaits a decision. */
export function BudgetStatusBadges({
  budget,
}: {
  budget: Pick<BudgetDto, 'status' | 'pendingClose'>;
}) {
  const { t } = useTranslation('budgets');
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className={`${BADGE} border-border`}>{t(`status.${budget.status}`)}</span>
      {budget.pendingClose !== undefined && (
        <span className={`${BADGE} border-primary`}>{t('decideClose')}</span>
      )}
    </span>
  );
}

/** The budgets with their bar and the period in course (plan §4.11.4). */
export function BudgetList({ budgets }: { budgets: readonly BudgetDto[] }) {
  const { t } = useTranslation('budgets');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const nameOf = useBudgetName();
  return (
    <ul className="flex flex-col gap-3">
      {budgets.map((budget) => {
        const symbol = symbolOf(budget.currencyCode);
        const { current } = budget;
        return (
          <li key={budget.id}>
            <Link
              to={`/presupuestos/${budget.id}`}
              className="flex min-h-11 flex-col gap-3 rounded-lg border border-border p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-start justify-between gap-4">
                <span className="flex flex-col gap-1">
                  <span className="font-medium">{nameOf(budget)}</span>
                  <BudgetStatusBadges budget={budget} />
                </span>
                {current !== undefined && (
                  <span className="text-right font-semibold tabular-nums">
                    {formatters.money(current.available, symbol)}
                  </span>
                )}
              </span>
              {current === undefined ? (
                <span className="text-sm text-muted-foreground">{t('noPeriod')}</span>
              ) : (
                <>
                  <BudgetBar budget={budget} current={current} />
                  <span className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
                    <PaceText pace={current.pace} symbol={symbol} money={formatters.money} />
                    <span>
                      {t('period', {
                        start: formatters.date(current.start),
                        end: formatters.date(current.end),
                      })}
                    </span>
                  </span>
                </>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
