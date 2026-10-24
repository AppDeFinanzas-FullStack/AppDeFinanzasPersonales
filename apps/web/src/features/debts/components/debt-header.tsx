import type { DebtDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

/** The capital, the accrued interest and the pending balance, shown apart (RF-M13-06). */
export function DebtHeader({ debt }: { debt: DebtDto }) {
  const { t } = useTranslation('debts');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(debt.currencyCode);
  const money = (amount: string) => formatters.money(amount, symbol);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <h2 className="text-2xl font-semibold">{debt.person}</h2>
          <p className="text-sm text-muted-foreground">
            {t(`direction.${debt.direction}`)}
            {debt.dueDate !== undefined &&
              ` · ${t('dueDate', { date: formatters.date(debt.dueDate) })}`}
          </p>
        </div>
        <span className="rounded-[calc(var(--radius)-2px)] border border-border px-2 py-1 text-sm">
          {t(`status.${debt.status}`)}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">{t('header.pending')}</span>
        <span className="text-[32px] font-semibold leading-tight tabular-nums">
          {money(debt.pending)}
        </span>
      </div>
      <dl className="flex flex-col divide-y divide-border">
        <div className="flex min-h-11 items-center justify-between gap-4">
          <dt>{t('header.capital')}</dt>
          <dd className="tabular-nums">{money(debt.capitalOutstanding)}</dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-4">
          <dt>{t('header.interest')}</dt>
          <dd className="tabular-nums">{money(debt.interestAccrued)}</dd>
        </div>
        {debt.forgivenAmount !== undefined && (
          <div className="flex min-h-11 items-center justify-between gap-4">
            <dt>{t('header.forgiven')}</dt>
            <dd className="tabular-nums">{money(debt.forgivenAmount)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
