import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { ResourceNotFound } from '@/components/resource-not-found';
import { Separator } from '@/components/ui/separator';
import { ApiError } from '@/lib/api-client';
import budgets from '@/locales/es-BO/budgets.json';

import { BudgetActions } from './components/budget-actions';
import { BudgetList, BudgetStatusBadges } from './components/budget-list';
import { BudgetProgress, useBudgetName } from './components/budget-progress';
import { CarryoverBreakdown } from './components/carryover-breakdown';
import { PeriodHistory } from './components/period-history';
import { useBudget, useBudgets } from './hooks/use-budgets';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'budgets', budgets, true, true);

/** `/presupuestos` (plan §4.11.4). */
export function BudgetsPage() {
  const { t } = useTranslation('budgets');
  const query = useBudgets();
  if (query.isError && query.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (query.data === undefined) return null;
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-semibold">{t('title')}</h2>
      {query.data.items.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <BudgetList budgets={query.data.items} />
      )}
    </div>
  );
}

/** `/presupuestos/:id` (plan §4.11.4). */
export function BudgetDetailPage() {
  const { t } = useTranslation('budgets');
  const { id = '' } = useParams();
  const query = useBudget(id);
  const nameOf = useBudgetName();

  if (query.isError && query.data === undefined) {
    if (query.error instanceof ApiError && query.error.code === 'NOT_FOUND') {
      return <ResourceNotFound />;
    }
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (query.data === undefined) return null;
  const budget = query.data;
  const { current } = budget;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-2xl font-semibold">{nameOf(budget)}</h2>
          <BudgetStatusBadges budget={budget} />
        </div>
        <BudgetActions budget={budget} />
      </div>
      {current === undefined ? (
        <p className="text-muted-foreground">{t('noPeriod')}</p>
      ) : (
        <>
          <BudgetProgress budget={budget} current={current} />
          <Separator />
          <CarryoverBreakdown budget={budget} current={current} />
        </>
      )}
      <PeriodHistory budget={budget} periods={budget.periods} />
      <Link to="/presupuestos" className="text-sm text-primary underline">
        {t('back')}
      </Link>
    </div>
  );
}
