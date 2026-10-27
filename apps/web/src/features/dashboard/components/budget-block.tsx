import type { DashboardViewDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useFormatters } from '@/features/settings/hooks/use-settings';

interface Props {
  data: NonNullable<DashboardViewDto['budgets']>;
  month: string;
  symbol: string;
}

function monthLabel(month: string): string {
  const [year, number] = month.split('-').map(Number);
  const name = new Intl.DateTimeFormat('es-BO', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year ?? 1970, (number ?? 1) - 1, 1)),
  );
  return `${name} ${String(year)}`;
}

/** "Presupuesto del mes": one bar per budget with its period, linking to Presupuestos. */
export function BudgetBlock({ data, month, symbol }: Props) {
  const { t } = useTranslation('dashboard');
  const formatters = useFormatters();
  const period = monthLabel(month);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-budget">
      <h2 id="dashboard-budget" className="text-base font-semibold">
        {t('budget.title')}
      </h2>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('budget.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {data.map((bar, index) => {
            const label = bar.name === '' ? t('budget.general') : bar.name;
            const pct = Math.round(bar.pct);
            return (
              <li key={`${bar.categoryId}-${String(index)}`} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span>{label}</span>
                  <span className="text-sm text-muted-foreground">{period}</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(pct, 100)}
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${String(Math.min(pct, 100))}%` }}
                  />
                </div>
                <div className="flex justify-between gap-2 text-sm text-muted-foreground">
                  <span className="tabular-nums">{`${String(pct)} %`}</span>
                  <span className="tabular-nums">
                    {t('budget.spentOf', {
                      spent: formatters.money(bar.spent, symbol),
                      limit: formatters.money(bar.limit, symbol),
                    })}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Link to="/presupuestos" className="min-h-11 text-sm font-medium text-primary underline">
        {t('budget.seeAll')}
      </Link>
    </section>
  );
}
