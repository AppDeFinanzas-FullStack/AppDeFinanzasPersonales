import type { DashboardViewDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useFormatters } from '@/features/settings/hooks/use-settings';

interface Props {
  data: NonNullable<DashboardViewDto['recent']>;
  symbol: string;
}

function signOf(kind: string): string {
  if (kind === 'expense') return '−';
  if (kind === 'income') return '+';
  return '';
}

/** "Últimos movimientos": the five most recent, linking to Movimientos. */
export function RecentBlock({ data, symbol }: Props) {
  const { t } = useTranslation('dashboard');
  const formatters = useFormatters();

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-recent">
      <h2 id="dashboard-recent" className="text-base font-semibold">
        {t('recent.title')}
      </h2>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('recent.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {data.map((tx) => (
            <li key={tx.id} className="border-b border-border last:border-b-0">
              <Link
                to={`/movimientos/${tx.id}`}
                className="flex min-h-11 items-center justify-between gap-2"
              >
                <span className="flex flex-col">
                  <span>{tx.category?.name ?? tx.note ?? t(`recent.kind.${tx.kind}`)}</span>
                  <span className="text-sm text-muted-foreground">{formatters.date(tx.date)}</span>
                </span>
                <span className="tabular-nums">
                  {signOf(tx.kind)}
                  {formatters.money(tx.amountInBase.replace('-', ''), symbol)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/movimientos" className="min-h-11 text-sm font-medium text-primary underline">
        {t('recent.seeAll')}
      </Link>
    </section>
  );
}
