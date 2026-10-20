import { useTranslation } from 'react-i18next';

import { Skeleton } from '@/components/ui/skeleton';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';

import type { TransactionFilters } from '../api';
import { useTransactionsSummary } from '../hooks/use-transactions';

import { useSignedMoney } from './transaction-row';

interface TotalsBarProps {
  filters: TransactionFilters;
  /** The user's base currency. */
  base: string;
}

/** The expense as a negative amount; the API gives it positive. */
const asOutflow = (expense: string): string => (/^0(\.0+)?$/.test(expense) ? expense : `-${expense}`);

/**
 * Totals of the active filter in the base currency, without what RN-02 leaves out (RF-M6-12):
 * the net stands out, income and expense go below.
 */
export function TotalsBar({ filters, base }: TotalsBarProps) {
  const { t } = useTranslation('transactions');
  const summary = useTransactionsSummary(filters);
  const symbolOf = useCurrencySymbol();
  const signed = useSignedMoney();

  if (summary.data === undefined) {
    return summary.isError ? (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    ) : (
      <Skeleton className="h-20 w-full" />
    );
  }

  const symbol = symbolOf(base);
  return (
    <section aria-label={t('totals.net')} className="flex flex-col gap-2">
      <dl className="flex flex-col">
        <dt className="text-sm text-muted-foreground">{t('totals.net')}</dt>
        <dd className="text-[2rem] font-semibold leading-tight tabular-nums">
          {signed(summary.data.net, symbol)}
        </dd>
      </dl>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('totals.income')}</dt>
          <dd className="tabular-nums">{signed(summary.data.income, symbol)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('totals.expense')}</dt>
          <dd className="tabular-nums">{signed(asOutflow(summary.data.expense), symbol)}</dd>
        </div>
      </dl>
    </section>
  );
}
