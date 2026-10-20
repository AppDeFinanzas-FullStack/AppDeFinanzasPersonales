import type { DashboardDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

interface Props {
  data: DashboardDto['balances'];
  baseCode: string;
  otherCode: string;
}

/** "Saldos al día de hoy": net worth in both currencies and the first accounts (RF-M8-07). */
export function BalancesBlock({ data, baseCode, otherCode }: Props) {
  const { t } = useTranslation('dashboard');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-balances">
      <div className="flex flex-col gap-1">
        <h2 id="dashboard-balances" className="text-base font-semibold">
          {t('balances.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('balances.asOfToday')}</p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-2xl font-semibold tabular-nums">
          {formatters.money(data.netWorth.base, symbolOf(baseCode))}
        </p>
        <p className="text-sm tabular-nums text-muted-foreground">
          {data.netWorth.other === null
            ? t('balances.noRate')
            : formatters.money(data.netWorth.other, symbolOf(otherCode))}
        </p>
      </div>
      <ul className="flex flex-col">
        {data.top.map((account) => (
          <li key={account.id} className="border-b border-border last:border-b-0">
            <Link
              to={`/cuentas/${account.id}`}
              className="flex min-h-11 items-center justify-between gap-2"
            >
              <span>{account.name}</span>
              <span className="tabular-nums">
                {formatters.money(account.balance, symbolOf(account.currencyCode))}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Link to="/cuentas" className="min-h-11 text-sm font-medium text-primary underline">
        {t('balances.seeAll')}
      </Link>
    </section>
  );
}
