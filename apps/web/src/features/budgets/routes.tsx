import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { ResourceNotFound } from '@/components/resource-not-found';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import budgets from '@/locales/es-BO/budgets.json';

import { BudgetActions } from './components/budget-actions';
import { BudgetForm } from './components/budget-form';
import { BudgetList, BudgetStatusBadges } from './components/budget-list';
import { BudgetProgress, useBudgetName } from './components/budget-progress';
import { CarryoverBreakdown } from './components/carryover-breakdown';
import { CloseDecisionCard } from './components/close-decision-card';
import { PeriodHistory } from './components/period-history';
import { useBudget, useBudgets } from './hooks/use-budgets';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'budgets', budgets, true, true);

/** `/presupuestos` (plan §4.11.4). */
export function BudgetsPage() {
  const { t } = useTranslation('budgets');
  const query = useBudgets();
  const [creating, setCreating] = useState(false);
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
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold">{t('title')}</h2>
        <Button
          type="button"
          className="h-11"
          onClick={() => {
            setCreating(true);
          }}
        >
          {t('new')}
        </Button>
      </div>
      {query.data.items.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <BudgetList budgets={query.data.items} />
      )}
      <BudgetForm open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/** `/presupuestos/:id` (plan §4.11.4). */
export function BudgetDetailPage() {
  const { t } = useTranslation('budgets');
  const { id = '' } = useParams();
  const query = useBudget(id);
  const nameOf = useBudgetName();
  const formatters = useFormatters();

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
      {current !== undefined && budget.nextStartDay !== undefined && (
        <p role="status" className="text-muted-foreground">
          {t('nextStart', { date: formatters.date(current.end), day: budget.nextStartDay })}
        </p>
      )}
      {budget.pendingClose !== undefined && (
        <CloseDecisionCard
          key={budget.pendingClose.periodId}
          budget={budget}
          pendingClose={budget.pendingClose}
        />
      )}
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
    </div>
  );
}
