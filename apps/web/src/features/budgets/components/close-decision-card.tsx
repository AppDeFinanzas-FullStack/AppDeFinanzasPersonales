import type { BudgetDto, DecisionInput } from '@finanzas/contracts';
import { parseMoney, toMoneyString } from '@finanzas/domain';
import { useTranslation } from 'react-i18next';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useCategories } from '@/features/categories/hooks/use-categories';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import { cn } from '@/lib/utils';
import budgets from '@/locales/es-BO/budgets.json';

import { useBudget, useBudgets, useCloseDecision } from '../hooks/use-budgets';

import { useBudgetName } from './budget-progress';
import { DeficitChoice } from './deficit-choice';
import { SurplusSplitForm } from './surplus-split-form';

// The inbox shows this card outside the budgets screens, so it registers the namespace too (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'budgets', budgets, true, true);

type PendingClose = NonNullable<BudgetDto['pendingClose']>;

/**
 * "Enviar a meta" is offered by the general budget or, when there is none, by the budgets of root
 * categories; subcategories only carry or discard (RF-M11-09).
 */
function useCanSendToGoal(budget: BudgetDto): boolean | undefined {
  const list = useBudgets();
  const categories = useCategories({ kind: 'expense', status: 'active' });
  if (budget.scope === 'general') return true;
  if (list.data === undefined || categories.data === undefined) return undefined;
  if (list.data.items.some((item) => item.scope === 'general')) return false;
  const categoryId = budget.category?.id;
  const isChild = categories.data.some((root) =>
    root.children.some((child) => child.id === categoryId),
  );
  return !isChild;
}

/** The split of the surplus, shown once it is known whether the budget may send to a goal. */
function SurplusDecision({
  budget,
  result,
  symbol,
  canCarry,
  pending,
  onSubmit,
}: {
  budget: BudgetDto;
  result: string;
  symbol: string;
  canCarry: boolean;
  pending: boolean;
  onSubmit: (input: DecisionInput) => void;
}) {
  const canSendToGoal = useCanSendToGoal(budget);
  if (canSendToGoal === undefined) return null;
  return (
    <SurplusSplitForm
      result={result}
      symbol={symbol}
      canCarry={canCarry}
      canSendToGoal={canSendToGoal}
      defaultAction={budget.defaultAction}
      pending={pending}
      onSubmit={onSubmit}
    />
  );
}

/**
 * The decision of a closed period (plan §4.11.4): "Comida cerró octubre: sobraron Bs 150,00" with
 * the split of the surplus, or "te pasaste por …" with Arrastrar and Absorber. A finalized budget has
 * no next period to carry to (EC-M11-09). `compact` is the version of the inbox, same endpoint.
 */
export function CloseDecisionCard({
  budget,
  pendingClose,
  compact = false,
}: {
  budget: BudgetDto;
  pendingClose: PendingClose;
  compact?: boolean;
}) {
  const { t } = useTranslation('budgets');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const nameOf = useBudgetName();
  const decide = useCloseDecision(budget.id, pendingClose.periodId);
  const symbol = symbolOf(budget.currencyCode);
  const result = parseMoney(pendingClose.result);
  const deficit = result.isNegative();
  const amount = formatters.money(toMoneyString(result.abs()), symbol);
  const canCarry = budget.status !== 'finalized';
  const params = { name: nameOf(budget), label: pendingClose.label, amount };

  const apply = (input: DecisionInput) => {
    decide.mutate(input);
  };

  return (
    <section
      aria-label={t('decideClose')}
      className={cn('flex flex-col gap-4', !compact && 'rounded-lg border border-border p-4')}
    >
      <p className={compact ? 'text-base font-semibold' : 'text-[2rem] font-semibold leading-tight tabular-nums'}>
        {deficit ? t('close.deficitTitle', params) : t('close.surplusTitle', params)}
      </p>
      {deficit ? (
        <DeficitChoice
          canCarry={canCarry}
          pending={decide.isPending}
          onChoose={(mode) => {
            apply({ result: 'deficit', mode });
          }}
        />
      ) : (
        <SurplusDecision
          budget={budget}
          result={toMoneyString(result)}
          symbol={symbol}
          canCarry={canCarry}
          pending={decide.isPending}
          onSubmit={apply}
        />
      )}
      {decide.isError && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError(decide.error instanceof ApiError ? decide.error : { code: '' })}
        </p>
      )}
    </section>
  );
}

/** The compact card of a close notification in the inbox, while its decision is pending (RF-M15-03). */
export function CloseDecisionNotice({
  budgetId,
  periodId,
}: {
  budgetId: string;
  periodId: string;
}) {
  const query = useBudget(budgetId);
  const budget = query.data;
  const pendingClose = budget?.pendingClose;
  if (budget === undefined || pendingClose?.periodId !== periodId) return null;
  return <CloseDecisionCard budget={budget} pendingClose={pendingClose} compact />;
}
