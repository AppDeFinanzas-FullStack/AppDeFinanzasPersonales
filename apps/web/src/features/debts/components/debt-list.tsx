import type { DebtDto, DebtsSummaryDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

type PersonNet = NonNullable<DebtsSummaryDto['byPerson']>[number];

const ZERO = /^-?0(\.0+)?$/;

/** Each debt with its pending balance (RF-M13-06). */
export function DebtList({ debts }: { debts: readonly DebtDto[] }) {
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
                {t(`direction.${debt.direction}`)} · {t(`status.${debt.status}`)}
              </span>
            </span>
            <span className="text-right tabular-nums">
              {formatters.money(debt.pending, symbolOf(debt.currencyCode))}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The net balance of each person in the base currency (RF-M13-13). */
export function PersonList({ people, base }: { people: readonly PersonNet[]; base: string }) {
  const { t } = useTranslation('debts');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(base);
  return (
    <ul className="flex flex-col divide-y divide-border">
      {people.map((item) => {
        const negative = item.net.startsWith('-');
        const zero = ZERO.test(item.net);
        const amount = formatters.money(negative ? item.net.slice(1) : item.net, symbol);
        const label = zero ? 'settled' : negative ? 'youOwe' : 'owesYou';
        const sign = zero ? '' : negative ? '−' : '+';
        return (
          <li
            key={item.personKey}
            className="flex min-h-11 items-center justify-between gap-4 py-3"
          >
            <span className="flex flex-col">
              <span className="font-medium">{item.person}</span>
              <span className="text-sm text-muted-foreground">{t(`net.${label}`)}</span>
            </span>
            <span className="text-right tabular-nums">{`${sign}${amount}`}</span>
          </li>
        );
      })}
    </ul>
  );
}
