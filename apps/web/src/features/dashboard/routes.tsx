import { BOLIVIA_TIME_ZONE, todayFor } from '@finanzas/domain';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams, type RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { QuickAccountForm } from '@/features/accounts/components/quick-account-form';
import { useAccounts, useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useMe } from '@/features/auth/hooks/use-me';
import { useCurrentRate } from '@/features/fx/hooks/use-current-rate';
import { MonthSelector } from '@/features/transactions/components/month-selector';
import dashboard from '@/locales/es-BO/dashboard.json';

import { DashboardBlocks } from './components/dashboard-blocks';
import { SummaryCards } from './components/summary-cards';
import { useDashboard } from './hooks/use-dashboard';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'dashboard', dashboard, true, true);

function DashboardContent() {
  const { t } = useTranslation('dashboard');
  const me = useMe();
  const rates = useCurrentRate();
  const symbolOf = useCurrencySymbol();
  const [params, setParams] = useSearchParams();
  const [today] = useState(() => todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date()));
  const requested = params.get('mes');
  const month =
    requested !== null && /^\d{4}-\d{2}$/.test(requested) ? requested : today.slice(0, 7);
  const query = useDashboard(month);
  const currentMonth = query.data?.range.currentMonth ?? today.slice(0, 7);
  const baseCode = rates.data?.base ?? 'BOB';
  const symbol = symbolOf(baseCode);

  return (
    <div className="flex flex-col gap-6">
      <MonthSelector
        month={month}
        currentMonth={currentMonth}
        onChange={(next) => {
          setParams({ mes: next }, { replace: true });
        }}
      />
      {query.data !== undefined ? (
        <>
          <SummaryCards cards={query.data.cards} symbol={symbol} />
          <nav aria-label={t('cardLinks')} className="flex gap-4">
            {(['income', 'expense'] as const).map((kind) => (
              <Link
                key={kind}
                to={`/movimientos?month=${month}&kind=${kind}`}
                className="flex min-h-11 items-center text-sm font-medium text-primary underline"
              >
                {t(`cards.${kind}`)}
              </Link>
            ))}
          </nav>
          <DashboardBlocks
            data={query.data}
            month={month}
            baseCode={baseCode}
            otherCode={baseCode === 'BOB' ? 'USD' : 'BOB'}
            symbol={symbol}
          />
        </>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('loadError')}
        </p>
      ) : null}
    </div>
  );
}

/** `/` (plan §4.8.4): without accounts it invites to create the first one (EC-M8-01). */
export function DashboardPage() {
  const active = useAccounts('active');
  if (active.data === undefined) return null;
  if (active.data.items.length === 0) return <QuickAccountForm />;
  return <DashboardContent />;
}

/** The private route of the Inicio (plan §4.8.4). */
export const dashboardRoutes: RouteObject[] = [{ index: true, element: <DashboardPage /> }];
