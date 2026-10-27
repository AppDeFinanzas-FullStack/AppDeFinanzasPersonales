import type { BudgetDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

type Current = NonNullable<BudgetDto['current']>;

/** An amount with its sign in front: "−Bs 200,00" or "+Bs 50,00" (design, montos). */
export function signedMoney(
  amount: string,
  symbol: string,
  money: (amount: string, symbol: string) => string,
): string {
  const negative = amount.startsWith('-');
  return `${negative ? '−' : '+'}${money(negative ? amount.slice(1) : amount, symbol)}`;
}

/** "Monto ± arrastre = disponible", with the late adjustments of the period (RF-M11-05). */
export function CarryoverBreakdown({ budget, current }: { budget: BudgetDto; current: Current }) {
  const { t } = useTranslation('budgets');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(budget.currencyCode);
  const signed = (amount: string) => signedMoney(amount, symbol, formatters.money);
  return (
    <section aria-labelledby="budget-breakdown" className="flex flex-col gap-3">
      <h3 id="budget-breakdown" className="text-lg font-semibold">
        {t('breakdown.title')}
      </h3>
      <ul className="flex flex-col divide-y divide-border">
        <li className="flex min-h-11 items-center justify-between gap-4">
          <span>{t('breakdown.amount')}</span>
          <span className="tabular-nums">{formatters.money(budget.amount, symbol)}</span>
        </li>
        <li className="flex min-h-11 items-center justify-between gap-4">
          <span>{t('breakdown.carryover')}</span>
          <span className="tabular-nums">{signed(current.carryover)}</span>
        </li>
        {current.lateAdjustments.map((adjustment, index) => (
          <li
            key={`${adjustment.sourceLabel}-${String(index)}`}
            className="flex min-h-11 items-center justify-between gap-4"
          >
            <span>{adjustment.sourceLabel}</span>
            <span className="tabular-nums">{signed(adjustment.amount)}</span>
          </li>
        ))}
        <li className="flex min-h-11 items-center justify-between gap-4 font-semibold">
          <span>{t('breakdown.available')}</span>
          <span className="tabular-nums">{formatters.money(current.available, symbol)}</span>
        </li>
      </ul>
    </section>
  );
}
