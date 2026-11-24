import type { DebtDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import { closedOn } from '../settled';

/** The history of paid and forgiven debts, apart from the open ones. */
export function SettledDebtList({ debts }: { debts: readonly DebtDto[] }) {
  const { t } = useTranslation('debts');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  return (
    <ul className="flex flex-col divide-y divide-border">
      {debts.map((debt) => (
        <li key={debt.id}>
          <Link
            to={`/deudas/${debt.id}`}
            className="flex min-h-11 items-center justify-between gap-4 rounded-md py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex flex-col">
              <span className="font-medium">{debt.person}</span>
              <span className="text-sm text-muted-foreground">
                {t(`direction.${debt.direction}`)} · {t(`status.${debt.status}`)} ·{' '}
                {formatters.date(closedOn(debt))}
              </span>
            </span>
            <span className="text-right tabular-nums">
              {formatters.money(debt.principal, symbolOf(debt.currencyCode))}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
