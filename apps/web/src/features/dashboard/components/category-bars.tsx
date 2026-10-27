import type { DashboardViewDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useFormatters } from '@/features/settings/hooks/use-settings';

interface Props {
  data: NonNullable<DashboardViewDto['byCategory']>;
  month: string;
  symbol: string;
}

/** "Gasto por categoría": top 5 plus "Otras", each linking to Movimientos (RF-M8-05). */
export function CategoryBars({ data, month, symbol }: Props) {
  const { t } = useTranslation('dashboard');
  const formatters = useFormatters();

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-by-category">
      <h2 id="dashboard-by-category" className="text-base font-semibold">
        {t('byCategory.title')}
      </h2>
      {data.top.length === 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t('byCategory.empty')}</p>
          <Link to="/registrar" className="min-h-11 text-sm font-medium text-primary underline">
            {t('register')}
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.top.map((row) => (
            <li key={row.categoryId}>
              <Link
                to={`/movimientos?month=${month}&kind=expense&categoryId=${row.categoryId}`}
                className="flex min-h-11 flex-col gap-1"
              >
                <span className="flex justify-between gap-2 text-sm">
                  <span>{row.name}</span>
                  <span className="tabular-nums">
                    −{formatters.money(row.amount, symbol)} · {row.pct} %
                  </span>
                </span>
                <span className="h-2 rounded-full bg-muted">
                  <span
                    className="block h-2 rounded-full bg-primary"
                    style={{ width: `${Math.min(100, Math.max(0, row.pct))}%` }}
                  />
                </span>
              </Link>
            </li>
          ))}
          {data.others !== null && (
            <li className="flex min-h-11 flex-col gap-1">
              <span className="flex justify-between gap-2 text-sm">
                <span>{t('byCategory.others')}</span>
                <span className="tabular-nums">
                  −{formatters.money(data.others.amount, symbol)} · {data.others.pct} %
                </span>
              </span>
              <span className="h-2 rounded-full bg-muted">
                <span
                  className="block h-2 rounded-full bg-muted-foreground"
                  style={{ width: `${Math.min(100, Math.max(0, data.others.pct))}%` }}
                />
              </span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
